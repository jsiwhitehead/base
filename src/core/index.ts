import type { ReadonlySignal } from "@preact/signals-core";
import { batch, computed, signal } from "@preact/signals-core";

import type { Result } from "./eval";
import {
  Results,
  createEvaluator,
  isBlankResult,
  isEntryGroupResult,
  isIssueResult,
  isResultGroupResult,
  isScalarResult,
} from "./eval";
import { interpretExpr } from "./lang";
import type {
  Entry,
  EntryContent,
  EntryId,
  ModelApplyResult,
  Op,
  Transaction,
  TransactionMeta,
  ViewName,
} from "./model";
import {
  createModel,
  isFormulaContent,
  isGroupContent,
  isQueryContent,
  makeBlankEntry,
  makeGroupEntry,
} from "./model";
import type { ViewConstraint } from "./sync";
import { contentSatisfiesConstraint, enforceViewConstraints } from "./sync";

export type ItemId = string;

type Focus = { container: ItemId; item: ItemId };
type Caret = { start: number; end: number };

type Selection =
  | { type: "idle" }
  | { type: "focused"; focus: Focus; target: string; caret?: Caret };

type NavDir = "left" | "right" | "up" | "down" | "out";

type Intent =
  | {
      type: "NAV";
      dir: NavDir;
      mode: "step" | "jump";
    }
  | { type: "CONFIRM"; caret?: Caret }
  | { type: "TAB"; shift: boolean; caret?: Caret }
  | { type: "TYPE"; char: string }
  | { type: "DELETE"; dir: "backward" | "forward" };

type KeyIntentInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

const DEFAULT_TARGET = "default" as const;
const LABEL_TARGET = "label" as const;
const VALUE_TARGET = "value" as const;
const connTarget: (key: string) => string = (key) => `conn:${key}`;

function parseKeyIntent(input: KeyIntentInput): Intent | null {
  if (input.key === "Escape") {
    return {
      type: "NAV",
      dir: "out",
      mode: input.metaKey || input.ctrlKey ? "jump" : "step",
    };
  }
  if (input.key === "Tab") return { type: "TAB", shift: !!input.shiftKey };
  if (input.key === "Enter") return { type: "CONFIRM" };

  if (input.key === "Backspace") return { type: "DELETE", dir: "backward" };
  if (input.key === "Delete") return { type: "DELETE", dir: "forward" };

  let dir: "left" | "right" | "up" | "down" | null = null;
  switch (input.key) {
    case "ArrowLeft":
      dir = "left";
      break;
    case "ArrowRight":
      dir = "right";
      break;
    case "ArrowUp":
      dir = "up";
      break;
    case "ArrowDown":
      dir = "down";
      break;
  }
  if (dir) {
    return {
      type: "NAV",
      dir,
      mode: input.metaKey || input.ctrlKey ? "jump" : "step",
    };
  }

  if (
    !(input.ctrlKey || input.metaKey || input.altKey) &&
    input.key.length === 1
  ) {
    return { type: "TYPE", char: input.key };
  }

  return null;
}

export type Value = true | number | string;
export type ValueOrBlank = Value | null;

export type Content =
  | { type: "value"; value: ValueOrBlank }
  | { type: "issue"; message: string }
  | { type: "group"; children: readonly ItemId[] };

export type Connected =
  | { type: "formula"; expr: string }
  | { type: "query"; from: string; where: string; orderBy: string };

type Mode =
  | { type: "readonly" }
  | { type: "plain" }
  | { type: "connected"; conn: Connected };

type Item = {
  id: ItemId;
  label?: string;
  content: Content;
  mode: Mode;
};

type ItemRef = { entryId: EntryId; path: readonly number[] };
type RepairAnchorStep = { parentId: EntryId; index: number };
type RepairAnchor = { steps: readonly RepairAnchorStep[] };
type TextHistoryGroupKey = {
  kind: "text";
  itemId: ItemId;
  target: string;
};
type UndoHistoryEntry = {
  user: Transaction;
  inverse: Transaction;
  groupedAt: number;
  groupKey: TextHistoryGroupKey | null;
};
type UserCommitHistoryCtx = {
  selection: Selection;
  startedAt: number;
};

