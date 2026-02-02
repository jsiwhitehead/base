import { batch } from "@preact/signals-core";
import {
  createModel,
  parseScalar,
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

type ItemRef = { entryId: EntryId; path: readonly number[] };

const itemIdOf = (entryId: EntryId, path: readonly number[] = []): ItemId =>
  `${String(entryId)}:${path.length ? path.join(",") : ""}`;

const refFromItemId = (id: ItemId): ItemRef => {
  const i = id.indexOf(":");
  const head = i === -1 ? id : id.slice(0, i);
  const entryId = Number(head);
  if (!Number.isFinite(entryId)) throw new Error("Invalid item id");
  const rest = i === -1 ? "" : id.slice(i + 1);
  const path = rest.trim() === "" ? [] : rest.split(",").map((x) => Number(x));
  if (path.some((n) => !Number.isFinite(n))) throw new Error("Invalid item id");
  return { entryId, path };
};

const isEntryItemId = (id: ItemId): boolean =>
  refFromItemId(id).path.length === 0;

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

export type Rule = (
  model: Model,
  input: ModelApplyResult,
  meta?: Transaction["meta"],
) => readonly Op[];

type HistoryEntry = {
  user: Transaction;
  inverse: Transaction;
};

export type Core = {
  dispose(): void;

  item(id: ItemId): Item;

  commit(run: (t: Tx) => void): ApplyResult;

  dispatch(txn: Transaction): ApplyResult;

  addRule(rule: Rule): () => void;

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

  const rules: Rule[] = [];

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

  const inverseOfOp = (op: Op): Op => {
    if (op.kind === "create") {
      return model.ops.reparent({ childId: op.entry.id, toOwnerId: null });
    }
    if (op.kind === "patch") {
      const cur = model.peekEntry(op.id);
      const next: any = {};
      if (op.next.label !== undefined) next.label = cur.label;
      if (op.next.view !== undefined) next.view = cur.view;
      if (op.next.content !== undefined) next.content = cur.content;
      return model.ops.patch(op.id, next);
    }
    const childId = op.spec.childId;
    const child = model.peekEntry(childId);
    const ownerId = child.ownerId ?? null;
    const loc = model.locateInOwner(childId);
    return model.ops.reparent({
      childId,
      toOwnerId: ownerId,
      ...(loc ? { toIndex: loc.index } : {}),
    });
  };

  const applyTxnCapturingInverse = (
    txn: Transaction,
  ): { result: ModelApplyResult; inverseOps: Op[] } => {
    let out = emptyModelApply;
    const inverseOps: Op[] = [];

    for (const op of txn.ops) {
      inverseOps.push(inverseOfOp(op));
      const one = model.apply(model.ops.transaction([op], txn.meta));
      out = mergeModelApply(out, one);
    }

    return { result: out, inverseOps };
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
      for (const rule of rules) {
        const ops0 = rule(model, input, { source: "rule" });
        if (ops0.length) opsOut = opsOut.concat(ops0);
      }
      if (!opsOut.length) break;

      const txn = model.ops.transaction(opsOut, { source: "rule" });
      const { result, inverseOps } = applyTxnCapturingInverse(txn);
      inverseAcc.push(...inverseOps);
      merged = mergeModelApply(merged, result);
      input = result;
    }

    return merged;
  };

  const toApplyResult = (r: ModelApplyResult): ApplyResult => {
    const toItemId = (eid: EntryId) => itemIdOf(eid);
    return {
      created: r.created.map(toItemId),
      touched: r.touched.map(toItemId),
      reparented: r.reparented.map((x) => ({
        fromOwnerId: x.fromOwnerId == null ? null : toItemId(x.fromOwnerId),
        toOwnerId: x.toOwnerId == null ? null : toItemId(x.toOwnerId),
        fromIndex: x.fromIndex,
        toIndex: x.toIndex,
      })),
    };
  };

  const entryIdFromItemIdLoose = (id: ItemId): EntryId | null => {
    const i = id.indexOf(":");
    const head = i === -1 ? id : id.slice(0, i);
    const n = Number(head);
    return Number.isFinite(n) ? n : null;
  };

  const selectionStillValid = (sel: Selection): boolean => {
    if (sel.kind === "idle") return true;
    const a = entryIdFromItemIdLoose(sel.focus.item);
    const b = entryIdFromItemIdLoose(sel.focus.container);
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

  const dispatch = (txn: Transaction): ApplyResult => {
    let final = emptyModelApply;
    const inverseAcc: Op[] = [];
    const isUser = txn.meta?.source === "user";

    batch(() => {
      const { result: userRes, inverseOps: invUser } =
        applyTxnCapturingInverse(txn);
      inverseAcc.push(...invUser);
      final = mergeModelApply(final, userRes);

      const ruleRes = runRulesFixpoint(userRes, inverseAcc);
      final = mergeModelApply(final, ruleRes);

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

  const addRule = (rule: Rule): (() => void) => {
    rules.push(rule);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const i = rules.indexOf(rule);
      if (i >= 0) rules.splice(i, 1);
    };
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

  const commit = (run: (t: Tx) => void): ApplyResult => {
    const ops: Op[] = [];

    const ensureEntryId = (id: ItemId): EntryId | null => {
      const r = refFromItemId(id);
      if (r.path.length) return null;
      return r.entryId;
    };

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
        if (ownerEid == null) return itemIdOf(-1);

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
        ops.push(model.ops.reparent({ childId: eid, toOwnerId: null }));
      },
    };

    run(t);
    if (!ops.length) return toApplyResult(emptyModelApply);

    const txn = model.ops.transaction(ops, { source: "user" });
    return dispatch(txn);
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
    const r = refFromItemId(id);
    if (r.path.length) return null;

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
      const { removedIds } = model.pruneUnreachable();
      evaluator.prune(removedIds);
      evaluator.dispose();
      runtime.dispose();
    },

    item,

    commit,

    dispatch,

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
export { parseScalar, clamp, isTextInput, defaultTextCaret };
