import { computed } from "@preact/signals-core";

import type {
  Caret,
  Focus,
  Intent,
  ItemId,
  Selection,
  ValueOrBlank,
} from "../core";
import {
  DEFAULT_TARGET,
  LABEL_TARGET,
  VALUE_TARGET,
  editTargetsForItem,
  fieldsFromConn,
  getTextForTarget,
} from "../core";
import type { Component, NavDir, UiCore } from "../dom";
import {
  bindItemFrame,
  buildItemHeader,
  buildTextField,
  caret0,
  caretAt,
  clampCaretToText,
  createComponent,
  el,
  handleContainerIntent,
  moveWithinItemEditTargets,
  observeHeight,
  patchConn,
  SELECT_ALL,
  setBodyClasses,
  typeCharIntoFocusedTextInput,
} from "../dom";
import { defineView } from "./index";

type EditPoint = { id: ItemId; target: string };

type OutlineMountCtx = {
  core: UiCore;
  rootId: ItemId;
  editPointsSignal: { value: EditPoint[] };
  onIntent: (intent: Intent) => void;
};

function valueToText(v: ValueOrBlank): string {
  return v == null ? "" : String(v);
}

const childrenOf = (core: UiCore, id: ItemId): readonly ItemId[] => {
  const content = core.item(id).content;
  return content.type === "group" ? content.children : [];
};

function parentOf(core: UiCore, rootId: ItemId, id: ItemId): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  return loc ? loc.parentId : null;
}

function focusFor(core: UiCore, rootId: ItemId, id: ItemId): Focus {
  const parentId = parentOf(core, rootId, id);
  return { container: parentId ?? rootId, item: id };
}

function computePruneAncestorsForRemoval(
  core: UiCore,
  rootId: ItemId,
  removedId: ItemId,
): ItemId[] {
  const out: ItemId[] = [];
  let cur: ItemId = removedId;

  while (true) {
    const parentId = parentOf(core, rootId, cur);
    if (!parentId) break;

    const parent = core.item(parentId);
    if (parent.mode.type === "readonly") break;
    if (parent.content.type !== "group") break;

    const kids = parent.content.children;
    if (kids.length !== 1 || kids[0] !== cur) break;

    out.push(parentId);
    cur = parentId;
  }

  return out;
}

function firstChild(core: UiCore, id: ItemId): ItemId | null {
  const kids = childrenOf(core, id);
  return kids[0] ?? null;
}

function prevSibling(core: UiCore, id: ItemId): ItemId | null {
  const loc = core.locate(id);
  return loc ? (loc.siblings[loc.index - 1] ?? null) : null;
}

function nextSibling(core: UiCore, id: ItemId): ItemId | null {
  const loc = core.locate(id);
  return loc ? (loc.siblings[loc.index + 1] ?? null) : null;
}

function isEditLeaf(core: UiCore, id: ItemId): boolean {
  const item = core.item(id);
  if (item.mode.type === "connected") return true;
  return item.mode.type === "plain" && item.content.type === "value";
}

function collectEditPoints(core: UiCore, rootId: ItemId): EditPoint[] {
  const out: EditPoint[] = [];
  const walk = (parentId: ItemId) => {
    for (const cid of childrenOf(core, parentId)) {
      if (core.view(cid) !== "outline") {
        out.push({ id: cid, target: DEFAULT_TARGET });
        continue;
      }
      if (isEditLeaf(core, cid)) {
        for (const t of editTargetsForItem(core, cid))
          out.push({ id: cid, target: t });
      }
      walk(cid);
    }
  };
  walk(rootId);
  return out;
}

const plan = {
  moveEditPoint(
    core: UiCore,
    rootId: ItemId,
    points: readonly EditPoint[],
    sel: Extract<Selection, { type: "focused" }>,
    dir: NavDir,
  ): { focus: Focus; target: string; caret: Caret } | null {
    if (points.length === 0) return null;

    const backward = dir === "up" || dir === "left";
    const forward = dir === "down" || dir === "right";
    if (!backward && !forward) return null;
    const intra = moveWithinItemEditTargets(
      core,
      sel.focus.item,
      sel.target,
      backward ? "backward" : "forward",
    );
    if (intra) {
      return {
        focus: sel.focus,
        target: intra.target,
        caret: intra.caret,
      };
    }

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
    if (next.target === DEFAULT_TARGET) {
      return {
        focus: focusFor(core, rootId, next.id),
        target: DEFAULT_TARGET,
        caret: caret0(),
      };
    }

    const caret = backward
      ? caretAt(getTextForTarget(core, next.id, next.target).length)
      : caret0();

    return {
      focus: focusFor(core, rootId, next.id),
      target: next.target,
      caret,
    };
  },

  adjacentEditStopAfterDeletion(
    core: UiCore,
    rootId: ItemId,
    points: readonly EditPoint[],
    sel: Extract<Selection, { type: "focused" }>,
    dir: "backward" | "forward",
  ): { focus: Focus; target: string; caret: Caret } | null {
    const at = points.findIndex(
      (p) => p.id === sel.focus.item && p.target === sel.target,
    );
    if (at < 0) return null;

    const nextIdx = dir === "backward" ? at - 1 : at + 1;
    const next = points[nextIdx] ?? null;
    if (!next) return null;
    if (next.target === DEFAULT_TARGET) {
      return {
        focus: focusFor(core, rootId, next.id),
        target: DEFAULT_TARGET,
        caret: caret0(),
      };
    }

    const text = getTextForTarget(core, next.id, next.target);
    const caret = dir === "backward" ? caretAt(text.length) : caret0();

    return {
      focus: focusFor(core, rootId, next.id),
      target: next.target,
      caret,
    };
  },
} as const;

