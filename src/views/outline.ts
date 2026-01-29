import { computed } from "@preact/signals-core";
import {
  type ItemId,
  type ViewKind,
  type Core,
  type Header,
  type Focus,
  type FocusTarget,
  type Caret,
  caret0,
  caretAt,
  type Selection,
  type EditorEffect,
  focusSelection,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
} from "../core";
import { type NavDir, type NavMode, type ViewKeyResult } from "../ui/host";
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
  textField,
  autosizeTextField,
  contentField,
} from "../ui/dom";
import {
  type DomView,
  type Runtime,
  type ViewFactoryArgs,
  createView,
  viewWantsChildView,
} from "./index";

type HeaderKind = Header["kind"];

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
  core: Core,
  id: ItemId,
): readonly HeaderFieldDef[] {
  return HEADER_FIELDS[core.header(id).kind] ?? HEADER_FIELDS.none;
}

function headerFieldValue(core: Core, id: ItemId, def: HeaderFieldDef): string {
  const h = core.header(id);
  if (h.kind === "derived") return def.field === "expr" ? (h.expr ?? "") : "";
  if (h.kind === "lens") {
    if (def.field === "from") return h.from ?? "";
    if (def.field === "where") return h.where ?? "";
    if (def.field === "orderBy") return h.orderBy ?? "";
  }
  return "";
}

const focusKey = (f: Focus) => `${String(f.scopeId)}::${String(f.id)}`;

const hasHeaderFields = (core: Core, id: ItemId) =>
  core.header(id).kind !== "none";

const isNavStop = (core: Core, id: ItemId) => {
  const kids = core.children(id);
  return kids.length === 0 || hasHeaderFields(core, id);
};

const defaultTargetFor = (core: Core, id: ItemId): FocusTarget =>
  hasHeaderFields(core, id)
    ? { kind: "header", index: 1 }
    : { kind: "content" };

function collectNavStopsFrom(core: Core, rootId: ItemId): Focus[] {
  const out: Focus[] = [];
  const walk = (ownerId: ItemId) => {
    for (const id of core.children(ownerId)) {
      if (isNavStop(core, id)) out.push({ scopeId: ownerId, id });
      walk(id);
    }
  };
  walk(rootId);
  return out;
}

function outlineNavMove(
  core: Core,
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
    const ownerId = core.get(from.scopeId).ownerId;
    return ownerId == null ? null : { scopeId: ownerId, id: from.scopeId };
  };

  const firstChildStop = (id: ItemId): Focus | null => {
    for (const cid of core.children(id)) {
      if (isNavStop(core, cid)) return { scopeId: id, id: cid };
      const deeper = firstChildStop(cid);
      if (deeper) return deeper;
    }
    return null;
  };

  let next: Focus | null = null;
  let caret: Caret | null = null;
  let targetOverride: FocusTarget | null = null;

  if (dir === "up") next = neighbor(-1);
  else if (dir === "down") next = neighbor(1);
  else if (dir === "right") {
    next = firstChildStop(from.id) ?? neighbor(1);
    if (mode === "jump") next = neighbor(1) ?? next;
  } else if (dir === "left") {
    const prev = neighbor(-1);
    const parent = parentFocus();
    next = prev ?? parent;
    if (mode === "jump") next = parent ?? prev ?? null;

    if (prev && next && focusKey(prev) === focusKey(next)) {
      const defs =
        sel.target.kind === "content" ? headerFieldsForItem(core, prev.id) : [];

      if (sel.target.kind === "content" && defs.length > 0) {
        const lastDef = defs[defs.length - 1]!;
        const text = headerFieldValue(core, prev.id, lastDef);
        targetOverride = { kind: "header", index: defs.length };
        caret = caretAt(text.length);
      } else {
        const t = core.text(prev.id);
        if (t.kind === "editable") caret = caretAt(t.text.length);
      }
    }
  }

  if (!next) return null;

  const target = targetOverride ?? defaultTargetFor(core, next.id);
  const outCaret = caret ?? caret0();
  const res = focusSelection(next, target, outCaret);
  return { selection: res.selection, effects: res.effects };
}

