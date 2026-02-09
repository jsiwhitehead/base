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
  type Intent,
  el,
  createComponent,
  createContent,
  autosizeTextField,
  textField,
  scalarField,
  bindTextEditorYield,
  SELECT_ALL,
  caret0,
  caretAt,
  consume,
  parseKeydownIntent,
  insertTextIntoActiveEditor,
  escapeLadder,
  presentItem,
} from "../dom";

type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

const VALUE_TARGET = "value";
const LABEL_TARGET = "label";

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
  }

  if (!next) return null;

  return {
    focus: { container: sel.focus.container, item: next },
    target: DEFAULT_TARGET,
    caret: caret0(),
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

  insertSibling(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    side: "before" | "after",
  ): void {
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
    sel: Extract<Selection, { kind: "focused" }>,
    caretStart: number,
    caretEnd = caretStart,
  ): void {
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

  joinBoundary(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    dir: "backward" | "forward",
  ): void {
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

  removeItem(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    prefer: "prev" | "next",
  ): void {
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
    sel: Extract<Selection, { kind: "focused" }>,
    dir: "in" | "out",
  ): void {
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

  confirm(core: Core, sel: Extract<Selection, { kind: "focused" }>): void {
    const id = sel.focus.item;
    const it = core.item(id);

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
  },

  deleteBoundary(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    dir: "backward" | "forward",
  ): void {
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

type OutlineMountCtx = {
  core: Core;
  rootId: ItemId;
  navMove: (sel: Selection, dir: NavDir, mode: NavMode) => NavResult | null;
  dispatch: (intent: Intent) => void;
};

function mountMeta(mountCtx: OutlineMountCtx, focus: Focus): Component {
  const { core, dispatch } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const meta = el("div", "ui-meta");

    const labelWrap = el("div", "ui-label");
    const sourceWrap = el("div", "ui-source");
    meta.append(labelWrap, sourceWrap);

    const canEditLabel = () => core.item(id).mode.kind !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel()) return;
      const cur = core.item(id).label ?? "";
      if (cur === text) return;
      outlineCommands.setLabel(core, id, text);
    };

    const labelComp = autosizeTextField(core, {
      focus,
      target: LABEL_TARGET,
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
    });

    labelWrap.replaceChildren(labelComp.el);
    ctx.cleanup(() => labelComp.dispose());
    ctx.cleanup(bindTextEditorYield(labelComp.focusEl, dispatch));

    const rows = ctx.list(sourceWrap, (key: string) => {
      return createComponent(core, (ctx2) => {
        const row = el("div", "ui-source-row");
        const keyEl = el("div", "ui-source-key");
        const valEl = el("div", "ui-source-val");
        row.append(keyEl, valEl);

        const tkey = `source:${key}`;

        const specForKey = (): SourceField | null => {
          const snap = core.item(id);
          if (snap.mode.kind !== "source") return null;
          return (
            fieldsFromSource(snap.mode.source).find((f) => f.key === key) ??
            null
          );
        };

        const multilineForKey = (): boolean => specForKey()?.multiline ?? true;
        const labelForKey = (): string => specForKey()?.label ?? "";

        const fc = textField(core, {
          focus,
          target: tkey,
          multiline: multilineForKey(),
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
        });

        valEl.replaceChildren(fc.el);
        ctx2.cleanup(() => fc.dispose());
        ctx2.cleanup(bindTextEditorYield(fc.focusEl, dispatch));

        ctx2.effect(() => {
          const lbl = labelForKey();
          if (keyEl.textContent !== lbl) keyEl.textContent = lbl;
        });

        return row;
      });
    });

    const labelFocused = computed(() => {
      const sel = core.selection();
      return (
        sel.kind === "focused" &&
        sel.focus.item === focus.item &&
        sel.focus.container === focus.container &&
        sel.target === LABEL_TARGET
      );
    });

    const hasLabel = computed(() => (core.item(id).label ?? "").trim() !== "");
    const fieldsSignal = computed(() => {
      const snap = core.item(id);
      return snap.mode.kind === "source"
        ? fieldsFromSource(snap.mode.source)
        : [];
    });

    const hasFields = computed(() => fieldsSignal.value.length > 0);
    const needMeta = computed(
      () => hasLabel.value || hasFields.value || labelFocused.value,
    );

    ctx.effect(() => {
      rows.update(fieldsSignal.value.map((f) => f.key));
    });

    ctx.effect(() => {
      meta.classList.toggle("hidden", !needMeta.value);
    });

    return meta;
  });
}

function mountScalarBody(mountCtx: OutlineMountCtx, focus: Focus): Component {
  const { core, dispatch } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const sf = scalarField({
      core,
      focus,
      className: "ui-outline-scalar",
      target: VALUE_TARGET,
      multiline: true,
      commitText: (text) => outlineCommands.setText(core, id, text),
      onCommitEvents: ["input"],
    });

    ctx.cleanup(bindTextEditorYield(sf.focusEl as any, dispatch));
    ctx.cleanup(() => sf.dispose());

    return sf.el;
  });
}

