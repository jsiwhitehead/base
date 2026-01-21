import { computed } from "@preact/signals-core";
import type { Store, ItemId, Txn, ViewKind, StoredContent } from "../store";
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
  mkFocusSelection,
  caret0,
  caretAt,
  proposeSelection,
  tryCmd,
  applyCmd,
  setIdle,
} from "../editor";
import type { Evaluator } from "../evaluator";
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
  valueField,
  autosizeTextField,
  textField,
  defaultTextNav,
  mountChildViewInto,
  type Component,
} from "../ui";
import { createChildViewForItem, viewWantsChildView } from "./index";

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
  return store.getItem(id).content.kind;
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
  const it = store.getItem(id);
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
    const ownerId = store.getItem(from.scopeId).ownerId;
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

  const res = mkFocusSelection(
    next,
    defaultTargetFor(store, next.id),
    caret0(),
  );
  return { selection: res.selection, effects: res.effects };
}

function canEditScalarText(store: Store, id: ItemId): boolean {
  const kind = store.getItem(id).content.kind;
  return kind === "blank" || kind === "scalar";
}

export const treeCommands = {
  commitLabel(editor: Editor, f: Focus, text: string): CmdResult {
    return tryCmd(() => {
      editor.apply({
        ops: [{ kind: "patch", id: f.id, next: { label: text } }],
      });
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
      editor.apply({
        ops: [
          {
            kind: "patch",
            id,
            next: { content: { kind: "scalar", value: parseScalar(text) } },
          },
        ],
      });
      void evaluator;
      return { didChange: true };
    });
  },

  setDerived(editor: Editor, f: Focus): CmdResult {
    return tryCmd(() => {
      const next = mkFocusSelection(f, { kind: "header", index: 1 }, caret0());
      editor.apply(
        {
          ops: [
            {
              kind: "patch",
              id: f.id,
              next: { content: { kind: "derived", expr: "" } },
            },
          ],
        },
        proposeSelection(next),
      );
      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
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
      const it = store.getItem(f.id);
      const c = it.content;

      if (fieldKey === "derived.expr") {
        editor.apply({
          ops: [
            {
              kind: "patch",
              id: f.id,
              next: { content: { kind: "derived", expr: text } },
            },
          ],
        });
        return { didChange: true };
      }

      if (c.kind !== "lens") return { didChange: false };

      const next = {
        from: fieldKey === "lens.from" ? text : c.from,
        where: fieldKey === "lens.where" ? text : c.where,
        orderBy: fieldKey === "lens.orderBy" ? text : c.orderBy,
      };

      editor.apply({
        ops: [
          {
            kind: "patch",
            id: f.id,
            next: { content: { kind: "lens", ...next } },
          },
        ],
      });

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

      const txn: Txn = {
        ops: [
          { kind: "create", item: store.make.blank(id) },
          {
            kind: "reparent",
            spec: { childId: id, toOwnerId: loc.ownerId, toIndex: at },
          },
        ],
      };

      const next = mkFocusSelection(
        { scopeId: f.scopeId, id },
        { kind: "content" },
        caret0(),
      );
      editor.apply(txn, proposeSelection(next));

      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
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

      const txn: Txn = {
        ops: [
          {
            kind: "patch",
            id: f.id,
            next: { content: { kind: "scalar", value: parseScalar(left) } },
          },
          { kind: "create", item: store.make.blank(rightId) },
          {
            kind: "reparent",
            spec: {
              childId: rightId,
              toOwnerId: loc.ownerId,
              toIndex: loc.index + 1,
            },
          },
          {
            kind: "patch",
            id: rightId,
            next: { content: { kind: "scalar", value: parseScalar(right) } },
          },
        ],
      };

      const next = mkFocusSelection(
        { scopeId: f.scopeId, id: rightId },
        { kind: "content" },
        caret0(),
      );
      editor.apply(txn, proposeSelection(next));

      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
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

      const txn: Txn = {
        ops: [
          {
            kind: "patch",
            id: survivorId,
            next: { content: { kind: "scalar", value: parseScalar(a + b) } },
          },
          { kind: "reparent", spec: { childId: removedId, toOwnerId: null } },
        ],
      };

      const next = mkFocusSelection(
        { scopeId: f.scopeId, id: survivorId },
        { kind: "content" },
        caretAt(a.length),
      );
      editor.apply(txn, proposeSelection(next));

      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
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

      const next = mkFocusSelection(
        nextFocus,
        defaultTargetFor(store, nextFocus.id),
        caret0(),
      );

      editor.apply(
        {
          ops: [{ kind: "reparent", spec: { childId: f.id, toOwnerId: null } }],
        },
        proposeSelection(next),
      );

      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
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

        const childInfo = store.getItem(f.id);
        const wrapperId = store.createId();
        const wrapper = store.make.group(wrapperId);

        const txn: Txn = {
          ops: [
            { kind: "create", item: { ...wrapper, label: childInfo.label } },
            {
              kind: "reparent",
              spec: {
                childId: wrapperId,
                toOwnerId: loc.ownerId,
                toIndex: loc.index,
              },
            },
            { kind: "patch", id: f.id, next: { label: "" } },
            {
              kind: "reparent",
              spec: { childId: f.id, toOwnerId: wrapperId, toIndex: 0 },
            },
          ],
        };

        const next = mkFocusSelection(
          { scopeId: wrapperId, id: f.id },
          defaultTargetFor(store, f.id),
          caret0(),
        );

        editor.apply(txn, proposeSelection(next));
        return {
          didChange: true,
          selection: next.selection,
          effects: next.effects,
        };
      }

      const child = store.getItem(f.id);
      const wrapperId = child.ownerId;
      if (wrapperId == null) return { didChange: false };

      const wrapper = store.getItem(wrapperId);
      if (wrapper.content.kind !== "group") return { didChange: false };

      const kids = evaluator.items(wrapperId);
      if (kids.length !== 1 || kids[0] !== f.id) return { didChange: false };

      const ownerId = wrapper.ownerId;
      if (ownerId == null) return { didChange: false };

      const idx = evaluator.items(ownerId).indexOf(wrapperId);
      if (idx < 0) return { didChange: false };

      const txn: Txn = {
        ops: [
          {
            kind: "reparent",
            spec: { childId: f.id, toOwnerId: ownerId, toIndex: idx },
          },
          { kind: "reparent", spec: { childId: wrapperId, toOwnerId: null } },
          { kind: "patch", id: f.id, next: { label: wrapper.label } },
          {
            kind: "patch",
            id: wrapperId,
            next: { label: "", content: { kind: "blank" } },
          },
        ],
      };

      const next = mkFocusSelection(
        { scopeId: ownerId, id: f.id },
        defaultTargetFor(store, f.id),
        caret0(),
      );

      editor.apply(txn, proposeSelection(next));
      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
    });
  },

  confirm(editor: Editor, evaluator: Evaluator, sel: Selection): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    if (sel.target.kind === "header") {
      const next = mkFocusSelection(f, { kind: "content" }, caret0());
      return {
        didChange: false,
        selection: next.selection,
        effects: next.effects,
      };
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
        mkFocusSelection(focus, { kind: "content" }, caret0()).selection,
      );
    };

    const labelComp = autosizeTextField({
      editor,
      focus,
      target: { kind: "header", index: 0 },
      commit: (text) =>
        applyCmd(editor, treeCommands.commitLabel(editor, focus, text)),
      getState: () => ({
        text: store.getItem(focus.id).label ?? "",
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
    ctx.using(labelComp);

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
      ctx.using(fc);
      targets.push(fc.el);
    }

    onTargets(targets);
    ctx.onCleanup(() => onTargets([]));

    return wrap;
  });
}