const cmd = {
  setLabel(core: UiCore, id: ItemId, text: string): void {
    core.commit((t) => t.setLabel(id, text));
  },

  setText(core: UiCore, id: ItemId, text: string): void {
    core.commit((t) => t.setValue(id, text));
  },

  commitConnField(core: UiCore, id: ItemId, key: string, text: string): void {
    const item = core.item(id);
    if (item.mode.type !== "connected") return;
    const next = patchConn(item.mode.conn, key, text);
    core.commit((t) => t.setConnected(id, next));
  },

  convertEmptyGroupToValue(core: UiCore, id: ItemId): void {
    core.commit((t) => t.setValue(id, ""));
  },

  removeAndPruneAncestors(core: UiCore, rootId: ItemId, id: ItemId): void {
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, id);
    core.commit((t) => {
      t.remove(id);
      for (const pruneId of pruneIds) t.remove(pruneId);
    });
  },

  insertSibling(
    core: UiCore,
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
    core: UiCore,
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
      return cmd.insertSibling(core, sel, "after");
    }

    const curText = valueToText(snap.content.value);
    const len = curText.length;

    const start = Math.max(0, Math.min(caretStart, len));
    const end = Math.max(0, Math.min(caretEnd, len));

    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let rightId: ItemId = "";

    core.commit((t) => {
      t.setValue(id, left);
      rightId = t.insertChild(parentId, { at: idx + 1 });
      t.setValue(rightId, right);
    });

    return rightId || null;
  },

  joinBoundary(
    core: UiCore,
    rootId: ItemId,
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
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, rightId);

    core.commit((t) => {
      t.setValue(leftId, leftText + rightText);
      t.remove(rightId);
      for (const pruneId of pruneIds) t.remove(pruneId);
    });

    return { id: leftId, caret: caretAt(leftText.length) };
  },

  changeNesting(
    core: UiCore,
    rootId: ItemId,
    sel: Extract<Selection, { type: "focused" }>,
    dir: "in" | "out",
  ): Focus | null {
    const id = sel.focus.item;
    const loc = core.locate(id);
    if (!loc) return null;

    if (dir === "in") {
      const { parentId, index: idx } = loc;
      const parentSnap = core.item(parentId);
      if (parentSnap.content.type !== "group") return null;
      if (
        parentSnap.mode.type === "readonly" ||
        parentSnap.mode.type === "connected"
      )
        return null;
      let wrapperId: ItemId = "";

      core.commit((t) => {
        wrapperId = t.insertChild(parentId, { at: idx });
        t.setGroup(wrapperId);
        t.move(id, wrapperId, { at: 0 });
      });

      return { container: wrapperId, item: id };
    }

    const { parentId: wrapperId } = loc;
    if (wrapperId === rootId) return null;

    const wrapperLoc = core.locate(wrapperId);
    if (!wrapperLoc) return null;
    const { parentId: grandparentId, index: wrapperIdx } = wrapperLoc;
    const wrapperSnap = core.item(wrapperId);
    if (wrapperSnap.content.type !== "group") return null;
    if (
      wrapperSnap.mode.type === "readonly" ||
      wrapperSnap.mode.type === "connected"
    )
      return null;
    const grandparentSnap = core.item(grandparentId);
    if (grandparentSnap.content.type !== "group") return null;
    if (
      grandparentSnap.mode.type === "readonly" ||
      grandparentSnap.mode.type === "connected"
    )
      return null;

    const kids = [...wrapperSnap.content.children];

    core.commit((t) => {
      for (let i = 0; i < kids.length; i += 1) {
        t.move(kids[i]!, grandparentId, { at: wrapperIdx + i });
      }
      t.remove(wrapperId);
    });

    return { container: grandparentId, item: id };
  },

  promoteChildToRoot(
    core: UiCore,
    rootId: ItemId,
    childId: ItemId,
  ): Focus | null {
    const loc = core.locate(childId);
    if (!loc || loc.parentId !== rootId) return null;

    const childSnap = core.item(childId);
    if (childSnap.mode.type !== "plain") return null;

    const childContent = childSnap.content;
    if (childContent.type !== "value" && childContent.type !== "group") {
      return null;
    }

    const rootKids = [...childrenOf(core, rootId)];

    core.commit((t) => {
      for (const cid of rootKids) {
        if (cid !== childId) t.remove(cid);
      }

      if (childContent.type === "value") {
        t.remove(childId);
        t.setValue(rootId, childContent.value);
        return;
      }

      t.setGroup(rootId);
      const kids = [...childContent.children];
      for (let i = 0; i < kids.length; i += 1) {
        t.move(kids[i]!, rootId, { at: i });
      }
      t.remove(childId);
    });

    return { container: rootId, item: rootId };
  },
} as const;

