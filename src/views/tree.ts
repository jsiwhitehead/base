import { computed } from "@preact/signals-core";
import {
  type ItemId,
  type ViewKind,
  type Transaction,
  type Store,
  isGroupContent,
  isDerivedContent,
  isLensContent,
  canEditTextContent,
} from "../store";
import {
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  type Evaluator,
} from "../eval";
import {
  type Focus,
  type FocusTarget,
  type Caret,
  caret0,
  caretAt,
  type Selection,
  type EditorEffect,
  withSelection,
  type Editor,
  type NavDir,
  type NavMode,
  type ViewKeyResult,
  type View,
  focusSelection,
  type CmdResult,
  tryCmd,
  applyCmd,
  setIdle,
} from "../editor";
import {
  type Component,
  defaultTextNav,
  el,
  on,
  clamp,
  ensureTabbable,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  mountViewInto,
  parseScalar,
  getEditableText,
  textField,
  autosizeTextField,
  contentField,
} from "../dom";
import type { Runtime, ViewFactoryArgs } from "./index";
import { createView, viewWantsChildView } from "./index";

type HeaderKind = "derived" | "lens" | "none";

type HeaderFieldDef = Readonly<{
  field: "expr" | "from" | "where" | "orderBy";
  label: string;
  multiline: boolean;
}>;

const HEADER_FIELDS: Record<HeaderKind, readonly HeaderFieldDef[]> = {
  derived: [{ field: "expr", label: "=", multiline: true }],
  lens: [
    { field: "from", label: "~", multiline: false },
    { field: "where", label: "where:", multiline: true },
    { field: "orderBy", label: "orderBy:", multiline: true },
  ],
  none: [],
} as const;

function headerFieldsForItem(
  store: Store,
  id: ItemId,
): readonly HeaderFieldDef[] {
  const content = store.readItem(id).content;
  if (isDerivedContent(content)) return HEADER_FIELDS.derived;
  if (isLensContent(content)) return HEADER_FIELDS.lens;
  return HEADER_FIELDS.none;
}

function headerFieldValue(
  store: Store,
  id: ItemId,
  def: HeaderFieldDef,
): string {
  const c = store.readItem(id).content;
  if (isDerivedContent(c)) {
    return def.field === "expr" ? (c.expr ?? "") : "";
  }
  if (isLensContent(c)) {
    switch (def.field) {
      case "from":
        return c.from ?? "";
      case "where":
        return c.where ?? "";
      case "orderBy":
        return c.orderBy ?? "";
      default:
        return "";
    }
  }
  return "";
}

const focusKey = (f: Focus) => `${String(f.scopeId)}::${String(f.id)}`;

const hasHeaderFields = (store: Store, id: ItemId) =>
  headerFieldsForItem(store, id).length > 0;

const isNavStop = (store: Store, evaluator: Evaluator, id: ItemId) => {
  const kids = evaluator.items(id);
  return kids.length === 0 || hasHeaderFields(store, id);
};

const defaultTargetFor = (store: Store, id: ItemId): FocusTarget =>
  hasHeaderFields(store, id)
    ? { kind: "header", index: 1 }
    : { kind: "content" };

function collectNavStopsFrom(
  store: Store,
  evaluator: Evaluator,
  rootId: ItemId,
): Focus[] {
  const out: Focus[] = [];
  const walk = (ownerId: ItemId) => {
    for (const id of evaluator.items(ownerId)) {
      if (isNavStop(store, evaluator, id)) out.push({ scopeId: ownerId, id });
      walk(id);
    }
  };
  walk(rootId);
  return out;
}