export const outlineCommands = {
  setLabel(core: Core, f: Focus, text: string): void {
    core.edit.setLabel(f.id, text);
  },

  setText(core: Core, id: ItemId, text: string): void {
    core.edit.setText(id, text);
  },

  setDerived(core: Core, f: Focus): void {
    core.edit.setDerived(f.id, "");
    const nextSel = focusSelection(f, { kind: "header", index: 1 }, caret0());
    core.setSelection(nextSel.selection);
  },

  commitHeaderField(
    core: Core,
    f: Focus,
    def: HeaderFieldDef,
    text: string,
  ): void {
    const h = core.header(f.id);

    if (h.kind === "derived") {
      if (def.field !== "expr") return;
      core.edit.setDerived(f.id, text);
      return;
    }

    if (h.kind !== "lens") return;

    core.edit.setLens(f.id, {
      from: def.field === "from" ? text : h.from,
      where: def.field === "where" ? text : h.where,
      orderBy: def.field === "orderBy" ? text : h.orderBy,
    });
  },

  insertSibling(core: Core, sel: Selection, side: "before" | "after"): void {
    if (sel.kind !== "focused") return;

    const loc = core.locate(sel.focus.id);
    if (!loc) return;

    const at = side === "before" ? loc.index : loc.index + 1;

    let id: ItemId = -1;
    core.commit((t) => {
      id = t.insert(loc.ownerId, { at, kind: "blank" });
    });

    const nextSel = focusSelection(
      { scopeId: sel.focus.scopeId, id },
      { kind: "content" },
      caret0(),
    );
    core.setSelection(nextSel.selection);
  },

  splitAt(
    core: Core,
    sel: Selection,
    caretStart: number,
    caretEnd = caretStart,
  ): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;

    const t0 = core.text(f.id);
    if (t0.kind !== "editable") {
      outlineCommands.insertSibling(core, sel, "after");
      return;
    }

    const loc = core.locate(f.id);
    if (!loc) return;

    const curText = t0.text;
    const len = curText.length;
    const start = clamp(caretStart, 0, len);
    const end = clamp(caretEnd, 0, len);

    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let rightId: ItemId = -1;

    core.commit((t) => {
      t.setText(f.id, left);
      rightId = t.insert(loc.ownerId, { at: loc.index + 1, kind: "blank" });
      t.setText(rightId, right);
    });

    const nextSel = focusSelection(
      { scopeId: f.scopeId, id: rightId },
      { kind: "content" },
      caret0(),
    );
    core.setSelection(nextSel.selection);
  },

  joinBoundary(core: Core, sel: Selection, dir: "backward" | "forward"): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;
    const loc = core.locate(f.id);
    if (!loc) return;

    const neighborId =
      dir === "backward"
        ? (loc.siblingIds[loc.index - 1] ?? null)
        : (loc.siblingIds[loc.index + 1] ?? null);
    if (neighborId == null) return;

    const leftId = dir === "backward" ? neighborId : f.id;
    const rightId = dir === "backward" ? f.id : neighborId;

    const a = core.text(leftId);
    const b = core.text(rightId);
    if (a.kind !== "editable" || b.kind !== "editable") return;

    core.commit((t) => {
      t.setText(leftId, a.text + b.text);
      t.remove(rightId);
    });

    const nextSel = focusSelection(
      { scopeId: f.scopeId, id: leftId },
      { kind: "content" },
      caretAt(a.text.length),
    );
    core.setSelection(nextSel.selection);
  },

  removeItem(core: Core, sel: Selection, prefer: "prev" | "next"): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;
    const loc = core.locate(f.id);
    if (!loc) return;

    const prevId = (loc.siblingIds[loc.index - 1] ?? null) as ItemId | null;
    const nextId = (loc.siblingIds[loc.index + 1] ?? null) as ItemId | null;

    const chosen =
      prefer === "prev"
        ? (prevId ?? nextId ?? loc.ownerId)
        : (nextId ?? prevId ?? loc.ownerId);

    const containerKids = core.children(f.scopeId);
    const nextFocus: Focus = containerKids.includes(chosen as ItemId)
      ? { scopeId: f.scopeId, id: chosen as ItemId }
      : { scopeId: loc.ownerId, id: chosen as ItemId };

    const shouldPlaceCaretAtEnd =
      prefer === "prev" &&
      chosen != null &&
      containerKids.includes(chosen as ItemId) &&
      core.text(chosen as ItemId).kind === "editable";

    const caret = shouldPlaceCaretAtEnd
      ? caretAt((core.text(chosen as ItemId) as any).text.length ?? 0)
      : caret0();

    core.edit.remove(f.id);

    const nextSel = focusSelection(
      nextFocus,
      defaultTargetFor(core, nextFocus.id),
      caret,
    );
    core.setSelection(nextSel.selection);
  },

  changeNesting(core: Core, sel: Selection, dir: "in" | "out"): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;

    if (dir === "in") {
      const loc = core.locate(f.id);
      if (!loc) return;

      const childLabel = core.get(f.id).label;
      let wrapperId: ItemId = -1;

      core.commit((t) => {
        wrapperId = t.insert(loc.ownerId, { at: loc.index, kind: "group" });
        t.setLabel(wrapperId, childLabel);
        t.setLabel(f.id, "");
        t.move(f.id, wrapperId, { at: 0 });
      });

      const nextSel = focusSelection(
        { scopeId: wrapperId, id: f.id },
        defaultTargetFor(core, f.id),
        caret0(),
      );
      core.setSelection(nextSel.selection);
      return;
    }

    const wrapperId = core.get(f.id).ownerId;
    if (wrapperId == null) return;

    const wrapperMeta = core.get(wrapperId);
    if (wrapperMeta.storedKind !== "group") return;

    const kids = core.children(wrapperId);
    if (kids.length !== 1 || kids[0] !== f.id) return;

    const ownerId = wrapperMeta.ownerId;
    if (ownerId == null) return;

    const idx = core.children(ownerId).indexOf(wrapperId);
    if (idx < 0) return;

    core.commit((t) => {
      t.move(f.id, ownerId, { at: idx });
      t.remove(wrapperId);
      t.setLabel(f.id, wrapperMeta.label);
    });

    const nextSel = focusSelection(
      { scopeId: ownerId, id: f.id },
      defaultTargetFor(core, f.id),
      caret0(),
    );
    core.setSelection(nextSel.selection);
  },

  confirm(core: Core, sel: Selection): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;

    if (sel.target.kind === "header") {
      const nextSel = focusSelection(f, { kind: "content" }, caret0());
      core.setSelection(nextSel.selection);
      return;
    }

    const t = core.text(f.id);
    if (t.kind === "editable") {
      outlineCommands.splitAt(core, sel, 0, 0);
      return;
    }

    outlineCommands.insertSibling(core, sel, "after");
  },

  deleteBoundary(
    core: Core,
    sel: Selection,
    dir: "backward" | "forward",
  ): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;
    const prefer = dir === "backward" ? "prev" : "next";

    const t = core.text(f.id);
    if (t.kind !== "editable") {
      outlineCommands.removeItem(core, sel, prefer);
      return;
    }

    if (t.text.length === 0) {
      outlineCommands.removeItem(core, sel, prefer);
      return;
    }

    outlineCommands.joinBoundary(core, sel, dir);
  },
} as const;