function buildMeasuredHeader(
  core: UiCore,
  args: {
    focus: Focus;
    id: ItemId;
    canEditLabel: () => boolean;
    commitLabel: (text: string) => void;
    commitConnField: (key: string, text: string) => void;
  },
  onHeight: (heightPx: number) => void,
): Component {
  return createComponent(core, (ctx) => {
    const header = buildItemHeader(core, args);

    ctx.effect(() => {
      const stop = observeHeight(header.el, onHeight);
      return () => {
        stop();
        onHeight(0);
        header.dispose();
      };
    });

    return header.el;
  });
}

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
        cmd.setLabel(core, id, text);
      };

      const commitConnField = (key: string, text: string) => {
        cmd.commitConnField(core, id, key, text);
      };

      const labelFocused = computed(() => {
        const selection = core.selection();
        return (
          selection.type === "focused" &&
          selection.focus.item === focus.item &&
          selection.focus.container === focus.container &&
          selection.target === LABEL_TARGET
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

      const shouldShowHeader = computed(
        () => hasLabel.value || hasFields.value || labelFocused.value,
      );
      const needsHeaderOffset = computed(() => {
        if (!shouldShowHeader.value) return false;
        if (core.view(id) !== "outline") return false;
        return core.item(id).content.type === "value";
      });

      const setHeaderHeight = (heightPx: number) => {
        frameEl.style.setProperty("--outline-header-h", `${heightPx}px`);
      };
      const headerArgs = {
        focus,
        id,
        canEditLabel,
        commitLabel,
        commitConnField,
      };

      ctx.slot(frameEl, () => {
        if (!shouldShowHeader.value) return null;
        if (!needsHeaderOffset.value) return buildItemHeader(core, headerArgs);
        return buildMeasuredHeader(core, headerArgs, setHeaderHeight);
      });

      ctx.effect(() => {
        if (!needsHeaderOffset.value) setHeaderHeight(0);
      });
    }

    ctx.slot(frameEl, () => {
      const wanted = core.view(id);
      if (wanted === "outline") return buildOutlineBody(mountCtx, focus);
      return core.mountView({ id, containerId: focus.container });
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
    autosize: true,
    className: "ui-outline-value",
    editModel: "live",
    commit: (text) => cmd.setText(core, id, text),
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

function buildEmptyGroupPlaceholder(core: UiCore): Component {
  return createComponent(core, () => {
    const placeholderEl = el("div", "ui-outline-placeholder");
    placeholderEl.textContent = "(empty)";
    return placeholderEl;
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

    const kids = computed<readonly ItemId[]>(() =>
      kind.value === "group" ? childrenOf(core, id) : [],
    );

    ctx.list<ItemId>(
      root,
      () => [...kids.value],
      (childId) => {
        const childFocus = focusFor(core, rootId, childId);
        return buildChildOuterFrame(mountCtx, childFocus, true);
      },
    );

    ctx.slot(root, () => {
      if (kind.value === "value")
        return buildOutlineScalarBody(mountCtx, focus);
      if (kids.value.length === 0) return buildEmptyGroupPlaceholder(core);
      return null;
    });

    return root;
  });
}

export const outlineView = defineView(({ core, id: rootId, focus }) => {
  const editPointsSignal = computed(() => collectEditPoints(core, rootId));

  const onIntent = (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type !== "focused") return;
    const sel = selection;

    if (
      intent.type === "TYPE" &&
      sel.target === DEFAULT_TARGET &&
      intent.char === "=" &&
      handleContainerIntent({ core, sel, intent })
    )
      return;

    if (intent.type === "TYPE" || intent.type === "CONFIRM") {
      if (
        sel.target === DEFAULT_TARGET &&
        core.item(sel.focus.item).content.type === "group" &&
        childrenOf(core, sel.focus.item).length === 0
      ) {
        const groupId = sel.focus.item;
        if (core.item(groupId).mode.type === "readonly") return;

        cmd.convertEmptyGroupToValue(core, groupId);

        if (intent.type === "TYPE") {
          core.focus(sel.focus, VALUE_TARGET, { caret: SELECT_ALL });
          queueMicrotask(() => typeCharIntoFocusedTextInput(intent.char));
          return;
        }

        core.focus(sel.focus, VALUE_TARGET, { caret: caret0() });
        return;
      }
    }

    switch (intent.type) {
      case "TAB": {
        const wasEditing = sel.target !== DEFAULT_TARGET;
        const fromTarget = wasEditing ? sel.target : DEFAULT_TARGET;
        const fromCaret = wasEditing ? (intent.caret ?? null) : null;

        let nextFocus = cmd.changeNesting(
          core,
          rootId,
          sel,
          intent.shift ? "out" : "in",
        );
        if (!nextFocus && intent.shift) {
          nextFocus = cmd.promoteChildToRoot(core, rootId, sel.focus.item);
        }
        if (!nextFocus) return;

        if (!wasEditing) {
          core.focus(nextFocus, DEFAULT_TARGET);
          return;
        }

        const validTargets = new Set(editTargetsForItem(core, nextFocus.item));
        const nextTarget = validTargets.has(fromTarget)
          ? fromTarget
          : DEFAULT_TARGET;

        if (nextTarget === DEFAULT_TARGET) {
          core.focus(nextFocus, DEFAULT_TARGET);
          return;
        }

        const text = getTextForTarget(core, nextFocus.item, nextTarget);
        const nextCaret = fromCaret
          ? clampCaretToText(fromCaret, text)
          : caretAt(text.length);

        core.focus(nextFocus, nextTarget, { caret: nextCaret });
        return;
      }
      case "NAV": {
        if (sel.target === DEFAULT_TARGET) {
          const dir = intent.dir === "out" ? "left" : intent.dir;

          const fromId = sel.focus.item;
          let nextId: ItemId | null = null;

          if (dir === "left") nextId = parentOf(core, rootId, fromId);
          else if (dir === "right")
            nextId = firstChild(core, fromId) ?? nextSibling(core, fromId);
          else if (dir === "up") nextId = prevSibling(core, fromId);
          else if (dir === "down") nextId = nextSibling(core, fromId);

          if (!nextId) return;

          core.focus(focusFor(core, rootId, nextId), DEFAULT_TARGET);
          return;
        }

        const move = plan.moveEditPoint(
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
      case "TYPE":
        if (sel.target !== DEFAULT_TARGET) return;
        handleContainerIntent({ core, sel, intent });
        return;
      case "CONFIRM": {
        if (sel.target !== DEFAULT_TARGET) {
          if (sel.target === VALUE_TARGET && intent.caret) {
            const nextId = cmd.splitAt(
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

          core.focus(sel.focus, DEFAULT_TARGET);
          return;
        }

        const did = handleContainerIntent({ core, sel, intent });
        if (did) return;

        const nextId = cmd.insertSibling(core, sel, "after");
        if (!nextId) return;
        core.focus(focusFor(core, rootId, nextId), VALUE_TARGET, {
          caret: caret0(),
        });
        return;
      }
      case "DELETE": {
        const id = sel.focus.item;

        if (sel.target === DEFAULT_TARGET) {
          if (core.item(id).mode.type === "readonly") return;
          cmd.removeAndPruneAncestors(core, rootId, id);
          return;
        }

        if (sel.target !== VALUE_TARGET) return;

        const item = core.item(id);
        if (!(item.mode.type === "plain" && item.content.type === "value"))
          return;

        const text = valueToText(item.content.value);

        if (text.length > 0) {
          const joined = cmd.joinBoundary(core, rootId, sel, intent.dir);
          if (!joined) return;
          core.focus(focusFor(core, rootId, joined.id), VALUE_TARGET, {
            caret: joined.caret,
          });
          return;
        }

        const destination = plan.adjacentEditStopAfterDeletion(
          core,
          rootId,
          editPointsSignal.value,
          sel,
          intent.dir,
        );

        cmd.removeAndPruneAncestors(core, rootId, id);

        if (destination) {
          core.focus(destination.focus, destination.target, {
            caret: destination.caret,
          });
        }
        return;
      }
    }
  };

  const body = buildOutlineBody(
    { core, rootId, editPointsSignal, onIntent },
    focus,
  );

  return { onIntent, body };
});
