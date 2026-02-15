import { computed } from "@preact/signals-core";

import type {
  Caret,
  Component,
  Core,
  DomView,
  Focus,
  ItemId,
  Selection,
  ValueOrBlank,
} from "../core";
import {
  DEFAULT_TARGET,
  LABEL_TARGET,
  VALUE_TARGET,
  connTarget,
  parseValue,
} from "../core";
import type { NavDir, ViewIntent } from "../dom";
import {
  bindItemFrame,
  buildItemHeader,
  buildTextField,
  caret0,
  caretAt,
  createComponent,
  el,
  enterEditOnType,
  fieldsFromConn,
  patchConn,
  setBodyClasses,
  toggleEditOnConfirm,
} from "../dom";

type EditPoint = { id: ItemId; target: string };

function valueToText(v: ValueOrBlank): string {
  return v == null ? "" : String(v);
}

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const content = core.item(id).content;
  return content.type === "group" ? content.children : [];
};

function parentOf(core: Core, rootId: ItemId, id: ItemId): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  return loc ? loc.parentId : null;
}

function focusFor(core: Core, rootId: ItemId, id: ItemId): Focus {
  const parentId = parentOf(core, rootId, id);
  return { container: parentId ?? rootId, item: id };
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
  const firstVisibleChild = firstChild(core, id);
  if (firstVisibleChild) return firstVisibleChild;

  let cur: ItemId | null = id;
  while (cur) {
    const loc = core.locate(cur);
    if (!loc) return null;
    const { parentId, index, siblings } = loc;
    const sibling = siblings[index + 1] ?? null;
    if (sibling) return sibling;
    cur = parentId;
    if (cur === rootId) return null;
  }
  return null;
}

function prevVisible(core: Core, rootId: ItemId, id: ItemId): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  if (!loc) return null;
  const { parentId, index, siblings } = loc;
  const prev = siblings[index - 1] ?? null;
  if (prev) return lastDescendant(core, prev);
  return parentId === rootId ? null : parentId;
}

function isEditLeaf(core: Core, id: ItemId): boolean {
  const item = core.item(id);
  if (item.mode.type === "connected") return true;
  return item.mode.type === "plain" && item.content.type === "value";
}

function getEditStopsForItem(core: Core, id: ItemId): string[] {
  const item = core.item(id);
  if (item.mode.type === "connected") {
    return fieldsFromConn(item.mode.conn).map((field) => connTarget(field.key));
  }
  if (item.mode.type === "plain" && item.content.type === "value")
    return [VALUE_TARGET];
  return [];
}

function getPrimaryEditTarget(core: Core, id: ItemId): string | null {
  return getEditStopsForItem(core, id)[0] ?? null;
}

function getTextForTarget(core: Core, id: ItemId, target: string): string {
  const item = core.item(id);
  if (target === VALUE_TARGET) {
    return item.content.type === "value" ? valueToText(item.content.value) : "";
  }
  if (target.startsWith("conn:")) {
    if (item.mode.type !== "connected") return "";
    const key = target.slice("conn:".length);
    return (
      fieldsFromConn(item.mode.conn).find((field) => field.key === key)?.text ??
      ""
    );
  }
  if (target === LABEL_TARGET) return item.label ?? "";
  return "";
}

