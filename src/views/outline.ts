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
  defaultTextCaret,
} from "../core";
import {
  type NavDir,
  type NavMode,
  defaultTextNav,
  el,
  on,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  createContent,
  autosizeTextField,
  scalarField,
  makeNotTabbable,
  textField,
  SELECT_ALL,
  caret0,
  caretAt,
  isPrintableKeydown,
  insertTextIntoActiveEditor,
  escapeLadder,
  keyNavMode,
  keyToNavDir,
  presentItem,
} from "../dom";

type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

const VALUE_TARGET = "value";

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

function getEditStopsForItem(core: Core, id: ItemId): string[] {
  const it = core.item(id);

  if (it.mode.kind === "source") {
    return fieldsFromSource(it.mode.source).map((f) => `source:${f.key}`);
  }

  if (it.mode.kind === "direct" && it.content.kind === "scalar") {
    return [VALUE_TARGET];
  }

  return [];
}

const defaultTargetFor = (core: Core, id: ItemId): string => {
  const it = core.item(id);
  return it.mode.kind === "source" ? "source:expr" : DEFAULT_TARGET;
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
          targetOverride = VALUE_TARGET;
          caret = caretAt(scalarToText(it.content.value).length);
        }
      }
    }
  }

  if (!next) return null;

  const target = targetOverride ?? DEFAULT_TARGET;
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

    core.focus({ container: containerId, item: id }, VALUE_TARGET, {
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

    core.focus({ container: containerId, item: rightId }, VALUE_TARGET, {
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

    core.focus({ container: containerId, item: leftId }, VALUE_TARGET, {
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
      core.focus(
        { container: containerId, item: chosen },
        DEFAULT_TARGET,
        prefer === "prev"
          ? {
              caret: caretAt(
                scalarToText(
                  core.item(chosen).content.kind === "scalar"
                    ? (core.item(chosen).content as any).value
                    : null,
                ).length,
              ),
            }
          : { caret: caret0() },
      );
      return;
    }

    core.blur();
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

      core.focus({ container: wrapperId, item: id }, DEFAULT_TARGET, {
        caret: caret0(),
      });
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

    core.focus({ container: parentId, item: id }, DEFAULT_TARGET, {
      caret: caret0(),
    });
  },

  confirm(core: Core, sel: Selection): void {
    if (sel.kind !== "focused") return;

    const id = sel.focus.item;

    if (sel.target.startsWith("source:")) {
      core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
      return;
    }

    const it = core.item(id);

    if (sel.target === DEFAULT_TARGET) {
      if (it.mode.kind === "direct" && it.content.kind === "scalar") {
        core.focus(sel.focus, VALUE_TARGET, {
          caret: caretAt(scalarToText(it.content.value).length),
        });
        return;
      }
      if (it.mode.kind === "source") {
        core.focus(sel.focus, "source:expr", { caret: caret0() });
        return;
      }
      outlineCommands.insertSibling(core, sel, "after");
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
  | { type: "ESCAPE" }
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

function mountMeta(mountCtx: OutlineMountCtx, focus: Focus): Component {
  const { core, dispatch } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const meta = el("div", "ui-meta");

    const labelWrap = el("div", "ui-label");
    const sourceWrap = el("div", "ui-source");
    meta.append(labelWrap, sourceWrap);

    const toContent = () =>
      core.focus(focus, DEFAULT_TARGET, { caret: caret0() });

    const canEditLabel = () => core.item(id).mode.kind !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel()) return;
      const cur = core.item(id).label ?? "";
      if (cur === text) return;
      outlineCommands.setLabel(core, id, text);
    };

    const labelSlot = ctx.slot(labelWrap);

    const labelComp = autosizeTextField(core, {
      commit: commitLabel,
      getState: () => {
        const snap = core.item(id);
        return {
          text: snap.label ?? "",
          readOnly: !canEditLabel(),
          isIssue: false,
        };
      },
      onCommitEvents: ["blur"],
      wrapClassName: "autosize",
      target: "label",
      textKeys: (inp) => {
        makeNotTabbable(inp);
        const handler = (e: KeyboardEvent) => {
          if (e.key === " ") {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Enter") commitLabel(inp.value);
            toContent();
          }
        };
        return on(inp, "keydown", handler);
      },
    });

    makeNotTabbable(labelComp.focusEl);
    labelSlot.set(labelComp);
    ctx.cleanup(() => labelComp.dispose());

    ctx.target(focus, "label", () => labelComp.focusEl, {
      caret: defaultTextCaret(),
    });
    ctx.select(focus, labelComp.focusEl, {
      target: "label",
      caret: "fromTarget",
    });

    const fieldSpec = new Map<string, SourceField>();

    const rows = ctx.list(sourceWrap, (key: string) => {
      return createComponent(core, (ctx2) => {
        const row = el("div", "ui-source-row");
        const keyEl = el("div", "ui-source-key");
        const valEl = el("div", "ui-source-val");
        row.append(keyEl, valEl);

        const valSlot = ctx2.slot(valEl);

        const makeField = (multiline: boolean, tkey: string) =>
          textField(core, {
            multiline,
            commit: (text) =>
              outlineCommands.commitSourceField(core, id, key, text),
            getState: () => {
              const snap = core.item(id);
              if (snap.mode.kind !== "source")
                return { text: "", readOnly: true, isIssue: false };
              const txt =
                fieldsFromSource(snap.mode.source).find((x) => x.key === key)
                  ?.text ?? "";
              return { text: txt, readOnly: false, isIssue: false };
            },
            onCommitEvents: ["blur"],
            target: tkey,
            textKeys: (inp) => {
              makeNotTabbable(inp);
              return bindTextControlKeys(inp, {
                nav: { yieldUpDown: "always", yieldLeftRight: "always" },
                onNav: (dir) => {
                  if (dir === "left" || dir === "right")
                    dispatch({ type: "NAV", dir, mode: "step" });
                },
                onEnter: () =>
                  outlineCommands.commitSourceField(core, id, key, inp.value),
                onEscape: () => dispatch({ type: "ESCAPE" }),
              });
            },
          });

        let fieldComp: Component | null = null;

        ctx2.effect(() => {
          const spec = fieldSpec.get(key);
          if (!spec) return;

          if (keyEl.textContent !== spec.label) keyEl.textContent = spec.label;

          const tkey = `source:${key}`;

          if (!fieldComp) {
            const fc = makeField(spec.multiline, tkey);
            makeNotTabbable(fc.focusEl);
            fieldComp = fc;
            valSlot.set(fc);
            ctx2.cleanup(() => fc.dispose());

            ctx2.target(focus, tkey, () => fc.focusEl, {
              caret: defaultTextCaret(),
            });
            ctx2.select(focus, fc.focusEl, {
              target: tkey,
              caret: "fromTarget",
            });
          }
        });

        return row;
      });
    });

    ctx.effect(() => {
      const snap = core.item(id);
      const label = (snap.label ?? "").trim();
      const fields =
        snap.mode.kind === "source" ? fieldsFromSource(snap.mode.source) : [];
      const sel = core.selection();
      const labelFocused =
        sel.kind === "focused" &&
        sel.focus.item === focus.item &&
        sel.focus.container === focus.container &&
        sel.target === "label";

      const needMeta = label !== "" || fields.length > 0 || labelFocused;

      meta.classList.toggle("hidden", !needMeta);

      fieldSpec.clear();
      for (const f of fields) fieldSpec.set(f.key, f);

      rows.update(needMeta ? fields.map((f) => f.key) : []);
    });

    return meta;
  });
}

function mountOutlineItem(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  showMeta: boolean,
): Component {
  const { core, dispatch } = mountCtx;
  const id = focus.item;

  return createContent({ core, focus, view: "outline" }, (ctx) => {
    const root = el("div");

    let metaComp: Component | null = null;
    let metaEl: HTMLElement | null = null;

    let bodyComp: Component | null = null;
    let bodyEl: HTMLElement | null = null;

    const unmountMeta = () => {
      metaComp?.dispose();
      metaComp = null;
      metaEl?.remove();
      metaEl = null;
    };

    const mountMetaIfNeeded = () => {
      if (metaComp) return;
      metaComp = mountMeta(mountCtx, focus);
      metaEl = metaComp.el;
      root.insertBefore(metaEl, root.firstChild);
    };

    const unmountBody = () => {
      bodyComp?.dispose();
      bodyComp = null;
      bodyEl?.remove();
      bodyEl = null;
    };

    const mountScalarBody = () => {
      const sf = scalarField({
        core,
        focus,
        className: "ui-outline-scalar",
        target: VALUE_TARGET,
        multiline: true,
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
              onEscape: () => dispatch({ type: "ESCAPE" }),
            }),
          );

          return () => {
            for (const fn of stops.toReversed()) fn();
          };
        },
      });

      makeNotTabbable(sf.focusEl);

      bodyComp = { el: sf.el, dispose: () => sf.dispose() };
      bodyEl = sf.el;

      ctx.select(focus, sf.focusEl, {
        target: VALUE_TARGET,
        caret: "fromTarget",
      });

      root.append(sf.el);
    };

    const mountGroupBody = () => {
      const wrap = el("div", "ui-outline-group");

      const mgr = ctx.list<ItemId>(wrap, (childId) => {
        const childFocus: Focus = { container: id, item: childId };
        return mountNode(mountCtx, childFocus, true);
      });

      ctx.effect(() => {
        const s = core.item(id);
        const c = s.content;
        mgr.update(c.kind === "group" ? [...c.children] : []);
      });

      bodyComp = { el: wrap, dispose: () => wrap.replaceChildren() };
      bodyEl = wrap;

      root.append(wrap);
    };

    const remount = () => {
      const snap = core.item(id);

      const label = (snap.label ?? "").trim();
      const fields =
        snap.mode.kind === "source" ? fieldsFromSource(snap.mode.source) : [];

      const sel = core.selection();
      const labelFocused =
        sel.kind === "focused" &&
        sel.focus.item === focus.item &&
        sel.focus.container === focus.container &&
        sel.target === "label";

      const needMeta =
        showMeta && (label !== "" || fields.length > 0 || labelFocused);

      if (needMeta) mountMetaIfNeeded();
      else unmountMeta();

      const wantBodyKind = snap.content.kind === "group" ? "group" : "scalar";
      const haveBodyKind = bodyEl?.classList.contains("ui-outline-group")
        ? "group"
        : bodyEl?.classList.contains("ui-outline-scalar")
          ? "scalar"
          : null;

      if (wantBodyKind !== haveBodyKind) {
        unmountBody();
        if (wantBodyKind === "group") mountGroupBody();
        else mountScalarBody();
      }
    };

    ctx.effect(() => {
      core.item(id);
      core.selection();
      remount();
    });

    ctx.cleanup(() => {
      metaComp?.dispose();
      bodyComp?.dispose();
      metaComp = null;
      bodyComp = null;
      metaEl = null;
      bodyEl = null;
    });

    return root;
  });
}