function mountTreeChildren(ctx0: TreeMountCtx, focus: Focus): Component {
  const { editor, evaluator, store, rootId, navMove } = ctx0;

  return createComponent((ctx) => {
    const container = el("div", "group");
    ensureTabbable(container);

    const mgr = ctx.list(container, (childId: ItemId) =>
      mountTreeNode(
        { ...ctx0, editor, evaluator, store, rootId, navMove },
        { focus: { scopeId: focus.id, id: childId }, showHeader: true },
      ),
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
        mkFocusSelection(focus, { kind: "content" }, caret0()).selection,
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
  const { editor, evaluator, store, dispatch } = ctx0;

  return createComponent((ctx) => {
    const host = el("div");
    const viewKind = store.getItem(focus.id).view as ViewKind;

    if (viewWantsChildView(viewKind)) {
      const childView = createChildViewForItem(
        { editor, evaluator },
        viewKind,
        focus.id,
        focus,
      );
      if (childView) {
        ensureTabbable(childView.root);
        onContentTarget(childView.root);
        ctx.using(mountChildViewInto(editor, host, childView));
        return host;
      }
    }

    const vf = valueField({
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
    ctx.using(vf);

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
      const info = store.getItem(focus.id);
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

export function createTreeView(
  ctx: { editor: Editor; evaluator: Evaluator },
  rootId: ItemId,
  _focus?: Focus,
): View {
  const { editor, evaluator } = ctx;
  const store = editor.store;

  const root = el("div", "view tree");
  const viewId = `tree:${String(rootId)}`;

  const navStopsSig = computed(() =>
    collectNavStopsFrom(store, evaluator, store.getRoot()),
  );

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    treeNavMove(store, evaluator, navStopsSig.value, sel, dir, mode);

  const dispatch = (intent: TreeIntent): ViewKeyResult => {
    const sel = editor.runtime.selection.value;

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) editor.setSelection(res.selection, res.effects);
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
    { editor, evaluator, store, rootId, navMove, dispatch },
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
      const label = (store.getItem(focus.id).label ?? "").trim();

      if (target.index === 0) return { kind: "header", index: 0 };

      if (defs.length === 0) return { kind: "content" };

      void label;

      const max = defs.length;
      const idx = Math.max(1, Math.min(target.index, max));
      return { kind: "header", index: idx };
    },

    onActivate() {
      if (editor.runtime.selection.value.kind !== "idle") return;

      const first = navStopsSig.value[0];
      if (!first) return;

      editor.setSelection(
        mkFocusSelection(first, defaultTargetFor(store, first.id), caret0())
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
