import type { ReadonlySignal } from "@preact/signals-core";
import { batch, computed } from "@preact/signals-core";

import type { Result } from "./eval";
import {
  createEvaluator,
  isBlankResult,
  isEntryGroupResult,
  isIssueResult,
  isResultGroupResult,
  isScalarResult,
} from "./eval";
import { interpretExpr } from "./lang";
import type {
  ApplyResult as ModelApplyResult,
  Entry,
  EntryContent,
  EntryId,
  Op,
  Transaction,
  TransactionMeta,
  ViewKind,
  ViewName,
} from "./model";
import {
  createModel,
  isFormulaContent,
  isGroupContent,
  isQueryContent,
  makeBlankEntry,
  makeGroupEntry,
  parseScalar,
} from "./model";
import type {
  Caret,
  Component,
  DomView,
  Focus,
  Selection,
  ViewFactory,
} from "./runtime";
import { DEFAULT_TARGET, createRuntime, defaultTextCaret } from "./runtime";
import type { Rule as SyncRule } from "./sync";
import { createShapeSyncGroup } from "./sync";

export type ItemId = string;

export type Value = true | number | string;
export type ValueOrBlank = Value | null;

export type Content =
  | { kind: "value"; value: ValueOrBlank }
  | { kind: "issue"; message: string }
  | { kind: "group"; children: readonly ItemId[] };

export type Connected =
  | { kind: "formula"; expr: string }
  | { kind: "query"; from: string; where: string; orderBy: string };

type Mode =
  | { kind: "readonly" }
  | { kind: "plain" }
  | { kind: "connected"; conn: Connected };

type Item = {
  id: ItemId;
  label?: string;
  content: Content;
  mode: Mode;
};

type ItemRef = { entryId: EntryId; path: readonly number[] };

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

function storedFromValue(v: ValueOrBlank): EntryContent {
  return v === null ? { kind: "blank" } : { kind: "scalar", value: v };
}

export const parseValue: (text: string) => ValueOrBlank = parseScalar;