function collectEditPoints(core: Core, rootId: ItemId): EditPoint[] {
  const out: EditPoint[] = [];
  const walk = (parentId: ItemId) => {
    for (const cid of childrenOf(core, parentId)) {
      if (isEditLeaf(core, cid)) {
        for (const t of getEditStopsForItem(core, cid))
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
  sel: Extract<Selection, { type: "focused" }>,
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
    ? caretAt(getTextForTarget(core, next.id, next.target).length)
    : caret0();

  return { focus: focusFor(core, rootId, next.id), target: next.target, caret };
}

function caretFromActiveEditor(): Caret | null {
  const activeEl = document.activeElement;
  if (
    !(
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement
    )
  )
    return null;
  const start = activeEl.selectionStart ?? 0;
  const end = activeEl.selectionEnd ?? start;
  return { start, end };
}

function clampCaretToText(caret: Caret, text: string): Caret {
  const len = text.length;
  const start = Math.max(0, Math.min(caret.start, len));
  const end = Math.max(0, Math.min(caret.end, len));
  return { start, end };
}

const outlineCommands = {
  setLabel(core: Core, id: ItemId, text: string): void {
    core.commit((t) => t.setLabel(id, text));
  },

  setText(core: Core, id: ItemId, text: string): void {
    core.commit((t) => t.setValue(id, parseValue(text)));
  },

  setFormula(core: Core, id: ItemId): void {
    core.commit((t) => t.setConnected(id, { type: "formula", expr: "" }));
  },

  commitConnField(core: Core, id: ItemId, key: string, text: string): void {
    const item = core.item(id);
    if (item.mode.type !== "connected") return;
    const next = patchConn(item.mode.conn, key, text);
    core.commit((t) => t.setConnected(id, next));
  },

  insertSibling(
    core: Core,
    sel: Extract<Selection, { type: "focused" }>,
    side: "before" | "after",
  ): ItemId | null {
    const loc = core.locate(sel.focus.item);
    if (!loc) return null;

    const { parentId, index: idx } = loc;
    const at = side === "before" ? idx : idx + 1;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId, { at });
    });

    return id || null;
  },

  splitAt(
    core: Core,
    sel: Extract<Selection, { type: "focused" }>,
    caretStart: number,
    caretEnd = caretStart,
  ): ItemId | null {
    const id = sel.focus.item;
    const snap = core.item(id);

    const loc = core.locate(id);
    if (!loc) return null;

    const { parentId, index: idx } = loc;

    if (!(snap.mode.type === "plain" && snap.content.type === "value")) {
      return outlineCommands.insertSibling(core, sel, "after");
    }

    const curText = valueToText(snap.content.value);
    const len = curText.length;

    const start = Math.max(0, Math.min(caretStart, len));
    const end = Math.max(0, Math.min(caretEnd, len));

    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let rightId: ItemId = "";

    core.commit((t) => {
      t.setValue(id, parseValue(left));
      rightId = t.insertChild(parentId, { at: idx + 1 });
      t.setValue(rightId, parseValue(right));
    });

    return rightId || null;
  },

  joinBoundary(
    core: Core,
    sel: Extract<Selection, { type: "focused" }>,
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

    const leftItem = core.item(leftId);
    const rightItem = core.item(rightId);

    if (!(leftItem.mode.type === "plain" && leftItem.content.type === "value"))
      return null;
    if (
      !(rightItem.mode.type === "plain" && rightItem.content.type === "value")
    )
      return null;

    const leftText = valueToText(leftItem.content.value);
    const rightText = valueToText(rightItem.content.value);

    core.commit((t) => {
      t.setValue(leftId, parseValue(leftText + rightText));
      t.remove(rightId);
    });

    return { id: leftId, caret: caretAt(leftText.length) };
  },

  removeItem(
    core: Core,
    sel: Extract<Selection, { type: "focused" }>,
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
    sel: Extract<Selection, { type: "focused" }>,
    dir: "in" | "out",
  ): Focus | null {
    const id = sel.focus.item;

    if (dir === "in") {
      const loc = core.locate(id);
      if (!loc) return null;

      const { parentId, index: idx } = loc;

      const label = core.item(id).label ?? "";
      let wrapperId: ItemId = "";

      core.commit((t) => {
        wrapperId = t.insertChild(parentId, { at: idx });
        t.setGroup(wrapperId);
        t.setLabel(wrapperId, label);
        t.setLabel(id, "");
        t.move(id, wrapperId, { at: 0 });
      });

      return { container: wrapperId, item: id };
    }

    const loc = core.locate(id);
    if (!loc) return null;

    const { parentId: wrapperId } = loc;
    if (wrapperId === rootId) return null;

    const grandparentId = parentOf(core, rootId, wrapperId);
    if (!grandparentId) return null;

    const grandparentSnap = core.item(grandparentId);
    if (grandparentSnap.content.type !== "group") return null;

    const wrapperIdx = grandparentSnap.content.children.indexOf(wrapperId);
    if (wrapperIdx < 0) return null;

    const wrapperSnap = core.item(wrapperId);
    if (wrapperSnap.content.type !== "group") return null;

    const wrapperLabel = wrapperSnap.label ?? "";
    const shouldUnwrap =
      wrapperSnap.content.children.length === 1 &&
      wrapperSnap.content.children[0] === id;
    const moveAt = shouldUnwrap ? wrapperIdx : wrapperIdx + 1;

    core.commit((t) => {
      t.move(id, grandparentId, { at: moveAt });
      if (!shouldUnwrap) return;
      t.remove(wrapperId);
      t.setLabel(id, wrapperLabel);
    });

    return { container: grandparentId, item: id };
  },
} as const;

type OutlineMountCtx = {
  core: Core;
  rootId: ItemId;
  editPointsSignal: { value: EditPoint[] };
  dispatch: (intent: ViewIntent) => void;
};

function buildChildOuterFrame(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  withHeader: boolean,
): Component {
  const { core } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const frameEl = el("div", "ui-outline-child");
    bindItemFrame(ctx, { core, focus }, frameEl);

    if (withHeader) {
      const canEditLabel = () => core.item(id).mode.type !== "readonly";

      const commitLabel = (text: string) => {
        if (!canEditLabel()) return;
        const cur = core.item(id).label ?? "";
        if (cur === text) return;
        outlineCommands.setLabel(core, id, text);
      };

      const commitConnField = (key: string, text: string) => {
        outlineCommands.commitConnField(core, id, key, text);
      };

      const labelFocused = computed(() => {
        const sel = core.selection();
        return (
          sel.type === "focused" &&
          sel.focus.item === focus.item &&
          sel.focus.container === focus.container &&
          sel.target === LABEL_TARGET
        );
      });

      const hasLabel = computed(
        () => (core.item(id).label ?? "").trim() !== "",
      );

      const fieldsSignal = computed(() => {
        const snap = core.item(id);
        return snap.mode.type === "connected"
          ? fieldsFromConn(snap.mode.conn)
          : [];
      });

      const hasFields = computed(() => fieldsSignal.value.length > 0);

      ctx.slot(frameEl, () => {
        const shouldShow =
          hasLabel.value || hasFields.value || labelFocused.value;
        if (!shouldShow) return null;

        return buildItemHeader(core, {
          focus,
          id,
          canEditLabel,
          commitLabel,
          commitConnField,
        });
      });
    }

    ctx.slot(frameEl, () => {
      const wanted = core.view(id);
      return core.mountView({ id, focus, view: wanted });
    });

    return frameEl;
  });
}