type OutlineMountCtx = {
  runtime: Runtime;
  core: Core;
  rootId: ItemId;
  navMove: (
    sel: Selection,
    dir: NavDir,
    mode: NavMode,
  ) => { selection: Selection; effects: EditorEffect[] } | null;
  dispatch: (intent: OutlineIntent) => ViewKeyResult;
};

type OutlineNodeSpec = {
  focus: Focus;
  showHeader: boolean;
};

type OutlineIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" }
  | { type: "INDENT"; dir: "in" | "out" }
  | { type: "DELETE_BOUNDARY"; dir: "backward" | "forward" }
  | { type: "SPLIT"; caret: Caret }
  | { type: "SET_DERIVED" };

function mountOutlineHeader(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  defs: readonly HeaderFieldDef[],
  onTargets: (targets: HTMLElement[]) => void,
): Component {
  const { core, dispatch, runtime } = mountCtx;

  return createComponent((componentCtx) => {
    const wrap = el("div");
    const labelHost = el("div");
    const fieldsHost = el("div", "header-fields");
    wrap.append(labelHost, fieldsHost);

    const toContent = () => {
      core.setSelection(
        focusSelection(focus, { kind: "content" }, caret0()).selection,
      );
    };

    const commitLabel = (text: string) => {
      const current = core.get(focus.id).label ?? "";
      if (current === text) return;
      outlineCommands.setLabel(core, focus, text);
    };

    const labelComp = autosizeTextField({
      core,
      host: runtime.host,
      focus,
      target: { kind: "header", index: 0 },
      registerFocus: false,
      commit: commitLabel,
      getState: () => ({
        text: core.get(focus.id).label ?? "",
        readOnly: false,
        isIssue: false,
      }),
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["blur"],
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
            if (e.key === "Enter") commitLabel(inputEl.value);
            toContent();
          }
        });
      },
    });

    labelHost.replaceChildren(labelComp.el);
    componentCtx.use(labelComp);

    const targets: HTMLElement[] = [];
    targets.push(labelComp.focusEl);

    for (let i = 0; i < defs.length; i++) {
      const d = defs[i]!;
      const labelEl = el("span", "equals", d.label);
      const valueHost = el("div");
      const row = el("div", "wrap");
      row.append(labelEl, valueHost);
      fieldsHost.append(row);
      const headerIndex = i + 1;

      const commitField = (text: string) => {
        const current = headerFieldValue(core, focus.id, d);
        if (current === text) return;
        outlineCommands.commitHeaderField(core, focus, d, text);
      };

      const fc = textField({
        core,
        host: runtime.host,
        focus,
        target: { kind: "header", index: headerIndex },
        multiline: d.multiline,
        caret: "fromTarget",
        stopPropagation: true,
        registerFocus: false,
        commit: commitField,
        getState: () => ({
          text: headerFieldValue(core, focus.id, d),
          readOnly: false,
          isIssue: false,
        }),
        onCommitEvents: ["blur"],
        textKeys: (inp) => {
          const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;

          const moveToHeaderField = (
            index: number,
            caretPos: "start" | "end",
          ): boolean => {
            const def = defs[index - 1];
            if (!def) return false;
            const text = headerFieldValue(core, focus.id, def);
            const caret = caretPos === "end" ? caretAt(text.length) : caret0();
            const { selection } = focusSelection(
              focus,
              { kind: "header", index },
              caret,
            );
            core.setSelection(selection);
            return true;
          };

          const boundaryNav = (dir: "left" | "right") => {
            dispatch({ type: "NAV", dir, mode: "step" });
          };

          return on(inputEl, "keydown", (e: KeyboardEvent) => {
            const noModifiers =
              !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
            if (
              noModifiers &&
              (e.key === "ArrowLeft" || e.key === "ArrowRight")
            ) {
              const start = inputEl.selectionStart ?? 0;
              const end = inputEl.selectionEnd ?? start;
              const hasSel = start !== end;
              const len = inputEl.value.length;

              if (!hasSel && e.key === "ArrowLeft" && start === 0) {
                e.preventDefault();
                e.stopPropagation();
                if (
                  headerIndex > 1
                    ? moveToHeaderField(headerIndex - 1, "end")
                    : false
                ) {
                  return;
                }
                boundaryNav("left");
                return;
              }

              if (!hasSel && e.key === "ArrowRight" && end === len) {
                e.preventDefault();
                e.stopPropagation();
                if (
                  headerIndex < defs.length
                    ? moveToHeaderField(headerIndex + 1, "start")
                    : false
                ) {
                  return;
                }
                boundaryNav("right");
                return;
              }
            }

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.stopPropagation();
              commitField(inputEl.value);
              return;
            }

            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              toContent();
            }
          });
        },
      });

      valueHost.replaceChildren(fc.el);
      componentCtx.use(fc);
      targets.push(fc.focusEl);
    }

    onTargets(targets);
    componentCtx.onCleanup(() => onTargets([]));

    return wrap;
  });
}

