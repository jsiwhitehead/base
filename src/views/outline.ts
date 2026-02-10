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
  type Intent,
  el,
  createComponent,
  createContent,
  autosizeTextField,
  textField,
  scalarField,
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

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

function parentOf(core: Core, rootId: ItemId, id: ItemId): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  return loc ? loc.ownerId : null;
}

function focusFor(core: Core, rootId: ItemId, id: ItemId): Focus {
  const p = parentOf(core, rootId, id);
  return { container: p ?? rootId, item: id };
}

function firstChild(core: Core, id: ItemId): ItemId | null {
  const kids = childrenOf(core, id);
  return kids[0] ?? null;
}

function lastDescendant(core: Core, id: ItemId): ItemId {
  let cur = id;
  while (true) {
    const kids = childrenOf(core, cur);
    if (kids.length === 0) return cur;
    cur = kids[kids.length - 1]!;
  }
}

function nextVisible(core: Core, rootId: ItemId, id: ItemId): ItemId | null {
  const fc = firstChild(core, id);
  if (fc) return fc;

  let cur: ItemId | null = id;
  while (cur) {
    const loc = core.locate(cur);
    if (!loc) return null;
    const { ownerId, index, siblings } = loc;
    const sib = siblings[index + 1] ?? null;
    if (sib) return sib;
    cur = ownerId;
    if (cur === rootId) return null;
  }
  return null;
}

function prevVisible(core: Core, rootId: ItemId, id: ItemId): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  if (!loc) return null;
  const { ownerId, index, siblings } = loc;
  const prev = siblings[index - 1] ?? null;
  if (prev) return lastDescendant(core, prev);
  return ownerId === rootId ? null : ownerId;
}

function isEditing(
  sel: Selection,
): sel is Extract<Selection, { kind: "focused" }> {
  return sel.kind === "focused" && sel.target !== DEFAULT_TARGET;
}

function isLeafForEditTraversal(core: Core, id: ItemId): boolean {
  const it = core.item(id);
  if (it.mode.kind === "source") return true;
  return it.mode.kind === "direct" && it.content.kind === "scalar";
}

function editStopsForItem(core: Core, id: ItemId): string[] {
  const it = core.item(id);
  if (it.mode.kind === "source") {
    return fieldsFromSource(it.mode.source).map((f) => `source:${f.key}`);
  }
  if (it.mode.kind === "direct" && it.content.kind === "scalar")
    return [VALUE_TARGET];
  return [];
}

function primaryEditTarget(core: Core, id: ItemId): string | null {
  return editStopsForItem(core, id)[0] ?? null;
}

function textForTarget(core: Core, id: ItemId, target: string): string {
  const it = core.item(id);
  if (target === VALUE_TARGET) {
    return it.content.kind === "scalar" ? scalarToText(it.content.value) : "";
  }
  if (target.startsWith("source:")) {
    if (it.mode.kind !== "source") return "";
    const key = target.slice("source:".length);
    return (
      fieldsFromSource(it.mode.source).find((f) => f.key === key)?.text ?? ""
    );
  }
  if (target === LABEL_TARGET) return it.label ?? "";
  return "";
}

type EditPoint = { id: ItemId; target: string };

function collectEditPoints(core: Core, rootId: ItemId): EditPoint[] {
  const out: EditPoint[] = [];
  const walk = (ownerId: ItemId) => {
    for (const cid of childrenOf(core, ownerId)) {
      if (isLeafForEditTraversal(core, cid)) {
        for (const t of editStopsForItem(core, cid))
          out.push({ id: cid, target: t });
      }
      walk(cid);
    }
  };
  walk(rootId);
  return out;
}

function moveEditPoint(
  core: Core,
  rootId: ItemId,
  points: readonly EditPoint[],
  sel: Extract<Selection, { kind: "focused" }>,
  dir: NavDir,
): { focus: Focus; target: string; caret: Caret } | null {
  if (points.length === 0) return null;

  const backward = dir === "up" || dir === "left";
  const forward = dir === "down" || dir === "right";
  if (!backward && !forward) return null;

  let at = points.findIndex(
    (p) => p.id === sel.focus.item && p.target === sel.target,
  );
  if (at < 0) {
    const firstForItem = points.findIndex((p) => p.id === sel.focus.item);
    at = firstForItem >= 0 ? firstForItem : 0;
  }

  const nextIdx = backward ? at - 1 : at + 1;
  const next = points[nextIdx] ?? null;
  if (!next) return null;

  const caret = backward
    ? caretAt(textForTarget(core, next.id, next.target).length)
    : caret0();

  return {
    focus: focusFor(core, rootId, next.id),
    target: next.target,
    caret,
  };
}

function caretFromActiveEditor(): Caret | null {
  const a = document.activeElement;
  if (!(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement))
    return null;
  const start = a.selectionStart ?? 0;
  const end = a.selectionEnd ?? start;
  return { start, end };
}