function buildOutlineScalarBody(
  mountCtx: OutlineMountCtx,
  focus: Focus,
): Component {
  const { core } = mountCtx;
  const id = focus.item;

  return buildTextField(core, {
    focus,
    target: VALUE_TARGET,
    multiline: true,
    autosize: false,
    editModel: "live",
    commit: (text) => outlineCommands.setText(core, id, text),
    getState: () => {
      const snap = core.item(id);
      const c = snap.content;

      if (c.type === "issue") return { text: c.message ?? "", readOnly: true };

      if (c.type === "value") {
        const editable = snap.mode.type === "plain";
        return { text: valueToText(c.value), readOnly: !editable };
      }

      return { text: "", readOnly: true };
    },
  });
}

function buildOutlineBody(mountCtx: OutlineMountCtx, focus: Focus): Component {
  const { core, rootId } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const root = el("div");
    setBodyClasses(root, "outline");

    const kind = computed<"group" | "value">(() => {
      const snap = core.item(id);
      return snap.content.type === "group" ? "group" : "value";
    });

    ctx.list<ItemId>(
      root,
      () => {
        if (kind.value !== "group") return [];
        const snap = core.item(id);
        const c = snap.content;
        return c.type === "group" ? [...c.children] : [];
      },
      (childId) => {
        const childFocus = focusFor(core, rootId, childId);
        return buildChildOuterFrame(mountCtx, childFocus, true);
      },
    );

    ctx.slot(root, () =>
      kind.value === "value" ? buildOutlineScalarBody(mountCtx, focus) : null,
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

  const editPointsSignal = computed(() => collectEditPoints(core, rootId));

  const dispatch = (intent: ViewIntent): void => {
    const sel0 = core.selection();
    if (sel0.type !== "focused") return;
    const sel = sel0;

    switch (intent.type) {
      case "TAB": {
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

        const validTargets = new Set(getEditStopsForItem(core, nextFocus.item));
        const nextTarget = validTargets.has(fromTarget)
          ? fromTarget
          : DEFAULT_TARGET;

        if (nextTarget === DEFAULT_TARGET) {
          core.focus(nextFocus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        const txt = getTextForTarget(core, nextFocus.item, nextTarget);
        const nextCaret = fromCaret
          ? clampCaretToText(fromCaret, txt)
          : caretAt(txt.length);

        core.focus(nextFocus, nextTarget, { caret: nextCaret });
        return;
      }
      case "NAV": {
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
        const id = sel.focus.item;
        const item = core.item(id);

        if (
          intent.char === "=" &&
          (sel.target === DEFAULT_TARGET || sel.target === VALUE_TARGET) &&
          item.mode.type === "plain" &&
          item.content.type === "value" &&
          valueToText(item.content.value).trim() === ""
        ) {
          outlineCommands.setFormula(core, id);
          core.focus(focusFor(core, rootId, id), connTarget("expr"), {
            caret: caret0(),
          });
          return;
        }

        if (sel.target !== DEFAULT_TARGET) return;

        enterEditOnType({
          core,
          sel,
          char: intent.char,
          getPrimaryTarget: (itemId) => getPrimaryEditTarget(core, itemId),
        });
        return;
      }
      case "CONFIRM": {
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

        const did = toggleEditOnConfirm({
          core,
          sel,
          getPrimaryTarget: (itemId) => getPrimaryEditTarget(core, itemId),
          caretForTarget: (itemId, target) =>
            caretAt(getTextForTarget(core, itemId, target).length),
        });
        if (did) return;

        const nextId = outlineCommands.insertSibling(core, sel, "after");
        if (!nextId) return;
        core.focus(focusFor(core, rootId, nextId), VALUE_TARGET, {
          caret: caret0(),
        });
        return;
      }
      case "DELETE_BOUNDARY": {
        const prefer = intent.dir === "backward" ? "prev" : "next";
        const item = core.item(sel.focus.item);

        if (!(item.mode.type === "plain" && item.content.type === "value")) {
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

        if (valueToText(item.content.value).length === 0) {
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
      case "DELETE":
        if (sel.target !== DEFAULT_TARGET) return;
        dispatch({ type: "DELETE_BOUNDARY", dir: intent.dir });
        return;
    }
  };

  const viewFocus: Focus = args.focus ?? { container: rootId, item: rootId };
  const body = buildOutlineBody(
    { core, rootId, editPointsSignal, dispatch },
    viewFocus,
  );

  return {
    root: body.el,
    onIntent: dispatch,
    dispose() {
      body.dispose();
    },
  };
}
