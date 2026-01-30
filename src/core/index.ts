import {
  createModel,
  parseScalar,
  type Entry,
  type EntryId,
  type EntryContent,
  type EntryContentSettable,
  type ViewKind,
  type ViewName,
  isBlankContent,
  isScalarContent,
  isDerivedContent,
  isLensContent,
  type Op,
} from "./model";
import {
  createEvaluator,
  type Value,
  type LabeledValue,
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

export type ItemRef = { entryId: EntryId; path: readonly number[] };

export type Scalar = null | true | number | string;

export type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

export type Editability =
  | { kind: "none" }
  | { kind: "scalar"; text: string }
  | { kind: "source"; fields: readonly SourceField[] };

export type ItemContent =
  | { kind: "scalar"; value: Scalar }
  | { kind: "issue"; message: string }
  | { kind: "group"; children: readonly ItemRef[] };

export type ItemSnapshot = {
  ref: ItemRef;
  label?: string;
  content: ItemContent;
  edit: Editability;
};

export type ApplyResult = {
  readonly created: readonly EntryId[];
  readonly touched: readonly EntryId[];
  readonly reparented: readonly {
    readonly fromOwnerId: EntryId | null;
    readonly toOwnerId: EntryId | null;
    readonly fromIndex: number | null;
    readonly toIndex: number | null;
  }[];
};

const refOf = (entryId: EntryId, path: readonly number[] = []): ItemRef => ({
  entryId,
  path,
});

const isEntryRef = (r: ItemRef): boolean => r.path.length === 0;

const entryIdOf = (r: ItemRef): EntryId => {
  if (!isEntryRef(r)) throw new Error("ItemRef is not an entry ref");
  return r.entryId;
};

type Resolved = { value: Value; label?: string };

function storedFromScalar(v: Scalar): EntryContentSettable {
  return v === null ? { kind: "blank" } : { kind: "scalar", value: v };
}

function entryContentToEditability(c: EntryContent): Editability {
  if (isBlankContent(c)) return { kind: "scalar", text: "" };
  if (isScalarContent(c)) return { kind: "scalar", text: String(c.value) };
  if (isDerivedContent(c))
    return {
      kind: "source",
      fields: [
        { key: "expr", label: "=", multiline: true, text: c.expr ?? "" },
      ],
    };
  if (isLensContent(c))
    return {
      kind: "source",
      fields: [
        { key: "from", label: "~", multiline: false, text: c.from ?? "" },
        { key: "where", label: "where:", multiline: true, text: c.where ?? "" },
        {
          key: "orderBy",
          label: "orderBy:",
          multiline: true,
          text: c.orderBy ?? "",
        },
      ],
    };
  return { kind: "none" };
}

export type Tx = {
  setLabel(ref: ItemRef, label: string): void;
  setContentScalar(ref: ItemRef, value: Scalar): void;
  setSourceField(ref: ItemRef, key: string, text: string): void;

  insertChild(
    ref: ItemRef,
    opts?: { at?: number; kind?: "blank" | "group" },
  ): EntryId;
  moveEntry(
    entryId: EntryId,
    toOwnerId: EntryId | null,
    opts?: { at?: number },
  ): void;
  removeEntry(entryId: EntryId): void;

  setView(entryId: EntryId, view: ViewKind): void;
};

export type Core = {
  dispose(): void;

  root(): ItemRef;

  item(ref: ItemRef): ItemSnapshot;

  commit(run: (t: Tx) => void): ApplyResult;
  edit: Tx;

  selection(): Selection;
  focus(focus: Focus, target?: string, opts?: { caret?: Caret }): void;
  blur(): void;

  attachFocus(opts: {
    focus: Focus;
    elementFor: (target: string) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  mountView(opts: { id: EntryId; focus?: Focus }): Component;
  mountView(opts: {
    id: EntryId;
    focus?: Focus;
    continueAs: ViewName;
  }): Component | null;
};

export function createCore(opts: {
  views: Partial<Record<ViewName, ViewFactory<Core>>>;
}): { core: Core; rootId: EntryId } {
  const model = createModel();
  const rootId = model.createId();
  model.setRoot(rootId);
  model.apply(
    model.ops.transaction([model.ops.create(model.createEntry.group(rootId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const runtime = createRuntime<Core>({
    model,
    getCore: () => core,
    views: opts.views,
    initialSelection: { kind: "idle" },
  });

  const resolve = (ref: ItemRef): Resolved => {
    let cur: Value = evaluator.value(ref.entryId);
    let label: string | undefined =
      model.readEntry(ref.entryId).label.trim() || undefined;

    for (let i = 0; i < ref.path.length; i++) {
      const idx = ref.path[i]!;
      if (isEntryGroupValue(cur)) {
        const childEntryId = cur.entryIds[idx];
        if (childEntryId == null)
          return { value: { kind: "issue", message: "Invalid path" } as any };
        label = model.readEntry(childEntryId).label.trim() || undefined;
        cur = evaluator.value(childEntryId);
        continue;
      }
      if (isValueGroupValue(cur)) {
        const it: LabeledValue | undefined = cur.items[idx];
        if (!it)
          return { value: { kind: "issue", message: "Invalid path" } as any };
        label = it.label?.trim() || undefined;
        cur = it.value;
        continue;
      }
      return { value: { kind: "issue", message: "Invalid path" } as any };
    }

    return { value: cur, ...(label ? { label } : {}) };
  };

  const childrenOfResolved = (base: ItemRef, v: Value): readonly ItemRef[] => {
    if (isEntryGroupValue(v) || isValueGroupValue(v)) {
      const len = isEntryGroupValue(v) ? v.entryIds.length : v.items.length;
      return Array.from({ length: len }, (_, i) => ({
        entryId: base.entryId,
        path: [...base.path, i],
      }));
    }
    return [];
  };

  const toContent = (ref: ItemRef, v: Value): ItemContent => {
    if (isBlankValue(v)) return { kind: "scalar", value: null };
    if (isIssueValue(v)) return { kind: "issue", message: v.message };
    if (isScalarValue(v))
      return {
        kind: "scalar",
        value:
          typeof v.value === "number" ||
          typeof v.value === "string" ||
          v.value === true
            ? v.value
            : null,
      };
    return { kind: "group", children: childrenOfResolved(ref, v) };
  };

  const editabilityOf = (ref: ItemRef): Editability => {
    if (!isEntryRef(ref)) return { kind: "none" };
    return entryContentToEditability(model.readEntry(ref.entryId).content);
  };

  const item = (ref: ItemRef): ItemSnapshot => {
    const r = resolve(ref);
    return {
      ref,
      ...(r.label ? { label: r.label } : {}),
      content: toContent(ref, r.value),
      edit: editabilityOf(ref),
    };
  };

  const commit = (run: (t: Tx) => void): ApplyResult => {
    const ops: Op[] = [];

    const t: Tx = {
      setLabel: (ref0, label) => {
        ops.push(model.ops.patchLabel(entryIdOf(ref0), label));
      },

      setContentScalar: (ref0, value) => {
        ops.push(
          model.ops.patchContent(entryIdOf(ref0), storedFromScalar(value)),
        );
      },

      setSourceField: (ref0, key, text) => {
        const id = entryIdOf(ref0);
        const prev: EntryContent = model.readEntry(id).content;

        if (key === "expr") {
          ops.push(model.ops.patchContent(id, { kind: "derived", expr: text }));
          return;
        }

        const base =
          prev.kind === "lens"
            ? prev
            : ({ kind: "lens", from: "", where: "", orderBy: "" } as const);

        if (key === "from")
          ops.push(
            model.ops.patchContent(id, {
              kind: "lens",
              from: text,
              where: base.where,
              orderBy: base.orderBy,
            }),
          );
        else if (key === "where")
          ops.push(
            model.ops.patchContent(id, {
              kind: "lens",
              from: base.from,
              where: text,
              orderBy: base.orderBy,
            }),
          );
        else if (key === "orderBy")
          ops.push(
            model.ops.patchContent(id, {
              kind: "lens",
              from: base.from,
              where: base.where,
              orderBy: text,
            }),
          );
      },

      insertChild: (ref0, opts2) => {
        const ownerId = entryIdOf(ref0);
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
            toOwnerId: ownerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );
        return id;
      },

      moveEntry: (id, toOwnerId, opts2) => {
        ops.push(
          model.ops.reparent({
            childId: id,
            toOwnerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );
      },

      removeEntry: (id) => {
        ops.push(model.ops.detach(id));
      },

      setView: (id, view) => {
        ops.push(model.ops.patchView(id, view));
      },
    };

    run(t);

    if (!ops.length) return { created: [], touched: [], reparented: [] };

    const txn = model.ops.transaction(ops);
    const result = model.apply(txn) as ApplyResult;

    runtime.setSelection(runtime.selectionSignal.peek());

    return result;
  };

  const edit: Tx = {
    setLabel: (ref0, label) => commit((t) => t.setLabel(ref0, label)),
    setContentScalar: (ref0, value) =>
      commit((t) => t.setContentScalar(ref0, value)),
    setSourceField: (ref0, key, text) =>
      commit((t) => t.setSourceField(ref0, key, text)),
    insertChild: (ref0, opts2) => {
      let out: EntryId = -1;
      commit((t) => {
        out = t.insertChild(ref0, opts2);
      });
      return out;
    },
    moveEntry: (id, toOwnerId, opts2) =>
      commit((t) => t.moveEntry(id, toOwnerId, opts2)),
    removeEntry: (id) => commit((t) => t.removeEntry(id)),
    setView: (id, view) => commit((t) => t.setView(id, view)),
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

  const mountView: Core["mountView"] = (args: any) =>
    (runtime.mountView as any)(args);

  const gc = (): void => {
    const { removedIds } = model.pruneUnreachable();
    evaluator.prune(removedIds);
  };

  const uninstallGlobal = runtime.installGlobalListeners(window);

  core = {
    dispose() {
      uninstallGlobal();
      gc();
      evaluator.dispose();
      runtime.dispose();
    },

    root: () => refOf(rootId),

    item,

    commit,
    edit,

    selection,
    focus,
    blur,

    attachFocus,
    mountView,
  };

  return { core, rootId };
}

export type { EntryId, ViewName, ViewKind, Value, LabeledValue };
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
  isEntryGroupValue,
  isValueGroupValue,
};
