import {
  createModel,
  isBlankContent,
  isDerivedContent,
  isLensContent,
  isScalarContent,
  type Item,
  type ItemId,
  type Scalar,
  type ViewKind,
  type ViewName,
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
} from "./compute";
import { interpretExpr } from "./lang";
import {
  createShell,
  type Selection,
  type Focus,
  type FocusTarget,
  type Caret,
  type EditorEffect,
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

export type Header =
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

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function parseScalar(text: string): Scalar | null {
  const t = text.trim();
  if (!t) return null;
  if (NUM_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t === "true") return true;
  return text;
}

function valueToDisplayText(v: Value): { text: string; issue?: string } {
  if (isBlankValue(v)) return { text: "" };
  if (isIssueValue(v)) return { text: v.message, issue: v.message };
  if (isScalarValue(v)) return { text: String(v.value) };
  return { text: "" };
}

export type Tx = {
  setLabel(id: ItemId, label: string): void;
  setView(id: ItemId, view: ViewKind): void;

  setText(id: ItemId, text: string): void;
  setScalar(id: ItemId, value: Scalar | null): void;

  setDerived(id: ItemId, expr: string): void;
  setLens(
    id: ItemId,
    spec: { from: string; where?: string; orderBy?: string },
  ): void;

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
  get(id: ItemId): Meta;

  header(id: ItemId): Header;
  value(id: ItemId): Value;
  children(id: ItemId): readonly ItemId[];
  findChild(ownerId: ItemId, label: string): ItemId | null;
  text(id: ItemId): TextState;
  locate(id: ItemId): Locate;

  commit(run: (t: Tx) => void): ApplyResult;
  edit: Tx;

  selection(): Selection;
  setSelection(next: Selection, effects?: EditorEffect[]): void;
  focus(focus: Focus, target?: FocusTarget, opts?: { caret?: CaretSpec }): void;
  blur(effects?: EditorEffect[]): void;

  mountViewRoot(opts: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
  }): () => void;

  bindFocus(opts: {
    focus: Focus;
    elementFor: (target: FocusTarget) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  installGlobalListeners(win?: Window): () => void;
};

export function createCore(): { core: Core; rootId: ItemId } {
  const model = createModel();
  const rootId = model.createId();
  model.setRoot(rootId);
  model.apply(
    model.op.transaction([model.op.create(model.createItem.group(rootId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });
  const shell = createShell({ model, initialSelection: { kind: "idle" } });

  const has = (id: ItemId): boolean => model.hasItem(id);

  const get = (id: ItemId): Meta => {
    const it = model.readItem(id);
    return {
      id: it.id,
      ownerId: it.ownerId,
      label: it.label,
      view: it.view,
      storedKind: it.content.kind,
    };
  };

  const header = (id: ItemId): Header => {
    const c = model.readItem(id).content;
    if (isDerivedContent(c)) return { kind: "derived", expr: c.expr ?? "" };
    if (isLensContent(c))
      return {
        kind: "lens",
        from: c.from ?? "",
        where: c.where ?? "",
        orderBy: c.orderBy ?? "",
      };
    return { kind: "none" };
  };

  const value = (id: ItemId): Value => evaluator.value(id);

  const children = (id: ItemId): readonly ItemId[] => {
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
    const ops: Array<
      | { kind: "create"; item: Item }
      | {
          kind: "patch";
          id: ItemId;
          next: { label?: string; view?: ViewKind; content?: any };
        }
      | {
          kind: "reparent";
          spec: { childId: ItemId; toOwnerId: ItemId | null; toIndex?: number };
        }
    > = [];

    const t: Tx = {
      setLabel: (id, label) => ops.push({ kind: "patch", id, next: { label } }),
      setView: (id, view) => ops.push({ kind: "patch", id, next: { view } }),

      setText: (id, txt) => {
        const v = parseScalar(txt);
        ops.push({
          kind: "patch",
          id,
          next:
            v === null
              ? { content: { kind: "blank" } }
              : { content: { kind: "scalar", value: v } },
        });
      },

      setScalar: (id, v) => {
        ops.push({
          kind: "patch",
          id,
          next:
            v === null
              ? { content: { kind: "blank" } }
              : { content: { kind: "scalar", value: v } },
        });
      },

      setDerived: (id, expr) => {
        ops.push({
          kind: "patch",
          id,
          next: { content: { kind: "derived", expr } },
        });
      },

      setLens: (id, spec) => {
        ops.push({
          kind: "patch",
          id,
          next: {
            content: {
              kind: "lens",
              from: spec.from,
              where: spec.where ?? "",
              orderBy: spec.orderBy ?? "",
            },
          },
        });
      },

      insert: (ownerId, opts2) => {
        const id = model.createId();
        const kind = opts2?.kind ?? "blank";
        const item =
          kind === "group"
            ? model.createItem.group(id)
            : model.createItem.blank(id);
        ops.push({ kind: "create", item });
        ops.push({
          kind: "reparent",
          spec: {
            childId: id,
            toOwnerId: ownerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          },
        });
        return id;
      },

      move: (id, toOwnerId, opts2) => {
        ops.push({
          kind: "reparent",
          spec: {
            childId: id,
            toOwnerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          },
        });
      },

      remove: (id) =>
        ops.push({ kind: "reparent", spec: { childId: id, toOwnerId: null } }),
    };

    run(t);

    if (!ops.length) return { created: [], touched: [], reparented: [] };

    const txn = model.op.transaction(
      ops.map((o) => {
        if (o.kind === "create") return model.op.create(o.item);
        if (o.kind === "patch") return model.op.patch(o.id, o.next);
        return model.op.reparent(o.spec);
      }),
    );

    const result = model.apply(txn) as ApplyResult;
    shell.setSelection(shell.selectionSignal.peek());
    return result;
  };

  const edit: Tx = {
    setLabel: (id, label) => commit((t) => t.setLabel(id, label)),
    setView: (id, view) => commit((t) => t.setView(id, view)),
    setText: (id, txt) => commit((t) => t.setText(id, txt)),
    setScalar: (id, v) => commit((t) => t.setScalar(id, v)),
    setDerived: (id, expr) => commit((t) => t.setDerived(id, expr)),
    setLens: (id, spec) => commit((t) => t.setLens(id, spec)),
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

  const selection = (): Selection => shell.selectionSignal.value;

  const setSelection = (next: Selection, effects: EditorEffect[] = []) => {
    shell.setSelection(next, effects);
  };

  const normalizeCaret = (spec: CaretSpec | undefined): Caret | undefined => {
    if (spec == null) return undefined;
    if (typeof spec === "number") return { start: spec, end: spec };
    return spec;
  };

  const focus = (
    f: Focus,
    target: FocusTarget = "content",
    opts2: { caret?: CaretSpec } = {},
  ): void => {
    const caret = normalizeCaret(opts2.caret);
    shell.focus(f, target, caret ? { caret } : {});
  };

  const blur = (effects: EditorEffect[] = []): void => {
    shell.setSelection({ kind: "idle" }, effects);
  };

  const mountViewRoot = (opts2: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
  }): (() => void) => shell.mountViewRoot(opts2);

  const bindFocus = (opts2: {
    focus: Focus;
    elementFor: (target: FocusTarget) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): (() => void) => shell.bindFocus(opts2);

  const installGlobalListeners = (win?: Window): (() => void) =>
    shell.installGlobalListeners(win);

  const core: Core = {
    dispose() {
      evaluator.dispose();
      shell.dispose();
    },

    has,
    get,
    header,
    value,
    children,
    findChild,
    text,
    locate,

    commit,
    edit,

    selection,
    setSelection,
    focus,
    blur,

    mountViewRoot,
    bindFocus,
    installGlobalListeners,
  };

  return { core, rootId };
}

export type { ItemId, ViewName, ViewKind, Scalar, Value, LabeledValue };
export type { Selection, Focus, FocusTarget, Caret };
export {
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
};
