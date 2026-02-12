import { computed } from "@preact/signals-core";

import type {
  Caret,
  Component,
  Core,
  DomView,
  Focus,
  ItemId,
  ValueOrBlank,
  Selection,
} from "../core";
import { DEFAULT_TARGET, parseValue } from "../core";
import type { Intent, NavDir } from "../dom";
import {
  LABEL_TARGET,
  SELECT_ALL,
  VALUE_TARGET,
  bindUiItemShell,
  caret0,
  caretAt,
  createComponent,
  el,
  escapeLadder,
  fieldsFromConn,
  insertTextIntoActiveEditor,
  buildItemMeta,
  patchConn,
  connTarget,
  stampBody,
  buildTextField,
} from "../dom";

function valueToText(v: ValueOrBlank): string {
  return v == null ? "" : String(v);
}

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

function parentOf(core: Core, rootId: ItemId, id: ItemId): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  return loc ? loc.parentId : null;
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
    const { parentId, index, siblings } = loc;
    const sib = siblings[index + 1] ?? null;
    if (sib) return sib;
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

function isLeafForEditTraversal(core: Core, id: ItemId): boolean {
  const it = core.item(id);
  if (it.mode.kind === "connected") return true;
  return it.mode.kind === "plain" && it.content.kind === "value";
}

function editStopsForItem(core: Core, id: ItemId): string[] {
  const it = core.item(id);
  if (it.mode.kind === "connected") {
    return fieldsFromConn(it.mode.conn).map((f) => connTarget(f.key));
  }
  if (it.mode.kind === "plain" && it.content.kind === "value")
    return [VALUE_TARGET];
  return [];
}

function primaryEditTarget(core: Core, id: ItemId): string | null {
  return editStopsForItem(core, id)[0] ?? null;
}

function textForTarget(core: Core, id: ItemId, target: string): string {
  const it = core.item(id);
  if (target === VALUE_TARGET) {
    return it.content.kind === "value" ? valueToText(it.content.value) : "";
  }
  if (target.startsWith("conn:")) {
    if (it.mode.kind !== "connected") return "";
    const key = target.slice("conn:".length);
    return fieldsFromConn(it.mode.conn).find((f) => f.key === key)?.text ?? "";
  }
  if (target === LABEL_TARGET) return it.label ?? "";
  return "";
}

type EditPoint = { id: ItemId; target: string };

