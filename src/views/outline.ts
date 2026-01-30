import { computed } from "@preact/signals-core";
import {
  type ItemId,
  type ViewKind,
  type Core,
  type Source,
  type Component,
  type Focus,
  type Caret,
  type Selection,
  type DomView,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  clamp,
} from "../core";
import {
  type NavDir,
  type NavMode,
  defaultTextNav,
  el,
  on,
  ensureTabbable,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  textField,
  autosizeTextField,
  contentField,
} from "../dom";

type SourceKind = Source["kind"];

type SourceFieldDef = Readonly<{
  field: "expr" | "from" | "where" | "orderBy";
  label: string;
  multiline: boolean;
  target: string;
}>;

const SOURCE_FIELDS: Record<SourceKind, readonly SourceFieldDef[]> = {
  derived: [
    { field: "expr", label: "=", multiline: true, target: "source:expr" },
  ],
  lens: [
    { field: "from", label: "~", multiline: false, target: "source:from" },
    {
      field: "where",
      label: "where:",
      multiline: true,
      target: "source:where",
    },
    {
      field: "orderBy",
      label: "orderBy:",
      multiline: true,
      target: "source:orderBy",
    },
  ],
  none: [],
} as const;

const caret0 = (): Caret => ({ start: 0, end: 0 });
const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

const sameFocus = (a: Focus, b: Focus) =>
  a.scopeId === b.scopeId && a.id === b.id;

function sourceFieldsForItem(
  core: Core,
  id: ItemId,
): readonly SourceFieldDef[] {
  return SOURCE_FIELDS[core.source(id).kind] ?? SOURCE_FIELDS.none;
}

function sourceFieldValue(core: Core, id: ItemId, def: SourceFieldDef): string {
  const s = core.source(id);
  if (s.kind === "derived") return def.field === "expr" ? (s.expr ?? "") : "";
  if (s.kind === "lens") {
    if (def.field === "from") return s.from ?? "";
    if (def.field === "where") return s.where ?? "";
    if (def.field === "orderBy") return s.orderBy ?? "";
  }
  return "";
}

const hasSourceFields = (core: Core, id: ItemId) =>
  core.source(id).kind !== "none";

const isNavStop = (core: Core, id: ItemId) => {
  const kids = core.childIds(id);
  return kids.length === 0 || hasSourceFields(core, id);
};

const defaultTargetFor = (core: Core, id: ItemId): string =>
  hasSourceFields(core, id) ? "label" : "content";

function collectNavStopsFrom(core: Core, rootId: ItemId): Focus[] {
  const out: Focus[] = [];
  const walk = (ownerId: ItemId) => {
    for (const id of core.childIds(ownerId)) {
      if (isNavStop(core, id)) out.push({ scopeId: ownerId, id });
      walk(id);
    }
  };
  walk(rootId);
  return out;
}

type NavResult = { focus: Focus; target: string; caret?: Caret };

function outlineNavMove(
  core: Core,
  stops: Focus[],
  sel: Selection,
  dir: NavDir,
  mode: NavMode,
): NavResult | null {
  if (sel.kind !== "focused") return null;

  const from = sel.focus;
  const at = Math.max(
    0,
    stops.findIndex((s) => sameFocus(s, from)),
  );

  const neighbor = (delta: -1 | 1) => {
    const j = at + delta;
    return j >= 0 && j < stops.length ? stops[j]! : null;
  };

  const parentFocus = (): Focus | null => {
    const ownerId = core.meta(from.scopeId).ownerId;
    return ownerId == null ? null : { scopeId: ownerId, id: from.scopeId };
  };

  const firstChildStop = (id: ItemId): Focus | null => {
    for (const cid of core.childIds(id)) {
      if (isNavStop(core, cid)) return { scopeId: id, id: cid };
      const deeper = firstChildStop(cid);
      if (deeper) return deeper;
    }
    return null;
  };

  let next: Focus | null = null;
  let caret: Caret | null = null;
  let targetOverride: string | null = null;

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

    if (prev && next && sameFocus(prev, next)) {
      if (sel.target === "content") {
        const defs = sourceFieldsForItem(core, prev.id);
        if (defs.length > 0) {
          const lastDef = defs[defs.length - 1]!;
          const text = sourceFieldValue(core, prev.id, lastDef);
          targetOverride = lastDef.target;
          caret = caretAt(text.length);
        } else {
          const t = core.text(prev.id);
          if (t.kind === "editable") caret = caretAt(t.text.length);
        }
      }
    }
  }

  if (!next) return null;

  const target = targetOverride ?? defaultTargetFor(core, next.id);
  const outCaret = caret ?? caret0();
  return { focus: next, target, caret: outCaret };
}

