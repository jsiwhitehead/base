import { batch, signal } from "@preact/signals-core";

import { makeBlankEntry } from "./model";
import type {
  ApplyDelta,
  Entry,
  EntryContent,
  EntryId,
  Model,
  Op,
  Transaction,
  TransactionMeta,
  ViewName,
} from "./model";
import { CoreApiError } from "./model";
import type { Connected, ItemId, ValueOrBlank } from "./read";
import { entryIdFromItemId, itemIdOf, parseItemId } from "./read";
import { CONTENT_TEXT_TARGET } from "./select";
import type { Selection, SelectionRepairAnchor } from "./select";
import { enforceViewShapes } from "./shape";
import type { ViewShape } from "./shape";

export type Tx = {
  setLabel(id: ItemId, label: string): void;
  setView(id: ItemId, view: ViewName | null): void;

  setValue(id: ItemId, value: ValueOrBlank): void;
  setConnected(id: ItemId, conn: Connected): void;
  setGroup(id: ItemId): void;

  insertChild(parentId: ItemId, opts?: { at?: number }): ItemId;

  move(id: ItemId, toParentId: ItemId, opts?: { at?: number }): void;
  remove(id: ItemId): void;
};

export type CommitController = {
  commit(run: (t: Tx) => void): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undoBoundary(): void;
  applyRemote(txn: Transaction): void;
  resetState(): void;
};

type TextHistoryOpClass = "insert" | "delete" | "replace";
type TextHistoryGroupKey = {
  type: "text";
  itemId: ItemId;
  target: string;
  opClass: TextHistoryOpClass;
};
type HistorySelectionSnapshot = { selection: Selection; caret?: number };
type UndoHistoryEntry = {
  forward: Transaction;
  inverse: Transaction;
  before: HistorySelectionSnapshot;
  groupedAt: number;
  groupKey: TextHistoryGroupKey | null;
};
type RedoHistoryEntry = UndoHistoryEntry & {
  redoSnapshot: HistorySelectionSnapshot;
};
type UserCommitHistoryCtx = {
  selection: Selection;
  caret?: number;
  startedAt: number;
};
type ControllerStateSnapshot = {
  selection: HistorySelectionSnapshot;
  undo: UndoHistoryEntry[];
  redo: RedoHistoryEntry[];
  localSeq: number;
};
type ApplyLocalOptions = {
  startNextId?: EntryId;
  nextIdAfterCommit?: EntryId;
};
type RawApplyCapture = {
  undoOps: Op[];
  userUndoOps: Op[] | null;
  forwardOps: Op[];
};
type ApplyLocalResult = {
  forward: Transaction;
  freshUndo: Transaction;
  userUndoOps: Op[];
};
type ShapeRuleApplyResult = {
  delta: ApplyDelta;
  undoOps: Op[];
  forwardOps: Op[];
};
type CommitPlanner = {
  tx: Tx;
  ops: Op[];
  userHistoryCtx: UserCommitHistoryCtx;
  getNextIdAfterCommit(): EntryId;
};

type CommitControllerOptions = {
  model: Model;
  shapes: Partial<Record<ViewName, ViewShape>>;
  getSelection: () => Selection;
  readCurrentCaret?: () => number | undefined;
  restoreSelectionIfValid: (snapshot: HistorySelectionSnapshot) => void;
  captureRepairAnchor: () => SelectionRepairAnchor | null;
  repairAfterLocalApply: (anchor: SelectionRepairAnchor | null) => void;
  coerceEditingToItem: () => void;
  coerceAfterRemoteApply: () => void;
  clearCachesForRemovedEntries: (removedIds: readonly EntryId[]) => void;
  collab?: { origin: string; send(txn: Transaction): void };
};

const TEXT_HISTORY_COALESCE_MS = 500;

const emptyApply: ApplyDelta = { removed: [], touched: [] };

function storedFromValue(v: ValueOrBlank): EntryContent {
  return v === null ? { type: "blank" } : { type: "scalar", value: v };
}