function mountNode(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  showMeta: boolean,
): Component {
  const { core } = mountCtx;
  const id = focus.item;

  return presentItem({
    core,
    focus,
    className: "ui-outline-node",
    mount(ctx, _host, slot) {
      ctx.effect(() => {
        core.item(id);
        const mounted = core.mountView({ id, focus, continueAs: "outline" });
        slot.set(mounted ?? mountOutlineItem(mountCtx, focus, showMeta));
      });
    },
  });
}

export function createOutlineView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: rootId } = args;

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
      case "ESCAPE":
        escapeLadder(core);
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

  const focus: Focus = args.focus ?? { container: rootId, item: rootId };
  const content = mountOutlineItem(
    { core, rootId, navMove, dispatch },
    focus,
    false,
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const sel = core.selection();

    if (
      isPrintableKeydown(e) &&
      sel.kind === "focused" &&
      sel.target === DEFAULT_TARGET
    ) {
      const stops = getEditStopsForItem(core, sel.focus.item);
      const target = stops[0] ?? null;
      if (!target) return;
      stopEvent(e);
      core.focus(sel.focus, target, { caret: SELECT_ALL });
      queueMicrotask(() => insertTextIntoActiveEditor(e.key));
      return;
    }

    const dir = keyToNavDir(e.key);
    if (dir) {
      stopEvent(e);
      dispatch({ type: "NAV", dir, mode: keyNavMode(e) });
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
      dispatch({ type: "ESCAPE" });
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
    root: content.el,
    onKeyDown,
    dispose() {
      content.dispose();
    },
  };
}