function treeNavMove(
  store: Store,
  evaluator: Evaluator,
  stops: Focus[],
  sel: Selection,
  dir: NavDir,
  mode: NavMode,
): { selection: Selection; effects: EditorEffect[] } | null {
  if (sel.kind !== "focused") return null;

  const from = sel.focus;
  const at = Math.max(
    0,
    stops.findIndex((s) => focusKey(s) === focusKey(from)),
  );

  const neighbor = (delta: -1 | 1) => {
    const j = at + delta;
    return j >= 0 && j < stops.length ? stops[j]! : null;
  };

  const parentFocus = (): Focus | null => {
    const ownerId = store.readItem(from.scopeId).ownerId;
    return ownerId == null ? null : { scopeId: ownerId, id: from.scopeId };
  };

  const firstChildStop = (id: ItemId): Focus | null => {
    for (const cid of evaluator.items(id)) {
      if (isNavStop(store, evaluator, cid)) return { scopeId: id, id: cid };
      const deeper = firstChildStop(cid);
      if (deeper) return deeper;
    }
    return null;
  };

  let next: Focus | null = null;

  if (dir === "up") next = neighbor(-1);
  else if (dir === "down") next = neighbor(1);
  else if (dir === "right") {
    next = firstChildStop(from.id) ?? neighbor(1);
    if (mode === "jump") next = neighbor(1) ?? next;
  } else if (dir === "left") {
    next = parentFocus() ?? neighbor(-1);
    if (mode === "jump") next = neighbor(-1) ?? next;
  }

  if (!next) return null;

  const res = focusSelection(next, defaultTargetFor(store, next.id), caret0());
  return { selection: res.selection, effects: res.effects };
}