function clampCaretToText(c: Caret, text: string): Caret {
  const len = text.length;
  const s = Math.max(0, Math.min(c.start, len));
  const e = Math.max(0, Math.min(c.end, len));
  return { start: s, end: e };
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
  ): ItemId | null {
    const loc = core.locate(sel.focus.item);
    if (!loc) return null;

    const { ownerId: containerId, index: idx } = loc;
    const at = side === "before" ? idx : idx + 1;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(containerId, { at, kind: "blank" });
    });

    return id || null;
  },

  splitAt(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    caretStart: number,
    caretEnd = caretStart,
  ): ItemId | null {
    const id = sel.focus.item;
    const snap = core.item(id);

    const loc = core.locate(id);
    if (!loc) return null;

    const { ownerId: containerId, index: idx } = loc;

    if (!(snap.mode.kind === "direct" && snap.content.kind === "scalar")) {
      return outlineCommands.insertSibling(core, sel, "after");
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

    return rightId || null;
  },

  joinBoundary(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    dir: "backward" | "forward",
  ): { id: ItemId; caret: Caret } | null {
    const loc = core.locate(sel.focus.item);
    if (!loc) return null;

    const { index: idx, siblings } = loc;

    const neighbor =
      dir === "backward"
        ? (siblings[idx - 1] ?? null)
        : (siblings[idx + 1] ?? null);
    if (!neighbor) return null;

    const leftId = dir === "backward" ? neighbor : sel.focus.item;
    const rightId = dir === "backward" ? sel.focus.item : neighbor;

    const a = core.item(leftId);
    const b = core.item(rightId);

    if (!(a.mode.kind === "direct" && a.content.kind === "scalar")) return null;
    if (!(b.mode.kind === "direct" && b.content.kind === "scalar")) return null;

    const leftText = scalarToText(a.content.value);
    const rightText = scalarToText(b.content.value);

    core.commit((t) => {
      t.setScalar(leftId, parseScalar(leftText + rightText));
      t.remove(rightId);
    });

    return { id: leftId, caret: caretAt(leftText.length) };
  },

  removeItem(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
    prefer: "prev" | "next",
  ): ItemId | null {
    const loc = core.locate(sel.focus.item);
    if (!loc) return null;

    const { index: idx, siblings } = loc;

    const prev = siblings[idx - 1] ?? null;
    const next = siblings[idx + 1] ?? null;

    const chosen =
      prefer === "prev" ? (prev ?? next ?? null) : (next ?? prev ?? null);

    core.commit((t) => t.remove(sel.focus.item));

    return chosen;
  },

  changeNesting(
    core: Core,
    rootId: ItemId,
    sel: Extract<Selection, { kind: "focused" }>,
    dir: "in" | "out",
  ): Focus | null {
    const id = sel.focus.item;

    if (dir === "in") {
      const loc = core.locate(id);
      if (!loc) return null;

      const { ownerId: containerId, index: idx } = loc;

      const label = core.item(id).label ?? "";
      let wrapperId: ItemId = "";

      core.commit((t) => {
        wrapperId = t.insertChild(containerId, { at: idx, kind: "group" });
        t.setLabel(wrapperId, label);
        t.setLabel(id, "");
        t.move(id, wrapperId, { at: 0 });
      });

      return { container: wrapperId, item: id };
    }

    const loc = core.locate(id);
    if (!loc) return null;

    const { ownerId: containerId } = loc;
    if (containerId === rootId) return null;

    const parentId = parentOf(core, rootId, containerId);
    if (!parentId) return null;

    const parentSnap = core.item(parentId);
    if (parentSnap.content.kind !== "group") return null;

    const wrapperIdx = parentSnap.content.children.indexOf(containerId);
    if (wrapperIdx < 0) return null;

    const wrapperLabel = core.item(containerId).label ?? "";

    core.commit((t) => {
      t.move(id, parentId, { at: wrapperIdx });
      t.remove(containerId);
      t.setLabel(id, wrapperLabel);
    });

    return { container: parentId, item: id };
  },
} as const;

