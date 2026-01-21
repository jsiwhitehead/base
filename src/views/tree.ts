import { computed } from "@preact/signals-core";
import type {
  Store,
  ItemId,
  Transaction,
  ViewKind,
  StoredContent,
} from "../store";
import type {
  Editor,
  View,
  Selection,
  Focus,
  FocusTarget,
  EditorEffect,
  ViewKeyResult,
  NavDir,
  NavMode,
  CmdResult,
  Caret,
} from "../editor";
import {
  focusSelection,
  caret0,
  caretAt,
  withSelection,
  tryCmd,
  applyCmd,
  setIdle,
} from "../editor";
import type { Evaluator } from "../eval";
import {
  createComponent,
  el,
  on,
  clamp,
  ensureTabbable,
  stopEvent,
  bindTextControlKeys,
  parseScalar,
  getEditableText,
  contentField,
  autosizeTextField,
  textField,
  defaultTextNav,
  mountViewInto,
  type Component,
} from "../dom";
import type { Runtime, ViewFactoryArgs } from "./index";
import { createView, viewWantsChildView } from "./index";

type HeaderFieldKey =
  | "derived.expr"
  | "lens.from"
  | "lens.where"
  | "lens.orderBy";

type HeaderFieldDef = Readonly<{
  key: HeaderFieldKey;
  label: string;
  multiline: boolean;
}>;

const DERIVED_FIELDS: readonly HeaderFieldDef[] = [
  { key: "derived.expr", label: "=", multiline: true },
] as const;

const LENS_FIELDS: readonly HeaderFieldDef[] = [
  { key: "lens.from", label: "~", multiline: false },
  { key: "lens.where", label: "where:", multiline: true },
  { key: "lens.orderBy", label: "orderBy:", multiline: true },
] as const;

function contentKindOf(store: Store, id: ItemId): StoredContent["kind"] {
  return store.readItem(id).content.kind;
}

function headerFieldsForItem(store: Store, id: ItemId) {
  const kind = contentKindOf(store, id);
  if (kind === "derived") return DERIVED_FIELDS;
  if (kind === "lens") return LENS_FIELDS;
  return [] as const;
}

