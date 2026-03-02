import { batch } from "@preact/signals-core";

import { CoreInvariantError } from "../dev";
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
  undoBoundary(): void;
  applyRemote(txn: Transaction): void;
  resetState(): void;
};

type TextHistoryGroupKey = { kind: "text"; itemId: ItemId; target: string };
type UndoHistoryEntry = {
  user: Transaction;
  inverse: Transaction;
  groupedAt: number;
  groupKey: TextHistoryGroupKey | null;
};
type UserCommitHistoryCtx = { selection: Selection; startedAt: number };
type CapturedSubtree = { entry: Entry; children: CapturedSubtree[] };

type CommitControllerOptions = {
  model: Model;
  shapes: Partial<Record<ViewName, ViewShape>>;
  rootEntryId: EntryId;
  getSelection: () => Selection;
  captureRepairAnchor: () => SelectionRepairAnchor | null;
  repairAfterLocalApply: (anchor: SelectionRepairAnchor | null) => void;
  coerceEditingToItem: () => void;
  coerceAfterRemoteApply: () => void;
  clearCachesForRemovedEntries: (removedIds: readonly EntryId[]) => void;
  collab?: { origin: string; send(txn: Transaction): void };
};

const TEXT_HISTORY_COALESCE_MS = 500;
const VALUE_TARGET = "value";

const emptyApply: ApplyDelta = { removed: [], touched: [] };

function assertNever(_exhaustive: never, message: string): never {
  throw new CoreInvariantError(message);
}

function storedFromValue(v: ValueOrBlank): EntryContent {
  return v === null ? { type: "blank" } : { type: "scalar", value: v };
}

