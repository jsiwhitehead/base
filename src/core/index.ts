import {
  createModel,
  isBlankContent,
  isDerivedContent,
  isLensContent,
  isScalarContent,
  parseScalar,
  type Item,
  type ItemId,
  type Scalar,
  type StoredContent,
  type StoredContentSettable,
  type ViewKind,
  type ViewName,
  type Op,
} from "./model";
import {
  type Value,
  type LabeledValue,
  createEvaluator,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
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
  clamp,
  isTextInput,
  defaultTextCaret,
  type TextCaret,
} from "./runtime";

export type CaretSpec = number | Caret;

export type StoredKind = "blank" | "scalar" | "group" | "derived" | "lens";

export type Meta = {
  id: ItemId;
  ownerId: ItemId | null;
  label: string;
  view: ViewKind;
  storedKind: StoredKind;
};

export type Source =
  | { kind: "none" }
  | { kind: "derived"; expr: string }
  | { kind: "lens"; from: string; where: string; orderBy: string };

export type TextState =
  | { kind: "editable"; text: string }
  | { kind: "readonly"; text: string; issue?: string };

export type Locate = null | {
  ownerId: ItemId;
  index: number;
  siblingIds: readonly ItemId[];
};

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

function valueToDisplayText(v: Value): { text: string; issue?: string } {
  if (isBlankValue(v)) return { text: "" };
  if (isIssueValue(v)) return { text: v.message, issue: v.message };
  if (isScalarValue(v)) return { text: String(v.value) };
  return { text: "" };
}

function contentToSource(c: StoredContent): Source {
  if (isDerivedContent(c)) return { kind: "derived", expr: c.expr ?? "" };
  if (isLensContent(c))
    return {
      kind: "lens",
      from: c.from ?? "",
      where: c.where ?? "",
      orderBy: c.orderBy ?? "",
    };
  return { kind: "none" };
}

function sourceToContent(prev: StoredContent, s: Source): StoredContent {
  if (s.kind === "none") {
    return prev.kind === "derived" || prev.kind === "lens"
      ? ({ kind: "blank" } as StoredContentSettable)
      : prev;
  }
  if (s.kind === "derived") return { kind: "derived", expr: s.expr };
  return {
    kind: "lens",
    from: s.from,
    where: s.where ?? "",
    orderBy: s.orderBy ?? "",
  };
}

function storedFromScalar(v: Scalar | null): StoredContentSettable {
  return v === null ? { kind: "blank" } : { kind: "scalar", value: v };
}

export type Tx = {
  setLabel(id: ItemId, label: string): void;
  setView(id: ItemId, view: ViewKind): void;

  setScalar(id: ItemId, value: Scalar | null): void;

  setSource(id: ItemId, source: Source): void;

  insert(
    ownerId: ItemId,
    opts?: { at?: number; kind?: "blank" | "group" },
  ): ItemId;

  move(id: ItemId, toOwnerId: ItemId | null, opts?: { at?: number }): void;

  remove(id: ItemId): void;
};