function mountGroupBody(mountCtx: OutlineMountCtx, focus: Focus): Component {
  const { core } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
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

    return wrap;
  });
}

function mountOutlineItem(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  showMeta: boolean,
): Component {
  const { core } = mountCtx;
  const id = focus.item;

  return createContent({ core, focus, view: "outline" }, (ctx) => {
    const root = el("div");

    if (showMeta) {
      const metaComp = mountMeta(mountCtx, focus);
      root.append(metaComp.el);
      ctx.cleanup(() => metaComp.dispose());
    }

    const bodyHost = el("div");
    root.append(bodyHost);

    const bodySlot = ctx.slot(bodyHost);

    let curKind: "group" | "scalar" | null = null;
    let cur: Component | null = null;

    ctx.effect(() => {
      const snap = core.item(id);
      const nextKind = snap.content.kind === "group" ? "group" : "scalar";
      if (cur && curKind === nextKind) return;

      curKind = nextKind;
      cur =
        nextKind === "group"
          ? mountGroupBody(mountCtx, focus)
          : mountScalarBody(mountCtx, focus);

      bodySlot.set(cur);
    });

    ctx.cleanup(() => {
      curKind = null;
      cur = null;
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
      let curView: string | null = null;

      ctx.effect(() => {
        const wanted = core.view(id);
        if (wanted === curView) return;
        curView = wanted;

        slot.set(
          wanted === "outline"
            ? mountOutlineItem(mountCtx, focus, showMeta)
            : core.mountView({ id, focus, view: wanted }),
        );
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

  const dispatch = (intent: Intent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "TYPE": {
        if (sel.kind !== "focused") return;

        if (sel.target === VALUE_TARGET) {
          const id = sel.focus.item;
          const it = core.item(id);
          if (
            intent.char === "=" &&
            it.mode.kind === "direct" &&
            it.content.kind === "scalar" &&
            scalarToText(it.content.value).trim() === ""
          ) {
            outlineCommands.setDerived(core, id);
            core.focus(sel.focus, "source:expr", { caret: caret0() });
            return;
          }
          return;
        }

        if (sel.target !== DEFAULT_TARGET) return;

        const stops = getEditStopsForItem(core, sel.focus.item);
        const target = stops[0] ?? null;
        if (!target) return;

        core.focus(sel.focus, target, { caret: SELECT_ALL });
        queueMicrotask(() => insertTextIntoActiveEditor(intent.char));
        return;
      }

      case "CONFIRM": {
        if (sel.kind !== "focused") return;

        if (sel.target !== DEFAULT_TARGET) {
          if (sel.target === VALUE_TARGET && intent.caret) {
            outlineCommands.splitAt(
              core,
              sel,
              intent.caret.start,
              intent.caret.end,
            );
            return;
          }
          core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        outlineCommands.confirm(core, sel);
        return;
      }

      case "TAB": {
        if (sel.kind !== "focused") return;
        outlineCommands.changeNesting(
          core,
          rootId,
          sel,
          intent.shift ? "out" : "in",
        );
        return;
      }

      case "DELETE_BOUNDARY": {
        if (sel.kind !== "focused") return;
        outlineCommands.deleteBoundary(core, sel, intent.dir);
        return;
      }

      case "DELETE": {
        if (sel.kind !== "focused") return;
        if (sel.target !== DEFAULT_TARGET) return;
        outlineCommands.deleteBoundary(core, sel, intent.dir);
        return;
      }

      case "CANCEL": {
        escapeLadder(core);
        return;
      }
    }
  };

  const focus: Focus = args.focus ?? { container: rootId, item: rootId };
  const content = mountOutlineItem(
    { core, rootId, navMove, dispatch },
    focus,
    false,
  );

  const onKeyDown = (e: KeyboardEvent) => {
    const intent = parseKeydownIntent(e);
    if (!intent) return;
    consume(e);
    dispatch(intent);
  };

  return {
    id: `outline:${String(rootId)}`,
    root: content.el,
    onKeyDown,
    dispose() {
      content.dispose();
    },
  };
}