function mountOutlineChildren(
  mountCtx: OutlineMountCtx,
  focus: Focus,
): Component {
  const { core } = mountCtx;

  return createComponent((componentCtx) => {
    const container = el("div", "group");
    ensureTabbable(container);

    const mgr = componentCtx.list(container, (childId: ItemId) =>
      mountOutlineNode(mountCtx, {
        focus: { scopeId: focus.id, id: childId },
        showHeader: true,
      }),
    );

    componentCtx.watch(
      () => core.children(focus.id),
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
      core.setSelection(
        focusSelection(focus, { kind: "content" }, caret0()).selection,
      );
      e.stopPropagation();
    });

    return container;
  });
}

type ContentTargetRef = { current: HTMLElement | null };

function mountOutlineBody(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  contentTargetRef: ContentTargetRef,
): Component {
  const { core, dispatch, runtime } = mountCtx;

  return createComponent((componentCtx) => {
    const hostEl = el("div");
    const viewKind = core.get(focus.id).view as ViewKind;

    if (viewWantsChildView(viewKind)) {
      const childView = createView(runtime, viewKind, focus.id, focus);
      if (childView) {
        ensureTabbable(childView.root);
        contentTargetRef.current = childView.root;
        componentCtx.use(runtime.host.mountViewInto(hostEl, childView));
        return hostEl;
      }
    }

    const vf = contentField({
      core,
      host: runtime.host,
      focus,
      id: focus.id,
      registerFocus: false,
      focusElRef: contentTargetRef,
      commitText: (text) => outlineCommands.setText(core, focus.id, text),
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
              const v = core.value(childId);
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

    hostEl.replaceChildren(vf.el);
    componentCtx.use(vf);

    componentCtx.onCleanup(() => {
      contentTargetRef.current = hostEl;
    });

    return hostEl;
  });
}

function mountOutlineNode(
  mountCtx: OutlineMountCtx,
  spec: OutlineNodeSpec,
): Component {
  const { core, runtime } = mountCtx;
  const { focus } = spec;

  return createComponent((componentCtx) => {
    const root = el("div", "item");
    const headerContainer = el("div", "header");
    const contentContainer = el("div", "content-host");
    root.append(contentContainer);

    const headerSlot = componentCtx.slot(headerContainer);
    const contentSlot = componentCtx.slot(contentContainer);

    let headerTargets: HTMLElement[] = [];
    const contentTargetRef: ContentTargetRef = { current: contentContainer };

    componentCtx.focusable({
      core,
      host: runtime.host,
      focus,
      elementFor: (target) =>
        target.kind === "content"
          ? (contentTargetRef.current ?? contentContainer)
          : (headerTargets[target.index] ?? null),
    });

    const setHeaderTargets = (targets: HTMLElement[]) => {
      headerTargets = targets;
    };

    componentCtx.watch(
      () => {
        const sel = core.getSelection();
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
        const meta = core.get(focus.id);
        const defs = headerFieldsForItem(core, focus.id);
        const label = (meta.label ?? "").trim();
        const headerKind = core.header(focus.id).kind;

        const v = core.value(focus.id);
        const viewKind = meta.view as ViewKind;
        const wantsChildView = viewWantsChildView(viewKind);
        const mode: "children" | "body" = wantsChildView
          ? "body"
          : isItemGroupValue(v)
            ? "children"
            : "body";

        const sel = core.getSelection();
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
              mountOutlineHeader(mountCtx, focus, defs, setHeaderTargets),
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
            const kids = mountOutlineChildren(mountCtx, focus);
            contentSlot.set(kids);
            ensureTabbable(kids.el);
            contentTargetRef.current = kids.el;
          } else {
            contentSlot.set(
              mountOutlineBody(mountCtx, focus, contentTargetRef),
            );
          }
        }
      },
    );

    return root;
  });
}