export type Core = {
  dispose(): void;

  has(id: ItemId): boolean;
  meta(id: ItemId): Meta;

  source(id: ItemId): Source;
  value(id: ItemId): Value;

  childIds(id: ItemId): readonly ItemId[];
  findChild(ownerId: ItemId, label: string): ItemId | null;

  text(id: ItemId): TextState;
  locate(id: ItemId): Locate;

  commit(run: (t: Tx) => void): ApplyResult;
  edit: Tx;

  selection(): Selection;
  focus(focus: Focus, target?: string, opts?: { caret?: CaretSpec }): void;
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
  const rootId = model.createId();
  model.setRoot(rootId);
  model.apply(
    model.ops.transaction([model.ops.create(model.createItem.group(rootId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  const has = (id: ItemId): boolean => model.hasItem(id);

  const meta = (id: ItemId): Meta => {
    const it = model.readItem(id);
    return {
      id: it.id,
      ownerId: it.ownerId,
      label: it.label,
      view: it.view,
      storedKind: it.content.kind,
    };
  };

  const source = (id: ItemId): Source => {
    if (!model.hasItem(id)) return { kind: "none" };
    return contentToSource(model.readItem(id).content);
  };

  const value = (id: ItemId): Value => evaluator.value(id);

  const childIds = (id: ItemId): readonly ItemId[] => {
    const v = evaluator.value(id);
    return isItemGroupValue(v) ? v.itemIds : [];
  };

  const findChild = (ownerId: ItemId, label: string): ItemId | null =>
    model.findChildIdByLabel(ownerId, label);

  const text = (id: ItemId): TextState => {
    if (model.canEditScalarText(id)) {
      const c = model.readItem(id).content;
      if (isBlankContent(c)) return { kind: "editable", text: "" };
      if (isScalarContent(c))
        return { kind: "editable", text: String(c.value) };
      return { kind: "editable", text: "" };
    }

    const disp = valueToDisplayText(evaluator.value(id));
    return {
      kind: "readonly",
      text: disp.text,
      ...(disp.issue ? { issue: disp.issue } : {}),
    };
  };

  const locate = (id: ItemId): Locate => {
    const loc = model.locateInOwner(id);
    if (!loc) return null;
    return { ownerId: loc.ownerId, index: loc.index, siblingIds: loc.childIds };
  };

  const commit = (run: (t: Tx) => void): ApplyResult => {
    const ops: Op[] = [];

    const t: Tx = {
      setLabel: (id, label) => ops.push(model.ops.patchLabel(id, label)),
      setView: (id, view) => ops.push(model.ops.patchView(id, view)),

      setScalar: (id, v) => {
        ops.push(model.ops.patchContent(id, storedFromScalar(v)));
      },

      setSource: (id, nextSource) => {
        const prev = model.hasItem(id)
          ? model.readItem(id).content
          : ({ kind: "blank" } as StoredContentSettable); // allow setting source on newly inserted items
        const next = sourceToContent(prev, nextSource);
        if (next !== prev) ops.push(model.ops.patchContent(id, next));
      },

      insert: (ownerId, opts2) => {
        const id = model.createId();
        const kind = opts2?.kind ?? "blank";
        const item: Item =
          kind === "group"
            ? model.createItem.group(id)
            : model.createItem.blank(id);

        ops.push(model.ops.create(item));
        ops.push(
          model.ops.reparent({
            childId: id,
            toOwnerId: ownerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );
        return id;
      },

      move: (id, toOwnerId, opts2) => {
        ops.push(
          model.ops.reparent({
            childId: id,
            toOwnerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );
      },

      remove: (id) => ops.push(model.ops.detach(id)),
    };

    run(t);

    if (!ops.length) return { created: [], touched: [], reparented: [] };

    const txn = model.ops.transaction(ops);
    const result = model.apply(txn) as ApplyResult;

    runtime.setSelection(runtime.selectionSignal.peek());

    return result;
  };

  const edit: Tx = {
    setLabel: (id, label) => commit((t) => t.setLabel(id, label)),
    setView: (id, view) => commit((t) => t.setView(id, view)),
    setScalar: (id, v) => commit((t) => t.setScalar(id, v)),
    setSource: (id, s) => commit((t) => t.setSource(id, s)),
    insert: (ownerId, opts2) => {
      let out: ItemId = -1;
      commit((t) => {
        out = t.insert(ownerId, opts2);
      });
      return out;
    },
    move: (id, toOwnerId, opts2) => commit((t) => t.move(id, toOwnerId, opts2)),
    remove: (id) => commit((t) => t.remove(id)),
  };

  const normalizeCaret = (spec: CaretSpec | undefined): Caret | undefined => {
    if (spec == null) return undefined;
    if (typeof spec === "number") return { start: spec, end: spec };
    return spec;
  };

  const focus = (
    f: Focus,
    target: string = "content",
    opts2: { caret?: CaretSpec } = {},
  ): void => {
    const caret = normalizeCaret(opts2.caret);
    runtime.setSelection(
      {
        kind: "focused",
        focus: f,
        target,
        ...(caret ? { caret } : {}),
      },
      [],
    );
  };

  const blur = (): void => {
    runtime.setSelection({ kind: "idle" });
  };

  const selection = (): Selection => runtime.selection();

  const attachFocus: Core["attachFocus"] = (args) => runtime.attachFocus(args);

  const mountView: Core["mountView"] = (args: any) =>
    (runtime.mountView as any)(args);

  const gc = (): void => {
    const { removedIds } = model.pruneUnreachable();
    evaluator.prune(removedIds);
  };

  const core: Core = {
    dispose() {
      uninstallGlobal();
      gc();
      evaluator.dispose();
      runtime.dispose();
    },

    has,
    meta,

    source,
    value,

    childIds,
    findChild,

    text,
    locate,

    commit,
    edit,

    selection,
    focus,
    blur,

    attachFocus,
    mountView,
  };

  const runtime = createRuntime<Core>({
    model,
    core,
    views: opts.views,
    initialSelection: { kind: "idle" },
  });

  const uninstallGlobal = runtime.installGlobalListeners(window);

  return { core, rootId };
}

export type { ItemId, ViewName, ViewKind, Scalar, Value, LabeledValue };
export type { Component, Selection, Focus, Caret, DomView, ViewFactory };
export type { TextCaret };
export {
  parseScalar,
  clamp,
  isTextInput,
  defaultTextCaret,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
};