type OutlineMountCtx = {
  core: Core;
  rootId: ItemId;
  editPointsSignal: { value: EditPoint[] };
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
      wrapClassName: "autosize",
      onIntent: dispatch,
    });

    labelWrap.replaceChildren(labelComp.el);
    ctx.cleanup(() => labelComp.dispose());

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
          onIntent: dispatch,
        });

        valEl.replaceChildren(fc.el);
        ctx2.cleanup(() => fc.dispose());

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
      onIntent: dispatch,
    });

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

  const editPointsSignal = computed(() => collectEditPoints(core, rootId));

  const dispatch = (intent: Intent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "TAB": {
        if (sel.kind !== "focused") return;

        const wasEditing = sel.target !== DEFAULT_TARGET;
        const fromTarget = wasEditing ? sel.target : DEFAULT_TARGET;
        const fromCaret = wasEditing ? caretFromActiveEditor() : null;

        const nextFocus = outlineCommands.changeNesting(
          core,
          rootId,
          sel,
          intent.shift ? "out" : "in",
        );
        if (!nextFocus) return;

        if (!wasEditing) {
          core.focus(nextFocus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        const validTargets = new Set(editStopsForItem(core, nextFocus.item));
        const nextTarget = validTargets.has(fromTarget)
          ? fromTarget
          : DEFAULT_TARGET;

        if (nextTarget === DEFAULT_TARGET) {
          core.focus(nextFocus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        const txt = textForTarget(core, nextFocus.item, nextTarget);
        const nextCaret = fromCaret
          ? clampCaretToText(fromCaret, txt)
          : caretAt(txt.length);

        core.focus(nextFocus, nextTarget, { caret: nextCaret });
        return;
      }

      case "NAV": {
        if (sel.kind !== "focused") return;

        if (sel.target === DEFAULT_TARGET) {
          const fromId = sel.focus.item;
          let nextId: ItemId | null = null;

          if (intent.dir === "left") nextId = parentOf(core, rootId, fromId);
          else if (intent.dir === "right") nextId = firstChild(core, fromId);
          else if (intent.dir === "up")
            nextId = prevVisible(core, rootId, fromId);
          else if (intent.dir === "down")
            nextId = nextVisible(core, rootId, fromId);

          if (!nextId) return;

          core.focus(focusFor(core, rootId, nextId), DEFAULT_TARGET, {
            caret: caret0(),
          });
          return;
        }

        const move = moveEditPoint(
          core,
          rootId,
          editPointsSignal.value,
          sel,
          intent.dir,
        );
        if (!move) return;
        core.focus(move.focus, move.target, { caret: move.caret });
        return;
      }

      case "TYPE": {
        if (sel.kind !== "focused") return;

        const id = sel.focus.item;
        const it = core.item(id);

        if (
          intent.char === "=" &&
          (sel.target === DEFAULT_TARGET || sel.target === VALUE_TARGET) &&
          it.mode.kind === "direct" &&
          it.content.kind === "scalar" &&
          scalarToText(it.content.value).trim() === ""
        ) {
          outlineCommands.setDerived(core, id);
          core.focus(focusFor(core, rootId, id), "source:expr", {
            caret: caret0(),
          });
          return;
        }

        if (sel.target !== DEFAULT_TARGET) return;

        const target = primaryEditTarget(core, id);
        if (!target) return;

        core.focus(sel.focus, target, { caret: SELECT_ALL });
        queueMicrotask(() => insertTextIntoActiveEditor(intent.char));
        return;
      }

      case "CONFIRM": {
        if (sel.kind !== "focused") return;

        if (sel.target !== DEFAULT_TARGET) {
          if (sel.target === VALUE_TARGET && intent.caret) {
            const nextId = outlineCommands.splitAt(
              core,
              sel,
              intent.caret.start,
              intent.caret.end,
            );
            if (!nextId) return;
            core.focus(focusFor(core, rootId, nextId), VALUE_TARGET, {
              caret: caret0(),
            });
            return;
          }

          core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        const id = sel.focus.item;
        const target = primaryEditTarget(core, id);
        if (target) {
          core.focus(sel.focus, target, {
            caret: caretAt(textForTarget(core, id, target).length),
          });
          return;
        }

        const nextId = outlineCommands.insertSibling(core, sel, "after");
        if (!nextId) return;
        core.focus(focusFor(core, rootId, nextId), VALUE_TARGET, {
          caret: caret0(),
        });
        return;
      }

      case "DELETE_BOUNDARY": {
        if (sel.kind !== "focused") return;

        const prefer = intent.dir === "backward" ? "prev" : "next";
        const it = core.item(sel.focus.item);

        if (!(it.mode.kind === "direct" && it.content.kind === "scalar")) {
          const chosen = outlineCommands.removeItem(core, sel, prefer);
          if (!chosen) {
            core.blur();
            return;
          }
          core.focus(focusFor(core, rootId, chosen), DEFAULT_TARGET, {
            caret: caret0(),
          });
          return;
        }

        if (scalarToText(it.content.value).length === 0) {
          const chosen = outlineCommands.removeItem(core, sel, prefer);
          if (!chosen) {
            core.blur();
            return;
          }
          core.focus(focusFor(core, rootId, chosen), DEFAULT_TARGET, {
            caret: caret0(),
          });
          return;
        }

        const joined = outlineCommands.joinBoundary(core, sel, intent.dir);
        if (!joined) return;
        core.focus(focusFor(core, rootId, joined.id), VALUE_TARGET, {
          caret: joined.caret,
        });
        return;
      }

      case "DELETE": {
        if (sel.kind !== "focused") return;
        if (sel.target !== DEFAULT_TARGET) return;
        dispatch({ type: "DELETE_BOUNDARY", dir: intent.dir });
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
    { core, rootId, editPointsSignal, dispatch },
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