export const treeCommands = {
  setLabel(editor: Editor, f: Focus, text: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      editor.commit(store.op.transaction([store.op.patchLabel(f.id, text)]));
      return { didChange: true };
    });
  },

  setScalarValue(editor: Editor, id: ItemId, text: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      if (!canEditTextContent(store, id)) return { didChange: false };
      editor.commit(
        store.op.transaction([
          store.op.patchContent(id, {
            kind: "scalar",
            value: parseScalar(text),
          }),
        ]),
      );
      return { didChange: true };
    });
  },

  setDerived(editor: Editor, f: Focus): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const nextSel = focusSelection(f, { kind: "header", index: 1 }, caret0());

      editor.commit(
        store.op.transaction([
          store.op.patchContent(f.id, { kind: "derived", expr: "" }),
        ]),
        withSelection({ selection: nextSel.selection }),
      );

      return { didChange: true };
    });
  },

  commitHeaderField(
    editor: Editor,
    f: Focus,
    def: HeaderFieldDef,
    text: string,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const it = store.readItem(f.id);
      const c = it.content;

      if (isDerivedContent(c)) {
        if (def.field !== "expr") return { didChange: false };
        editor.commit(
          store.op.transaction([
            store.op.patchContent(f.id, { kind: "derived", expr: text }),
          ]),
        );
        return { didChange: true };
      }

      if (!isLensContent(c)) return { didChange: false };

      editor.commit(
        store.op.transaction([
          store.op.patchContent(f.id, {
            kind: "lens",
            from: def.field === "from" ? text : c.from,
            where: def.field === "where" ? text : c.where,
            orderBy: def.field === "orderBy" ? text : c.orderBy,
          }),
        ]),
      );

      return { didChange: true };
    });
  },

  insertSibling(
    editor: Editor,
    sel: Selection,
    side: "before" | "after",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      const loc = store.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const at = side === "before" ? loc.index : loc.index + 1;
      const id = store.createId();

      const txn: Transaction = store.op.transaction([
        store.op.create(store.create.blank(id)),
        store.op.reparent({ childId: id, toOwnerId: loc.ownerId, toIndex: at }),
      ]);

      const nextSel = focusSelection(
        { scopeId: f.scopeId, id },
        { kind: "content" },
        caret0(),
      );

      editor.commit(txn, withSelection({ selection: nextSel.selection }));
      return { didChange: true };
    });
  },

  splitAt(
    editor: Editor,
    evaluator: Evaluator,
    sel: Selection,
    caretStart: number,
    caretEnd = caretStart,
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      if (!canEditTextContent(store, f.id))
        return treeCommands.insertSibling(editor, sel, "after");

      const loc = store.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const curText = getEditableText(store, evaluator, f.id).text;
      const len = curText.length;
      const start = clamp(caretStart, 0, len);
      const end = clamp(caretEnd, 0, len);

      const left = curText.slice(0, start);
      const right = curText.slice(end);

      const rightId = store.createId();

      const txn: Transaction = store.op.transaction([
        store.op.patchContent(f.id, {
          kind: "scalar",
          value: parseScalar(left),
        }),
        store.op.create(store.create.blank(rightId)),
        store.op.reparent({
          childId: rightId,
          toOwnerId: loc.ownerId,
          toIndex: loc.index + 1,
        }),
        store.op.patchContent(rightId, {
          kind: "scalar",
          value: parseScalar(right),
        }),
      ]);

      const nextSel = focusSelection(
        { scopeId: f.scopeId, id: rightId },
        { kind: "content" },
        caret0(),
      );

      editor.commit(txn, withSelection({ selection: nextSel.selection }));
      return { didChange: true };
    });
  },

  joinBoundary(
    editor: Editor,
    evaluator: Evaluator,
    sel: Selection,
    dir: "backward" | "forward",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      if (!canEditTextContent(store, f.id)) return { didChange: false };

      const loc = store.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const neighborId =
        dir === "backward"
          ? loc.items[loc.index - 1]
          : loc.items[loc.index + 1];
      if (neighborId == null || !canEditTextContent(store, neighborId))
        return { didChange: false };

      const leftId = dir === "backward" ? neighborId : f.id;
      const rightId = dir === "backward" ? f.id : neighborId;

      const a = getEditableText(store, evaluator, leftId).text;
      const b = getEditableText(store, evaluator, rightId).text;

      const survivorId = leftId;
      const removedId = rightId;

      const txn: Transaction = store.op.transaction([
        store.op.patchContent(survivorId, {
          kind: "scalar",
          value: parseScalar(a + b),
        }),
        store.op.detach(removedId),
      ]);

      const nextSel = focusSelection(
        { scopeId: f.scopeId, id: survivorId },
        { kind: "content" },
        caretAt(a.length),
      );

      editor.commit(txn, withSelection({ selection: nextSel.selection }));
      return { didChange: true };
    });
  },

  removeItem(
    editor: Editor,
    evaluator: Evaluator,
    sel: Selection,
    prefer: "prev" | "next",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      const loc = store.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const prevId = loc.items[loc.index - 1] ?? null;
      const nextId = loc.items[loc.index + 1] ?? null;

      const chosen =
        prefer === "prev"
          ? (prevId ?? nextId ?? loc.ownerId)
          : (nextId ?? prevId ?? loc.ownerId);

      const containerKids = evaluator.items(f.scopeId);
      const nextFocus: Focus = containerKids.includes(chosen as ItemId)
        ? { scopeId: f.scopeId, id: chosen as ItemId }
        : { scopeId: loc.ownerId, id: chosen as ItemId };

      const nextSel = focusSelection(
        nextFocus,
        defaultTargetFor(store, nextFocus.id),
        caret0(),
      );

      editor.commit(
        store.op.transaction([store.op.detach(f.id)]),
        withSelection({ selection: nextSel.selection }),
      );

      return { didChange: true };
    });
  },

  changeNesting(
    editor: Editor,
    evaluator: Evaluator,
    sel: Selection,
    dir: "in" | "out",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      if (dir === "in") {
        const loc = store.locateInOwner(f.id);
        if (!loc) return { didChange: false };

        const childInfo = store.readItem(f.id);
        const wrapperId = store.createId();
        const wrapper = store.create.group(wrapperId);

        const txn: Transaction = store.op.transaction([
          store.op.create({ ...wrapper, label: childInfo.label }),
          store.op.reparent({
            childId: wrapperId,
            toOwnerId: loc.ownerId,
            toIndex: loc.index,
          }),
          store.op.patchLabel(f.id, ""),
          store.op.reparent({
            childId: f.id,
            toOwnerId: wrapperId,
            toIndex: 0,
          }),
        ]);

        const nextSel = focusSelection(
          { scopeId: wrapperId, id: f.id },
          defaultTargetFor(store, f.id),
          caret0(),
        );

        editor.commit(txn, withSelection({ selection: nextSel.selection }));
        return { didChange: true };
      }

      const child = store.readItem(f.id);
      const wrapperId = child.ownerId;
      if (wrapperId == null) return { didChange: false };

      const wrapper = store.readItem(wrapperId);
      if (!isGroupContent(wrapper.content)) return { didChange: false };

      const kids = evaluator.items(wrapperId);
      if (kids.length !== 1 || kids[0] !== f.id) return { didChange: false };

      const ownerId = wrapper.ownerId;
      if (ownerId == null) return { didChange: false };

      const idx = evaluator.items(ownerId).indexOf(wrapperId);
      if (idx < 0) return { didChange: false };

      const txn: Transaction = store.op.transaction([
        store.op.reparent({ childId: f.id, toOwnerId: ownerId, toIndex: idx }),
        store.op.detach(wrapperId),
        store.op.patchLabel(f.id, wrapper.label),
      ]);

      const nextSel = focusSelection(
        { scopeId: ownerId, id: f.id },
        defaultTargetFor(store, f.id),
        caret0(),
      );

      editor.commit(txn, withSelection({ selection: nextSel.selection }));
      return { didChange: true };
    });
  },

  confirm(editor: Editor, evaluator: Evaluator, sel: Selection): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    if (sel.target.kind === "header") {
      const nextSel = focusSelection(f, { kind: "content" }, caret0());
      return { didChange: false, selection: nextSel.selection };
    }

    return canEditTextContent(store, f.id)
      ? treeCommands.splitAt(editor, evaluator, sel, 0, 0)
      : treeCommands.insertSibling(editor, sel, "after");
  },

  deleteBoundary(
    editor: Editor,
    evaluator: Evaluator,
    sel: Selection,
    dir: "backward" | "forward",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    const prefer = dir === "backward" ? "prev" : "next";

    if (!canEditTextContent(store, f.id))
      return treeCommands.removeItem(editor, evaluator, sel, prefer);

    const txt = getEditableText(store, evaluator, f.id).text;
    if (txt.length === 0)
      return treeCommands.removeItem(editor, evaluator, sel, prefer);

    return treeCommands.joinBoundary(editor, evaluator, sel, dir);
  },
} as const;

