import { computed } from "@preact/signals-core";
import {
  type ItemId,
  type Core,
  type Component,
  type Focus,
  type Caret,
  type Selection,
  type DomView,
  type ScalarOrBlank,
  type Source,
  parseScalar,
  DEFAULT_TARGET,
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
  type FocusScope,
} from "../dom";

type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

const caret0 = (): Caret => ({ start: 0, end: 0 });
const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

function scalarToText(v: ScalarOrBlank): string {
  return v == null ? "" : String(v);
}

function fieldsFromSource(source: Source): SourceField[] {
  if (source.type === "derived") {
    return [
      { key: "expr", label: "=", multiline: true, text: source.expr ?? "" },
    ];
  }
  return [
    { key: "from", label: "~", multiline: false, text: source.from ?? "" },
    {
      key: "where",
      label: "where:",
      multiline: true,
      text: source.where ?? "",
    },
    {
      key: "orderBy",
      label: "orderBy:",
      multiline: true,
      text: source.orderBy ?? "",
    },
  ];
}

function patchSource(source: Source, key: string, text: string): Source {
  if (source.type === "derived") {
    if (key === "expr") return { type: "derived", expr: text };
    return source;
  }
  if (key === "from") return { ...source, from: text };
  if (key === "where") return { ...source, where: text };
  if (key === "orderBy") return { ...source, orderBy: text };
  return source;
}

const defaultTargetFor = (core: Core, id: ItemId): string => {
  const it = core.item(id);
  return it.mode.kind === "source" ? "label" : DEFAULT_TARGET;
};

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

const isNavStop = (core: Core, id: ItemId) => {
  const it = core.item(id);
  const kids = it.content.kind === "group" ? it.content.children : [];
  return kids.length === 0 || it.mode.kind === "source";
};

function collectNavStopsFrom(core: Core, rootId: ItemId): ItemId[] {
  const out: ItemId[] = [];
  const walk = (ownerId: ItemId) => {
    for (const childId of childrenOf(core, ownerId)) {
      if (isNavStop(core, childId)) out.push(childId);
      walk(childId);
    }
  };
  walk(rootId);
  return out;
}

type NavResult = { focus: Focus; target: string; caret?: Caret };

function findPresentedParent(
  rootId: ItemId,
  core: Core,
  want: ItemId,
): ItemId | null {
  if (rootId === want) return null;

  const stack: ItemId[] = [rootId];

  while (stack.length) {
    const cur = stack.pop()!;
    const kids = childrenOf(core, cur);
    for (const k of kids) {
      if (k === want) return cur;
      stack.push(k);
    }
  }

  return null;
}

function outlineNavMove(
  core: Core,
  rootId: ItemId,
  stops: ItemId[],
  sel: Selection,
  dir: NavDir,
  mode: NavMode,
): NavResult | null {
  if (sel.kind !== "focused") return null;

  const from = sel.focus.item;
  const at = Math.max(0, stops.indexOf(from));

  const neighbor = (delta: -1 | 1) => {
    const j = at + delta;
    return j >= 0 && j < stops.length ? stops[j]! : null;
  };

  const firstChildStop = (id: ItemId): ItemId | null => {
    for (const cid of childrenOf(core, id)) {
      if (isNavStop(core, cid)) return cid;
      const deeper = firstChildStop(cid);
      if (deeper) return deeper;
    }
    return null;
  };

  let next: ItemId | null = null;
  let caret: Caret | null = null;
  let targetOverride: string | null = null;

  if (dir === "up") next = neighbor(-1);
  else if (dir === "down") next = neighbor(1);
  else if (dir === "right") {
    next = firstChildStop(from) ?? neighbor(1);
    if (mode === "jump") next = neighbor(1) ?? next;
  } else if (dir === "left") {
    const prev = neighbor(-1);
    const parent = findPresentedParent(rootId, core, from);
    next = prev ?? parent;
    if (mode === "jump") next = parent ?? prev ?? null;

    if (prev && next && prev === next) {
      if (sel.target === DEFAULT_TARGET) {
        const it = core.item(prev);
        if (it.mode.kind === "source") {
          const fields = fieldsFromSource(it.mode.source);
          const last = fields[fields.length - 1];
          if (last) {
            targetOverride = `source:${last.key}`;
            caret = caretAt((last.text ?? "").length);
          }
        } else if (it.mode.kind === "direct" && it.content.kind === "scalar") {
          caret = caretAt(scalarToText(it.content.value).length);
        }
      }
    }
  }

  if (!next) return null;

  const target = targetOverride ?? defaultTargetFor(core, next);
  const outCaret = caret ?? caret0();
  return {
    focus: { container: sel.focus.container, item: next },
    target,
    caret: outCaret,
  };
}