const TEXT_HISTORY_COALESCE_MS = 1000;

const itemIdOf = (entryId: EntryId, path: readonly number[] = []): ItemId =>
  `${String(entryId)}:${path.length ? path.join(",") : ""}`;

const parseItemId = (id: ItemId): ItemRef | null => {
  const i = id.indexOf(":");
  if (i === -1) return null;

  const head = id.slice(0, i);
  const entryId = Number(head);
  if (!Number.isFinite(entryId)) return null;

  const rest = id.slice(i + 1);
  if (!rest.trim()) return { entryId: entryId as EntryId, path: [] };

  const parts = rest.split(",");
  const path: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    path.push(n);
  }

  return { entryId: entryId as EntryId, path };
};

const refFromItemId = (id: ItemId): ItemRef => {
  const ref = parseItemId(id);
  if (!ref) throw new Error("Invalid item id");
  return ref;
};

const entryIdFromItemId = (id: ItemId): EntryId | null => {
  const ref = parseItemId(id);
  return ref && ref.path.length === 0 ? ref.entryId : null;
};

function assertNever(_exhaustive: never, message: string): never {
  throw new Error(message);
}

const NUMERIC_VALUE_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function storedFromValue(v: ValueOrBlank): EntryContent {
  return v === null ? { type: "blank" } : { type: "scalar", value: v };
}

export function isNumericLikeValue(value: ValueOrBlank): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return false;
  if (!NUMERIC_VALUE_RE.test(t)) return false;
  return Number.isFinite(Number(t));
}

function modeFromContent(ref: ItemRef, c: EntryContent): Mode {
  if (ref.path.length) return { type: "readonly" };
  if (isFormulaContent(c))
    return { type: "connected", conn: { type: "formula", expr: c.expr } };
  if (isQueryContent(c))
    return {
      type: "connected",
      conn: {
        type: "query",
        from: c.from,
        where: c.where,
        orderBy: c.orderBy,
      },
    };
  return { type: "plain" };
}

export type ApplyResult = {
  readonly created: readonly ItemId[];
  readonly touched: readonly ItemId[];
  readonly moved: readonly {
    readonly fromParentId: ItemId | null;
    readonly toParentId: ItemId | null;
    readonly fromIndex: number | null;
    readonly toIndex: number | null;
  }[];
};

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

type FocusOpts = { caret?: Caret };

type LocateResult = {
  parentId: ItemId;
  index: number;
  siblings: readonly ItemId[];
};

export type Core = {
  dispose(): void;

  item(id: ItemId): Item;

  view(id: ItemId): ViewName;

  commit(run: (t: Tx) => void): ApplyResult;

  undo(): ApplyResult;
  redo(): ApplyResult;

  selection(): Selection;
  focus(focus: Focus, target?: string, opts?: FocusOpts): void;
  blur(): void;

  locate(id: ItemId): LocateResult | null;

  dispatch(intent: Intent): void;
};

type ConnField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

export function fieldsFromConn(conn: Connected): ConnField[] {
  if (conn.type === "formula") {
    return [
      { key: "expr", label: "=", multiline: false, text: conn.expr ?? "" },
    ];
  }
  return [
    { key: "from", label: "~", multiline: false, text: conn.from ?? "" },
    { key: "where", label: "where:", multiline: false, text: conn.where ?? "" },
    {
      key: "orderBy",
      label: "orderBy:",
      multiline: false,
      text: conn.orderBy ?? "",
    },
  ];
}

export function editTargetsForItem(core: Core, id: ItemId): string[] {
  const snapshot = core.item(id);
  if (snapshot.mode.type === "connected") {
    return fieldsFromConn(snapshot.mode.conn).map((field) =>
      connTarget(field.key),
    );
  }
  if (snapshot.mode.type === "plain" && snapshot.content.type === "value")
    return [VALUE_TARGET];
  return [];
}