type TreeMountCtx = {
  runtime: Runtime;
  editor: Editor;
  evaluator: Evaluator;
  rootId: ItemId;
  navMove: (
    sel: Selection,
    dir: NavDir,
    mode: NavMode,
  ) => { selection: Selection; effects: EditorEffect[] } | null;
  dispatch: (intent: TreeIntent) => ViewKeyResult;
};

type TreeNodeSpec = {
  focus: Focus;
  showHeader: boolean;
};

type TreeIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" }
  | { type: "INDENT"; dir: "in" | "out" }
  | { type: "DELETE_BOUNDARY"; dir: "backward" | "forward" }
  | { type: "SPLIT"; caret: Caret }
  | { type: "SET_DERIVED" };

function mountTreeHeader(
  mountCtx: TreeMountCtx,
  focus: Focus,
  defs: readonly HeaderFieldDef[],
  onTargets: (targets: HTMLElement[]) => void,
): Component {
  const { editor } = mountCtx;
  const store = editor.store;

  return createComponent((componentCtx) => {
    const wrap = el("div");
    const labelHost = el("div");
    const fieldsHost = el("div", "header-fields");
    wrap.append(labelHost, fieldsHost);

    const toContent = () => {
      editor.setSelection(
        focusSelection(focus, { kind: "content" }, caret0()).selection,
      );
    };

    const labelComp = autosizeTextField({
      editor,
      focus,
      target: { kind: "header", index: 0 },
      registerFocus: false,
      commit: (text) =>
        applyCmd(editor, treeCommands.setLabel(editor, focus, text)),
      getState: () => ({
        text: store.readItem(focus.id).label ?? "",
        readOnly: false,
        isIssue: false,
      }),
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["input", "blur"],
      wrapClassName: "autosize label",
      textKeys: (inp) => {
        const inputEl = inp as HTMLInputElement;
        return on(inputEl, "keydown", (e: KeyboardEvent) => {
          if (e.key === " ") {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            toContent();
          }
        });
      },
    });

    labelHost.replaceChildren(labelComp.el);
    componentCtx.use(labelComp);

    const targets: HTMLElement[] = [];
    const labelInput =
      labelComp.el.querySelector<HTMLInputElement>("input") ?? labelComp.el;
    targets.push(labelInput);

    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]!;
      const labelEl = el("span", "equals", d.label);
      const valueHost = el("div");
      const row = el("div", "wrap");
      row.append(labelEl, valueHost);
      fieldsHost.append(row);
      const headerIndex = i + 1;

      const fc = textField({
        editor,
        focus,
        target: { kind: "header", index: headerIndex },
        multiline: d.multiline,
        caret: "fromTarget",
        stopPropagation: true,
        registerFocus: false,
        commit: (text) =>
          applyCmd(
            editor,
            treeCommands.commitHeaderField(editor, focus, d, text),
          ),
        getState: () => ({
          text: headerFieldValue(store, focus.id, d),
          readOnly: false,
          isIssue: false,
        }),
        onCommitEvents: ["input", "blur"],
        textKeys: (inp) => {
          const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;
          return on(inputEl, "keydown", (e: KeyboardEvent) => {
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              toContent();
            }
          });
        },
      });

      valueHost.replaceChildren(fc.el);
      componentCtx.use(fc);
      targets.push(fc.el);
    }

    onTargets(targets);
    componentCtx.onCleanup(() => onTargets([]));

    return wrap;
  });
}