export function createCommitController(
  opts: CommitControllerOptions,
): CommitController {
  const currentModel = opts.model;

  const history: { undo: UndoHistoryEntry[]; redo: UndoHistoryEntry[] } = {
    undo: [],
    redo: [],
  };

  const mergeApply = (a: ApplyDelta, b: ApplyDelta): ApplyDelta => ({
    removed: Array.from(new Set([...a.removed, ...b.removed])),
    touched: Array.from(new Set([...a.touched, ...b.touched])),
  });

  const captureInverseForTxn = (txn: Transaction): Op[] => {
    const model = currentModel;
    const inverses: Op[] = [];

    const captureSubtree = (rootEntryId: EntryId): CapturedSubtree => {
      const entry = model.peekEntry(rootEntryId);
      const childIds =
        entry.content.type === "group" ? model.childIdsOf(rootEntryId) : [];
      return {
        entry,
        children: childIds.map((childId) => captureSubtree(childId)),
      };
    };

    const entryForRestoreCreate = (entry: Entry): Entry => {
      if (entry.content.type !== "group") return { ...entry, parentId: null };
      return {
        ...entry,
        parentId: null,
        content: { type: "group", childIds: [] },
      };
    };

    const pushCreateOpsForSubtree = (
      node: CapturedSubtree,
      out: Op[],
      createOpts?: { skipRoot?: true },
    ): void => {
      if (!createOpts?.skipRoot)
        out.push(model.ops.create(entryForRestoreCreate(node.entry)));
      for (const child of node.children) pushCreateOpsForSubtree(child, out);
    };

    const pushChildRestoreMoves = (node: CapturedSubtree, out: Op[]): void => {
      for (let i = 0; i < node.children.length; i += 1) {
        const child = node.children[i]!;
        out.push(
          model.ops.move({
            childId: child.entry.id,
            toParentId: node.entry.id,
            toIndex: i,
          }),
        );
        pushChildRestoreMoves(child, out);
      }
    };

    for (const op of txn.ops) {
      if (op.type === "create") {
        inverses.push(model.ops.remove(op.entry.id));
        continue;
      }

      if (op.type === "patch") {
        if (!model.hasEntry(op.id)) continue;
        const cur = model.peekEntry(op.id);
        const next: Parameters<typeof model.ops.patch>[1] = {};
        if (op.next.label !== undefined) next.label = cur.label;
        if (op.next.view !== undefined) next.view = cur.view;
        if (op.next.content !== undefined) next.content = cur.content;
        inverses.push(model.ops.patch(op.id, next));
        continue;
      }

      if (op.type === "move") {
        const childId = op.spec.childId;
        if (!model.hasEntry(childId)) continue;
        const child = model.peekEntry(childId);
        const parentId = child.parentId;
        if (parentId == null)
          throw new CoreInvariantError(
            "Move inverse expects child to have a parent",
          );
        const loc = model.locateInParent(childId);
        inverses.push(
          model.ops.move({
            childId,
            toParentId: parentId,
            ...(loc ? { toIndex: loc.index } : {}),
          }),
        );
        continue;
      }

      if (op.type === "remove") {
        const id0 = op.id;
        if (!model.hasEntry(id0)) continue;

        const cur = model.peekEntry(id0);
        const subtree = captureSubtree(id0);
        if (id0 === opts.rootEntryId) {
          if (subtree.entry.content.type === "group") {
            pushChildRestoreMoves(subtree, inverses);
            pushCreateOpsForSubtree(subtree, inverses, { skipRoot: true });
            inverses.push(
              model.ops.patch(id0, {
                label: subtree.entry.label,
                view: subtree.entry.view,
                content: { type: "group", childIds: [] },
              }),
            );
          } else {
            inverses.push(
              model.ops.patch(id0, {
                label: subtree.entry.label,
                view: subtree.entry.view,
                content: subtree.entry.content,
              }),
            );
          }
          continue;
        }

        const parentId = cur.parentId;
        if (parentId == null)
          throw new CoreInvariantError(
            "Remove inverse expects non-root item to have a parent",
          );
        const loc = model.locateInParent(id0);
        const prevIndex = loc?.index ?? undefined;
        pushChildRestoreMoves(subtree, inverses);
        inverses.push(
          model.ops.move({
            childId: id0,
            toParentId: parentId,
            ...(prevIndex != null ? { toIndex: prevIndex } : {}),
          }),
        );
        pushCreateOpsForSubtree(subtree, inverses);

        continue;
      }

      assertNever(op, "Unhandled op");
    }

    return inverses;
  };

  const applyTxnWithInverse = (
    txn: Transaction,
  ): { delta: ApplyDelta; inverseOps: Op[] } => {
    const inverseOps = captureInverseForTxn(txn);
    const delta = currentModel.apply(txn);
    return { delta, inverseOps };
  };

  const applyShapeRuleOps = (
    touchedIds: readonly EntryId[],
    inverseAcc: Op[],
  ): ApplyDelta => {
    let merged = emptyApply;

    const model = currentModel;
    enforceViewShapes(model, opts.shapes, touchedIds, (shapeOps) => {
      const txn = model.ops.transaction(shapeOps, { source: "rule" });
      const { delta, inverseOps } = applyTxnWithInverse(txn);
      inverseAcc.push(...inverseOps);
      merged = mergeApply(merged, delta);
    });

    return merged;
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
      | { phase: "local"; anchor: SelectionRepairAnchor | null }
      | { phase: "remote" },
  ): void => {
    coerceEditingIfViewChanged(txn);
    if (opts0.phase === "local") {
      opts.repairAfterLocalApply(opts0.anchor);
      return;
    }
    opts.coerceAfterRemoteApply();
  };

  const classifyTextHistoryGroup = (
    txn: Transaction,
    sel: Selection,
  ): TextHistoryGroupKey | null => {
    if (sel.type !== "editing") return null;
    if (sel.target !== VALUE_TARGET) return null;
    if (txn.ops.length !== 1) return null;

    const op = txn.ops[0];
    if (!op) return null;
    if (
      op.type !== "patch" ||
      op.next.label !== undefined ||
      op.next.view !== undefined
    ) {
      return null;
    }

    const content = op.next.content;
    if (!content || (content.type !== "blank" && content.type !== "scalar")) {
      return null;
    }

    const focusedEntryId = entryIdFromItemId(sel.location.item);
    if (focusedEntryId == null || focusedEntryId !== op.id) return null;

    return { kind: "text", itemId: sel.location.item, target: sel.target };
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
      next.groupedAt - prev.groupedAt <= TEXT_HISTORY_COALESCE_MS
    );
  };

  const mergeUndoEntries = (
    prev: UndoHistoryEntry,
    next: UndoHistoryEntry,
  ): UndoHistoryEntry => ({
    user: {
      ops: [...prev.user.ops, ...next.user.ops],
      ...(next.user.meta ? { meta: next.user.meta } : {}),
    },
    inverse: {
      ops: [...next.inverse.ops, ...prev.inverse.ops],
      ...(next.inverse.meta ? { meta: next.inverse.meta } : {}),
    },
    groupedAt: next.groupedAt,
    groupKey: next.groupKey,
  });

  const pushOrCoalesceUndoEntry = (entry: UndoHistoryEntry): void => {
    const last = history.undo.at(-1) ?? null;
    if (!canCoalesceUndoEntries(last, entry)) {
      history.undo.push(entry);
      return;
    }
    history.undo[history.undo.length - 1] = mergeUndoEntries(last!, entry);
  };

  const applyRemotePipeline = (
    txn: Transaction,
    inverseAcc: Op[],
  ): ApplyDelta => {
    let merged = emptyApply;

    const modelDelta = currentModel.apply(txn);
    merged = mergeApply(merged, modelDelta);

    const shapeRuleDelta = applyShapeRuleOps(modelDelta.touched, inverseAcc);
    merged = mergeApply(merged, shapeRuleDelta);

    normalizeSelectionAfterApply(txn, { phase: "remote" });

    return merged;
  };

  const applyUserPipeline = (
    txn: Transaction,
    inverseAcc: Op[],
    userHistoryCtx: UserCommitHistoryCtx | null = null,
  ): ApplyDelta => {
    let merged = emptyApply;
    const anchor = opts.captureRepairAnchor();
    const isUser = txn.meta?.source === "user";

    const { delta: userDelta, inverseOps } = applyTxnWithInverse(txn);
    inverseAcc.push(...inverseOps);
    merged = mergeApply(merged, userDelta);

    const shapeRuleDelta = applyShapeRuleOps(userDelta.touched, inverseAcc);
    merged = mergeApply(merged, shapeRuleDelta);

    normalizeSelectionAfterApply(txn, { phase: "local", anchor });

    if (isUser) {
      const inverse = currentModel.ops.transaction(inverseAcc.toReversed(), {
        source: "undo",
      });
      pushOrCoalesceUndoEntry({
        user: txn,
        inverse,
        groupedAt: userHistoryCtx?.startedAt ?? Date.now(),
        groupKey: userHistoryCtx
          ? classifyTextHistoryGroup(txn, userHistoryCtx.selection)
          : null,
      });
      history.redo = [];
    }

    return merged;
  };

  const applyPipeline = (
    txn: Transaction,
    userHistoryCtx: UserCommitHistoryCtx | null = null,
  ): void => {
    let final = emptyApply;
    const inverseAcc: Op[] = [];
    const source = txn.meta?.source;

    batch(() => {
      if (source === "remote") {
        final = mergeApply(final, applyRemotePipeline(txn, inverseAcc));
      } else {
        final = mergeApply(
          final,
          applyUserPipeline(txn, inverseAcc, userHistoryCtx),
        );
      }

      opts.clearCachesForRemovedEntries(final.removed);
    });
  };

  let localSeq = 0;

  const stampLocalMeta = (
    meta: TransactionMeta | undefined,
  ): TransactionMeta => {
    const base = meta ?? {};
    const origin = opts.collab?.origin;
    const seq = origin ? ++localSeq : undefined;
    return {
      ...base,
      ...(origin ? { origin } : {}),
      ...(seq != null ? { seq } : {}),
    };
  };

  const sendLocalTxn = (txn: Transaction): void => {
    if (!opts.collab) return;
    opts.collab.send(txn);
  };

  const applyLocal = (
    txn: Transaction,
    userHistoryCtx: UserCommitHistoryCtx | null = null,
  ): void => {
    const model = currentModel;
    const stamped = model.ops.transaction(txn.ops, stampLocalMeta(txn.meta));
    applyPipeline(stamped, userHistoryCtx);
    sendLocalTxn(stamped);
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
    applyPipeline(model.ops.transaction(txn.ops, meta));
  };

  const buildTx = (
    ops: Op[],
    pendingCreated: Set<EntryId>,
    requireTxEntryId: (id: ItemId, opName: string) => EntryId,
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

      const model = currentModel;
      const id = model.createId();
      const entry: Entry = makeBlankEntry(id);
      pendingCreated.add(id);

      ops.push(model.ops.create(entry));
      ops.push(
        model.ops.move({
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

  const commit = (run: (t: Tx) => void): void => {
    const userHistoryCtx: UserCommitHistoryCtx = {
      selection: opts.getSelection(),
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

    const t = buildTx(ops, pendingCreated, requireTxEntryId);

    run(t);
    if (!ops.length) return;

    const txn = currentModel.ops.transaction(ops, { source: "user" });
    applyLocal(txn, userHistoryCtx);
  };

  const undo = (): void => {
    const last = history.undo.pop() ?? null;
    if (!last) return;
    applyLocal(last.inverse);
    history.redo.push(last);
  };

  const redo = (): void => {
    const last = history.redo.pop() ?? null;
    if (!last) return;

    const replay = currentModel.ops.transaction(last.user.ops, {
      source: "redo",
    });
    applyLocal(replay);
    history.undo.push(last);
  };

  const undoBoundary = (): void => {
    const last = history.undo.at(-1);
    if (last) last.groupKey = null;
  };

  const resetState = (): void => {
    history.undo = [];
    history.redo = [];
  };

  return { commit, undo, redo, undoBoundary, applyRemote, resetState };
}