function modeFromContent(ref: ItemRef, c: EntryContent): Mode {
  if (ref.path.length) return { kind: "readonly" };
  if (isFormulaContent(c))
    return { kind: "connected", conn: { kind: "formula", expr: c.expr } };
  if (isQueryContent(c))
    return {
      kind: "connected",
      conn: {
        kind: "query",
        from: c.from,
        where: c.where,
        orderBy: c.orderBy,
      },
    };
  return { kind: "plain" };
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

type Tx = {
  setLabel(id: ItemId, label: string): void;
  setView(id: ItemId, view: ViewKind): void;

  setValue(id: ItemId, value: ValueOrBlank): void;
  setConnected(id: ItemId, conn: Connected): void;
  setGroup(id: ItemId): void;

  insertChild(parentId: ItemId, opts?: { at?: number }): ItemId;

  move(id: ItemId, toParentId: ItemId, opts?: { at?: number }): void;
  remove(id: ItemId): void;
};

type LocateResult = {
  parentId: ItemId;
  index: number;
  siblings: readonly ItemId[];
};

type HistoryEntry = {
  user: Transaction;
  inverse: Transaction;
};

export type Core = {
  dispose(): void;

  item(id: ItemId): Item;

  view(id: ItemId): ViewName;

  commit(run: (t: Tx) => void): ApplyResult;

  undo(): ApplyResult;
  redo(): ApplyResult;

  selection(): Selection;
  focus(focus: Focus, target?: string, opts?: { caret?: Caret }): void;
  blur(): void;

  locate(id: ItemId): LocateResult | null;

  attachTarget(opts: {
    focus: Focus;
    target: string;
    getEl: () => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  mountView(opts: { id: ItemId; focus?: Focus; view: ViewName }): Component;
};

type CollabWire = {
  origin: string;
  send(txn: Transaction): void;
  subscribe(onTxn: (txn: Transaction) => void): () => void;
};

export function createCore(opts: {
  views: Partial<Record<ViewName, ViewFactory<Core>>>;
  collab?: CollabWire;
}): { core: Core; rootId: ItemId } {
  const model = createModel();

  const rootEntryId = model.createId();
  model.setRoot(rootEntryId);
  model.apply(
    model.ops.transaction([model.ops.create(makeGroupEntry(rootEntryId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const rootId = itemIdOf(rootEntryId);

  const runtime = createRuntime<Core>({
    model,
    getCore: () => core,
    views: opts.views,
    initialSelection: {
      kind: "focused",
      focus: { container: rootId, item: rootId },
      target: DEFAULT_TARGET,
    },
  });

  const rules: { id: string; run: SyncRule }[] = [];
  let nextRuleId = 1;

  const history: { undo: HistoryEntry[]; redo: HistoryEntry[] } = {
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
    if (sel.kind === "idle") return true;
    const a = entryIdFromItemId(sel.focus.item);
    const b = entryIdFromItemId(sel.focus.container);
    if (a == null || b == null) return false;
    return model.hasEntry(a) && model.hasEntry(b);
  };

  const repairSelectionAfterDispatch = (meta?: Transaction["meta"]) => {
    const source = meta?.source;
    if (source === "remote") {
      const sel = runtime.selectionSignal.peek();
      if (!selectionStillValid(sel)) runtime.setSelection({ kind: "idle" });
      return;
    }
    runtime.setSelection(runtime.selectionSignal.peek());
  };

  const childrenOfResolved = (base: ItemRef, v: Result): readonly ItemId[] => {
    if (isEntryGroupResult(v))
      return v.entryIds.map((eid) => itemIdOf(eid, []));
    if (isResultGroupResult(v))
      return v.items.map((_it, i) => itemIdOf(base.entryId, [...base.path, i]));
    return [];
  };

  const resolve = (ref: ItemRef): { result: Result; label?: string } => {
    let cur: Result = evaluator.result(ref.entryId);
    let label: string | undefined =
      model.readEntry(ref.entryId).label.trim() || undefined;

    for (let i = 0; i < ref.path.length; i++) {
      const idx = ref.path[i]!;
      if (!isResultGroupResult(cur))
        return { result: { kind: "issue", message: "Invalid path" } as any };
      const item = cur.items[idx];
      if (!item)
        return { result: { kind: "issue", message: "Invalid path" } as any };
      label = item.label?.trim() || undefined;
      cur = item.result;
    }

    return { result: cur, ...(label ? { label } : {}) };
  };

  const toContent = (ref: ItemRef, v: Result): Content => {
    if (isBlankResult(v)) return { kind: "value", value: null };
    if (isIssueResult(v)) return { kind: "issue", message: v.message };
    if (isScalarResult(v)) {
      const x = v.result;
      return {
        kind: "value",
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
      const resolved = resolve(ref);
      const content = toContent(ref, resolved.result);

      let mode: Mode = { kind: "readonly" };
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
        content: { kind: "issue", message: msg },
        mode: { kind: "readonly" },
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
        const wanted = (vk ?? "outline") as ViewName;
        const hasFactory = !!opts.views[wanted];
        return hasFactory ? wanted : "outline";
      });
      viewSignalCache.set(eid, sig);
    }

    return sig.value;
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

      if (op.kind === "move") {
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

      if (op.kind === "remove") {
        const id0 = op.id;
        if (!model.hasEntry(id0)) continue;

        const cur = model.peekEntry(id0);
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
              content: { kind: "group", childIds: [] },
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
      for (const rule of rules) {
        const ops0 = rule.run(model, input, { source: "rule" });
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

  const addRuleInternal = (
    ruleFn: SyncRule,
    addRuleOpts: { id?: string } = {},
  ): (() => void) => {
    const id = addRuleOpts.id ?? `rule:${nextRuleId++}`;
    const rec = { id, run: ruleFn };
    rules.push(rec);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const i = rules.indexOf(rec);
      if (i >= 0) rules.splice(i, 1);
    };
  };

  const shapeSync = createShapeSyncGroup({
    model,
    addRule: (ruleFn) => addRuleInternal(ruleFn, { id: "sync:shape" }),
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

      const entry = model.peekEntry(id);
      const isTable = entry.view === "table";
      if (isTable) tableIds.push(id);

      if (isGroupContent(entry.content)) {
        for (const cid of entry.content.childIds) {
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

        if (row.view != null) {
          opsOut.push(model.ops.patch(rid, { view: null }));
        }

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
    const source = txn.meta?.source;

    batch(() => {
      const isRemote = source === "remote";

      if (isRemote) {
        const res = model.apply(txn);
        final = mergeModelApply(final, res);

        const invRes = applyInvariantOps(txn.meta, inverseAcc);
        final = mergeModelApply(final, invRes);

        repairSelectionAfterDispatch(txn.meta);

        return;
      }

      const isUser = source === "user";

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

  const applyLocal = (txn: Transaction): ApplyResult => {
    const stamped = model.ops.transaction(txn.ops, stampLocalMeta(txn.meta));
    const res = applyPipeline(stamped);
    sendLocalTxn(stamped);
    return res;
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

        if (conn.kind === "formula") {
          ops.push(
            model.ops.patch(eid, {
              content: { kind: "formula", expr: conn.expr },
            }),
          );
          return;
        }

        ops.push(
          model.ops.patch(eid, {
            content: {
              kind: "query",
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
          model.ops.patch(eid, { content: { kind: "group", childIds: [] } }),
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
    return applyLocal(txn);
  };

  const undo = (): ApplyResult => {
    const last = history.undo.pop() ?? null;
    if (!last) return toApplyResult(emptyModelApply);
    const res = applyLocal(last.inverse);
    history.redo.push(last);
    return res;
  };

  const redo = (): ApplyResult => {
    const last = history.redo.pop() ?? null;
    if (!last) return toApplyResult(emptyModelApply);

    const replay = model.ops.transaction(last.user.ops, { source: "redo" });
    const res = applyLocal(replay);
    history.undo.push(last);

    return res;
  };

  const focus = (
    focus: Focus,
    target: string = DEFAULT_TARGET,
    focusOpts: { caret?: Caret } = {},
  ) => {
    runtime.setSelection(
      {
        kind: "focused",
        focus,
        target,
        ...(focusOpts.caret ? { caret: focusOpts.caret } : {}),
      },
      [],
    );
  };

  const blur = (): void => {
    runtime.setSelection({ kind: "idle" });
  };

  const selection = (): Selection => runtime.selection();

  const attachTarget: Core["attachTarget"] = (args) =>
    runtime.attachTarget(args);

  const mountView: Core["mountView"] = (args) => runtime.mountView(args);

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

  const uninstallGlobal = runtime.installGlobalListeners(window);

  const unsubscribeCollab = opts.collab
    ? opts.collab.subscribe((txn) => {
        applyRemote(txn);
      })
    : null;

  core = {
    dispose() {
      unsubscribeCollab?.();
      uninstallGlobal();
      shapeSync.dispose();
      const { removedIds } = model.pruneUnreachable();
      evaluator.prune(removedIds);
      evaluator.dispose();
      runtime.dispose();
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

    attachTarget,
    mountView,
  };

  return { core, rootId };
}

export type {
  Caret,
  Component,
  DomView,
  Focus,
  Selection,
  Transaction,
  ViewFactory,
  ViewKind,
  ViewName,
};
export { DEFAULT_TARGET, defaultTextCaret };
