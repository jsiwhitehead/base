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
  refKey,
  refFromKey,
} from "./runtime";
import { DEV, devAssert } from "../dev";

export type ItemRef = { entryId: EntryId; path: readonly number[] };

export type Scalar = true | number | string;
export type ScalarOrBlank = Scalar | null;

export type Content =
  | { kind: "scalar"; value: ScalarOrBlank }
  | { kind: "issue"; message: string }
  | { kind: "group"; children: readonly ItemRef[] };

export type Source =
  | { type: "derived"; expr: string }
  | { type: "lens"; from: string; where: string; orderBy: string };

export type Edit =
  | { kind: "none" }
  | { kind: "direct" }
  | { kind: "source"; source: Source };

export type ItemBase = {
  ref: ItemRef;
  label?: string;
};

export type Item =
  | (ItemBase & {
      edit: { kind: "direct" };
      content: Exclude<Content, { kind: "issue" }>;
    })
  | (ItemBase & {
      edit: Exclude<Edit, { kind: "direct" }>;
      content: Content;
    });

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

function storedFromScalar(v: ScalarOrBlank): EntryContent {
  return v === null ? { kind: "blank" } : { kind: "scalar", value: v };
}

function toEditFromContent(c: EntryContent): Edit {
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

function contentToScalarOrBlank(
  c: Extract<Content, { kind: "scalar" }>,
): ScalarOrBlank {
  return c.value;
}

export type Tx = {
  setLabel(ref: ItemRef, label: string): void;
  setView(entryId: EntryId, view: ViewKind): void;

  setScalar(ref: ItemRef, value: ScalarOrBlank): void;
  setSource(ref: ItemRef, source: Source): void;

  insertChild(
    owner: ItemRef,
    opts?: { at?: number; kind?: "blank" | "group" },
  ): EntryId;

  move(
    entryId: EntryId,
    toOwnerId: EntryId | null,
    opts?: { at?: number },
  ): void;
  remove(entryId: EntryId): void;
};

export type Core = {
  dispose(): void;

  root(): ItemRef;

  item(ref: ItemRef): Item;

  commit(run: (t: Tx) => void): ApplyResult;

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

  const childrenOfResolved = (base: ItemRef, v: Value): readonly ItemRef[] => {
    if (isEntryGroupValue(v)) {
      return v.entryIds.map((id) => ({ entryId: id, path: [] }));
    }
    if (isValueGroupValue(v)) {
      return v.items.map((_it, i) => ({
        entryId: base.entryId,
        path: [...base.path, i],
      }));
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

  const toEdit = (ref: ItemRef): Edit => {
    if (!isEntryRef(ref)) return { kind: "none" };
    const c = model.readEntry(ref.entryId).content;
    return toEditFromContent(c);
  };

  const item = (ref: ItemRef): Item => {
    try {
      const r = resolve(ref);
      const c = toContent(ref, r.value);
      const edit = toEdit(ref);

      const base: ItemBase = {
        ref,
        ...(r.label ? { label: r.label } : {}),
      };

      if (edit.kind === "direct") {
        devAssert(
          c.kind !== "issue",
          "Direct edit cannot pair with issue content",
        );
        return {
          ...base,
          edit,
          content: c as Exclude<Content, { kind: "issue" }>,
        };
      }

      return { ...base, edit, content: c };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ref,
        content: { kind: "issue", message: msg },
        edit: { kind: "none" },
      };
    }
  };

  const commit = (run: (t: Tx) => void): ApplyResult => {
    const ops: Op[] = [];

    const ensureEditableEntryRef = (ref: ItemRef) => {
      if (!isEntryRef(ref)) {
        if (DEV) throw new Error("Ref is not editable");
        return false;
      }
      return true;
    };

    const t: Tx = {
      setLabel: (ref0, label) => {
        if (!ensureEditableEntryRef(ref0)) return;
        ops.push(model.ops.patchLabel(ref0.entryId, label));
      },

      setView: (entryId, view) => {
        ops.push(model.ops.patchView(entryId, view));
      },

      setScalar: (ref0, value) => {
        if (!ensureEditableEntryRef(ref0)) return;
        ops.push(model.ops.patchContent(ref0.entryId, storedFromScalar(value)));
      },

      setSource: (ref0, source) => {
        if (!ensureEditableEntryRef(ref0)) return;

        if (source.type === "derived") {
          ops.push(
            model.ops.patchContent(ref0.entryId, {
              kind: "derived",
              expr: source.expr,
            }),
          );
          return;
        }

        ops.push(
          model.ops.patchContent(ref0.entryId, {
            kind: "lens",
            from: source.from,
            where: source.where,
            orderBy: source.orderBy,
          }),
        );
      },

      insertChild: (ownerRef, opts2) => {
        if (!ensureEditableEntryRef(ownerRef)) return -1;

        const ownerItem = item(ownerRef);
        if (
          ownerItem.edit.kind !== "direct" ||
          ownerItem.content.kind !== "group"
        ) {
          if (DEV) throw new Error("Owner is not a direct editable group");
          return -1;
        }

        const ownerId = ownerRef.entryId;
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

      move: (id, toOwnerId, opts2) => {
        ops.push(
          model.ops.reparent({
            childId: id,
            toOwnerId,
            ...(opts2?.at != null ? { toIndex: opts2.at } : {}),
          }),
        );
      },

      remove: (id) => {
        ops.push(model.ops.detach(id));
      },
    };

    run(t);

    if (!ops.length) return { created: [], touched: [], reparented: [] };

    const txn = model.ops.transaction(ops);
    const result = model.apply(txn) as ApplyResult;

    runtime.setSelection(runtime.selectionSignal.peek());

    return result;
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
export type { EntryId, ViewName, ViewKind };
export {
  parseScalar,
  clamp,
  isTextInput,
  defaultTextCaret,
  refKey,
  refFromKey,
};