function headerFieldValueForItem(
  store: Store,
  id: ItemId,
  key: HeaderFieldKey,
): string {
  const it = store.readItem(id);
  const c = it.content;

  if (c.kind === "derived") return key === "derived.expr" ? (c.expr ?? "") : "";
  if (c.kind !== "lens") return "";

  switch (key) {
    case "lens.from":
      return c.from ?? "";
    case "lens.where":
      return c.where ?? "";
    case "lens.orderBy":
      return c.orderBy ?? "";
    default:
      return "";
  }
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

function canEditScalarText(store: Store, id: ItemId): boolean {
  const kind = store.readItem(id).content.kind;
  return kind === "blank" || kind === "scalar";
}

export const treeCommands = {
  commitLabel(editor: Editor, f: Focus, text: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      editor.commit(store.op.transaction([store.op.patchLabel(f.id, text)]));
      return { didChange: true };
    });
  },

  commitScalarText(
    editor: Editor,
    evaluator: Evaluator,
    id: ItemId,
    text: string,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      if (!canEditScalarText(store, id)) return { didChange: false };
      editor.commit(
        store.op.transaction([
          store.op.patchContent(id, {
            kind: "scalar",
            value: parseScalar(text),
          }),
        ]),
      );
      void evaluator;
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
    store: Store,
    f: Focus,
    fieldKey: string,
    text: string,
  ): CmdResult {
    return tryCmd(() => {
      const it = store.readItem(f.id);
      const c = it.content;

      if (fieldKey === "derived.expr") {
        editor.commit(
          store.op.transaction([
            store.op.patchContent(f.id, { kind: "derived", expr: text }),
          ]),
        );
        return { didChange: true };
      }

      if (c.kind !== "lens") return { didChange: false };

      const next = {
        from: fieldKey === "lens.from" ? text : c.from,
        where: fieldKey === "lens.where" ? text : c.where,
        orderBy: fieldKey === "lens.orderBy" ? text : c.orderBy,
      };

      editor.commit(
        store.op.transaction([
          store.op.patchContent(f.id, { kind: "lens", ...next }),
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
      if (!canEditScalarText(store, f.id))
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
      if (!canEditScalarText(store, f.id)) return { didChange: false };

      const loc = store.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const neighborId =
        dir === "backward"
          ? loc.items[loc.index - 1]
          : loc.items[loc.index + 1];
      if (neighborId == null || !canEditScalarText(store, neighborId))
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
      if (wrapper.content.kind !== "group") return { didChange: false };

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

    return canEditScalarText(store, f.id)
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

    if (!canEditScalarText(store, f.id))
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
  store: Store;
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
  ctx0: TreeMountCtx,
  focus: Focus,
  defs: readonly HeaderFieldDef[],
  onTargets: (targets: HTMLElement[]) => void,
): Component {
  const { editor, store } = ctx0;

  return createComponent((ctx) => {
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
      commit: (text) =>
        applyCmd(editor, treeCommands.commitLabel(editor, focus, text)),
      getState: () => ({
        text: store.readItem(focus.id).label ?? "",
        readOnly: false,
        isIssue: false,
      }),
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["input", "blur"],
      wrapClassName: "autosize label",
      textKeys: (inp) =>
        on(inp as any, "keydown", (e: any) => {
          if (e.key === " ") {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            toContent();
          }
        }),
    });

    labelHost.replaceChildren(labelComp.el);
    ctx.use(labelComp);

    const targets: HTMLElement[] = [];
    targets.push((labelComp.el as any).querySelector("input") ?? labelComp.el);

    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]!;
      const row = el("div", "wrap");
      row.append(el("span", "equals", d.label), el("div"));
      fieldsHost.append(row);

      const host = row.lastElementChild as HTMLElement;
      const headerIndex = i + 1;

      const fc = textField({
        editor,
        focus,
        target: { kind: "header", index: headerIndex },
        multiline: d.multiline,
        caret: "fromTarget",
        stopPropagation: true,
        commit: (text) =>
          applyCmd(
            editor,
            treeCommands.commitHeaderField(editor, store, focus, d.key, text),
          ),
        getState: () => ({
          text: headerFieldValueForItem(store, focus.id, d.key as any),
          readOnly: false,
          isIssue: false,
        }),
        onCommitEvents: ["input", "blur"],
        textKeys: (inp) =>
          on(inp as any, "keydown", (e: any) => {
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              toContent();
            }
          }),
      });

      host.replaceChildren(fc.el);
      ctx.use(fc);
      targets.push(fc.el);
    }

    onTargets(targets);
    ctx.onCleanup(() => onTargets([]));

    return wrap;
  });
}

function mountTreeChildren(ctx0: TreeMountCtx, focus: Focus): Component {
  const { editor, evaluator } = ctx0;

  return createComponent((ctx) => {
    const container = el("div", "group");
    ensureTabbable(container);

    const mgr = ctx.list(container, (childId: ItemId) =>
      mountTreeNode(ctx0, {
        focus: { scopeId: focus.id, id: childId },
        showHeader: true,
      }),
    );

    ctx.watch(() => {
      mgr.update(evaluator.items(focus.id));
    });

    ctx.on(container, "pointerdown", (e) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      editor.setSelection(
        focusSelection(focus, { kind: "content" }, caret0()).selection,
      );
      e.stopPropagation();
    });

    return container;
  });
}