function mountTreeChildren(mountCtx: TreeMountCtx, focus: Focus): Component {
  const { editor, evaluator } = mountCtx;

  return createComponent((componentCtx) => {
    const container = el("div", "group");
    ensureTabbable(container);

    const mgr = componentCtx.list(container, (childId: ItemId) =>
      mountTreeNode(mountCtx, {
        focus: { scopeId: focus.id, id: childId },
        showHeader: true,
      }),
    );

    componentCtx.watch(
      () => evaluator.items(focus.id),
      (items) => {
        mgr.update(items);
      },
    );

    componentCtx.on(container, "pointerdown", (e: PointerEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      editor.setSelection(
        focusSelection(focus, { kind: "content" }, caret0()).selection,
      );
      e.stopPropagation();
    });

    return container;
  });
}

function mountTreeBody(
  mountCtx: TreeMountCtx,
  focus: Focus,
  onContentTarget: (el0: HTMLElement | null) => void,
): Component {
  const { editor, evaluator, dispatch, runtime } = mountCtx;
  const store = editor.store;

  return createComponent((componentCtx) => {
    const host = el("div");
    const viewKind = store.readItem(focus.id).view as ViewKind;

    if (viewWantsChildView(viewKind)) {
      const childView = createView(runtime, viewKind, focus.id, focus);
      if (childView) {
        ensureTabbable(childView.root);
        onContentTarget(childView.root);
        componentCtx.use(mountViewInto(editor, host, childView));
        return host;
      }
    }

    const vf = contentField({
      editor,
      evaluator,
      focus,
      id: focus.id,
      registerFocus: false,
      commitScalarText: (text) =>
        applyCmd(editor, treeCommands.setScalarValue(editor, focus.id, text)),
      textKeys: (inp) => {
        const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;
        const stops: Array<() => void> = [];

        stops.push(
          on(inputEl, "keydown", (e: KeyboardEvent) => {
            if (e.key === "=" && !inputEl.value) {
              stopEvent(e);
              dispatch({ type: "SET_DERIVED" });
            }
          }),
        );

        stops.push(
          bindTextControlKeys(inputEl, {
            nav: defaultTextNav,
            onNav: (dir, mode) => dispatch({ type: "NAV", dir, mode }),
            onEnter: (caret) => dispatch({ type: "SPLIT", caret }),
            onTab: (shift) =>
              dispatch({ type: "INDENT", dir: shift ? "out" : "in" }),
            onBackspaceBoundary: () =>
              dispatch({ type: "DELETE_BOUNDARY", dir: "backward" }),
            onDeleteBoundary: () =>
              dispatch({ type: "DELETE_BOUNDARY", dir: "forward" }),
            onEscape: () => dispatch({ type: "CANCEL" }),
          }),
        );

        return () => {
          for (const fn of stops.toReversed()) fn();
        };
      },
      renderItemGroupChild: (childId) => {
        const d = el("div", "item readonly");
        return createComponent((componentCtx) => {
          componentCtx.watch(
            () => {
              const v = evaluator.value(childId);
              const isIssue = isIssueValue(v);
              const text = isIssue
                ? v.message
                : isScalarValue(v)
                  ? String(v.value)
                  : "";
              return { text, isIssue };
            },
            ({ text, isIssue }) => {
              d.textContent = text;
              d.classList.toggle("issue", isIssue);
            },
          );
          return d;
        });
      },
    });

    host.replaceChildren(vf.el);
    componentCtx.use(vf);

    ensureTabbable(vf.el);
    onContentTarget(vf.el);
    componentCtx.onCleanup(() => onContentTarget(null));

    return host;
  });
}