export function createOutlineView({
  runtime,
  id: rootId,
}: ViewFactoryArgs): DomView {
  const core = runtime.core as Core;

  const root = el("div", "view outline");
  const viewId = `outline:${String(rootId)}`;

  const navStopsSignal = computed(() => collectNavStopsFrom(core, rootId));

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    outlineNavMove(core, navStopsSignal.value, sel, dir, mode);

  const dispatch = (intent: OutlineIntent): ViewKeyResult => {
    const sel = core.getSelection();

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) core.setSelection(res.selection, res.effects);
        return;
      }

      case "CONFIRM": {
        outlineCommands.confirm(core, sel);
        return;
      }

      case "CANCEL": {
        core.setSelection({ kind: "idle" });
        return;
      }

      case "INDENT": {
        outlineCommands.changeNesting(core, sel, intent.dir);
        return;
      }

      case "DELETE_BOUNDARY": {
        outlineCommands.deleteBoundary(core, sel, intent.dir);
        return;
      }

      case "SPLIT": {
        outlineCommands.splitAt(
          core,
          sel,
          intent.caret.start,
          intent.caret.end,
        );
        return;
      }

      case "SET_DERIVED": {
        if (sel.kind !== "focused") return;
        outlineCommands.setDerived(core, sel.focus);
        return;
      }
    }
  };

  const mountCtx: OutlineMountCtx = {
    runtime: runtime as Runtime,
    core,
    rootId,
    navMove,
    dispatch,
  };

  const node = mountOutlineNode(mountCtx, {
    focus: { scopeId: rootId, id: rootId },
    showHeader: false,
  });

  root.append(node.el);

  return {
    id: viewId,
    root,

    normalizeTarget(_ctx2, focus, target) {
      if (target.kind !== "header") return target;

      if (focus.id === rootId) return { kind: "content" };

      const defs = headerFieldsForItem(core, focus.id);

      if (target.index === 0) return { kind: "header", index: 0 };

      if (defs.length === 0) return { kind: "content" };

      const max = defs.length;
      const idx = Math.max(1, Math.min(target.index, max));
      return { kind: "header", index: idx };
    },

    onActivate() {
      if (core.getSelection().kind !== "idle") return;

      const first = navStopsSignal.value[0];
      if (!first) return;

      core.setSelection(
        focusSelection(first, defaultTargetFor(core, first.id), caret0())
          .selection,
      );
    },

    onKeyDown(e): ViewKeyResult {
      if (!(e instanceof KeyboardEvent)) return;

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
