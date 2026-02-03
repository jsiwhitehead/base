import { batch } from "@preact/signals-core";
import {
  createModel,
  type ApplyResult as ModelApplyResult,
  type Entry,
  type EntryContent,
  type EntryId,
  type Model,
  type Op,
  type Transaction,
  type ViewKind,
  type ViewName,
  isDerivedContent,
  isLensContent,
  isGroupContent,
  makeBlankEntry,
  makeGroupEntry,
} from "./model";
import {
  createEvaluator,
  type Value,
  isBlankValue,
  isEntryGroupValue,
  isIssueValue,
  isScalarValue,
  isValueGroupValue,
} from "./eval";
import { interpretExpr } from "./lang";
import {
  createRuntime,
  type Caret,
  type Component,
  type DomView,
  type Focus,
  type Selection,
  type TextCaret,
  type ViewFactory,
  DEFAULT_TARGET,
  clamp,
  defaultTextCaret,
  isTextInput,
} from "./runtime";
import { createShapeSyncGroup, type Rule as SyncRule } from "./sync";

export type ItemId = string;

export type Scalar = true | number | string;
export type ScalarOrBlank = Scalar | null;

export type Content =
  | { kind: "scalar"; value: ScalarOrBlank }
  | { kind: "issue"; message: string }
  | { kind: "group"; children: readonly ItemId[] };

export type Source =
  | { type: "derived"; expr: string }
  | { type: "lens"; from: string; where: string; orderBy: string };

export type Mode =
  | { kind: "readonly" }
  | { kind: "direct" }
  | { kind: "source"; source: Source };

export type Item = {
  id: ItemId;
  label?: string;
  content: Content;
  mode: Mode;
};

export type ItemRef = { entryId: EntryId; path: readonly number[] };

export const itemIdOf = (
  entryId: EntryId,
  path: readonly number[] = [],
): ItemId => `${String(entryId)}:${path.length ? path.join(",") : ""}`;