function mountTreeNode(mountCtx: TreeMountCtx, spec: TreeNodeSpec): Component {
  const { editor, evaluator } = mountCtx;
  const store = editor.store;
  const { focus } = spec;

  return createComponent((componentCtx) => {
    const root = el("div", "item");
    const headerContainer = el("div", "header");
    const contentContainer = el("div", "content-host");
    root.append(contentContainer);

    const headerSlot = componentCtx.slot(headerContainer);
    const contentSlot = componentCtx.slot(contentContainer);

    let headerTargets: HTMLElement[] = [];
    let contentTargetEl: HTMLElement | null = contentContainer;

    componentCtx.focusable({
      editor,
      focus,
      elementFor: (target) =>
        target.kind === "content"
          ? contentTargetEl
          : (headerTargets[target.index] ?? null),
    });

    const setHeaderTargets = (targets: HTMLElement[]) => {
      headerTargets = targets;
    };

    const setContentTarget = (el0: HTMLElement | null) => {
      contentTargetEl = el0 ?? contentContainer;
    };

    componentCtx.watch(
      () => {
        const sel = editor.runtime.selection.value;
        return (
          sel.kind === "focused" && focusKey(sel.focus) === focusKey(focus)
        );
      },
      (focused) => {
        root.classList.toggle("focused", focused);
      },
    );

    let lastHeaderKey: string | null = null;
    let lastContentMode: "children" | "body" | null = null;
    componentCtx.watch(
      () => {
        const info = store.readItem(focus.id);
        const defs = headerFieldsForItem(store, focus.id);
        const label = (info.label ?? "").trim();
        const contentKind = info.content.kind;
        const headerKind =
          contentKind === "derived"
            ? "derived"
            : contentKind === "lens"
              ? "lens"
              : "none";

        const v = evaluator.value(focus.id);
        const mode: "children" | "body" = isItemGroupValue(v)
          ? "children"
          : "body";

        const sel = editor.runtime.selection.value;
        const labelFocused =
          sel.kind === "focused" &&
          focusKey(sel.focus) === focusKey(focus) &&
          sel.target.kind === "header" &&
          sel.target.index === 0;

        return {
          label,
          defs,
          headerKind,
          mode,
          isIssue: isIssueValue(v),
          labelFocused,
        };
      },
      ({ label, defs, headerKind, mode, isIssue, labelFocused }) => {
        const needHeader =
          spec.showHeader && (label !== "" || defs.length > 0 || labelFocused);
        const headerKey = `${needHeader ? "on" : "off"}:${headerKind}:${defs.length}`;

        if (headerKey !== lastHeaderKey) {
          lastHeaderKey = headerKey;

          if (needHeader) {
            if (headerContainer.parentElement !== root)
              root.insertBefore(headerContainer, contentContainer);

            headerSlot.set(
              mountTreeHeader(mountCtx, focus, defs, setHeaderTargets),
            );
          } else {
            headerSlot.set(null);
            setHeaderTargets([]);
            if (headerContainer.parentElement === root)
              headerContainer.remove();
          }
        }

        contentContainer.classList.toggle("issue", isIssue);

        if (mode !== lastContentMode) {
          lastContentMode = mode;

          if (mode === "children") {
            const kids = mountTreeChildren(mountCtx, focus);
            contentSlot.set(kids);
            setContentTarget(kids.el);
            ensureTabbable(kids.el);
          } else {
            contentSlot.set(mountTreeBody(mountCtx, focus, setContentTarget));
          }
        }
      },
    );

    return root;
  });
}