export function primaryEditTarget(core: Core, id: ItemId): string | null {
  return editTargetsForItem(core, id)[0] ?? null;
}

export function getTextForTarget(
  core: Core,
  id: ItemId,
  target: string,
): string {
  const snapshot = core.item(id);
  if (target === VALUE_TARGET) {
    return snapshot.content.type === "value"
      ? String(snapshot.content.value ?? "")
      : "";
  }
  if (target === LABEL_TARGET) return snapshot.label ?? "";
  if (!target.startsWith("conn:") || snapshot.mode.type !== "connected")
    return "";
  const key = target.slice("conn:".length);
  return (
    fieldsFromConn(snapshot.mode.conn).find((field) => field.key === key)
      ?.text ?? ""
  );
}

type CollabWire = {
  origin: string;
  send(txn: Transaction): void;
  subscribe(onTxn: (txn: Transaction) => void): () => void;
};

type CorePlatformHooks = {
  onSelectionChange?: (selection: Selection) => void;
  getActiveViewIntentHandler?: () => ((intent: Intent) => void) | null;
  typeCharAtFocusedTarget?: (text: string) => void;
};

export type { CorePlatformHooks };

export function createCore(opts: {
  constraints?: Partial<Record<ViewName, ViewConstraint>>;
  collab?: CollabWire;
  platform?: CorePlatformHooks;
}): {
  core: Core;
  rootId: ItemId;
} {
  const constraints = opts.constraints ?? {};

  const model = createModel();

  const rootEntryId = model.createId();
  model.setRoot(rootEntryId);
  model.apply(
    model.ops.transaction([model.ops.create(makeGroupEntry(rootEntryId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const rootId = itemIdOf(rootEntryId);
  const selectionSignal = signal<Selection>({
    type: "focused",
    focus: { container: rootId, item: rootId },
    target: DEFAULT_TARGET,
  });

  const getActiveViewIntentHandler = (): ((intent: Intent) => void) | null =>
    opts.platform?.getActiveViewIntentHandler?.() ?? null;

  const emitSelectionChange = (sel: Selection): void => {
    opts.platform?.onSelectionChange?.(sel);
  };

  const isValidFocusedSelection = (
    sel: Extract<Selection, { type: "focused" }>,
  ): boolean => {
    const itemEid = entryIdFromItemId(sel.focus.item);
    const containerEid = entryIdFromItemId(sel.focus.container);
    if (itemEid == null || containerEid == null) return false;
    if (!model.hasEntry(itemEid) || !model.hasEntry(containerEid)) return false;
    if (itemEid === containerEid) return true;

    const loc = model.locateInParent(itemEid);
    return !!loc && loc.parentId === containerEid;
  };

  const setSelection = (next: Selection): void => {
    const repairToRoot = (): Selection => {
      if (!model.hasEntry(rootEntryId)) return { type: "idle" };
      return {
        type: "focused",
        focus: { container: rootId, item: rootId },
        target: DEFAULT_TARGET,
      };
    };

    if (next.type === "idle") {
      selectionSignal.value = next;
      emitSelectionChange(next);
      return;
    }

    const repaired = isValidFocusedSelection(next) ? next : repairToRoot();
    selectionSignal.value = repaired;
    emitSelectionChange(repaired);
  };

  const history: {
    undo: UndoHistoryEntry[];
    redo: UndoHistoryEntry[];
  } = {
    undo: [],
    redo: [],
  };

  const emptyModelApply: ModelApplyResult = {
    created: [],
    touched: [],
    moved: [],
  };

  const mergeModelApply = (
    a: ModelApplyResult,
    b: ModelApplyResult,
  ): ModelApplyResult => ({
    created: [...a.created, ...b.created],
    touched: Array.from(new Set([...a.touched, ...b.touched])),
    moved: [...a.moved, ...b.moved],
  });

  const toApplyResult = (modelApply: ModelApplyResult): ApplyResult => {
    const toItem = (eid: EntryId) => itemIdOf(eid);
    return {
      created: modelApply.created.map(toItem),
      touched: modelApply.touched.map(toItem),
      moved: modelApply.moved.map((x) => ({
        fromParentId: x.fromParentId == null ? null : toItem(x.fromParentId),
        toParentId: x.toParentId == null ? null : toItem(x.toParentId),
        fromIndex: x.fromIndex,
        toIndex: x.toIndex,
      })),
    };
  };

  const selectionStillValid = (sel: Selection): boolean => {
    if (sel.type === "idle") return true;
    return isValidFocusedSelection(sel);
  };

  const captureRepairAnchor = (): RepairAnchor | null => {
    const sel = selectionSignal.peek();
    if (sel.type !== "focused") return null;

    const leafId =
      entryIdFromItemId(sel.focus.item) ??
      entryIdFromItemId(sel.focus.container);
    if (leafId == null) return null;

    const steps: RepairAnchorStep[] = [];
    let cur = leafId;
    while (true) {
      const loc = model.locateInParent(cur);
      if (!loc) break;
      steps.push({ parentId: loc.parentId, index: loc.index });
      cur = loc.parentId;
    }

    return { steps };
  };

  const resolveRepairAnchor = (anchor: RepairAnchor): Focus | null => {
    for (let i = anchor.steps.length - 1; i >= 0; i--) {
      const { parentId, index } = anchor.steps[i]!;
      if (!model.hasEntry(parentId)) continue;

      const siblings = model.childIdsOf(parentId);
      if (!siblings.length) continue;

      const childId = siblings[index] ?? siblings[index - 1] ?? null;
      if (childId == null || !model.hasEntry(childId)) continue;

      const id = itemIdOf(childId);
      return { container: id, item: id };
    }

    return null;
  };

  const repairSelectionAfterLocalApply = (
    anchor: RepairAnchor | null,
  ): void => {
    const selNow = selectionSignal.peek();
    if (selectionStillValid(selNow)) {
      setSelection(selNow);
      return;
    }

    if (anchor) {
      const focus = resolveRepairAnchor(anchor);
      if (focus) {
        setSelection({
          type: "focused",
          focus,
          target: DEFAULT_TARGET,
        });
        return;
      }
    }

    setSelection(selNow);
  };

  const childrenOfResolved = (
    base: ItemRef,
    result: Result,
  ): readonly ItemId[] => {
    if (isEntryGroupResult(result))
      return result.entryIds.map((entryId) => itemIdOf(entryId, []));
    if (isResultGroupResult(result))
      return result.items.map((_item, i) =>
        itemIdOf(base.entryId, [...base.path, i]),
      );
    return [];
  };

  const resolve = (ref: ItemRef): { result: Result; label?: string } => {
    let cur: Result = evaluator.result(ref.entryId);
    let label: string | undefined =
      model.readEntry(ref.entryId).label.trim() || undefined;

    for (let i = 0; i < ref.path.length; i++) {
      const idx = ref.path[i]!;
      if (!isResultGroupResult(cur))
        return { result: Results.issue("Invalid path") };
      const item = cur.items[idx];
      if (!item) return { result: Results.issue("Invalid path") };
      label = item.label?.trim() || undefined;
      cur = item.result;
    }

    return { result: cur, ...(label ? { label } : {}) };
  };

  const toContent = (ref: ItemRef, result: Result): Content => {
    if (isBlankResult(result)) return { type: "value", value: null };
    if (isIssueResult(result))
      return { type: "issue", message: result.message };
    if (isScalarResult(result)) {
      const scalar = result.result;
      return {
        type: "value",
        value:
          scalar === true ||
          typeof scalar === "number" ||
          typeof scalar === "string"
            ? scalar
            : null,
      };
    }
    return { type: "group", children: childrenOfResolved(ref, result) };
  };

  const item = (id: ItemId): Item => {
    try {
      const ref = refFromItemId(id);
      const resolved = resolve(ref);
      const content = toContent(ref, resolved.result);

      let mode: Mode = { type: "readonly" };
      if (!ref.path.length) {
        const stored = model.readEntry(ref.entryId).content;
        mode = modeFromContent(ref, stored);
      }

      return {
        id,
        ...(resolved.label ? { label: resolved.label } : {}),
        content,
        mode,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        id,
        content: { type: "issue", message: msg },
        mode: { type: "readonly" },
      };
    }
  };

  const viewSignalCache = new Map<EntryId, ReadonlySignal<ViewName>>();

  const view = (id: ItemId): ViewName => {
    const eid = entryIdFromItemId(id);
    if (eid == null) return "outline";

    let sig = viewSignalCache.get(eid);
    if (!sig) {
      sig = computed(() => {
        if (!model.hasEntry(eid)) return "outline";

        const vk = model.entrySignal(eid).value.view;
        const wanted = vk ?? "outline";
        if (wanted === "outline") return "outline";

        const content = item(itemIdOf(eid)).content;
        const isGroup = content.type === "group";

        return contentSatisfiesConstraint(
          { isGroup, childCount: isGroup ? content.children.length : 0 },
          constraints[wanted],
        )
          ? wanted
          : "outline";
      });
      viewSignalCache.set(eid, sig);
    }

    return sig.value;
  };

  const captureInverseForTxn = (txn: Transaction): Op[] => {
    const inverses: Op[] = [];

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
        const parentId = child.parentId ?? null;
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
        if (id0 === rootEntryId) {
          const prev = { label: cur.label, view: cur.view };

          if (isGroupContent(cur.content)) {
            const childIds = cur.content.childIds.filter((cid) =>
              model.hasEntry(cid),
            );
            inverses.push(
              model.ops.patch(id0, {
                ...prev,
                content: { type: "group", childIds: [] },
              }),
            );
            for (let i = 0; i < childIds.length; i++) {
              inverses.push(
                model.ops.move({
                  childId: childIds[i]!,
                  toParentId: id0,
                  toIndex: i,
                }),
              );
            }
          } else {
            inverses.push(
              model.ops.patch(id0, {
                ...prev,
                content: cur.content,
              }),
            );
          }
          continue;
        }

        const parentId = cur.parentId ?? null;
        const loc = model.locateInParent(id0);
        const prevIndex = loc?.index ?? undefined;

        if (isGroupContent(cur.content)) {
          const childIds = [...cur.content.childIds].filter((cid) =>
            model.hasEntry(cid),
          );

          for (let i = childIds.length - 1; i >= 0; i--) {
            inverses.push(
              model.ops.move({
                childId: childIds[i]!,
                toParentId: id0,
                toIndex: i,
              }),
            );
          }

          inverses.push(
            model.ops.move({
              childId: id0,
              toParentId: parentId,
              ...(prevIndex != null ? { toIndex: prevIndex } : {}),
            }),
          );

          inverses.push(
            model.ops.create({
              ...cur,
              parentId: null,
              content: { type: "group", childIds: [] },
            }),
          );
        } else {
          inverses.push(
            model.ops.move({
              childId: id0,
              toParentId: parentId,
              ...(prevIndex != null ? { toIndex: prevIndex } : {}),
            }),
          );
          inverses.push(model.ops.create({ ...cur, parentId: null }));
        }

        continue;
      }

      assertNever(op, "Unhandled op");
    }

    return inverses;
  };

  const applyTxnWithInverse = (
    txn: Transaction,
  ): { result: ModelApplyResult; inverseOps: Op[] } => {
    const inverseOps = captureInverseForTxn(txn);
    const result = model.apply(txn);
    return { result, inverseOps };
  };

  const applyConstraintOps = (
    touchedIds: readonly EntryId[],
    inverseAcc: Op[],
  ): ModelApplyResult => {
    let merged = emptyModelApply;

    enforceViewConstraints(model, constraints, touchedIds, (ops) => {
      const txn = model.ops.transaction(ops, { source: "rule" });
      const { result, inverseOps } = applyTxnWithInverse(txn);
      inverseAcc.push(...inverseOps);
      merged = mergeModelApply(merged, result);
    });

    return merged;
  };

  const classifyTextHistoryGroup = (
    txn: Transaction,
    sel: Selection,
  ): TextHistoryGroupKey | null => {
    if (sel.type !== "focused") return null;
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

    const focusedEntryId = entryIdFromItemId(sel.focus.item);
    if (focusedEntryId == null || focusedEntryId !== op.id) return null;

    return { kind: "text", itemId: sel.focus.item, target: sel.target };
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
  ): ModelApplyResult => {
    let merged = emptyModelApply;

    const modelApply = model.apply(txn);
    merged = mergeModelApply(merged, modelApply);

    const constraintApply = applyConstraintOps(modelApply.touched, inverseAcc);
    merged = mergeModelApply(merged, constraintApply);

    const selection = selectionSignal.peek();
    if (!selectionStillValid(selection)) setSelection({ type: "idle" });

    return merged;
  };

  const applyUserPipeline = (
    txn: Transaction,
    inverseAcc: Op[],
    userHistoryCtx: UserCommitHistoryCtx | null = null,
  ): ModelApplyResult => {
    let merged = emptyModelApply;
    const anchor = captureRepairAnchor();
    const isUser = txn.meta?.source === "user";

    const { result: userApply, inverseOps } = applyTxnWithInverse(txn);
    inverseAcc.push(...inverseOps);
    merged = mergeModelApply(merged, userApply);

    const constraintApply = applyConstraintOps(userApply.touched, inverseAcc);
    merged = mergeModelApply(merged, constraintApply);

    repairSelectionAfterLocalApply(anchor);

    if (isUser) {
      const inverse = model.ops.transaction(inverseAcc.toReversed(), {
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
  ): ApplyResult => {
    let final = emptyModelApply;
    const inverseAcc: Op[] = [];
    const source = txn.meta?.source;

    batch(() => {
      const isRemote = source === "remote";

      if (isRemote) {
        final = mergeModelApply(final, applyRemotePipeline(txn, inverseAcc));
        return;
      }

      final = mergeModelApply(
        final,
        applyUserPipeline(txn, inverseAcc, userHistoryCtx),
      );
    });

    return toApplyResult(final);
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
  ): ApplyResult => {
    const stamped = model.ops.transaction(txn.ops, stampLocalMeta(txn.meta));
    const applyResult = applyPipeline(stamped, userHistoryCtx);
    sendLocalTxn(stamped);
    return applyResult;
  };

  const applyRemote = (txn: Transaction): ApplyResult => {
    if (
      opts.collab &&
      txn.meta?.origin &&
      txn.meta.origin === opts.collab.origin
    )
      return toApplyResult(emptyModelApply);
    const meta = { ...(txn.meta ?? {}), source: "remote" as const };
    return applyPipeline(model.ops.transaction(txn.ops, meta));
  };

  const commit = (run: (t: Tx) => void): ApplyResult => {
    const userHistoryCtx: UserCommitHistoryCtx = {
      selection: selectionSignal.peek(),
      startedAt: Date.now(),
    };
    const ops: Op[] = [];
    const pendingCreated = new Set<EntryId>();

    const requireTxEntryId = (id: ItemId, opName: string): EntryId => {
      const ref = parseItemId(id);
      if (!ref) throw new Error(`${opName} expects a valid item id`);

      const { entryId, path } = ref;
      if (path.length !== 0)
        throw new Error(`${opName} does not accept readonly/derived item ids`);
      if (!model.hasEntry(entryId) && !pendingCreated.has(entryId)) {
        throw new Error(`${opName} expects an existing item id`);
      }

      return entryId;
    };

    const t: Tx = {
      setLabel: (id, label) => {
        const eid = requireTxEntryId(id, "setLabel");
        ops.push(model.ops.patch(eid, { label }));
      },

      setView: (id, view) => {
        const eid = requireTxEntryId(id, "setView");
        ops.push(model.ops.patch(eid, { view }));
      },

      setValue: (id, value) => {
        const eid = requireTxEntryId(id, "setValue");
        ops.push(model.ops.patch(eid, { content: storedFromValue(value) }));
      },

      setConnected: (id, conn) => {
        const eid = requireTxEntryId(id, "setConnected");

        if (conn.type === "formula") {
          ops.push(
            model.ops.patch(eid, {
              content: { type: "formula", expr: conn.expr },
            }),
          );
          return;
        }

        ops.push(
          model.ops.patch(eid, {
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
          model.ops.patch(eid, { content: { type: "group", childIds: [] } }),
        );
      },

      insertChild: (parentId, insertOpts) => {
        const parentEid = requireTxEntryId(parentId, "insertChild");

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
          model.ops.move({
            childId: childEid,
            toParentId: toParentEid,
            ...(moveOpts?.at != null ? { toIndex: moveOpts.at } : {}),
          }),
        );
      },

      remove: (id) => {
        const eid = requireTxEntryId(id, "remove");
        ops.push(model.ops.remove(eid));
      },
    };

    run(t);
    if (!ops.length) return toApplyResult(emptyModelApply);

    const txn = model.ops.transaction(ops, { source: "user" });
    return applyLocal(txn, userHistoryCtx);
  };

  const undo = (): ApplyResult => {
    const last = history.undo.pop() ?? null;
    if (!last) return toApplyResult(emptyModelApply);
    const applyResult = applyLocal(last.inverse);
    history.redo.push(last);
    return applyResult;
  };

  const redo = (): ApplyResult => {
    const last = history.redo.pop() ?? null;
    if (!last) return toApplyResult(emptyModelApply);

    const replay = model.ops.transaction(last.user.ops, { source: "redo" });
    const applyResult = applyLocal(replay);
    history.undo.push(last);

    return applyResult;
  };

  const focus = (
    nextFocus: Focus,
    target: string = DEFAULT_TARGET,
    focusOpts: FocusOpts = {},
  ) => {
    const shouldApplyCaret = target !== DEFAULT_TARGET && !!focusOpts.caret;
    setSelection({
      type: "focused",
      focus: nextFocus,
      target,
      ...(shouldApplyCaret ? { caret: focusOpts.caret } : {}),
    });
  };

  const blur = (): void => {
    setSelection({ type: "idle" });
  };

  const selection = (): Selection => selectionSignal.value;

  const locate = (id: ItemId): LocateResult | null => {
    const ref = parseItemId(id);
    if (!ref || ref.path.length) return null;

    const loc = model.locateInParent(ref.entryId);
    if (!loc) return null;

    return {
      parentId: itemIdOf(loc.parentId),
      index: loc.index,
      siblings: loc.childIds.map((eid) => itemIdOf(eid)),
    };
  };

  const unsubscribeCollab = opts.collab
    ? opts.collab.subscribe((txn) => {
        applyRemote(txn);
      })
    : null;

  const wrapRootIntoChild = (): ItemId | null => {
    const rootItem = item(rootId);
    const rootView = view(rootId);
    const rootChildren =
      rootItem.content.type === "group" ? [...rootItem.content.children] : [];
    let wrappedId: ItemId = "";

    core.commit((t) => {
      if (rootItem.content.type !== "group") t.setGroup(rootId);

      wrappedId = t.insertChild(rootId, { at: 0 });
      t.setLabel(wrappedId, "");
      t.setView(wrappedId, rootView);

      if (rootItem.mode.type === "connected") {
        t.setConnected(wrappedId, rootItem.mode.conn);
        return;
      }

      if (rootItem.content.type === "value") {
        t.setValue(wrappedId, rootItem.content.value);
        return;
      }

      t.setGroup(wrappedId);
      for (const childId of rootChildren) t.move(childId, wrappedId);
    });

    return wrappedId || null;
  };

  const handleRootIntent = (intent: Intent, sel: Selection): boolean => {
    if (
      sel.type !== "focused" ||
      sel.focus.item !== rootId ||
      sel.focus.container !== rootId
    ) {
      return false;
    }
    const rootItem = item(rootId);

    switch (intent.type) {
      case "NAV": {
        if (sel.target !== DEFAULT_TARGET) return false;
        if (intent.dir === "out") {
          setSelection({ type: "idle" });
          return true;
        }

        if (intent.dir !== "right") return false;
        if (rootItem.content.type !== "group") return false;

        const firstChildId = rootItem.content.children[0];
        if (!firstChildId) return false;

        setSelection({
          type: "focused",
          focus: { container: rootId, item: firstChildId },
          target: DEFAULT_TARGET,
        });
        return true;
      }

      case "TAB": {
        if (intent.shift) return false;

        const wrappedId = wrapRootIntoChild();
        if (wrappedId) {
          const wrappedTargets = editTargetsForItem(core, wrappedId);
          const target =
            sel.target === DEFAULT_TARGET || wrappedTargets.includes(sel.target)
              ? sel.target
              : DEFAULT_TARGET;

          setSelection({
            type: "focused",
            focus: { container: rootId, item: wrappedId },
            target,
          });
        }
        return true;
      }

      case "CONFIRM":
      case "TYPE": {
        if (sel.target !== DEFAULT_TARGET) return false;
        const rootIsEditable = rootItem.mode.type !== "readonly";
        const rootIsEmptyGroup =
          rootItem.content.type === "group" &&
          rootItem.content.children.length === 0;

        let target: string;
        let caret: Caret;

        if (rootIsEditable && rootIsEmptyGroup) {
          core.commit((t) => t.setValue(rootId, ""));
          target = VALUE_TARGET;
          caret =
            intent.type === "CONFIRM"
              ? { start: 0, end: 0 }
              : { start: 0, end: Number.MAX_SAFE_INTEGER };
        } else {
          const t = primaryEditTarget(core, rootId);
          if (!t) {
            if (
              intent.type === "CONFIRM" &&
              rootItem.content.type === "group"
            ) {
              const firstChildId = rootItem.content.children[0];
              if (!firstChildId) return false;

              setSelection({
                type: "focused",
                focus: { container: rootId, item: firstChildId },
                target: DEFAULT_TARGET,
              });
              return true;
            }
            return false;
          }

          target = t;
          if (intent.type === "CONFIRM") {
            const pos = getTextForTarget(core, rootId, target).length;
            caret = { start: pos, end: pos };
          } else {
            caret = { start: 0, end: Number.MAX_SAFE_INTEGER };
          }
        }

        setSelection({
          type: "focused",
          focus: sel.focus,
          target,
          caret,
        });

        if (intent.type === "TYPE") {
          opts.platform?.typeCharAtFocusedTarget?.(intent.char);
        }

        return true;
      }

      default:
        return false;
    }
  };

  const handleNavOut = (sel: Selection): boolean => {
    if (sel.type === "idle") return true;

    if (sel.target !== DEFAULT_TARGET) {
      setSelection({
        type: "focused",
        focus: sel.focus,
        target: DEFAULT_TARGET,
      });
      return true;
    }

    return false;
  };

  const dispatch = (intent: Intent): void => {
    const sel = selectionSignal.peek();

    if (intent.type === "NAV" && intent.dir === "out" && handleNavOut(sel)) {
      return;
    }

    if (handleRootIntent(intent, sel)) return;

    getActiveViewIntentHandler()?.(intent);
  };

  core = {
    dispose() {
      unsubscribeCollab?.();
      const { removedIds } = model.pruneUnreachable();
      evaluator.prune(removedIds);
      evaluator.dispose();
      viewSignalCache.clear();
    },

    item,

    view,

    commit,

    undo,
    redo,

    selection,
    focus,
    blur,

    locate,

    dispatch,
  };

  return { core, rootId };
}

export type {
  Caret,
  Focus,
  Intent,
  KeyIntentInput,
  NavDir,
  Selection,
  Transaction,
  ViewConstraint,
  ViewName,
};

export {
  DEFAULT_TARGET,
  LABEL_TARGET,
  VALUE_TARGET,
  connTarget,
  parseKeyIntent,
};
