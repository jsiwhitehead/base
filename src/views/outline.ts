import { computed } from "@preact/signals-core";
import {
  type EntryId,
  type ItemRef,
  type Core,
  type Component,
  type Focus,
  type Caret,
  type Selection,
  type DomView,
  parseScalar,
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

type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

const caret0 = (): Caret => ({ start: 0, end: 0 });
const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

const sameRef = (a: ItemRef, b: ItemRef) =>
  a.entryId === b.entryId &&
  a.path.length === b.path.length &&
  a.path.every((x, i) => x === b.path[i]);

const isEntryRef = (r: ItemRef) => r.path.length === 0;

const refKey = (r: ItemRef): string =>
  `${String(r.entryId)}:${r.path.length ? r.path.join(",") : ""}`;

const defaultTargetFor = (core: Core, ref: ItemRef): string => {
  const it = core.item(ref);
  return it.edit.kind === "source" ? "label" : "content";
};

const childrenOf = (core: Core, ref: ItemRef): readonly ItemRef[] => {
  const c = core.item(ref).content;
  return c.kind === "group" ? c.children : [];
};

const isNavStop = (core: Core, ref: ItemRef) => {
  const it = core.item(ref);
  const kids = it.content.kind === "group" ? it.content.children : [];
  return kids.length === 0 || it.edit.kind === "source";
};

function collectNavStopsFrom(core: Core, root: ItemRef): ItemRef[] {
  const out: ItemRef[] = [];
  const walk = (owner: ItemRef) => {
    for (const child of childrenOf(core, owner)) {
      if (isNavStop(core, child)) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

type NavResult = { focus: Focus; target: string; caret?: Caret };

function outlineNavMove(
  core: Core,
  stops: ItemRef[],
  sel: Selection,
  dir: NavDir,
  mode: NavMode,
): NavResult | null {
  if (sel.kind !== "focused") return null;

  const from = sel.focus.ref;
  const at = Math.max(
    0,
    stops.findIndex((r) => sameRef(r, from)),
  );

  const neighbor = (delta: -1 | 1) => {
    const j = at + delta;
    return j >= 0 && j < stops.length ? stops[j]! : null;
  };

  const parentRef = (r: ItemRef): ItemRef | null => {
    if (!r.path.length) return null;
    return { entryId: r.entryId, path: r.path.slice(0, -1) };
  };

  const firstChildStop = (r: ItemRef): ItemRef | null => {
    for (const cid of childrenOf(core, r)) {
      if (isNavStop(core, cid)) return cid;
      const deeper = firstChildStop(cid);
      if (deeper) return deeper;
    }
    return null;
  };

  let next: ItemRef | null = null;
  let caret: Caret | null = null;
  let targetOverride: string | null = null;

  if (dir === "up") next = neighbor(-1);
  else if (dir === "down") next = neighbor(1);
  else if (dir === "right") {
    next = firstChildStop(from) ?? neighbor(1);
    if (mode === "jump") next = neighbor(1) ?? next;
  } else if (dir === "left") {
    const prev = neighbor(-1);
    const parent = parentRef(from);
    next = prev ?? parent;
    if (mode === "jump") next = parent ?? prev ?? null;

    if (prev && next && sameRef(prev, next)) {
      if (sel.target === "content") {
        const it = core.item(prev);
        if (it.edit.kind === "source") {
          const fields = it.edit.fields;
          const last = fields[fields.length - 1];
          if (last) {
            targetOverride = `source:${last.key}`;
            caret = caretAt((last.text ?? "").length);
          }
        } else if (it.edit.kind === "scalar") {
          caret = caretAt((it.edit.text ?? "").length);
        }
      }
    }
  }

  if (!next) return null;

  const target = targetOverride ?? defaultTargetFor(core, next);
  const outCaret = caret ?? caret0();
  return {
    focus: { scope: sel.focus.scope, ref: next },
    target,
    caret: outCaret,
  };
}

export const outlineCommands = {
  setLabel(core: Core, ref: ItemRef, text: string): void {
    if (!isEntryRef(ref)) return;
    core.edit.setLabel(ref, text);
  },

  setText(core: Core, ref: ItemRef, text: string): void {
    if (!isEntryRef(ref)) return;
    core.edit.setContentScalar(ref, parseScalar(text) as any);
  },

  setDerived(core: Core, ref: ItemRef): void {
    if (!isEntryRef(ref)) return;
    core.edit.setSourceField(ref, "expr", "");
  },

  commitSourceField(core: Core, ref: ItemRef, key: string, text: string): void {
    if (!isEntryRef(ref)) return;
    core.edit.setSourceField(ref, key, text);
  },

  insertSibling(core: Core, sel: Selection, side: "before" | "after"): void {
    if (sel.kind !== "focused") return;
    const scope = sel.focus.scope;

    const c = core.item(scope).content;
    if (c.kind !== "group") return;

    const siblings = c.children;
    const idx = siblings.findIndex((r) => sameRef(r, sel.focus.ref));
    if (idx < 0) return;

    const at = side === "before" ? idx : idx + 1;

    let id: EntryId = -1;
    core.commit((t) => {
      id = t.insertChild(scope, { at, kind: "blank" });
    });

    const ref: ItemRef = { entryId: id, path: [] };
    core.focus({ scope, ref }, "content", { caret: caret0() });
  },

  splitAt(
    core: Core,
    sel: Selection,
    caretStart: number,
    caretEnd = caretStart,
  ): void {
    if (sel.kind !== "focused") return;
    const ref = sel.focus.ref;
    if (!isEntryRef(ref)) {
      outlineCommands.insertSibling(core, sel, "after");
      return;
    }

    const snap = core.item(ref);
    if (snap.edit.kind !== "scalar") {
      outlineCommands.insertSibling(core, sel, "after");
      return;
    }

    const scope = sel.focus.scope;
    const c = core.item(scope).content;
    if (c.kind !== "group") return;

    const siblings = c.children;
    const idx = siblings.findIndex((r) => sameRef(r, ref));
    if (idx < 0) return;

    const curText = snap.edit.text ?? "";
    const len = curText.length;

    const start = Math.max(0, Math.min(caretStart, len));
    const end = Math.max(0, Math.min(caretEnd, len));

    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let rightId: EntryId = -1;

    core.commit((t) => {
      t.setContentScalar(ref, parseScalar(left) as any);
      rightId = t.insertChild(scope, { at: idx + 1, kind: "blank" });
      t.setContentScalar(
        { entryId: rightId, path: [] },
        parseScalar(right) as any,
      );
    });

    core.focus({ scope, ref: { entryId: rightId, path: [] } }, "content", {
      caret: caret0(),
    });
  },

  joinBoundary(core: Core, sel: Selection, dir: "backward" | "forward"): void {
    if (sel.kind !== "focused") return;

    const scope = sel.focus.scope;
    const c = core.item(scope).content;
    if (c.kind !== "group") return;

    const siblings = c.children;
    const idx = siblings.findIndex((r) => sameRef(r, sel.focus.ref));
    if (idx < 0) return;

    const neighbor =
      dir === "backward"
        ? (siblings[idx - 1] ?? null)
        : (siblings[idx + 1] ?? null);
    if (!neighbor) return;

    const leftRef = dir === "backward" ? neighbor : sel.focus.ref;
    const rightRef = dir === "backward" ? sel.focus.ref : neighbor;

    const a = core.item(leftRef);
    const b = core.item(rightRef);
    if (a.edit.kind !== "scalar" || b.edit.kind !== "scalar") return;
    if (!isEntryRef(leftRef) || !isEntryRef(rightRef)) return;

    const leftText = a.edit.text ?? "";
    const rightText = b.edit.text ?? "";

    core.commit((t) => {
      t.setContentScalar(leftRef, parseScalar(leftText + rightText) as any);
      t.removeEntry(rightRef.entryId);
    });

    core.focus({ scope, ref: leftRef }, "content", {
      caret: caretAt(leftText.length),
    });
  },

  removeItem(core: Core, sel: Selection, prefer: "prev" | "next"): void {
    if (sel.kind !== "focused") return;
    const ref = sel.focus.ref;
    if (!isEntryRef(ref)) return;

    const scope = sel.focus.scope;
    const c = core.item(scope).content;
    if (c.kind !== "group") return;

    const siblings = c.children;
    const idx = siblings.findIndex((r) => sameRef(r, ref));
    if (idx < 0) return;

    const prev = siblings[idx - 1] ?? null;
    const next = siblings[idx + 1] ?? null;

    const chosen =
      prefer === "prev" ? (prev ?? next ?? null) : (next ?? prev ?? null);

    core.edit.removeEntry(ref.entryId);

    if (chosen) {
      const it = core.item(chosen);
      const caret =
        prefer === "prev" && it.edit.kind === "scalar"
          ? caretAt((it.edit.text ?? "").length)
          : caret0();
      core.focus({ scope, ref: chosen }, defaultTargetFor(core, chosen), {
        caret,
      });
    } else {
      core.blur();
    }
  },

  changeNesting(core: Core, sel: Selection, dir: "in" | "out"): void {
    if (sel.kind !== "focused") return;

    const ref = sel.focus.ref;
    const scope = sel.focus.scope;
    if (!isEntryRef(ref) || !isEntryRef(scope)) return;

    const scopeContent = core.item(scope).content;
    if (scopeContent.kind !== "group") return;

    const siblings = scopeContent.children;
    const idx = siblings.findIndex((r) => sameRef(r, ref));
    if (idx < 0) return;

    if (dir === "in") {
      const label = core.item(ref).label ?? "";
      let wrapperId: EntryId = -1;

      core.commit((t) => {
        wrapperId = t.insertChild(scope, { at: idx, kind: "group" });
        t.setLabel({ entryId: wrapperId, path: [] }, label);
        t.setLabel(ref, "");
        t.moveEntry(ref.entryId, wrapperId, { at: 0 });
      });

      core.focus(
        { scope: { entryId: wrapperId, path: [] }, ref },
        defaultTargetFor(core, ref),
        { caret: caret0() },
      );
      return;
    }

    const parentEntryId = scope.entryId;
    const parentRef: ItemRef | null = { entryId: parentEntryId, path: [] };

    if (!parentRef) return;

    const parentContent = core.item(parentRef).content;
    if (parentContent.kind !== "group") return;

    const wrapperIdx = parentContent.children.findIndex(
      (r) => r.entryId === scope.entryId && r.path.length === 0,
    );
    if (wrapperIdx < 0) return;

    const wrapperLabel = core.item(scope).label ?? "";

    core.commit((t) => {
      t.moveEntry(ref.entryId, parentEntryId, { at: wrapperIdx });
      t.removeEntry(scope.entryId);
      t.setLabel(ref, wrapperLabel);
    });

    core.focus({ scope: parentRef, ref }, defaultTargetFor(core, ref), {
      caret: caret0(),
    });
  },

  confirm(core: Core, sel: Selection): void {
    if (sel.kind !== "focused") return;

    const ref = sel.focus.ref;

    if (sel.target.startsWith("source:") || sel.target === "label") {
      core.focus(sel.focus, "content", { caret: caret0() });
      return;
    }

    const it = core.item(ref);
    if (it.edit.kind === "scalar") {
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

    const ref = sel.focus.ref;
    const prefer = dir === "backward" ? "prev" : "next";

    const it = core.item(ref);
    if (it.edit.kind !== "scalar") {
      outlineCommands.removeItem(core, sel, prefer);
      return;
    }

    if ((it.edit.text ?? "").length === 0) {
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
  root: ItemRef;
  navMove: (sel: Selection, dir: NavDir, mode: NavMode) => NavResult | null;
  dispatch: (intent: OutlineIntent) => void;
};

type TargetsByKey = Map<string, HTMLElement>;

function mountOutlineHeader(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  fields: readonly SourceField[],
  onTargets: (targets: TargetsByKey) => void,
): Component {
  const { core, dispatch } = mountCtx;
  const ref = focus.ref;

  return createComponent((componentCtx) => {
    const wrap = el("div");
    const labelHost = el("div");
    const fieldsHost = el("div", "header-fields");
    wrap.append(labelHost, fieldsHost);

    const toContent = () => core.focus(focus, "content", { caret: caret0() });

    const canEditLabel = isEntryRef(ref);

    const commitLabel = (text: string) => {
      if (!canEditLabel) return;
      const cur = core.item(ref).label ?? "";
      if (cur === text) return;
      outlineCommands.setLabel(core, ref, text);
    };

    const labelComp = autosizeTextField({
      core,
      focus,
      target: "label",
      registerFocus: false,
      commit: commitLabel,
      getState: () => ({
        text: core.item(ref).label ?? "",
        readOnly: !canEditLabel,
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

    for (const f of fields) {
      const labelEl = el("span", "equals", f.label);
      const valueHost = el("div");
      const row = el("div", "wrap");
      row.append(labelEl, valueHost);
      fieldsHost.append(row);

      const commitField = (text: string) => {
        outlineCommands.commitSourceField(core, ref, f.key, text);
      };

      const fc = textField({
        core,
        focus,
        target: `source:${f.key}`,
        multiline: f.multiline,
        caret: "fromTarget",
        stopPropagation: true,
        registerFocus: false,
        commit: commitField,
        getState: () => {
          const snap = core.item(ref);
          const text =
            snap.edit.kind === "source"
              ? (snap.edit.fields.find((x) => x.key === f.key)?.text ?? "")
              : "";
          return { text, readOnly: !isEntryRef(ref), isIssue: false };
        },
        onCommitEvents: ["blur"],
        textKeys: (inp) => {
          const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;
          const boundaryNav = (dir: "left" | "right") =>
            dispatch({ type: "NAV", dir, mode: "step" });

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
      targets.set(`source:${f.key}`, fc.focusEl);
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

    const mgr = componentCtx.list(container, (key: string) => {
      const childRef = (() => {
        const [a, rest] = key.split(":");
        const entryId = Number(a);
        const path =
          rest && rest.length ? rest.split(",").map((x) => Number(x)) : [];
        return { entryId, path } as ItemRef;
      })();
      return mountOutlineNode(mountCtx, {
        focus: { scope: focus.ref, ref: childRef },
        showHeader: true,
      });
    });

    componentCtx.watch(
      () => {
        const c = core.item(focus.ref).content;
        return c.kind === "group" ? c.children.map(refKey) : [];
      },
      (keys) => mgr.update(keys),
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
  const ref = focus.ref;

  return createComponent((componentCtx) => {
    const hostEl = el("div");

    if (isEntryRef(ref)) {
      const nested = core.mountView({
        id: ref.entryId,
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
    }

    const vf = contentField({
      core,
      focus,
      ref,
      registerFocus: false,
      focusElRef: contentTargetRef,
      commitText: (text) => outlineCommands.setText(core, ref, text),
      textKeys: (inp) => {
        const inputEl = inp as HTMLInputElement | HTMLTextAreaElement;
        const stops: Array<() => void> = [];

        stops.push(
          on(inputEl, "keydown", (e: KeyboardEvent) => {
            if (e.key === "=" && !inputEl.value && isEntryRef(ref)) {
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
      renderGroupChild: (childRef) => {
        const d = el("div", "item readonly");
        return createComponent((componentCtx) => {
          componentCtx.watch(
            () => core.item(childRef).content,
            (c) => {
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
        return (
          sel.kind === "focused" &&
          sameRef(sel.focus.ref, focus.ref) &&
          sameRef(sel.focus.scope, focus.scope)
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
        const snap = core.item(focus.ref);
        const label = (snap.label ?? "").trim();
        const fields =
          snap.edit.kind === "source"
            ? (snap.edit.fields as SourceField[])
            : [];
        const content = snap.content;
        const mode: "children" | "body" =
          content.kind === "group" ? "children" : "body";

        const sel = core.selection();
        const labelFocused =
          sel.kind === "focused" &&
          sameRef(sel.focus.ref, focus.ref) &&
          sameRef(sel.focus.scope, focus.scope) &&
          sel.target === "label";

        return {
          label,
          fields,
          mode,
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
            headerSlot.set(
              mountOutlineHeader(mountCtx, focus, fields, setHeaderTargets),
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

export function createOutlineView(args: {
  core: Core;
  id: EntryId;
  focus?: Focus;
}): DomView {
  const { core, id } = args;

  const rootRef: ItemRef = { entryId: id, path: [] };

  const root = el("div", "view outline");
  const navStopsSignal = computed(() => collectNavStopsFrom(core, rootRef));

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

      case "CONFIRM":
        outlineCommands.confirm(core, sel);
        return;

      case "CANCEL":
        core.blur();
        return;

      case "INDENT":
        outlineCommands.changeNesting(core, sel, intent.dir);
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
        outlineCommands.setDerived(core, sel.focus.ref);
        core.focus(sel.focus, "source:expr", { caret: caret0() });
        return;
    }
  };

  const mountCtx: OutlineMountCtx = { core, root: rootRef, navMove, dispatch };

  const node = mountOutlineNode(mountCtx, {
    focus: args.focus ?? { scope: rootRef, ref: rootRef },
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
        { scope: rootRef, ref: first },
        defaultTargetFor(core, first),
        {
          caret: caret0(),
        },
      );
    }
  }

  return {
    id: `outline:${String(id)}`,
    root,
    onKeyDown,
    dispose() {
      node.dispose();
      root.replaceChildren();
    },
  };
}