export const parseItemId = (id: ItemId): ItemRef | null => {
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

export const refFromItemId = (id: ItemId): ItemRef => {
  const r = parseItemId(id);
  if (!r) throw new Error("Invalid item id");
  return r;
};

export const isEntryItemId = (id: ItemId): boolean => {
  const r = parseItemId(id);
  return !!r && r.path.length === 0;
};

export const entryIdFromItemId = (id: ItemId): EntryId | null => {
  const r = parseItemId(id);
  return r && r.path.length === 0 ? r.entryId : null;
};

function storedFromScalar(v: ScalarOrBlank): EntryContent {
  return v === null ? { kind: "blank" } : { kind: "scalar", value: v };
}

function modeFromContent(ref: ItemRef, c: EntryContent): Mode {
  if (ref.path.length) return { kind: "readonly" };
  if (isDerivedContent(c))
    return { kind: "source", source: { type: "derived", expr: c.expr } };
  if (isLensContent(c))
    return {
      kind: "source",
      source: {
        type: "lens",
        from: c.from,
        where: c.where,
        orderBy: c.orderBy,
      },
    };
  return { kind: "direct" };
}

export type ApplyResult = {
  readonly created: readonly ItemId[];
  readonly touched: readonly ItemId[];
  readonly reparented: readonly {
    readonly fromOwnerId: ItemId | null;
    readonly toOwnerId: ItemId | null;
    readonly fromIndex: number | null;
    readonly toIndex: number | null;
  }[];
};

export type Tx = {
  setLabel(id: ItemId, label: string): void;
  setView(id: ItemId, view: ViewKind): void;

  setScalar(id: ItemId, value: ScalarOrBlank): void;
  setSource(id: ItemId, source: Source): void;

  insertChild(
    ownerId: ItemId,
    opts?: { at?: number; kind?: "blank" | "group" },
  ): ItemId;

  move(id: ItemId, toOwnerId: ItemId | null, opts?: { at?: number }): void;
  remove(id: ItemId): void;
};

export type LocateResult = {
  ownerId: ItemId;
  index: number;
  siblings: readonly ItemId[];
};

export type Rule = SyncRule;

type HistoryEntry = {
  user: Transaction;
  inverse: Transaction;
};

export type Core = {
  dispose(): void;

  item(id: ItemId): Item;

  commit(run: (t: Tx) => void): ApplyResult;

  dispatch(txn: Transaction): ApplyResult;
  dispatchRemote(txn: Transaction): ApplyResult;

  undo(): ApplyResult;
  redo(): ApplyResult;

  addRule(rule: Rule, opts?: { id?: string }): () => void;

  selection(): Selection;
  focus(focus: Focus, target?: string, opts?: { caret?: Caret }): void;
  blur(): void;

  locate(id: ItemId): LocateResult | null;

  attachFocus(opts: {
    focus: Focus;
    elementFor: (target: string) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  mountView(opts: { id: ItemId; focus?: Focus }): Component;
  mountView(opts: {
    id: ItemId;
    focus?: Focus;
    continueAs: ViewName;
  }): Component | null;
};

export function createCore(opts: {
  views: Partial<Record<ViewName, ViewFactory<Core>>>;
}): { core: Core; rootId: ItemId } {
  const model = createModel();

  const rootEntryId = model.createId();
  model.setRoot(rootEntryId);
  model.apply(
    model.ops.transaction([model.ops.create(makeGroupEntry(rootEntryId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const runtime = createRuntime<Core>({
    model,
    getCore: () => core,
    views: opts.views,
    initialSelection: { kind: "idle" },
  });

  const rules: { id: string; run: Rule }[] = [];
  let nextRuleId = 1;

  const history: { undo: HistoryEntry[]; redo: HistoryEntry[] } = {
    undo: [],
    redo: [],
  };

  const emptyModelApply: ModelApplyResult = {
    created: [],
    touched: [],
    reparented: [],
  };

  const mergeModelApply = (
    a: ModelApplyResult,
    b: ModelApplyResult,
  ): ModelApplyResult => ({
    created: [...a.created, ...b.created],
    touched: Array.from(new Set([...a.touched, ...b.touched])),
    reparented: [...a.reparented, ...b.reparented],
  });

  const toApplyResult = (r: ModelApplyResult): ApplyResult => {
    const toItem = (eid: EntryId) => itemIdOf(eid);
    return {
      created: r.created.map(toItem),
      touched: r.touched.map(toItem),
      reparented: r.reparented.map((x) => ({
        fromOwnerId: x.fromOwnerId == null ? null : toItem(x.fromOwnerId),
        toOwnerId: x.toOwnerId == null ? null : toItem(x.toOwnerId),
        fromIndex: x.fromIndex,
        toIndex: x.toIndex,
      })),
    };
  };

  const selectionStillValid = (sel: Selection): boolean => {
    if (sel.kind === "idle") return true;
    const a = entryIdFromItemId(sel.focus.item);
    const b = entryIdFromItemId(sel.focus.container);
    if (a == null || b == null) return false;
    return model.hasEntry(a) && model.hasEntry(b);
  };

  const repairSelectionAfterDispatch = (meta?: Transaction["meta"]) => {
    const src = meta?.source;
    if (src === "remote") {
      const sel = runtime.selectionSignal.peek();
      if (!selectionStillValid(sel)) runtime.setSelection({ kind: "idle" });
      return;
    }
    runtime.setSelection(runtime.selectionSignal.peek());
  };

  const childrenOfResolved = (base: ItemRef, v: Value): readonly ItemId[] => {
    if (isEntryGroupValue(v)) return v.entryIds.map((eid) => itemIdOf(eid, []));
    if (isValueGroupValue(v))
      return v.items.map((_it, i) => itemIdOf(base.entryId, [...base.path, i]));
    return [];
  };

  const resolve = (ref: ItemRef): { value: Value; label?: string } => {
    let cur: Value = evaluator.value(ref.entryId);
    let label: string | undefined =
      model.readEntry(ref.entryId).label.trim() || undefined;

    for (let i = 0; i < ref.path.length; i++) {
      const idx = ref.path[i]!;
      if (!isValueGroupValue(cur))
        return { value: { kind: "issue", message: "Invalid path" } as any };
      const it = cur.items[idx];
      if (!it)
        return { value: { kind: "issue", message: "Invalid path" } as any };
      label = it.label?.trim() || undefined;
      cur = it.value;
    }

    return { value: cur, ...(label ? { label } : {}) };
  };

  const toContent = (ref: ItemRef, v: Value): Content => {
    if (isBlankValue(v)) return { kind: "scalar", value: null };
    if (isIssueValue(v)) return { kind: "issue", message: v.message };
    if (isScalarValue(v)) {
      const x = v.value;
      return {
        kind: "scalar",
        value:
          x === true || typeof x === "number" || typeof x === "string"
            ? x
            : null,
      };
    }
    return { kind: "group", children: childrenOfResolved(ref, v) };
  };

  const item = (id: ItemId): Item => {
    try {
      const ref = refFromItemId(id);
      const r = resolve(ref);
      const c = toContent(ref, r.value);

      let mode: Mode = { kind: "readonly" };
      if (!ref.path.length) {
        const stored = model.readEntry(ref.entryId).content;
        mode = modeFromContent(ref, stored);
      }

      return {
        id,
        ...(r.label ? { label: r.label } : {}),
        content: c,
        mode,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        id,
        content: { kind: "issue", message: msg },
        mode: { kind: "readonly" },
      };
    }
  };

  const ensureEntryId = (id: ItemId): EntryId | null => {
    const r = parseItemId(id);
    if (!r || r.path.length) return null;
    return r.entryId;
  };

  const captureInverseForTxn = (txn: Transaction): Op[] => {
    const inverses: Op[] = [];

    for (const op of txn.ops) {
      if (op.kind === "create") {
        inverses.push(model.ops.remove(op.entry.id));
        continue;
      }

      if (op.kind === "patch") {
        if (!model.hasEntry(op.id)) continue;
        const cur = model.peekEntry(op.id);
        const next: any = {};
        if (op.next.label !== undefined) next.label = cur.label;
        if (op.next.view !== undefined) next.view = cur.view;
        if (op.next.content !== undefined) next.content = cur.content;
        inverses.push(model.ops.patch(op.id, next));
        continue;
      }

      if (op.kind === "reparent") {
        const childId = op.spec.childId;
        if (!model.hasEntry(childId)) continue;
        const child = model.peekEntry(childId);
        const ownerId = child.ownerId ?? null;
        const loc = model.locateInOwner(childId);
        inverses.push(
          model.ops.reparent({
            childId,
            toOwnerId: ownerId,
            ...(loc ? { toIndex: loc.index } : {}),
          }),
        );
        continue;
      }

      if (op.kind === "remove") {
        const id = op.id;
        if (!model.hasEntry(id)) continue;

        const cur = model.peekEntry(id);
        const ownerId = cur.ownerId ?? null;
        const loc = model.locateInOwner(id);
        const prevIndex = loc?.index ?? undefined;

        if (isGroupContent(cur.content)) {
          const childIds = [...cur.content.childIds].filter((cid) =>
            model.hasEntry(cid),
          );

          inverses.push(model.ops.create(cur));

          for (let i = 0; i < childIds.length; i++) {
            inverses.push(
              model.ops.reparent({
                childId: childIds[i]!,
                toOwnerId: id,
                toIndex: i,
              }),
            );
          }

          inverses.push(
            model.ops.reparent({
              childId: id,
              toOwnerId: ownerId,
              ...(prevIndex != null ? { toIndex: prevIndex } : {}),
            }),
          );
        } else {
          inverses.push(model.ops.create(cur));
          inverses.push(
            model.ops.reparent({
              childId: id,
              toOwnerId: ownerId,
              ...(prevIndex != null ? { toIndex: prevIndex } : {}),
            }),
          );
        }

        continue;
      }

      const never: never = op;
      throw new Error(`Unknown op: ${String((never as any).kind)}`);
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

  const MAX_RULE_PASSES = 25;

  const runRulesFixpoint = (
    seed: ModelApplyResult,
    inverseAcc: Op[],
  ): ModelApplyResult => {
    let merged = emptyModelApply;
    let input = seed;

    for (let pass = 0; pass < MAX_RULE_PASSES; pass++) {
      let opsOut: Op[] = [];
      for (const r of rules) {
        const ops0 = r.run(model, input, { source: "rule" });
        if (ops0.length) opsOut = opsOut.concat(ops0);
      }
      if (!opsOut.length) break;

      const txn = model.ops.transaction(opsOut, { source: "rule" });
      const { result, inverseOps } = applyTxnWithInverse(txn);
      inverseAcc.push(...inverseOps);
      merged = mergeModelApply(merged, result);
      input = result;
    }

    return merged;
  };

  const shapeSync = createShapeSyncGroup({
    model,
    addRule: (ruleFn) =>
      addRule(ruleFn, { id: "sync:shape" }) as unknown as () => void,
  });

  const tableRowSync = (() => {
    const rows = new Set<EntryId>();

    const clearDead = () => {
      for (const id of rows) {
        if (!model.hasEntry(id)) {
          rows.delete(id);
          shapeSync.remove(id);
        }
      }
    };

    const addRow = (id: EntryId) => {
      if (rows.has(id)) return;
      rows.add(id);
      shapeSync.add(id);
    };

    const removeRow = (id: EntryId) => {
      if (!rows.has(id)) return;
      rows.delete(id);
      shapeSync.remove(id);
    };

    const setRows = (desired: Set<EntryId>) => {
      for (const id of rows) {
        if (!desired.has(id)) removeRow(id);
      }
      for (const id of desired) addRow(id);
    };

    return { clearDead, setRows };
  })();

  const findTablesAndRows = (): {
    tableIds: EntryId[];
    rowIds: Set<EntryId>;
  } => {
    const tableIds: EntryId[] = [];
    const rowIds = new Set<EntryId>();

    const stack: EntryId[] = [model.rootId()];
    const seen = new Set<EntryId>();

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!model.hasEntry(id)) continue;

      const it = model.peekEntry(id);
      const isTable = it.view === "table";
      if (isTable) tableIds.push(id);

      if (isGroupContent(it.content)) {
        for (const cid of it.content.childIds) {
          if (isTable) rowIds.add(cid);
          stack.push(cid);
        }
      }
    }

    return { tableIds, rowIds };
  };

  const reconcileTablesOps = (): Op[] => {
    const { tableIds, rowIds } = findTablesAndRows();
    const opsOut: Op[] = [];

    for (const tableId of tableIds) {
      if (!model.hasEntry(tableId)) continue;
      const t = model.peekEntry(tableId);

      if (!isGroupContent(t.content)) {
        opsOut.push(
          model.ops.patch(tableId, {
            content: { kind: "group", childIds: [] },
          }),
        );
        continue;
      }

      for (const rid of t.content.childIds) {
        if (!model.hasEntry(rid)) continue;
        const row = model.peekEntry(rid);
        if (!isGroupContent(row.content)) {
          opsOut.push(
            model.ops.patch(rid, {
              content: { kind: "group", childIds: [] },
            }),
          );
        }
      }
    }

    tableRowSync.clearDead();
    tableRowSync.setRows(rowIds);

    return opsOut;
  };

  const applyInvariantOps = (
    meta: Transaction["meta"] | undefined,
    inverseAcc: Op[],
  ): ModelApplyResult => {
    const opsOut = reconcileTablesOps();
    if (!opsOut.length) return emptyModelApply;

    const txn = model.ops.transaction(opsOut, { source: "rule" });
    const { result, inverseOps } = applyTxnWithInverse(txn);

    if (meta?.source !== "remote") inverseAcc.push(...inverseOps);

    evaluator.prune(result.touched);
    return result;
  };

  const applyPipeline = (txn: Transaction): ApplyResult => {
    let final = emptyModelApply;
    const inverseAcc: Op[] = [];
    const src = txn.meta?.source;

    batch(() => {
      const isRemote = src === "remote";

      if (isRemote) {
        const res = model.apply(txn);
        final = mergeModelApply(final, res);

        const invRes = applyInvariantOps(txn.meta, inverseAcc);
        final = mergeModelApply(final, invRes);

        repairSelectionAfterDispatch(txn.meta);

        return;
      }

      const isUser = src === "user";

      const { result: userRes, inverseOps: invUser } = applyTxnWithInverse(txn);
      inverseAcc.push(...invUser);
      final = mergeModelApply(final, userRes);

      const invRes1 = applyInvariantOps(txn.meta, inverseAcc);
      final = mergeModelApply(final, invRes1);

      const ruleRes = runRulesFixpoint(userRes, inverseAcc);
      final = mergeModelApply(final, ruleRes);

      const invRes2 = applyInvariantOps(txn.meta, inverseAcc);
      final = mergeModelApply(final, invRes2);

      repairSelectionAfterDispatch(txn.meta);

      if (isUser) {
        const inverse = model.ops.transaction(inverseAcc.toReversed(), {
          source: "undo",
        });
        history.undo.push({ user: txn, inverse });
        history.redo = [];
      }
    });

    return toApplyResult(final);
  };

  const dispatch = (txn: Transaction): ApplyResult => applyPipeline(txn);

  const dispatchRemote = (txn: Transaction): ApplyResult => {
    const meta = { ...(txn.meta ?? {}), source: "remote" as const };
    return applyPipeline(model.ops.transaction(txn.ops, meta));
  };

  const addRule = (rule: Rule, opts2: { id?: string } = {}): (() => void) => {
    const id = opts2.id ?? `rule:${nextRuleId++}`;
    const rec = { id, run: rule };
    rules.push(rec);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const i = rules.indexOf(rec);
      if (i >= 0) rules.splice(i, 1);
    };
  };

  const commit = (run: (t: Tx) => void): ApplyResult => {
    const ops: Op[] = [];

    const t: Tx = {
      setLabel: (id, label) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.patch(eid, { label }));
      },

      setView: (id, view) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.patch(eid, { view }));
      },

      setScalar: (id, value) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.patch(eid, { content: storedFromScalar(value) }));
      },

      setSource: (id, source) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;

        if (source.type === "derived") {
          ops.push(
            model.ops.patch(eid, {
              content: { kind: "derived", expr: source.expr },
            }),
          );
          return;
        }

        ops.push(
          model.ops.patch(eid, {
            content: {
              kind: "lens",
              from: source.from,
              where: source.where,
              orderBy: source.orderBy,
            },
          }),
        );
      },

      insertChild: (ownerId, opts2) => {
        const ownerEid = ensureEntryId(ownerId);
        if (ownerEid == null) return itemIdOf(-1 as any);

        const id = model.createId();
        const kind = opts2?.kind ?? "blank";
        const entry: Entry =
          kind === "group" ? makeGroupEntry(id) : makeBlankEntry(id);

        ops.push(model.ops.create(entry));
        ops.push(
          model.ops.reparent({
            childId: id,
            toOwnerId: ownerEid,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );

        return itemIdOf(id);
      },

      move: (id, toOwnerId, opts2) => {
        const childEid = ensureEntryId(id);
        if (childEid == null) return;

        const toOwnerEid = toOwnerId == null ? null : ensureEntryId(toOwnerId);
        if (toOwnerId != null && toOwnerEid == null) return;

        ops.push(
          model.ops.reparent({
            childId: childEid,
            toOwnerId: toOwnerEid,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );
      },

      remove: (id) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.remove(eid));
      },
    };

    run(t);
    if (!ops.length) return toApplyResult(emptyModelApply);

    const txn = model.ops.transaction(ops, { source: "user" });
    return dispatch(txn);
  };

  const undo = (): ApplyResult => {
    const last = history.undo.pop() ?? null;
    if (!last) return toApplyResult(emptyModelApply);
    const res = dispatch(last.inverse);
    history.redo.push(last);
    return res;
  };

  const redo = (): ApplyResult => {
    const last = history.redo.pop() ?? null;
    if (!last) return toApplyResult(emptyModelApply);

    const replay = model.ops.transaction(last.user.ops, { source: "redo" });
    const res = dispatch(replay);

    const newUndoTop = history.undo.at(-1) ?? null;
    if (newUndoTop) history.redo = [...history.redo, newUndoTop];

    return res;
  };

  const focus = (
    f: Focus,
    target: string = DEFAULT_TARGET,
    opts2: { caret?: Caret } = {},
  ) => {
    runtime.setSelection(
      {
        kind: "focused",
        focus: f,
        target,
        ...(opts2.caret ? { caret: opts2.caret } : {}),
      },
      [],
    );
  };

  const blur = (): void => {
    runtime.setSelection({ kind: "idle" });
  };

  const selection = (): Selection => runtime.selection();

  const attachFocus: Core["attachFocus"] = (args) => runtime.attachFocus(args);

  const mountView: Core["mountView"] = (args: any) => {
    const id: ItemId = args.id;
    if (!isEntryItemId(id)) {
      if ("continueAs" in args) return null;
      return { el: document.createElement("div"), dispose() {} };
    }
    return (runtime.mountView as any)(args);
  };

  const locate = (id: ItemId): LocateResult | null => {
    const r = parseItemId(id);
    if (!r || r.path.length) return null;

    const loc = model.locateInOwner(r.entryId);
    if (!loc) return null;

    return {
      ownerId: itemIdOf(loc.ownerId),
      index: loc.index,
      siblings: loc.childIds.map((eid) => itemIdOf(eid)),
    };
  };

  const uninstallGlobal = runtime.installGlobalListeners(window);

  const rootId = itemIdOf(rootEntryId);

  core = {
    dispose() {
      uninstallGlobal();
      shapeSync.dispose();
      const { removedIds } = model.pruneUnreachable();
      evaluator.prune(removedIds);
      evaluator.dispose();
      runtime.dispose();
    },

    item,

    commit,

    dispatch,
    dispatchRemote,

    undo,
    redo,

    addRule,

    selection,
    focus,
    blur,

    locate,

    attachFocus,
    mountView,
  };

  return { core, rootId };
}

export type { Component, Selection, Focus, Caret, DomView, ViewFactory };
export type { TextCaret };
export type { ViewName, ViewKind };
export { DEFAULT_TARGET };
export { clamp, isTextInput, defaultTextCaret };