export const outlineCommands = {
  setLabel(core: Core, id: ItemId, text: string): void {
    core.commit((t) => t.setLabel(id, text));
  },

  setText(core: Core, id: ItemId, text: string): void {
    core.commit((t) => t.setScalar(id, parseScalar(text)));
  },

  setDerived(core: Core, id: ItemId): void {
    core.commit((t) => t.setSource(id, { type: "derived", expr: "" }));
  },

  commitSourceField(core: Core, id: ItemId, key: string, text: string): void {
    const it = core.item(id);
    if (it.mode.kind !== "source") return;
    const next = patchSource(it.mode.source, key, text);
    core.commit((t) => t.setSource(id, next));
  },

  insertSibling(core: Core, sel: Selection, side: "before" | "after"): void {
    if (sel.kind !== "focused") return;

    const loc = core.locate(sel.focus.item);
    if (!loc) return;

    const { ownerId: containerId, index: idx } = loc;
    const at = side === "before" ? idx : idx + 1;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(containerId, { at, kind: "blank" });
    });

    core.focus({ container: containerId, item: id }, DEFAULT_TARGET, {
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

    const id = sel.focus.item;
    const snap = core.item(id);

    const loc = core.locate(id);
    if (!loc) return;

    const { ownerId: containerId, index: idx } = loc;

    if (!(snap.mode.kind === "direct" && snap.content.kind === "scalar")) {
      outlineCommands.insertSibling(core, sel, "after");
      return;
    }

    const curText = scalarToText(snap.content.value);
    const len = curText.length;

    const start = Math.max(0, Math.min(caretStart, len));
    const end = Math.max(0, Math.min(caretEnd, len));

    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let rightId: ItemId = "";

    core.commit((t) => {
      t.setScalar(id, parseScalar(left));
      rightId = t.insertChild(containerId, { at: idx + 1, kind: "blank" });
      t.setScalar(rightId, parseScalar(right));
    });

    core.focus({ container: containerId, item: rightId }, DEFAULT_TARGET, {
      caret: caret0(),
    });
  },

  joinBoundary(core: Core, sel: Selection, dir: "backward" | "forward"): void {
    if (sel.kind !== "focused") return;

    const loc = core.locate(sel.focus.item);
    if (!loc) return;

    const { ownerId: containerId, index: idx, siblings } = loc;

    const neighbor =
      dir === "backward"
        ? (siblings[idx - 1] ?? null)
        : (siblings[idx + 1] ?? null);
    if (!neighbor) return;

    const leftId = dir === "backward" ? neighbor : sel.focus.item;
    const rightId = dir === "backward" ? sel.focus.item : neighbor;

    const a = core.item(leftId);
    const b = core.item(rightId);

    if (!(a.mode.kind === "direct" && a.content.kind === "scalar")) return;
    if (!(b.mode.kind === "direct" && b.content.kind === "scalar")) return;

    const leftText = scalarToText(a.content.value);
    const rightText = scalarToText(b.content.value);

    core.commit((t) => {
      t.setScalar(leftId, parseScalar(leftText + rightText));
      t.remove(rightId);
    });

    core.focus({ container: containerId, item: leftId }, DEFAULT_TARGET, {
      caret: caretAt(leftText.length),
    });
  },

  removeItem(core: Core, sel: Selection, prefer: "prev" | "next"): void {
    if (sel.kind !== "focused") return;

    const loc = core.locate(sel.focus.item);
    if (!loc) return;

    const { ownerId: containerId, index: idx, siblings } = loc;

    const prev = siblings[idx - 1] ?? null;
    const next = siblings[idx + 1] ?? null;

    const chosen =
      prefer === "prev" ? (prev ?? next ?? null) : (next ?? prev ?? null);

    core.commit((t) => t.remove(sel.focus.item));

    if (chosen) {
      const it = core.item(chosen);
      const caret =
        prefer === "prev" &&
        it.mode.kind === "direct" &&
        it.content.kind === "scalar"
          ? caretAt(scalarToText(it.content.value).length)
          : caret0();

      core.focus(
        { container: containerId, item: chosen },
        defaultTargetFor(core, chosen),
        { caret },
      );
    } else {
      core.blur();
    }
  },

  changeNesting(
    core: Core,
    rootId: ItemId,
    sel: Selection,
    dir: "in" | "out",
  ): void {
    if (sel.kind !== "focused") return;

    const id = sel.focus.item;

    if (dir === "in") {
      const loc = core.locate(id);
      if (!loc) return;

      const { ownerId: containerId, index: idx } = loc;

      const label = core.item(id).label ?? "";
      let wrapperId: ItemId = "";

      core.commit((t) => {
        wrapperId = t.insertChild(containerId, { at: idx, kind: "group" });
        t.setLabel(wrapperId, label);
        t.setLabel(id, "");
        t.move(id, wrapperId, { at: 0 });
      });

      core.focus(
        { container: wrapperId, item: id },
        defaultTargetFor(core, id),
        { caret: caret0() },
      );
      return;
    }

    const loc = core.locate(id);
    if (!loc) return;

    const { ownerId: containerId } = loc;
    const parentId = findPresentedParent(rootId, core, containerId);
    if (!parentId) return;

    const parentSnap = core.item(parentId);
    if (parentSnap.content.kind !== "group") return;

    const wrapperIdx = parentSnap.content.children.indexOf(containerId);
    if (wrapperIdx < 0) return;

    const wrapperLabel = core.item(containerId).label ?? "";

    core.commit((t) => {
      t.move(id, parentId, { at: wrapperIdx });
      t.remove(containerId);
      t.setLabel(id, wrapperLabel);
    });

    core.focus({ container: parentId, item: id }, defaultTargetFor(core, id), {
      caret: caret0(),
    });
  },

  confirm(core: Core, sel: Selection): void {
    if (sel.kind !== "focused") return;

    const id = sel.focus.item;

    if (sel.target.startsWith("source:") || sel.target === "label") {
      core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
      return;
    }

    const it = core.item(id);
    if (it.mode.kind === "direct" && it.content.kind === "scalar") {
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

    const prefer = dir === "backward" ? "prev" : "next";
    const it = core.item(sel.focus.item);

    if (!(it.mode.kind === "direct" && it.content.kind === "scalar")) {
      outlineCommands.removeItem(core, sel, prefer);
      return;
    }

    if (scalarToText(it.content.value).length === 0) {
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

function mountOutlineHeader(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  fields: readonly SourceField[],
  scope: FocusScope,
): Component {
  const { core, dispatch } = mountCtx;
  const id = focus.item;

  return createComponent((componentCtx) => {
    const wrap = el("div");
    const labelHost = el("div");
    const fieldsHost = el("div", "header-fields");
    wrap.append(labelHost, fieldsHost);

    const toContent = () =>
      core.focus(focus, DEFAULT_TARGET, { caret: caret0() });

    const canEditLabel = core.item(id).mode.kind !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel) return;
      const cur = core.item(id).label ?? "";
      if (cur === text) return;
      outlineCommands.setLabel(core, id, text);
    };

    const labelComp = autosizeTextField({
      commit: commitLabel,
      getState: () => {
        const snap = core.item(id);
        return {
          text: snap.label ?? "",
          readOnly: !canEditLabel,
          isIssue: false,
        };
      },
      onCommitEvents: ["blur"],
      wrapClassName: "autosize label",
      textKeys: (inp) => {
        const inputEl = inp as HTMLInputElement;
        const handler = (e: KeyboardEvent) => {
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
        };
        return on(inputEl, "keydown", handler);
      },
    });

    labelHost.replaceChildren(labelComp.el);
    componentCtx.use(labelComp);

    scope.elementFor("label", () => labelComp.focusEl);
    scope.selectOn(labelComp.focusEl, {
      target: "label",
      caret: "fromTarget",
    });

    for (const f of fields) {
      const labelEl = el("span", "equals", f.label);
      const valueHost = el("div");
      const row = el("div", "wrap");
      row.append(labelEl, valueHost);
      fieldsHost.append(row);

      const commitField = (text: string) => {
        outlineCommands.commitSourceField(core, id, f.key, text);
      };

      const fc = textField({
        multiline: f.multiline,
        commit: commitField,
        getState: () => {
          const snap = core.item(id);
          if (snap.mode.kind !== "source") {
            return { text: "", readOnly: true, isIssue: false };
          }
          const text =
            fieldsFromSource(snap.mode.source).find((x) => x.key === f.key)
              ?.text ?? "";
          return { text, readOnly: false, isIssue: false };
        },
        onCommitEvents: ["blur"],
        textKeys: (inp) =>
          bindTextControlKeys(inp, {
            nav: {
              yieldUpDown: "always",
              yieldLeftRight: "always",
            },
            onNav: (dir, _mode) => {
              if (dir === "left" || dir === "right")
                dispatch({ type: "NAV", dir, mode: "step" });
            },
            onEnter: () => commitField((inp as any).value),
            onEscape: () => toContent(),
          }),
      });

      valueHost.replaceChildren(fc.el);
      componentCtx.use(fc);

      const tkey = `source:${f.key}`;
      scope.elementFor(tkey, () => fc.focusEl);
      scope.selectOn(fc.focusEl, { target: tkey, caret: "fromTarget" });
    }

    return wrap;
  });
}

function mountOutlineChildren(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  scope: FocusScope,
): Component {
  const { core } = mountCtx;

  return createComponent((componentCtx) => {
    const container = el("div", "group");
    ensureTabbable(container);

    scope.selectOn(container, { caret: "zero" });

    const mgr = componentCtx.list(container, (childId: string) => {
      const childFocus: Focus = { container: focus.item, item: childId };
      return mountOutlineNode(mountCtx, {
        focus: childFocus,
        showHeader: true,
      });
    });

    componentCtx.watch(
      () => {
        const snap = core.item(focus.item);
        const c = snap.content;
        return c.kind === "group" ? [...c.children] : [];
      },
      (ids) => mgr.update(ids),
    );

    return container;
  });
}

type ContentTargetRef = { current: HTMLElement | null };

function mountOutlineBody(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  scope: FocusScope,
  contentTargetRef: ContentTargetRef,
): Component {
  const { core, dispatch } = mountCtx;
  const id = focus.item;

  return createComponent((componentCtx) => {
    const hostEl = el("div");

    const nested = core.mountView({ id, focus, continueAs: "outline" });
    if (nested) {
      ensureTabbable(nested.el);
      contentTargetRef.current = nested.el;

      hostEl.replaceChildren(nested.el);
      componentCtx.use(nested);

      scope.selectOn(nested.el, { caret: "zero" });

      componentCtx.onCleanup(() => {
        contentTargetRef.current = hostEl;
      });

      return hostEl;
    }

    const vf = contentField({
      core,
      id,
      commitText: (text) => outlineCommands.setText(core, id, text),
      textKeys: (inp) => {
        const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;
        const stops: Array<() => void> = [];

        stops.push(
          on(inputEl, "keydown", (e: KeyboardEvent) => {
            if (e.key === "=" && !inputEl.value) {
              const it = core.item(id);
              if (it.mode.kind === "direct") {
                stopEvent(e);
                dispatch({ type: "SET_DERIVED" });
              }
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
      renderGroupChild: (childId) => {
        const d = el("div", "item readonly");
        ensureTabbable(d);
        return createComponent((cctx) => {
          cctx.watch(
            () => core.item(childId),
            (snap) => {
              const c = snap.content;
              const isIssue = c.kind === "issue";
              const text =
                c.kind === "issue"
                  ? c.message
                  : c.kind === "scalar"
                    ? c.value == null
                      ? ""
                      : String(c.value)
                    : "";
              d.textContent = text;
              d.classList.toggle("issue", isIssue);
            },
          );
          return d;
        });
      },
    });

    contentTargetRef.current = vf.focusEl;

    hostEl.replaceChildren(vf.el);
    componentCtx.use(vf);

    scope.selectOn(vf.focusEl as HTMLElement, {
      target: DEFAULT_TARGET,
      caret: "fromTarget",
    });

    componentCtx.onCleanup(() => {
      contentTargetRef.current = hostEl;
    });

    return hostEl;
  });
}

function mountOutlineNode(
  mountCtx: OutlineMountCtx,
  spec: { focus: Focus; showHeader: boolean },
): Component {
  const { core } = mountCtx;
  const focus = spec.focus;

  return createComponent((componentCtx) => {
    const root = el("div", "item");
    const headerContainer = el("div", "header");
    const contentContainer = el("div", "content-host");
    root.append(contentContainer);

    const headerSlot = componentCtx.slot(headerContainer);
    const contentSlot = componentCtx.slot(contentContainer);

    const contentTargetRef: ContentTargetRef = { current: contentContainer };

    const scope = componentCtx.focus(core, focus, {
      default: () => contentTargetRef.current ?? contentContainer,
    });

    scope.elementFor(DEFAULT_TARGET, () => contentTargetRef.current);
    scope.selectOn(root, { target: DEFAULT_TARGET, caret: "zero" });

    componentCtx.watch(
      () => {
        const sel = core.selection();
        return (
          sel.kind === "focused" &&
          sel.focus.item === focus.item &&
          sel.focus.container === focus.container
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
        const snap = core.item(focus.item);
        const label = (snap.label ?? "").trim();
        const fields =
          snap.mode.kind === "source"
            ? fieldsFromSource(snap.mode.source)
            : [];
        const content = snap.content;

        const sel = core.selection();
        const labelFocused =
          sel.kind === "focused" &&
          sel.focus.item === focus.item &&
          sel.focus.container === focus.container &&
          sel.target === "label";

        return {
          label,
          fields,
          mode:
            content.kind === "group"
              ? ("children" as const)
              : ("body" as const),
          isIssue: content.kind === "issue",
          labelFocused,
        };
      },
      ({ label, fields, mode, isIssue, labelFocused }) => {
        const needHeader =
          spec.showHeader &&
          (label !== "" || fields.length > 0 || labelFocused);
        const headerKey = `${needHeader ? "on" : "off"}:${fields.length}`;

        if (headerKey !== lastHeaderKey) {
          lastHeaderKey = headerKey;

          if (needHeader) {
            if (headerContainer.parentElement !== root)
              root.insertBefore(headerContainer, contentContainer);
            headerSlot.set(mountOutlineHeader(mountCtx, focus, fields, scope));
          } else {
            headerSlot.set(null);
            if (headerContainer.parentElement === root)
              headerContainer.remove();
          }
        }

        contentContainer.classList.toggle("issue", isIssue);

        if (mode !== lastContentMode) {
          lastContentMode = mode;

          if (mode === "children") {
            const kids = mountOutlineChildren(mountCtx, focus, scope);
            contentSlot.set(kids);
            ensureTabbable(kids.el);
            contentTargetRef.current = kids.el;
          } else {
            contentSlot.set(
              mountOutlineBody(mountCtx, focus, scope, contentTargetRef),
            );
          }
        }
      },
    );

    return root;
  });
}

export function createOutlineView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: rootId } = args;

  const root = el("div", "view outline");
  const navStopsSignal = computed(() => collectNavStopsFrom(core, rootId));

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    outlineNavMove(core, rootId, navStopsSignal.value, sel, dir, mode);

  const dispatch = (intent: OutlineIntent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "CONFIRM":
        outlineCommands.confirm(core, sel);
        return;

      case "CANCEL":
        core.blur();
        return;

      case "INDENT":
        outlineCommands.changeNesting(core, rootId, sel, intent.dir);
        return;

      case "DELETE_BOUNDARY":
        outlineCommands.deleteBoundary(core, sel, intent.dir);
        return;

      case "SPLIT":
        outlineCommands.splitAt(
          core,
          sel,
          intent.caret.start,
          intent.caret.end,
        );
        return;

      case "SET_DERIVED":
        if (sel.kind !== "focused") return;
        outlineCommands.setDerived(core, sel.focus.item);
        core.focus(sel.focus, "source:expr", { caret: caret0() });
        return;
    }
  };

  const mountCtx: OutlineMountCtx = { core, rootId, navMove, dispatch };

  const node = mountOutlineNode(mountCtx, {
    focus: args.focus ?? { container: rootId, item: rootId },
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
    if (first) {
      core.focus(
        { container: rootId, item: first },
        defaultTargetFor(core, first),
        { caret: caret0() },
      );
    }
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
