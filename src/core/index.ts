import {
  createModel,
  parseScalar,
  type Entry,
  type EntryId,
  type EntryContent,
  type ViewKind,
  type ViewName,
  type Op,
  isDerivedContent,
  isLensContent,
} from "./model";
import {
  createEvaluator,
  type Value,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isEntryGroupValue,
  isValueGroupValue,
} from "./eval";
import { interpretExpr } from "./lang";
import {
  createRuntime,
  type Component,
  type Selection,
  type Focus,
  type Caret,
  type DomView,
  type ViewFactory,
  type TextCaret,
  clamp,
  isTextInput,
  defaultTextCaret,
} from "./runtime";
import { DEV } from "../dev";

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

export type Core = {
  dispose(): void;

  root(): ItemId;

  item(id: ItemId): Item;

  commit(run: (t: Tx) => void): ApplyResult;

  selection(): Selection;
  focus(focus: Focus, target?: string, opts?: { caret?: Caret }): void;
  blur(): void;

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
    model.ops.transaction([
      model.ops.create(model.createEntry.group(rootEntryId)),
    ]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const runtime = createRuntime<Core>({
    model,
    getCore: () => core,
    views: opts.views,
    initialSelection: { kind: "idle" },
  });

  const childrenOfResolved = (base: ItemRef, v: Value): readonly ItemId[] => {
    if (isEntryGroupValue(v)) {
      return v.entryIds.map((eid) => itemIdOf(eid, []));
    }
    if (isValueGroupValue(v)) {
      return v.items.map((_it, i) => itemIdOf(base.entryId, [...base.path, i]));
    }
    return [];
  };

  const resolve = (ref: ItemRef): { value: Value; label?: string } => {
    let cur: Value = evaluator.value(ref.entryId);
    let label: string | undefined =
      model.readEntry(ref.entryId).label.trim() || undefined;

    for (let i = 0; i < ref.path.length; i++) {
      const idx = ref.path[i]!;
      if (!isValueGroupValue(cur)) {
        return { value: { kind: "issue", message: "Invalid path" } as any };
      }
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
      if (r.path.length) {
        if (DEV) throw new Error("Item is not entry-backed");
        return null;
      }
      return r.entryId;
    };

    const t: Tx = {
      setLabel: (id, label) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.patchLabel(eid, label));
      },

      setView: (id, view) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.patchView(eid, view));
      },

      setScalar: (id, value) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;
        ops.push(model.ops.patchContent(eid, storedFromScalar(value)));
      },

      setSource: (id, source) => {
        const eid = ensureEntryId(id);
        if (eid == null) return;

        if (source.type === "derived") {
          ops.push(
            model.ops.patchContent(eid, {
              kind: "derived",
              expr: source.expr,
            }),
          );
          return;
        }

        ops.push(
          model.ops.patchContent(eid, {
            kind: "lens",
            from: source.from,
            where: source.where,
            orderBy: source.orderBy,
          }),
        );
      },

      insertChild: (ownerId, opts2) => {
        const ownerEid = ensureEntryId(ownerId);
        if (ownerEid == null) return itemIdOf(-1);

        const ownerItem = item(ownerId);
        if (
          ownerItem.mode.kind !== "direct" ||
          ownerItem.content.kind !== "group"
        ) {
          if (DEV) throw new Error("Owner is not a direct editable group");
          return itemIdOf(-1);
        }

        const id = model.createId();
        const kind = opts2?.kind ?? "blank";
        const entry: Entry =
          kind === "group"
            ? model.createEntry.group(id)
            : model.createEntry.blank(id);

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
        ops.push(model.ops.detach(eid));
      },
    };

    run(t);

    if (!ops.length) return { created: [], touched: [], reparented: [] };

    const txn = model.ops.transaction(ops);
    const result0 = model.apply(txn);

    runtime.setSelection(runtime.selectionSignal.peek());

    const toItemId = (eid: EntryId) => itemIdOf(eid);

    return {
      created: result0.created.map(toItemId),
      touched: result0.touched.map(toItemId),
      reparented: result0.reparented.map((r) => ({
        fromOwnerId: r.fromOwnerId == null ? null : toItemId(r.fromOwnerId),
        toOwnerId: r.toOwnerId == null ? null : toItemId(r.toOwnerId),
        fromIndex: r.fromIndex,
        toIndex: r.toIndex,
      })),
    };
  };

  const focus = (
    f: Focus,
    target: string = "content",
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

  const gc = (): void => {
    const { removedIds } = model.pruneUnreachable();
    evaluator.prune(removedIds);
  };

  const uninstallGlobal = runtime.installGlobalListeners(window);

  const rootId = itemIdOf(rootEntryId);

  core = {
    dispose() {
      uninstallGlobal();
      gc();
      evaluator.dispose();
      runtime.dispose();
    },

    root: () => rootId,

    item,

    commit,

    selection,
    focus,
    blur,

    attachFocus,
    mountView,
  };

  return { core, rootId };
}

export type { Component, Selection, Focus, Caret, DomView, ViewFactory };
export type { TextCaret };
export type { ViewName, ViewKind };
export { parseScalar, clamp, isTextInput, defaultTextCaret };