function collectEditPoints(core: Core, rootId: ItemId): EditPoint[] {
  const out: EditPoint[] = [];
  const walk = (parentId: ItemId) => {
    for (const cid of childrenOf(core, parentId)) {
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

  return { focus: focusFor(core, rootId, next.id), target: next.target, caret };
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

const outlineCommands = {
  setLabel(core: Core, id: ItemId, text: string): void {
    core.commit((t) => t.setLabel(id, text));
  },

  setText(core: Core, id: ItemId, text: string): void {
    core.commit((t) => t.setValue(id, parseValue(text)));
  },

  setFormula(core: Core, id: ItemId): void {
    core.commit((t) => t.setConnected(id, { kind: "formula", expr: "" }));
  },

  commitConnField(core: Core, id: ItemId, key: string, text: string): void {
    const it = core.item(id);
    if (it.mode.kind !== "connected") return;
    const next = patchConn(it.mode.conn, key, text);
    core.commit((t) => t.setConnected(id, next));
  },

  insertSibling(
    core: Core,
    sel: Extract<Selection, { kind: "focused" }>,
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
    sel: Extract<Selection, { kind: "focused" }>,
    caretStart: number,
    caretEnd = caretStart,
  ): ItemId | null {
    const id = sel.focus.item;
    const snap = core.item(id);

    const loc = core.locate(id);
    if (!loc) return null;

    const { parentId, index: idx } = loc;

    if (!(snap.mode.kind === "plain" && snap.content.kind === "value")) {
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

    if (!(a.mode.kind === "plain" && a.content.kind === "value")) return null;
    if (!(b.mode.kind === "plain" && b.content.kind === "value")) return null;

    const leftText = valueToText(a.content.value);
    const rightText = valueToText(b.content.value);

    core.commit((t) => {
      t.setValue(leftId, parseValue(leftText + rightText));
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
    if (grandparentSnap.content.kind !== "group") return null;

    const wrapperIdx = grandparentSnap.content.children.indexOf(wrapperId);
    if (wrapperIdx < 0) return null;

    const wrapperLabel = core.item(wrapperId).label ?? "";

    core.commit((t) => {
      t.move(id, grandparentId, { at: wrapperIdx });
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
  dispatch: (intent: Intent) => void;
};

function buildOutlineNodeShell(
  mountCtx: OutlineMountCtx,
  focus: Focus,
  withMeta: boolean,
): Component {
  const { core, rootId } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const shell = el("div", "ui-outline-node");
    bindUiItemShell(ctx, { core, focus }, shell);

    if (withMeta) {
      const canEditLabel = () => core.item(id).mode.kind !== "readonly";

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
          sel.kind === "focused" &&
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
        return snap.mode.kind === "connected"
          ? fieldsFromConn(snap.mode.conn)
          : [];
      });

      const hasFields = computed(() => fieldsSignal.value.length > 0);

      ctx.slot(shell, () => {
        const shouldShow =
          hasLabel.value || hasFields.value || labelFocused.value;
        if (!shouldShow) return null;

        return buildItemMeta(core, {
          focus,
          id,
          dispatch: mountCtx.dispatch,
          canEditLabel,
          commitLabel,
          commitConnField,
        });
      });
    }

    ctx.slot(shell, () => {
      const wanted = core.view(id);
      return core.mountView({ id, focus, view: wanted });
    });

    return shell;
  });
}

function buildOutlineScalarBody(
  mountCtx: OutlineMountCtx,
  focus: Focus,
): Component {
  const { core, dispatch } = mountCtx;
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

      if (c.kind === "issue")
        return { text: c.message ?? "", readOnly: true, isIssue: true };

      if (c.kind === "value") {
        const editable = snap.mode.kind === "plain";
        return {
          text: valueToText(c.value),
          readOnly: !editable,
          isIssue: false,
        };
      }

      return { text: "", readOnly: true, isIssue: false };
    },
    onIntent: dispatch,
  });
}

function buildOutlineBody(mountCtx: OutlineMountCtx, focus: Focus): Component {
  const { core, rootId } = mountCtx;
  const id = focus.item;

  return createComponent(core, (ctx) => {
    const root = el("div");
    stampBody(root, "outline");

    const kind = computed<"group" | "value">(() => {
      const snap = core.item(id);
      return snap.content.kind === "group" ? "group" : "value";
    });

    ctx.list<ItemId>(
      root,
      () => {
        if (kind.value !== "group") return [];
        const snap = core.item(id);
        const c = snap.content;
        return c.kind === "group" ? [...c.children] : [];
      },
      (childId) => {
        const childFocus = focusFor(core, rootId, childId);
        return buildOutlineNodeShell(mountCtx, childFocus, true);
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
          it.mode.kind === "plain" &&
          it.content.kind === "value" &&
          valueToText(it.content.value).trim() === ""
        ) {
          outlineCommands.setFormula(core, id);
          core.focus(focusFor(core, rootId, id), connTarget("expr"), {
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

        if (!(it.mode.kind === "plain" && it.content.kind === "value")) {
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

        if (valueToText(it.content.value).length === 0) {
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

  const viewFocus: Focus = args.focus ?? { container: rootId, item: rootId };
  const body = buildOutlineBody(
    { core, rootId, editPointsSignal, dispatch },
    viewFocus,
  );

  return {
    id: `outline:${String(rootId)}`,
    root: body.el,
    onIntent: dispatch,
    dispose() {
      body.dispose();
    },
  };
}