export function createTreeView({ runtime, id: rootId }: ViewFactoryArgs): View {
  const { editor, evaluator } = runtime;
  const store = editor.store;

  const root = el("div", "view tree");
  const viewId = `tree:${String(rootId)}`;

  const navStopsSignal = computed(() =>
    collectNavStopsFrom(store, evaluator, rootId),
  );

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    treeNavMove(store, evaluator, navStopsSignal.value, sel, dir, mode);

  const dispatch = (intent: TreeIntent): ViewKeyResult => {
    const sel = editor.runtime.selection.value;

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) editor.setSelection(res.selection);
        return;
      }

      case "CONFIRM": {
        applyCmd(editor, treeCommands.confirm(editor, evaluator, sel));
        return;
      }

      case "CANCEL": {
        setIdle(editor);
        return;
      }

      case "INDENT": {
        applyCmd(
          editor,
          treeCommands.changeNesting(editor, evaluator, sel, intent.dir),
        );
        return;
      }

      case "DELETE_BOUNDARY": {
        applyCmd(
          editor,
          treeCommands.deleteBoundary(editor, evaluator, sel, intent.dir),
        );
        return;
      }

      case "SPLIT": {
        applyCmd(
          editor,
          treeCommands.splitAt(
            editor,
            evaluator,
            sel,
            intent.caret.start,
            intent.caret.end,
          ),
        );
        return;
      }

      case "SET_DERIVED": {
        if (sel.kind !== "focused") return;
        applyCmd(editor, treeCommands.setDerived(editor, sel.focus));
        return;
      }
    }
  };

  const node = mountTreeNode(
    { runtime, editor, evaluator, rootId, navMove, dispatch },
    { focus: { scopeId: rootId, id: rootId }, showHeader: false },
  );

  root.append(node.el);

  return {
    id: viewId,
    root,

    normalizeTarget({ store: contextStore }, focus, target) {
      const activeStore = contextStore ?? store;

      if (target.kind !== "header") return target;

      if (focus.id === rootId) return { kind: "content" };

      const defs = headerFieldsForItem(activeStore, focus.id);

      if (target.index === 0) return { kind: "header", index: 0 };

      if (defs.length === 0) return { kind: "content" };

      const max = defs.length;
      const idx = Math.max(1, Math.min(target.index, max));
      return { kind: "header", index: idx };
    },

    onActivate() {
      if (editor.runtime.selection.value.kind !== "idle") return;

      const first = navStopsSignal.value[0];
      if (!first) return;

      editor.setSelection(
        focusSelection(first, defaultTargetFor(store, first.id), caret0())
          .selection,
      );
    },

    onKeyDown(e): ViewKeyResult {
      const mode: NavMode = e.metaKey || e.ctrlKey ? "jump" : "step";

      const arrowDir: Record<string, NavDir> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
      };

      const dir = arrowDir[e.key];
      if (dir) {
        stopEvent(e);
        return dispatch({ type: "NAV", dir, mode });
      }

      if (e.key === "Enter") {
        stopEvent(e);
        return dispatch({ type: "CONFIRM" });
      }

      if (e.key === "Backspace") {
        stopEvent(e);
        return dispatch({ type: "DELETE_BOUNDARY", dir: "backward" });
      }

      if (e.key === "Delete") {
        stopEvent(e);
        return dispatch({ type: "DELETE_BOUNDARY", dir: "forward" });
      }

      if (e.key === "Tab") {
        stopEvent(e);
        return dispatch({ type: "INDENT", dir: e.shiftKey ? "out" : "in" });
      }

      if (e.key === "Escape") {
        stopEvent(e);
        return dispatch({ type: "CANCEL" });
      }
    },

    dispose() {
      node.dispose();
      root.replaceChildren();
    },
  };
}