function mountTreeBody(
  ctx0: TreeMountCtx,
  focus: Focus,
  onContentTarget: (el0: HTMLElement | null) => void,
): Component {
  const { editor, evaluator, store, dispatch, runtime } = ctx0;

  return createComponent((ctx) => {
    const host = el("div");
    const viewKind = store.readItem(focus.id).view as ViewKind;

    if (viewWantsChildView(viewKind)) {
      const childView = createView(runtime, viewKind, focus.id, focus);
      if (childView) {
        ensureTabbable(childView.root);
        onContentTarget(childView.root);
        ctx.use(mountViewInto(editor, host, childView));
        return host;
      }
    }

    const vf = contentField({
      editor,
      evaluator,
      focus,
      id: focus.id,
      commitScalarText: (text) =>
        applyCmd(
          editor,
          treeCommands.commitScalarText(editor, evaluator, focus.id, text),
        ),
      textKeys: (inp) => {
        const stops: Array<() => void> = [];

        stops.push(
          on(inp as any, "keydown", (e: KeyboardEvent) => {
            if (e.key === "=" && !inp.value) {
              stopEvent(e);
              dispatch({ type: "SET_DERIVED" });
            }
          }),
        );

        stops.push(
          bindTextControlKeys(inp, {
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
        return createComponent((cctx) => {
          cctx.watch(() => {
            const v = evaluator.value(childId);
            d.textContent =
              v.kind === "issue"
                ? v.message
                : v.kind === "scalar"
                  ? String(v.value)
                  : "";
            d.classList.toggle("issue", v.kind === "issue");
          });
          return d;
        });
      },
    });

    host.replaceChildren(vf.el);
    ctx.use(vf);

    ensureTabbable(vf.el);
    onContentTarget(vf.el);
    ctx.onCleanup(() => onContentTarget(null));

    return host;
  });
}

function mountTreeNode(ctx0: TreeMountCtx, spec: TreeNodeSpec): Component {
  const { editor, evaluator, store } = ctx0;
  const { focus } = spec;

  return createComponent((ctx) => {
    const root = el("div", "item");
    const headerContainer = el("div", "header");
    const contentContainer = el("div", "content-host");
    root.append(contentContainer);

    const headerSlot = ctx.slot(headerContainer);
    const contentSlot = ctx.slot(contentContainer);

    let headerTargets: HTMLElement[] = [];
    let contentTargetEl: HTMLElement | null = contentContainer;

    ctx.focusable({
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

    ctx.watch(() => {
      const info = store.readItem(focus.id);
      const defs = headerFieldsForItem(store, focus.id);
      const label = info.label ?? "";

      const sel = editor.runtime.selection.value;
      const focused =
        sel.kind === "focused" && focusKey(sel.focus) === focusKey(focus);
      const labelFocused =
        focused &&
        sel.kind === "focused" &&
        sel.target.kind === "header" &&
        sel.target.index === 0;

      const needHeader =
        spec.showHeader &&
        (label.trim() !== "" || defs.length > 0 || labelFocused);

      if (needHeader) {
        if (headerContainer.parentElement !== root)
          root.insertBefore(headerContainer, contentContainer);

        headerSlot.set(mountTreeHeader(ctx0, focus, defs, setHeaderTargets));
      } else {
        headerSlot.set(null);
        setHeaderTargets([]);
        if (headerContainer.parentElement === root) headerContainer.remove();
      }

      const v = evaluator.value(focus.id);
      if (v.kind === "item-group") {
        const kids = mountTreeChildren(ctx0, focus);
        contentSlot.set(kids);
        setContentTarget(kids.el);
        ensureTabbable(kids.el);
      } else {
        contentSlot.set(mountTreeBody(ctx0, focus, setContentTarget));
      }

      root.classList.toggle("focused", focused);
      contentContainer.classList.toggle("issue", v.kind === "issue");
    });

    return root;
  });
}

export function createTreeView({ runtime, id: rootId }: ViewFactoryArgs): View {
  const { editor, eval: evaluator } = runtime;
  const store = editor.store;

  const root = el("div", "view tree");
  const viewId = `tree:${String(rootId)}`;

  const navStopsSignal = computed(() =>
    collectNavStopsFrom(store, evaluator, store.getRoot()),
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
    { runtime, editor, evaluator, store, rootId, navMove, dispatch },
    { focus: { scopeId: rootId, id: rootId }, showHeader: false },
  );

  root.append(node.el);

  return {
    id: viewId,
    root,

    normalizeTarget({ store: store0 }, focus, target) {
      void store0;

      if (target.kind !== "header") return target;

      if (focus.id === rootId) return { kind: "content" };

      const defs = headerFieldsForItem(store, focus.id);
      const label = (store.readItem(focus.id).label ?? "").trim();

      if (target.index === 0) return { kind: "header", index: 0 };

      if (defs.length === 0) return { kind: "content" };

      void label;

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