function cloneSelection(selection: Selection): Selection {
  if (selection.type === "idle") return { type: "idle" };
  if (selection.type === "editing")
    return {
      type: "editing",
      location: {
        item: selection.location.item,
        portals: [...selection.location.portals],
      },
      target: selection.target,
    };
  return {
    type: "item",
    anchor: {
      item: selection.anchor.item,
      portals: [...selection.anchor.portals],
    },
    head: { item: selection.head.item, portals: [...selection.head.portals] },
  };
}

function captureSelectionSnapshot(
  selection: Selection,
  caret?: number,
): HistorySelectionSnapshot {
  if (selection.type !== "editing") {
    return { selection: cloneSelection(selection) };
  }
  return {
    selection: cloneSelection(selection),
    ...(caret !== undefined ? { caret } : {}),
  };
}

function patchesViewOnSelection(
  txn: Transaction,
  snapshot: HistorySelectionSnapshot,
): boolean {
  if (snapshot.selection.type !== "editing") return false;
  const eid = entryIdFromItemId(snapshot.selection.location.item);
  if (eid == null) return false;
  return txn.ops.some(
    (op) => op.type === "patch" && op.id === eid && op.next.view !== undefined,
  );
}

export function createCommitController(
  opts: CommitControllerOptions,
): CommitController {
  const currentModel = opts.model;

  const undoHistory = signal<UndoHistoryEntry[]>([]);
  const redoHistory = signal<RedoHistoryEntry[]>([]);

  const snapshotControllerState = (): ControllerStateSnapshot => {
    const selection = opts.getSelection();
    const caret =
      selection.type === "editing" ? opts.readCurrentCaret?.() : undefined;
    return {
      selection: captureSelectionSnapshot(selection, caret),
      undo: [...undoHistory.value],
      redo: [...redoHistory.value],
      localSeq,
    };
  };

  const restoreControllerState = (snapshot: ControllerStateSnapshot): void => {
    undoHistory.value = snapshot.undo;
    redoHistory.value = snapshot.redo;
    localSeq = snapshot.localSeq;
    opts.restoreSelectionIfValid(snapshot.selection);
  };

  const applyAtomically = (run: () => void): void => {
    const before = snapshotControllerState();
    try {
      run();
    } catch (err) {
      restoreControllerState(before);
      throw err;
    }
  };

  const mergeApply = (a: ApplyDelta, b: ApplyDelta): ApplyDelta => ({
    removed: Array.from(new Set([...a.removed, ...b.removed])),
    touched: Array.from(new Set([...a.touched, ...b.touched])),
  });

  const rollbackOps = (undoOps: readonly Op[]): void => {
    if (!undoOps.length) return;
    try {
      currentModel.apply(
        currentModel.ops.transaction(undoOps, { source: "undo" }),
      );
    } catch {}
  };

  const applyShapeRuleOps = (
    touchedIds: readonly EntryId[],
  ): ShapeRuleApplyResult => {
    let merged = emptyApply;
    let undoOps: Op[] = [];
    const forwardOps: Op[] = [];

    const model = currentModel;
    try {
      enforceViewShapes(model, opts.shapes, touchedIds, (shapeOps) => {
        const txn = model.ops.transaction(shapeOps, { source: "rule" });
        const result = model.apply(txn);
        undoOps = [...result.undoOps, ...undoOps];
        forwardOps.push(...txn.ops);
        merged = mergeApply(merged, result.delta);
      });
    } catch (err) {
      rollbackOps(undoOps);
      throw err;
    }

    return { delta: merged, undoOps, forwardOps };
  };

  const coerceEditingIfViewChanged = (txn: Transaction): void => {
    const sel = opts.getSelection();
    if (sel.type !== "editing") return;
    const eid = entryIdFromItemId(sel.location.item);
    if (eid == null) return;
    if (
      txn.ops.some(
        (op) =>
          op.type === "patch" && op.id === eid && op.next.view !== undefined,
      )
    ) {
      opts.coerceEditingToItem();
    }
  };

  const normalizeSelectionAfterApply = (
    txn: Transaction,
    opts0:
      | { type: "local"; anchor: SelectionRepairAnchor | null }
      | { type: "remote" },
  ): void => {
    coerceEditingIfViewChanged(txn);
    if (opts0.type === "local") {
      opts.repairAfterLocalApply(opts0.anchor);
      return;
    }
    opts.coerceAfterRemoteApply();
  };

  const readSingleTextPatch = (
    ops: readonly Op[],
    expectedId?: EntryId,
  ): {
    id: EntryId;
    content: Extract<EntryContent, { type: "blank" | "scalar" }>;
  } | null => {
    if (ops.length !== 1) return null;
    const op = ops[0];
    if (
      !op ||
      op.type !== "patch" ||
      op.next.label !== undefined ||
      op.next.view !== undefined
    ) {
      return null;
    }
    if (expectedId != null && op.id !== expectedId) return null;
    const content = op.next.content;
    if (!content || (content.type !== "blank" && content.type !== "scalar")) {
      return null;
    }
    return { id: op.id, content };
  };

  const classifyTextHistoryGroup = (
    txn: Transaction,
    undoOps: readonly Op[],
    sel: Selection,
  ): TextHistoryGroupKey | null => {
    if (sel.type !== "editing") return null;
    if (sel.target !== CONTENT_TEXT_TARGET) return null;

    const focusedEntryId = entryIdFromItemId(sel.location.item);
    if (focusedEntryId == null) return null;

    const nextPatch = readSingleTextPatch(txn.ops, focusedEntryId);
    if (!nextPatch) return null;
    const prevPatch = readSingleTextPatch(undoOps, nextPatch.id);
    if (!prevPatch) return null;

    const prevLen =
      prevPatch.content.type === "blank"
        ? 0
        : String(prevPatch.content.value).length;
    const nextLen =
      nextPatch.content.type === "blank"
        ? 0
        : String(nextPatch.content.value).length;
    const opClass: TextHistoryOpClass =
      nextLen > prevLen ? "insert" : nextLen < prevLen ? "delete" : "replace";

    return {
      type: "text",
      itemId: sel.location.item,
      target: sel.target,
      opClass,
    };
  };

  const canCoalesceUndoEntries = (
    prev: UndoHistoryEntry | null,
    next: UndoHistoryEntry,
  ): boolean => {
    const prevKey = prev?.groupKey;
    const nextKey = next.groupKey;
    if (!prevKey || !nextKey) return false;

    return (
      prevKey.itemId === nextKey.itemId &&
      prevKey.target === nextKey.target &&
      prevKey.opClass === nextKey.opClass &&
      next.groupedAt - prev.groupedAt <= TEXT_HISTORY_COALESCE_MS
    );
  };

  const mergeUndoEntries = (
    prev: UndoHistoryEntry,
    next: UndoHistoryEntry,
  ): UndoHistoryEntry => ({
    forward: {
      ops: [...prev.forward.ops, ...next.forward.ops],
      ...(next.forward.meta ? { meta: next.forward.meta } : {}),
    },
    inverse: {
      ops: [...next.inverse.ops, ...prev.inverse.ops],
      ...(next.inverse.meta ? { meta: next.inverse.meta } : {}),
    },
    before: prev.before,
    groupedAt: next.groupedAt,
    groupKey: next.groupKey,
  });

  const pushOrCoalesceUndoEntry = (entry: UndoHistoryEntry): void => {
    const undoStack = undoHistory.value;
    const last = undoStack.at(-1);
    if (!last || !canCoalesceUndoEntries(last, entry)) {
      undoHistory.value = [...undoStack, entry];
      return;
    }
    undoHistory.value = [
      ...undoStack.slice(0, -1),
      mergeUndoEntries(last, entry),
    ];
  };

  const applyExactTransaction = (
    txn: Transaction,
  ): { delta: ApplyDelta; undoOps: Op[] } => {
    const result = currentModel.apply(txn);
    return { delta: result.delta, undoOps: [...result.undoOps] };
  };

  const applyExactLocal = (
    txn: Transaction,
  ): { freshUndo: Transaction } => {
    const anchor = opts.captureRepairAnchor();
    let delta = emptyApply;
    let undoOps: Op[] = [];

    try {
      batch(() => {
        const applied = applyExactTransaction(txn);
        delta = applied.delta;
        undoOps = applied.undoOps;
        normalizeSelectionAfterApply(txn, { type: "local", anchor });
        opts.clearCachesForRemovedEntries(delta.removed);
      });
    } catch (err) {
      rollbackOps(undoOps);
      throw err;
    }

    return {
      freshUndo: currentModel.ops.transaction(undoOps, { source: "undo" }),
    };
  };

  const applyRawLocal = (txn: Transaction): RawApplyCapture => {
    const anchor = opts.captureRepairAnchor();
    let delta = emptyApply;
    let undoOps: Op[] = [];
    let userUndoOps: Op[] | null = null;
    let forwardOps: Op[] = [];

    try {
      batch(() => {
        const userApplied = applyExactTransaction(txn);
        userUndoOps = userApplied.undoOps;
        undoOps = userApplied.undoOps;
        forwardOps = [...txn.ops];

        const shapeRules = applyShapeRuleOps(userApplied.delta.touched);
        delta = mergeApply(userApplied.delta, shapeRules.delta);
        undoOps = [...shapeRules.undoOps, ...userApplied.undoOps];
        forwardOps.push(...shapeRules.forwardOps);

        normalizeSelectionAfterApply(txn, { type: "local", anchor });
        opts.clearCachesForRemovedEntries(delta.removed);
      });
    } catch (err) {
      rollbackOps(undoOps);
      throw err;
    }

    return { undoOps, userUndoOps, forwardOps };
  };

  const applyRawRemote = (txn: Transaction): void => {
    let undoOps: Op[] = [];
    let delta = emptyApply;

    try {
      batch(() => {
        const userApplied = applyExactTransaction(txn);
        undoOps = userApplied.undoOps;

        const shapeRules = applyShapeRuleOps(userApplied.delta.touched);
        delta = mergeApply(userApplied.delta, shapeRules.delta);
        undoOps = [...shapeRules.undoOps, ...userApplied.undoOps];

        normalizeSelectionAfterApply(txn, { type: "remote" });
        opts.clearCachesForRemovedEntries(delta.removed);
      });
    } catch (err) {
      rollbackOps(undoOps);
      throw err;
    }
  };

  let localSeq = 0;

  const stampLocalMeta = (
    meta: TransactionMeta | undefined,
  ): TransactionMeta => {
    const base = meta ?? {};
    const origin = opts.collab?.origin;
    return {
      ...base,
      ...(origin ? { origin } : {}),
    };
  };

  const sendLocalTxn = (txn: Transaction): void => {
    if (!opts.collab) return;
    opts.collab.send(txn);
  };

  const applyLocal = (
    txn: Transaction,
    applyLocalOpts?: ApplyLocalOptions,
  ): ApplyLocalResult => {
    const model = currentModel;
    const stamped = model.ops.transaction(txn.ops, stampLocalMeta(txn.meta));
    const startNextId = applyLocalOpts?.startNextId;
    const nextIdAfterCommit = applyLocalOpts?.nextIdAfterCommit;
    const stagedNextId = startNextId != null && nextIdAfterCommit != null;
    if (stagedNextId) model.setNextId(nextIdAfterCommit);

    let capture: RawApplyCapture = {
      undoOps: [],
      userUndoOps: null,
      forwardOps: [],
    };

    try {
      applyAtomically(() => {
        capture = applyRawLocal(stamped);
      });
    } catch (err) {
      if (stagedNextId) model.setNextId(startNextId);
      throw err;
    }

    const freshUndo = model.ops.transaction(capture.undoOps, {
      source: "undo",
    });
    const committedMeta: TransactionMeta =
      opts.collab?.origin != null
        ? { ...(stamped.meta ?? {}), seq: ++localSeq }
        : (stamped.meta ?? {});
    const forward = model.ops.transaction(capture.forwardOps, committedMeta);
    const outbound = model.ops.transaction(stamped.ops, committedMeta);
    sendLocalTxn(outbound);
    return {
      forward,
      freshUndo,
      userUndoOps: capture.userUndoOps ?? [],
    };
  };

  const applyRemote = (txn: Transaction): void => {
    if (
      opts.collab &&
      txn.meta?.origin &&
      txn.meta.origin === opts.collab.origin
    ) {
      return;
    }

    const meta = { ...(txn.meta ?? {}), source: "remote" as const };
    const model = currentModel;
    applyAtomically(() => {
      applyRawRemote(model.ops.transaction(txn.ops, meta));
    });
  };

  const buildTx = (
    ops: Op[],
    pendingCreated: Set<EntryId>,
    requireTxEntryId: (id: ItemId, opName: string) => EntryId,
    allocateEntryId: () => EntryId,
  ): Tx => ({
    setLabel: (id, label) => {
      const eid = requireTxEntryId(id, "setLabel");
      ops.push(currentModel.ops.patch(eid, { label }));
    },

    setView: (id, view) => {
      const eid = requireTxEntryId(id, "setView");
      ops.push(currentModel.ops.patch(eid, { view }));
    },

    setValue: (id, value) => {
      const eid = requireTxEntryId(id, "setValue");
      ops.push(
        currentModel.ops.patch(eid, { content: storedFromValue(value) }),
      );
    },

    setConnected: (id, conn) => {
      const eid = requireTxEntryId(id, "setConnected");

      if (conn.type === "formula") {
        ops.push(
          currentModel.ops.patch(eid, {
            content: { type: "formula", expr: conn.expr },
          }),
        );
        return;
      }

      ops.push(
        currentModel.ops.patch(eid, {
          content: {
            type: "query",
            from: conn.from,
            where: conn.where,
            orderBy: conn.orderBy,
          },
        }),
      );
    },

    setGroup: (id) => {
      const eid = requireTxEntryId(id, "setGroup");
      ops.push(
        currentModel.ops.patch(eid, {
          content: { type: "group", childIds: [] },
        }),
      );
    },

    insertChild: (parentId, insertOpts) => {
      const parentEid = requireTxEntryId(parentId, "insertChild");

      const id = allocateEntryId();
      const entry: Entry = makeBlankEntry(id);
      pendingCreated.add(id);

      ops.push(currentModel.ops.create(entry));
      ops.push(
        currentModel.ops.move({
          childId: id,
          toParentId: parentEid,
          ...(insertOpts?.at != null ? { toIndex: insertOpts.at } : {}),
        }),
      );

      return itemIdOf(id);
    },

    move: (id, toParentId, moveOpts) => {
      const childEid = requireTxEntryId(id, "move");
      const toParentEid = requireTxEntryId(toParentId, "move");

      ops.push(
        currentModel.ops.move({
          childId: childEid,
          toParentId: toParentEid,
          ...(moveOpts?.at != null ? { toIndex: moveOpts.at } : {}),
        }),
      );
    },

    remove: (id) => {
      const eid = requireTxEntryId(id, "remove");
      ops.push(currentModel.ops.remove(eid));
    },
  });

  const createCommitPlanner = (startNextId: EntryId): CommitPlanner => {
    let nextIdCursor = startNextId;
    const allocateEntryId = (): EntryId => {
      const id = nextIdCursor;
      nextIdCursor += 1;
      return id;
    };

    const selBefore = opts.getSelection();
    const caretBefore =
      selBefore.type === "editing" ? opts.readCurrentCaret?.() : undefined;
    const userHistoryCtx: UserCommitHistoryCtx = {
      selection: cloneSelection(selBefore),
      ...(caretBefore !== undefined ? { caret: caretBefore } : {}),
      startedAt: Date.now(),
    };
    const ops: Op[] = [];
    const pendingCreated = new Set<EntryId>();

    const requireTxEntryId = (id: ItemId, opName: string): EntryId => {
      const ref = parseItemId(id);
      if (!ref)
        throw new CoreApiError(
          "INVALID_ITEM_ID",
          `${opName} expects a valid item id`,
        );

      const { entryId, path } = ref;
      if (path.length !== 0)
        throw new CoreApiError(
          "DERIVED_ITEM_ID",
          `${opName} does not accept readonly/derived item ids`,
        );
      const model = currentModel;
      if (!model.hasEntry(entryId) && !pendingCreated.has(entryId)) {
        throw new CoreApiError(
          "UNKNOWN_ITEM_ID",
          `${opName} expects an existing item id`,
        );
      }

      return entryId;
    };

    return {
      tx: buildTx(ops, pendingCreated, requireTxEntryId, allocateEntryId),
      ops,
      userHistoryCtx,
      getNextIdAfterCommit: () => nextIdCursor,
    };
  };

  const commit = (run: (t: Tx) => void): void => {
    const startNextId = currentModel.peekNextId();
    const planner = createCommitPlanner(startNextId);

    run(planner.tx);
    if (!planner.ops.length) return;

    const txn = currentModel.ops.transaction(planner.ops, { source: "user" });
    const nextIdAfterCommit = planner.getNextIdAfterCommit();
    const { forward, freshUndo, userUndoOps } = applyLocal(txn, {
      ...(nextIdAfterCommit !== startNextId
        ? { startNextId, nextIdAfterCommit }
        : {}),
    });
    pushOrCoalesceUndoEntry({
      forward,
      inverse: freshUndo,
      before: captureSelectionSnapshot(
        planner.userHistoryCtx.selection,
        planner.userHistoryCtx.caret,
      ),
      groupedAt: planner.userHistoryCtx.startedAt,
      groupKey: classifyTextHistoryGroup(
        txn,
        userUndoOps,
        planner.userHistoryCtx.selection,
      ),
    });
    redoHistory.value = [];
  };

  const undo = (): void => {
    const undoStack = undoHistory.value;
    const last = undoStack.at(-1) ?? null;
    if (!last) return;
    const selBeforeUndo = opts.getSelection();
    const caretBeforeUndo =
      selBeforeUndo.type === "editing" ? opts.readCurrentCaret?.() : undefined;
    const redoSnapshot = captureSelectionSnapshot(
      selBeforeUndo,
      caretBeforeUndo,
    );
    const { freshUndo } = applyExactLocal(last.inverse);
    if (!patchesViewOnSelection(last.inverse, last.before)) {
      opts.restoreSelectionIfValid(last.before);
    }
    undoHistory.value = undoStack.slice(0, -1);
    redoHistory.value = [
      ...redoHistory.value,
      { ...last, inverse: freshUndo, redoSnapshot },
    ];
  };

  const redo = (): void => {
    const redoStack = redoHistory.value;
    const redone = redoStack.at(-1) ?? null;
    if (!redone) return;

    const replay = currentModel.ops.transaction(redone.forward.ops, {
      ...(redone.forward.meta ?? {}),
      source: "redo",
    });
    const { freshUndo } = applyExactLocal(replay);
    if (!patchesViewOnSelection(replay, redone.redoSnapshot)) {
      opts.restoreSelectionIfValid(redone.redoSnapshot);
    }
    redoHistory.value = redoStack.slice(0, -1);
    undoHistory.value = [
      ...undoHistory.value,
      {
        forward: replay,
        inverse: freshUndo,
        before: redone.before,
        groupedAt: redone.groupedAt,
        groupKey: redone.groupKey,
      },
    ];
  };

  const canUndo = (): boolean => undoHistory.value.length > 0;
  const canRedo = (): boolean => redoHistory.value.length > 0;

  const undoBoundary = (): void => {
    const undoStack = undoHistory.value;
    const last = undoStack.at(-1);
    if (last) {
      undoHistory.value = [
        ...undoStack.slice(0, -1),
        { ...last, groupKey: null },
      ];
    }
  };

  const resetState = (): void => {
    undoHistory.value = [];
    redoHistory.value = [];
  };

  return {
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    undoBoundary,
    applyRemote,
    resetState,
  };
}