export const outlineCommands = {
  setLabel(core: Core, f: Focus, text: string): void {
    core.edit.setLabel(f.id, text);
  },

  setText(core: Core, id: ItemId, text: string): void {
    core.edit.setText(id, text);
  },

  setDerived(core: Core, f: Focus): void {
    core.edit.setSource(f.id, { kind: "derived", expr: "" });
    core.focus(f, "source:expr", { caret: caret0() });
  },

  commitSourceField(
    core: Core,
    f: Focus,
    def: SourceFieldDef,
    text: string,
  ): void {
    const s = core.source(f.id);

    if (s.kind === "derived") {
      if (def.field !== "expr") return;
      core.edit.setSource(f.id, { kind: "derived", expr: text });
      return;
    }

    if (s.kind !== "lens") return;

    core.edit.setSource(f.id, {
      kind: "lens",
      from: def.field === "from" ? text : s.from,
      where: def.field === "where" ? text : s.where,
      orderBy: def.field === "orderBy" ? text : s.orderBy,
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

    core.focus({ scopeId: sel.focus.scopeId, id }, "content", {
      caret: caret0(),
    });
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

    core.focus({ scopeId: f.scopeId, id: rightId }, "content", {
      caret: caret0(),
    });
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

    core.focus({ scopeId: f.scopeId, id: leftId }, "content", {
      caret: caretAt(a.text.length),
    });
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

    const containerKids = core.childIds(f.scopeId);
    const nextFocus: Focus = containerKids.includes(chosen as ItemId)
      ? { scopeId: f.scopeId, id: chosen as ItemId }
      : { scopeId: loc.ownerId, id: chosen as ItemId };

    const shouldPlaceCaretAtEnd =
      prefer === "prev" &&
      chosen != null &&
      containerKids.includes(chosen as ItemId) &&
      core.text(chosen as ItemId).kind === "editable";

    const c = shouldPlaceCaretAtEnd
      ? caretAt((core.text(chosen as ItemId) as any).text.length ?? 0)
      : caret0();

    core.edit.remove(f.id);

    core.focus(nextFocus, defaultTargetFor(core, nextFocus.id), { caret: c });
  },

  changeNesting(core: Core, sel: Selection, dir: "in" | "out"): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;

    if (dir === "in") {
      const loc = core.locate(f.id);
      if (!loc) return;

      const childLabel = core.meta(f.id).label;
      let wrapperId: ItemId = -1;

      core.commit((t) => {
        wrapperId = t.insert(loc.ownerId, { at: loc.index, kind: "group" });
        t.setLabel(wrapperId, childLabel);
        t.setLabel(f.id, "");
        t.move(f.id, wrapperId, { at: 0 });
      });

      core.focus(
        { scopeId: wrapperId, id: f.id },
        defaultTargetFor(core, f.id),
        {
          caret: caret0(),
        },
      );
      return;
    }

    const wrapperId = core.meta(f.id).ownerId;
    if (wrapperId == null) return;

    const wrapperMeta = core.meta(wrapperId);
    if (wrapperMeta.storedKind !== "group") return;

    const kids = core.childIds(wrapperId);
    if (kids.length !== 1 || kids[0] !== f.id) return;

    const ownerId = wrapperMeta.ownerId;
    if (ownerId == null) return;

    const idx = core.childIds(ownerId).indexOf(wrapperId);
    if (idx < 0) return;

    core.commit((t) => {
      t.move(f.id, ownerId, { at: idx });
      t.remove(wrapperId);
      t.setLabel(f.id, wrapperMeta.label);
    });

    core.focus({ scopeId: ownerId, id: f.id }, defaultTargetFor(core, f.id), {
      caret: caret0(),
    });
  },

  confirm(core: Core, sel: Selection): void {
    if (sel.kind !== "focused") return;

    const f = sel.focus;

    if (sel.target.startsWith("source:") || sel.target === "label") {
      core.focus(f, "content", { caret: caret0() });
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

type OutlineIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" }
  | { type: "INDENT"; dir: "in" | "out" }
  | { type: "DELETE_BOUNDARY"; dir: "backward" | "forward" }
  | { type: "SPLIT"; caret: Caret }
  | { type: "SET_DERIVED" };

type OutlineMountCtx = {
  core: Core;
  rootId: ItemId;
  navMove: (sel: Selection, dir: NavDir, mode: NavMode) => NavResult | null;
  dispatch: (intent: OutlineIntent) => void;
};

type OutlineNodeSpec = {
  focus: Focus;
  showHeader: boolean;
};

type TargetsByKey = Map<string, HTMLElement>;

function mountOutlineHeader(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  defs: readonly SourceFieldDef[],
  onTargets: (targets: TargetsByKey) => void,
): Component {
  const { core, dispatch } = mountCtx;

  return createComponent((componentCtx) => {
    const wrap = el("div");
    const labelHost = el("div");
    const fieldsHost = el("div", "header-fields");
    wrap.append(labelHost, fieldsHost);

    const toContent = () => {
      core.focus(focus, "content", { caret: caret0() });
    };

    const commitLabel = (text: string) => {
      const current = core.meta(focus.id).label ?? "";
      if (current === text) return;
      outlineCommands.setLabel(core, focus, text);
    };

    const labelComp = autosizeTextField({
      core,
      focus,
      target: "label",
      registerFocus: false,
      commit: commitLabel,
      getState: () => ({
        text: core.meta(focus.id).label ?? "",
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

    const targets: TargetsByKey = new Map();
    targets.set("label", labelComp.focusEl);

    for (const d of defs) {
      const labelEl = el("span", "equals", d.label);
      const valueHost = el("div");
      const row = el("div", "wrap");
      row.append(labelEl, valueHost);
      fieldsHost.append(row);

      const commitField = (text: string) => {
        const current = sourceFieldValue(core, focus.id, d);
        if (current === text) return;
        outlineCommands.commitSourceField(core, focus, d, text);
      };

      const fc = textField({
        core,
        focus,
        target: d.target,
        multiline: d.multiline,
        caret: "fromTarget",
        stopPropagation: true,
        registerFocus: false,
        commit: commitField,
        getState: () => ({
          text: sourceFieldValue(core, focus.id, d),
          readOnly: false,
          isIssue: false,
        }),
        onCommitEvents: ["blur"],
        textKeys: (inp) => {
          const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;

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
                boundaryNav("left");
                return;
              }

              if (!hasSel && e.key === "ArrowRight" && end === len) {
                e.preventDefault();
                e.stopPropagation();
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
      targets.set(d.target, fc.focusEl);
    }

    onTargets(targets);
    componentCtx.onCleanup(() => onTargets(new Map()));

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
      () => core.childIds(focus.id),
      (items) => {
        mgr.update(items);
      },
    );

    componentCtx.on(container, "pointerdown", (e: PointerEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      )
        return;
      core.focus(focus, "content", { caret: caret0() });
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
  const { core, dispatch } = mountCtx;

  return createComponent((componentCtx) => {
    const hostEl = el("div");

    const nested = core.mountView({
      id: focus.id,
      focus,
      continueAs: "outline",
    });
    if (nested) {
      ensureTabbable(nested.el);
      contentTargetRef.current = nested.el;
      hostEl.replaceChildren(nested.el);
      componentCtx.use(nested);
      return hostEl;
    }

    const vf = contentField({
      core,
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
  const { core } = mountCtx;
  const { focus } = spec;

  return createComponent((componentCtx) => {
    const root = el("div", "item");
    const headerContainer = el("div", "header");
    const contentContainer = el("div", "content-host");
    root.append(contentContainer);

    const headerSlot = componentCtx.slot(headerContainer);
    const contentSlot = componentCtx.slot(contentContainer);

    let headerTargets: TargetsByKey = new Map();
    const contentTargetRef: ContentTargetRef = { current: contentContainer };

    componentCtx.focusable({
      core,
      focus,
      elementFor: (target) => {
        if (target === "content")
          return contentTargetRef.current ?? contentContainer;
        return headerTargets.get(target) ?? null;
      },
    });

    const setHeaderTargets = (targets: TargetsByKey) => {
      headerTargets = targets;
    };

    componentCtx.watch(
      () => {
        const sel = core.selection();
        return sel.kind === "focused" && sameFocus(sel.focus, focus);
      },
      (focused) => {
        root.classList.toggle("focused", focused);
      },
    );

    let lastHeaderKey: string | null = null;
    let lastContentMode: "children" | "body" | null = null;

    componentCtx.watch(
      () => {
        const meta = core.meta(focus.id);
        const defs = sourceFieldsForItem(core, focus.id);
        const label = (meta.label ?? "").trim();
        const sourceKind = core.source(focus.id).kind;

        const v = core.value(focus.id);
        const viewKind = meta.view as ViewKind;
        const forceBody = viewKind != null && viewKind !== "outline";

        const mode: "children" | "body" = forceBody
          ? "body"
          : isItemGroupValue(v)
            ? "children"
            : "body";

        const sel = core.selection();
        const labelFocused =
          sel.kind === "focused" &&
          sameFocus(sel.focus, focus) &&
          sel.target === "label";

        return {
          label,
          defs,
          sourceKind,
          mode,
          isIssue: isIssueValue(v),
          labelFocused,
        };
      },
      ({ label, defs, sourceKind, mode, isIssue, labelFocused }) => {
        const needHeader =
          spec.showHeader && (label !== "" || defs.length > 0 || labelFocused);
        const headerKey = `${needHeader ? "on" : "off"}:${sourceKind}:${defs.length}`;

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
            setHeaderTargets(new Map());
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

export function createOutlineView(args: { core: Core; id: ItemId }): DomView {
  const { core, id: rootId } = args;

  const root = el("div", "view outline");
  const navStopsSignal = computed(() => collectNavStopsFrom(core, rootId));

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    outlineNavMove(core, navStopsSignal.value, sel, dir, mode);

  const dispatch = (intent: OutlineIntent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "CONFIRM": {
        outlineCommands.confirm(core, sel);
        return;
      }

      case "CANCEL": {
        core.blur();
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

  const mountCtx: OutlineMountCtx = { core, rootId, navMove, dispatch };

  const node = mountOutlineNode(mountCtx, {
    focus: { scopeId: rootId, id: rootId },
    showHeader: false,
  });

  root.append(node.el);
  ensureTabbable(root);

  const onKeyDown = (e: KeyboardEvent) => {
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
      dispatch({ type: "NAV", dir, mode });
      return;
    }

    if (e.key === "Enter") {
      stopEvent(e);
      dispatch({ type: "CONFIRM" });
      return;
    }

    if (e.key === "Backspace") {
      stopEvent(e);
      dispatch({ type: "DELETE_BOUNDARY", dir: "backward" });
      return;
    }

    if (e.key === "Delete") {
      stopEvent(e);
      dispatch({ type: "DELETE_BOUNDARY", dir: "forward" });
      return;
    }

    if (e.key === "Tab") {
      stopEvent(e);
      dispatch({ type: "INDENT", dir: e.shiftKey ? "out" : "in" });
      return;
    }

    if (e.key === "Escape") {
      stopEvent(e);
      dispatch({ type: "CANCEL" });
      return;
    }
  };

  if (core.selection().kind === "idle") {
    const first = navStopsSignal.value[0];
    if (first)
      core.focus(first, defaultTargetFor(core, first.id), { caret: caret0() });
  }

  return {
    id: `outline:${String(rootId)}`,
    root,
    onKeyDown,
    dispose() {
      node.dispose();
      root.replaceChildren();
    },
  };
}
