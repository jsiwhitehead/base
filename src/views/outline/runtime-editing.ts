import type { Signal } from "@preact/signals-core";

import {
  VALUE_TARGET,
  type Core,
  type ItemId,
  type Location,
} from "../../core";
import {
  getDomPointFromViewport,
  getDomRangeInRoot,
  getDomSelectionPointsInRoot,
  getMappedRange,
  getMappedSelectionRangeInRoot,
  getPlainTextFromDataTransfer,
  getSurfaceFromNodeInRoot,
  getTextNodeFromMutationRecord,
  readPlainTextFromContentEditable,
  renderPlainTextToContentEditable,
  setDomCaret,
  setDomSelectionRange,
  writePlainTextClipboard,
} from "../../dom";
import type { Ctx, SuppressionFlag, UiCore } from "../../dom";

import {
  deleteMultiItemRange,
  deleteSingleItemRange,
  removeBlockSelection,
  outlineCmd,
  readSelectionText,
} from "./commands";
import {
  extendBlockSelectionByArrow,
  isPlainValueItem,
  moveNavPoint,
  textLengthForTarget,
  valueToText,
  type ModelPosition,
  type NavPoint,
} from "./navigation";
import {
  domPositionToModel,
  getCollapsedCaretRect,
  getCaretBoundaryRect,
  ITEM_SELECTOR,
  itemSelectorById,
  modelPositionToDom,
  valueCaretOffset,
  VALUE_SELECTOR,
} from "./dom-mapping";
import type { OutlineSelectionEditingControls } from "./runtime-selection";
import { isOutlineValueEditEvent } from "./runtime-selection";

export type InputState = {
  compositionEndedAt: number;
  stickyCaretX: number | null;
};

export type ApplyEditingResult = (args: {
  location: Location;
  target: string;
  caret?: number;
  reveal?: { offset: number; defer?: boolean };
}) => void;

export type EditCtx = {
  core: Core;
  rootId: ItemId;
  portals: readonly ItemId[];
  root: HTMLElement;
  navPoints: Signal<readonly NavPoint[]>;
  applyEditingResult: ApplyEditingResult;
  setCursorAndReveal: (itemId: ItemId, offset: number) => void;
  discardPendingMutationRecords: () => void;
  suppressMutationSync: SuppressionFlag<boolean>;
  suppressHistoryKeydown: SuppressionFlag<"undo" | "redo" | null>;
};

function adjacentOutlineValueItem(
  navPoints: readonly NavPoint[],
  fromId: ItemId,
  dir: "up" | "down",
): ItemId | null {
  const points = navPoints.filter(
    (p): p is Extract<NavPoint, { type: "editing" }> =>
      p.type === "editing" && p.target === VALUE_TARGET,
  );
  const idx = points.findIndex((p) => p.location.item === fromId);
  if (idx < 0) return null;
  const next = points[dir === "up" ? idx - 1 : idx + 1];
  return next?.location.item ?? null;
}

function moveVerticalAcrossOutlineValue(
  core: Core,
  root: HTMLElement,
  portals: readonly ItemId[],
  navPoints: readonly NavPoint[],
  state: InputState,
  applyEditingResult: ApplyEditingResult,
  dir: "up" | "down",
): boolean {
  const modelSel = core.selection();
  if (modelSel.type !== "editing" || modelSel.target !== VALUE_TARGET)
    return false;
  const boundaryRect = getCaretBoundaryRect(
    root,
    core,
    modelSel.location.item,
    dir,
  );
  if (!boundaryRect) return false;
  const targetId = adjacentOutlineValueItem(
    navPoints,
    modelSel.location.item,
    dir,
  );
  if (!targetId) return false;
  if (state.stickyCaretX == null) state.stickyCaretX = boundaryRect.left;
  const itemEl = root.querySelector<HTMLElement>(itemSelectorById(targetId));
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (!valueEl) return false;
  const valueRect = valueEl.getBoundingClientRect();
  const y =
    dir === "up"
      ? Math.max(valueRect.top + 1, valueRect.bottom - 1)
      : Math.min(valueRect.bottom - 1, valueRect.top + 1);
  const point = getDomPointFromViewport(root, state.stickyCaretX, y);
  const pos =
    point && valueEl.contains(point.node)
      ? domPositionToModel(root, point.node, point.offset)
      : null;
  const targetLoc = { item: targetId, portals };
  if (pos && pos.itemId === targetId) {
    applyEditingResult({
      location: targetLoc,
      target: VALUE_TARGET,
      caret: pos.offset,
      reveal: { offset: pos.offset, defer: false },
    });
    return true;
  }
  const snap = core.item(targetId);
  const fallbackOffset =
    dir === "up" && isPlainValueItem(snap)
      ? valueToText(snap.content.value).length
      : 0;
  applyEditingResult({
    location: targetLoc,
    target: VALUE_TARGET,
    caret: fallbackOffset,
    reveal: { offset: fallbackOffset, defer: false },
  });
  return true;
}

function deleteSelection(
  ctx: EditCtx,
  start: ModelPosition,
  end: ModelPosition,
): boolean {
  return (
    deleteSingleItemRange(
      ctx.core,
      ctx.portals,
      start,
      end,
      ctx.setCursorAndReveal,
    ) ||
    deleteMultiItemRange(
      ctx.core,
      ctx.portals,
      start,
      end,
      ctx.setCursorAndReveal,
    )
  );
}

function handleArrowHorizontal(
  core: Core,
  root: HTMLElement,
  navPoints: readonly NavPoint[],
  state: InputState,
  applyEditingResult: ApplyEditingResult,
  e: KeyboardEvent,
  dir: "backward" | "forward",
): boolean {
  let atValueBoundaryWithNoNavMove = false;
  const resolveMovedPoint = (): ReturnType<typeof moveNavPoint> => {
    const modelSel = core.selection();
    if (modelSel.type === "editing" && modelSel.target === VALUE_TARGET) {
      const caretOffset = valueCaretOffset(root, modelSel.location.item, true);
      if (caretOffset == null) return null;
      const snap = core.item(modelSel.location.item);
      if (!isPlainValueItem(snap)) return null;
      const textLen = valueToText(snap.content.value).length;
      const atBoundary =
        dir === "backward" ? caretOffset === 0 : caretOffset === textLen;
      if (!atBoundary) return null;
      const moved = moveNavPoint(
        navPoints,
        { type: "editing", location: modelSel.location, target: VALUE_TARGET },
        dir,
      );
      if (!moved) atValueBoundaryWithNoNavMove = true;
      return moved;
    }
    if (modelSel.type === "item") {
      if (
        modelSel.anchor.portals.length !== modelSel.head.portals.length ||
        modelSel.anchor.portals.some(
          (portal, i) => portal !== modelSel.head.portals[i],
        ) ||
        modelSel.anchor.item !== modelSel.head.item
      ) {
        return null;
      }
      return moveNavPoint(
        navPoints,
        { type: "item", location: modelSel.head },
        dir,
      );
    }
    return null;
  };

  state.stickyCaretX = null;
  const moved = resolveMovedPoint();
  if (!moved) {
    if (atValueBoundaryWithNoNavMove) {
      e.preventDefault();
      return true;
    }
    return false;
  }
  if (moved.point.type === "item") {
    e.preventDefault();
    core.focus({ type: "item", location: moved.point.location });
    return true;
  }
  e.preventDefault();
  const caret =
    moved.edge == null
      ? undefined
      : moved.edge === "start"
        ? 0
        : textLengthForTarget(
            core,
            moved.point.location.item,
            moved.point.target,
          );
  applyEditingResult({
    location: moved.point.location,
    target: moved.point.target,
    ...(caret !== undefined ? { caret } : {}),
    ...(moved.point.target === VALUE_TARGET
      ? { reveal: { offset: caret ?? 0 } }
      : {}),
  });
  return true;
}

function handleArrowVertical(
  core: Core,
  root: HTMLElement,
  portals: readonly ItemId[],
  navPoints: readonly NavPoint[],
  state: InputState,
  applyEditingResult: ApplyEditingResult,
  e: KeyboardEvent,
  dir: "up" | "down",
): boolean {
  const modelSel = core.selection();
  if (modelSel.type !== "editing" || modelSel.target !== VALUE_TARGET)
    return false;
  if (!getDomSelectionPointsInRoot(root)?.isCollapsed) return false;
  const caretRect = getCollapsedCaretRect(root, modelSel.location.item);
  if (state.stickyCaretX == null && caretRect)
    state.stickyCaretX = caretRect.rect.left;
  if (
    !moveVerticalAcrossOutlineValue(
      core,
      root,
      portals,
      navPoints,
      state,
      applyEditingResult,
      dir,
    )
  ) {
    return false;
  }
  e.preventDefault();
  return true;
}

function handleHistoryBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
  kind: "undo" | "redo",
): void {
  e.preventDefault();
  ctx.suppressHistoryKeydown.suppressForTurn(kind);
  if (kind === "undo") ctx.core.undo();
  else ctx.core.redo();
}

function handleInsertLineBreakBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
  range: AbstractRange,
): void {
  e.preventDefault();
  const rangePos = getMappedRange(range, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return;
  if (rangePos.start.itemId !== rangePos.end.itemId) return;
  const snap = ctx.core.item(rangePos.start.itemId);
  if (!isPlainValueItem(snap)) return;

  const text = valueToText(snap.content.value);
  const start = rangePos.start.offset;
  const end = rangePos.end.offset;
  const nextText = text.slice(0, start) + "\n" + text.slice(end);
  const nextCaret = start + 1;
  ctx.core.commit((t) => t.setValue(rangePos.start.itemId, nextText));
  ctx.applyEditingResult({
    location: { item: rangePos.start.itemId, portals: ctx.portals },
    target: VALUE_TARGET,
    caret: nextCaret,
    reveal: { offset: nextCaret },
  });
}

function handleInsertParagraphBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
  range: AbstractRange,
): void {
  e.preventDefault();
  const rangePos = getMappedRange(range, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return;
  if (ctx.core.selection().type !== "editing") return;

  const caretStart = rangePos.start.offset;
  let caretEnd = caretStart;
  const multiItem =
    !range.collapsed && rangePos.start.itemId !== rangePos.end.itemId;
  if (multiItem) {
    ctx.suppressMutationSync.suppressForTurn(true);
    if (
      !deleteMultiItemRange(
        ctx.core,
        ctx.portals,
        rangePos.start,
        rangePos.end,
        ctx.setCursorAndReveal,
      )
    ) {
      return;
    }
  } else if (!range.collapsed) {
    caretEnd = rangePos.end.offset;
  }

  const splitLoc = { item: rangePos.start.itemId, portals: ctx.portals };
  const newId = outlineCmd.splitAt(ctx.core, splitLoc, caretStart, caretEnd);
  if (!newId) return;
  ctx.applyEditingResult({
    location: { item: newId, portals: ctx.portals },
    target: VALUE_TARGET,
    caret: 0,
    reveal: { offset: 0, defer: false },
  });
}

function handleDeleteBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
  targetRange: StaticRange,
): boolean {
  const rangePos = getMappedRange(targetRange, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return false;
  const startPos = rangePos.start;
  const endPos = rangePos.end;
  if (startPos.itemId !== endPos.itemId) return false;
  if (startPos.offset === endPos.offset) return false;

  e.preventDefault();
  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return true;
  const text = valueToText(snap.content.value);
  const nextText = text.slice(0, startPos.offset) + text.slice(endPos.offset);

  ctx.core.commit((t) => t.setValue(startPos.itemId, nextText));

  const itemEl = ctx.root.querySelector<HTMLElement>(
    itemSelectorById(startPos.itemId),
  );
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (valueEl) {
    ctx.discardPendingMutationRecords();
    renderPlainTextToContentEditable(valueEl, nextText);
  }
  ctx.applyEditingResult({
    location: { item: startPos.itemId, portals: ctx.portals },
    target: VALUE_TARGET,
    caret: startPos.offset,
    reveal: { offset: startPos.offset, defer: false },
  });
  return true;
}

function handleBoundaryDeleteBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
  dir: "backward" | "forward",
  range: Range,
): void {
  if (range.collapsed) {
    const pos = domPositionToModel(
      ctx.root,
      range.startContainer,
      range.startOffset,
    );
    if (!pos) return;
    const snap = ctx.core.item(pos.itemId);
    const text =
      snap.content.type === "value" ? valueToText(snap.content.value) : "";
    const atBoundary =
      dir === "backward" ? pos.offset === 0 : pos.offset === text.length;
    if (!atBoundary) return;
    e.preventDefault();
    const modelSel = ctx.core.selection();
    if (modelSel.type !== "editing") return;
    if (
      modelSel.target === VALUE_TARGET &&
      snap.mode.type === "plain" &&
      snap.content.type === "value" &&
      text.length === 0
    ) {
      const nextStop = moveNavPoint(
        ctx.navPoints.value,
        {
          type: "editing",
          location: modelSel.location,
          target: modelSel.target,
        },
        dir,
      );
      ctx.suppressMutationSync.suppressForTurn(true);
      outlineCmd.removeAndPruneAncestors(ctx.core, ctx.rootId, pos.itemId);
      if (!nextStop) return;
      if (nextStop.point.type === "item") {
        ctx.core.focus({ type: "item", location: nextStop.point.location });
        return;
      }
      const caret =
        nextStop.edge == null
          ? undefined
          : nextStop.edge === "start"
            ? 0
            : textLengthForTarget(
                ctx.core,
                nextStop.point.location.item,
                nextStop.point.target,
              );
      ctx.applyEditingResult({
        location: nextStop.point.location,
        target: nextStop.point.target,
        ...(caret !== undefined ? { caret } : {}),
        ...(nextStop.point.target === VALUE_TARGET
          ? { reveal: { offset: caret ?? 0 } }
          : {}),
      });
      return;
    }
    const adjacentStop = moveNavPoint(
      ctx.navPoints.value,
      {
        type: "editing",
        location: modelSel.location,
        target: modelSel.target,
      },
      dir,
    );
    if (
      !adjacentStop ||
      adjacentStop.point.type !== "editing" ||
      adjacentStop.point.target !== VALUE_TARGET
    ) {
      return;
    }
    const joined = outlineCmd.joinValues(
      ctx.core,
      ctx.rootId,
      dir === "backward"
        ? adjacentStop.point.location.item
        : modelSel.location.item,
      dir === "backward"
        ? modelSel.location.item
        : adjacentStop.point.location.item,
    );
    if (!joined) return;
    ctx.applyEditingResult({
      location: { item: joined.id, portals: ctx.portals },
      target: VALUE_TARGET,
      caret: joined.caret,
      reveal: { offset: joined.caret },
    });
    return;
  }

  const rangePos = getMappedRange(range, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return;
  if (
    !deleteMultiItemRange(
      ctx.core,
      ctx.portals,
      rangePos.start,
      rangePos.end,
      ctx.setCursorAndReveal,
    )
  ) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
}

function handleInsertReplacementTextBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
): void {
  e.preventDefault();
  const replacementText = e.data ?? "";
  const fallback = () => insertText(ctx, replacementText);
  const targetRange = e.getTargetRanges()[0];
  if (!targetRange) return fallback();

  const rangePos = getMappedRange(targetRange, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return fallback();
  const startPos = rangePos.start;
  const endPos = rangePos.end;
  if (startPos.itemId !== endPos.itemId) return fallback();

  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return fallback();

  const currentText = valueToText(snap.content.value);
  const nextCaret = startPos.offset + replacementText.length;
  const nextText =
    currentText.slice(0, startPos.offset) +
    replacementText +
    currentText.slice(endPos.offset);
  ctx.core.commit((t) => t.setValue(startPos.itemId, nextText));

  const valueEl = ctx.root
    .querySelector<HTMLElement>(itemSelectorById(startPos.itemId))
    ?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (valueEl) {
    ctx.discardPendingMutationRecords();
    renderPlainTextToContentEditable(valueEl, nextText);
  }
  ctx.applyEditingResult({
    location: { item: startPos.itemId, portals: ctx.portals },
    target: VALUE_TARGET,
    caret: nextCaret,
    reveal: { offset: nextCaret, defer: false },
  });
}

function insertText(
  ctx: EditCtx,
  text: string,
  range: AbstractRange | null = null,
): void {
  if (!text) return;
  const modelSel = ctx.core.selection();
  if (modelSel.type !== "editing") return;
  const editRange = range ?? getDomRangeInRoot(ctx.root);
  if (!editRange) return;
  const startValueEl = getSurfaceFromNodeInRoot(
    ctx.root,
    editRange.startContainer,
    VALUE_SELECTOR,
  );
  const startPos = domPositionToModel(
    ctx.root,
    editRange.startContainer,
    editRange.startOffset,
  );
  if (!startPos) return;
  if (!editRange.collapsed) {
    const endPos = domPositionToModel(
      ctx.root,
      editRange.endContainer,
      editRange.endOffset,
    );
    if (!endPos) return;
    if (!deleteSelection(ctx, startPos, endPos)) return;
  }
  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return;
  const current = valueToText(snap.content.value);
  const caretStart = startPos.offset;
  const before = current.slice(0, caretStart);
  const after = current.slice(caretStart);
  const syncStartValueSurface = (): void => {
    if (!startValueEl) return;
    const startSnap = ctx.core.item(startPos.itemId);
    if (!isPlainValueItem(startSnap)) return;
    ctx.discardPendingMutationRecords();
    renderPlainTextToContentEditable(
      startValueEl,
      valueToText(startSnap.content.value),
    );
  };
  const applyValueEditingResult = (itemId: ItemId, caret: number): void => {
    ctx.applyEditingResult({
      location: { item: itemId, portals: ctx.portals },
      target: VALUE_TARGET,
      caret,
      reveal: { offset: caret, defer: false },
    });
  };

  const lines = text.split("\n");
  const loc = ctx.core.locate(startPos.itemId);
  if (!loc) {
    const nextText = before + text + after;
    const nextCaret = before.length + text.length;
    ctx.core.commit((t) => t.setValue(startPos.itemId, nextText));
    syncStartValueSurface();
    applyValueEditingResult(startPos.itemId, nextCaret);
    return;
  }
  const insertedIds: ItemId[] = [];
  ctx.core.commit((t) => {
    t.setValue(
      startPos.itemId,
      before + (lines[0] ?? "") + (lines.length === 1 ? after : ""),
    );
    for (let i = 1; i < lines.length; i += 1) {
      const newId = t.insertChild(loc.parentId, { at: loc.index + i });
      t.setValue(
        newId,
        (lines[i] ?? "") + (i === lines.length - 1 ? after : ""),
      );
      insertedIds.push(newId);
    }
  });
  syncStartValueSurface();
  const lastId = insertedIds[insertedIds.length - 1] ?? startPos.itemId;
  const lastOffset =
    lastId === startPos.itemId
      ? before.length + (lines[0]?.length ?? 0)
      : (lines[lines.length - 1]?.length ?? 0);
  applyValueEditingResult(lastId, lastOffset);
}

export function createOutlineMutationSync(args: {
  core: UiCore;
  root: HTMLElement;
  suppressMutationSync: SuppressionFlag<boolean>;
  isComposing: () => boolean;
}): {
  discardPendingMutationRecords: () => void;
  bind: (effect: Ctx["effect"]) => void;
} {
  const { core, root, suppressMutationSync, isComposing } = args;
  const observer = new MutationObserver((mutations) => {
    if (suppressMutationSync.get() || isComposing()) return;
    for (const mutation of mutations) {
      const textNode = getTextNodeFromMutationRecord(mutation);
      const valueEl =
        (textNode
          ? getSurfaceFromNodeInRoot(root, textNode, VALUE_SELECTOR)
          : null) ??
        getSurfaceFromNodeInRoot(root, mutation.target, VALUE_SELECTOR);
      if (!valueEl) continue;
      if (textNode && !valueEl.contains(textNode)) continue;

      const itemEl = valueEl.closest<HTMLElement>(ITEM_SELECTOR);
      const itemId = itemEl?.dataset.id as ItemId | undefined;
      if (!itemId) continue;

      const snap = core.item(itemId);
      if (!isPlainValueItem(snap)) continue;

      if (
        mutation.type === "childList" &&
        valueEl.childNodes.length === 1 &&
        valueEl.firstChild instanceof HTMLBRElement
      ) {
        continue;
      }
      if (
        mutation.type === "characterData" &&
        mutation.oldValue != null &&
        mutation.target instanceof Text &&
        mutation.target.data === mutation.oldValue
      ) {
        continue;
      }
      const newText = readPlainTextFromContentEditable(valueEl);
      if (valueToText(snap.content.value) === newText) continue;
      core.commit((t) => t.setValue(itemId, newText));
    }
  });

  return {
    discardPendingMutationRecords: (): void => {
      observer.takeRecords();
    },
    bind: (effect): void => {
      effect(() => {
        observer.observe(root, {
          characterData: true,
          characterDataOldValue: true,
          childList: true,
          subtree: true,
        });
        return () => {
          observer.disconnect();
        };
      });
    },
  };
}

export type OutlineEditingRuntime = {
  setCursorAndReveal: (itemId: ItemId, offset: number) => void;
  applyEditingResult: ApplyEditingResult;
  bind: (args: {
    on: Ctx["on"];
    state: InputState;
    onValueTab: (location: Location, shift: boolean, caret: number) => void;
    setIsComposing: (next: boolean) => void;
    clearStickyCaretX: () => void;
  }) => void;
};

export function createOutlineEditingRuntime(args: {
  core: UiCore;
  rootId: ItemId;
  portals: readonly ItemId[];
  root: HTMLElement;
  navPoints: Signal<readonly NavPoint[]>;
  discardPendingMutationRecords: () => void;
  suppressMutationSync: SuppressionFlag<boolean>;
  suppressHistoryKeydown: SuppressionFlag<"undo" | "redo" | null>;
  selection: OutlineSelectionEditingControls;
}): OutlineEditingRuntime {
  const {
    core,
    rootId,
    portals,
    root,
    navPoints,
    discardPendingMutationRecords,
    suppressMutationSync,
    suppressHistoryKeydown,
    selection,
  } = args;
  const {
    suppressSelectionSync,
    clearValueRangeSelectedItems,
    setValueSelectionRangeState,
  } = selection;

  const setCursorAndReveal = (itemId: ItemId, offset: number): void => {
    discardPendingMutationRecords();
    const pos = modelPositionToDom(root, itemId, offset);
    if (pos) {
      suppressSelectionSync.suppressForTurn(true);
      setDomCaret(pos);
      setValueSelectionRangeState({ collapsed: true });
    }
    const itemEl = root.querySelector<HTMLElement>(itemSelectorById(itemId));
    const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
    valueEl?.scrollIntoView({ block: "nearest" });
  };

  const applyEditingResult: ApplyEditingResult = (args): void => {
    const { location, target, caret, reveal } = args;
    if (target !== VALUE_TARGET || caret !== undefined) {
      clearValueRangeSelectedItems();
    }
    core.focus(
      { type: "editing", location, target },
      caret !== undefined ? { caret } : undefined,
    );
    if (target !== VALUE_TARGET || !reveal) return;
    const run = (): void => {
      setCursorAndReveal(location.item, reveal.offset);
    };
    if (reveal.defer === false) run();
    else queueMicrotask(run);
  };

  const editCtx: EditCtx = {
    core,
    rootId,
    portals,
    root,
    navPoints,
    applyEditingResult,
    setCursorAndReveal,
    discardPendingMutationRecords,
    suppressMutationSync,
    suppressHistoryKeydown,
  };

  return {
    setCursorAndReveal,
    applyEditingResult,
    bind: ({
      on,
      state,
      onValueTab,
      setIsComposing,
      clearStickyCaretX,
    }): void => {
      bindOutlineBodyEditingEvents({
        on,
        editCtx,
        state,
        onValueTab,
        setIsComposing,
        clearStickyCaretX,
        setValueSelectionRangeState,
        suppressSelectionSync,
      });
    },
  };
}

export function bindOutlineBodyEditingEvents(args: {
  on: Ctx["on"];
  editCtx: EditCtx;
  state: InputState;
  onValueTab: (location: Location, shift: boolean, caret: number) => void;
  setIsComposing: (next: boolean) => void;
  clearStickyCaretX: () => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startItemId?: ItemId;
    endItemId?: ItemId;
  }) => void;
  suppressSelectionSync: SuppressionFlag<boolean>;
}): void {
  const {
    on,
    state,
    editCtx,
    onValueTab,
    setIsComposing,
    clearStickyCaretX,
    setValueSelectionRangeState,
    suppressSelectionSync,
  } = args;
  const { core, rootId, portals, root, discardPendingMutationRecords } =
    editCtx;

  const gated =
    <E extends Event>(handler: (e: E) => void): ((e: E) => void) =>
    (e: E) => {
      if (!isOutlineValueEditEvent(e.target, root)) return;
      handler(e);
    };

  bindOutlineCompositionEvents({
    on,
    root,
    gated,
    state,
    core,
    setIsComposing,
  });
  bindOutlineBeforeInputEvents({
    on,
    root,
    gated,
    core,
    editCtx,
  });
  bindOutlineKeydownEvents({
    on,
    root,
    gated,
    core,
    rootId,
    portals,
    editCtx,
    state,
    clearStickyCaretX,
    setValueSelectionRangeState,
    suppressSelectionSync,
    discardPendingMutationRecords,
    onValueTab,
  });
  bindOutlineClipboardEvents({
    on,
    root,
    gated,
    core,
    editCtx,
  });
}

function bindOutlineCompositionEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  state: InputState;
  core: Core;
  setIsComposing: (next: boolean) => void;
}): void {
  const { on, root, gated, state, core, setIsComposing } = args;

  on(
    root,
    "compositionstart",
    gated((_e: CompositionEvent): void => {
      setIsComposing(true);
      core.undoBoundary();
    }),
  );
  on(
    root,
    "compositionupdate",
    gated((_e: CompositionEvent): void => {
      setIsComposing(true);
    }),
  );
  on(
    root,
    "compositionend",
    gated((_e: CompositionEvent): void => {
      setIsComposing(false);
      state.compositionEndedAt = Date.now();
      core.undoBoundary();
    }),
  );
}

function resolveBeforeInputRange(
  root: HTMLElement,
  e: InputEvent,
): AbstractRange | null {
  const targetRange = e.getTargetRanges()[0];
  if (
    targetRange &&
    root.contains(targetRange.startContainer) &&
    root.contains(targetRange.endContainer)
  ) {
    return targetRange;
  }
  return getDomRangeInRoot(root);
}

function bindOutlineBeforeInputEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  core: Core;
  editCtx: EditCtx;
}): void {
  const { on, root, gated, core, editCtx } = args;

  on(
    root,
    "beforeinput",
    gated((e: InputEvent): void => {
      if (e.isComposing) return;
      switch (e.inputType) {
        case "historyUndo": {
          handleHistoryBeforeInput(editCtx, e, "undo");
          break;
        }

        case "historyRedo": {
          handleHistoryBeforeInput(editCtx, e, "redo");
          break;
        }

        case "insertText": {
          if (!e.data) break;
          const range = resolveBeforeInputRange(root, e);
          if (!range) break;
          const pos = domPositionToModel(
            root,
            range.startContainer,
            range.startOffset,
          );
          if (!pos) break;
          const snap = core.item(pos.itemId);
          if (
            snap.content.type === "group" &&
            snap.content.children.length > 0
          ) {
            e.preventDefault();
            break;
          }
          e.preventDefault();
          insertText(editCtx, e.data, range);
          break;
        }

        case "insertParagraph": {
          const range = resolveBeforeInputRange(root, e);
          if (!range) break;
          handleInsertParagraphBeforeInput(editCtx, e, range);
          break;
        }

        case "insertLineBreak": {
          const range = resolveBeforeInputRange(root, e);
          if (!range) break;
          handleInsertLineBreakBeforeInput(editCtx, e, range);
          break;
        }

        case "deleteContentBackward":
        case "deleteContentForward":
        case "deleteWordBackward":
        case "deleteWordForward":
        case "deleteHardLineBackward":
        case "deleteHardLineForward":
        case "deleteSoftLineBackward":
        case "deleteSoftLineForward": {
          const dir = e.inputType.includes("Backward") ? "backward" : "forward";
          const targetRange = e.getTargetRanges()[0];
          if (targetRange && handleDeleteBeforeInput(editCtx, e, targetRange)) {
            break;
          }
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleBoundaryDeleteBeforeInput(editCtx, e, dir, range);
          break;
        }

        case "insertFromPaste":
          e.preventDefault();
          break;

        case "insertFromDrop":
          e.preventDefault();
          break;

        case "deleteByDrag":
          e.preventDefault();
          break;

        case "insertReplacementText":
          handleInsertReplacementTextBeforeInput(editCtx, e);
          break;

        default:
          e.preventDefault();
          return;
      }
    }),
  );
}

function bindOutlineKeydownEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  core: Core;
  rootId: ItemId;
  portals: readonly ItemId[];
  editCtx: EditCtx;
  state: InputState;
  clearStickyCaretX: () => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startItemId?: ItemId;
    endItemId?: ItemId;
  }) => void;
  suppressSelectionSync: SuppressionFlag<boolean>;
  discardPendingMutationRecords: () => void;
  onValueTab: (location: Location, shift: boolean, caret: number) => void;
}): void {
  const {
    on,
    root,
    gated,
    core,
    rootId,
    portals,
    editCtx,
    state,
    clearStickyCaretX,
    setValueSelectionRangeState,
    suppressSelectionSync,
    discardPendingMutationRecords,
    onValueTab,
  } = args;

  on(
    root,
    "keydown",
    gated((e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (e.key === "Enter" && Date.now() - state.compositionEndedAt < 100) {
        e.preventDefault();
        return;
      }
      const sel = core.selection();
      if (sel.type === "item") {
        if (
          e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          (e.key === "ArrowUp" || e.key === "ArrowDown")
        ) {
          const next = extendBlockSelectionByArrow(
            core,
            rootId,
            sel,
            e.key === "ArrowUp" ? "up" : "down",
            portals,
          );
          if (!next) return;
          e.preventDefault();
          core.focus({ type: "item", anchor: sel.anchor, head: next });
          return;
        }
        if (
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          (e.key === "Backspace" || e.key === "Delete")
        ) {
          e.preventDefault();
          removeBlockSelection(core, rootId, sel, portals);
          return;
        }
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Shift") {
        clearStickyCaretX();
      }
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "a" && !e.altKey) {
        const modelSel = core.selection();
        if (modelSel.type !== "editing" || modelSel.target !== VALUE_TARGET) {
          return;
        }

        const seen = new Set<ItemId>();
        let firstItemId: ItemId | undefined;
        let lastItemId: ItemId | undefined;
        for (const point of editCtx.navPoints.value) {
          if (point.type !== "editing" || point.target !== VALUE_TARGET) {
            continue;
          }
          const itemId = point.location.item;
          if (seen.has(itemId)) continue;
          seen.add(itemId);
          if (!firstItemId) firstItemId = itemId;
          lastItemId = itemId;
        }
        if (!firstItemId || !lastItemId) return;

        e.preventDefault();
        setValueSelectionRangeState({
          collapsed: false,
          startItemId: firstItemId,
          endItemId: lastItemId,
        });
        core.focus({
          type: "editing",
          location: { item: lastItemId, portals },
          target: VALUE_TARGET,
        });

        const anchorDom = modelPositionToDom(root, firstItemId, 0);
        const focusDom = modelPositionToDom(
          root,
          lastItemId,
          textLengthForTarget(core, lastItemId, VALUE_TARGET),
        );
        if (anchorDom && focusDom) {
          suppressSelectionSync.suppressForTurn(true);
          discardPendingMutationRecords();
          setDomSelectionRange(anchorDom, focusDom);
        }
        return;
      }
      if (isMod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (editCtx.suppressHistoryKeydown.get() === "undo") {
          e.preventDefault();
          editCtx.suppressHistoryKeydown.set(null);
          return;
        }
        e.preventDefault();
        core.undo();
        return;
      }
      if (
        isMod &&
        (e.key.toLowerCase() === "y" ||
          (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        if (editCtx.suppressHistoryKeydown.get() === "redo") {
          e.preventDefault();
          editCtx.suppressHistoryKeydown.set(null);
          return;
        }
        e.preventDefault();
        core.redo();
        return;
      }
      if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        !e.altKey &&
        !isMod
      ) {
        const dir = e.key === "ArrowLeft" ? "backward" : ("forward" as const);
        if (
          handleArrowHorizontal(
            core,
            root,
            editCtx.navPoints.value,
            state,
            editCtx.applyEditingResult,
            e,
            dir,
          )
        ) {
          return;
        }
      }
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.shiftKey &&
        !e.altKey &&
        !isMod
      ) {
        const dir = e.key === "ArrowUp" ? "up" : "down";
        if (
          handleArrowVertical(
            core,
            root,
            portals,
            editCtx.navPoints.value,
            state,
            editCtx.applyEditingResult,
            e,
            dir,
          )
        ) {
          return;
        }
      }
      if (e.key === "Enter" && isMod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        const range = getDomRangeInRoot(root);
        if (!range) return;
        const rangePos = getMappedRange(range, (point) =>
          domPositionToModel(root, point.node, point.offset),
        );
        if (!rangePos) return;
        if (core.selection().type !== "editing") return;

        const caretStart = rangePos.start.offset;
        let caretEnd = caretStart;
        const multiItem =
          !range.collapsed && rangePos.start.itemId !== rangePos.end.itemId;
        if (multiItem) {
          editCtx.suppressMutationSync.suppressForTurn(true);
          if (
            !deleteMultiItemRange(
              core,
              portals,
              rangePos.start,
              rangePos.end,
              editCtx.setCursorAndReveal,
            )
          ) {
            return;
          }
        } else if (!range.collapsed) {
          caretEnd = rangePos.end.offset;
        }

        const nextId =
          outlineCmd.splitAfterParent(
            core,
            rootId,
            { item: rangePos.start.itemId, portals },
            caretStart,
            caretEnd,
          ) ??
          outlineCmd.splitAt(
            core,
            { item: rangePos.start.itemId, portals },
            caretStart,
            caretEnd,
          );
        if (!nextId) return;
        clearStickyCaretX();
        editCtx.suppressMutationSync.suppressForTurn(true);
        editCtx.applyEditingResult({
          location: { item: nextId, portals },
          target: VALUE_TARGET,
          caret: 0,
          reveal: { offset: 0, defer: false },
        });
        return;
      }
      if (e.key === "Tab") {
        clearStickyCaretX();
        e.preventDefault();
        e.stopPropagation();
        const modelSel = core.selection();
        if (modelSel.type !== "editing") return;
        const caretOffset = valueCaretOffset(root, modelSel.location.item) ?? 0;
        editCtx.suppressMutationSync.suppressForTurn(true);
        onValueTab(modelSel.location, e.shiftKey, caretOffset);
        return;
      }
      if (e.key === "Escape") {
        clearStickyCaretX();
        e.preventDefault();
        core.dispatch({ type: "NAV", dir: "out", mode: "step" });
      }
    }),
  );
}

function bindOutlineClipboardEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  core: Core;
  editCtx: EditCtx;
}): void {
  const { on, root, gated, core, editCtx } = args;

  const insertPlainTextFromTransfer = (
    e: ClipboardEvent | DragEvent,
    dt: DataTransfer | null | undefined,
  ): void => {
    const text = getPlainTextFromDataTransfer(dt);
    if (!text) return;
    e.preventDefault();
    core.undoBoundary();
    insertText(editCtx, text);
    core.undoBoundary();
  };

  const canAcceptPlainTextDrop = (
    dt: DataTransfer | null | undefined,
  ): boolean => {
    if (!dt) return false;
    const types = Array.from(dt.types ?? []);
    return types.length === 0 || types.includes("text/plain");
  };

  on(root, "copy", (e: ClipboardEvent): void => {
    const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
      domPositionToModel(root, point.node, point.offset),
    );
    if (!rangeSel) return;
    const text = readSelectionText(core, rangeSel);
    if (text == null) {
      e.preventDefault();
      return;
    }
    if (!writePlainTextClipboard(e, text)) return;
    e.preventDefault();
  });

  on(root, "cut", (e: ClipboardEvent): void => {
    const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
      domPositionToModel(root, point.node, point.offset),
    );
    if (!rangeSel) return;
    const text = readSelectionText(core, rangeSel);
    if (text == null) {
      e.preventDefault();
      return;
    }
    if (!writePlainTextClipboard(e, text)) return;
    e.preventDefault();

    if (rangeSel.range.collapsed) return;
    core.undoBoundary();
    void deleteSelection(editCtx, rangeSel.start, rangeSel.end);
    core.undoBoundary();
  });

  on(
    root,
    "paste",
    gated((e: ClipboardEvent): void => {
      insertPlainTextFromTransfer(e, e.clipboardData);
    }),
  );

  on(
    root,
    "dragstart",
    gated((e: DragEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel || !e.dataTransfer) return;
      const text = readSelectionText(core, rangeSel);
      if (text == null) return;
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", text);
    }),
  );

  on(
    root,
    "dragover",
    gated((e: DragEvent): void => {
      if (!canAcceptPlainTextDrop(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }),
  );

  on(
    root,
    "drop",
    gated((e: DragEvent): void => {
      insertPlainTextFromTransfer(e, e.dataTransfer);
    }),
  );
}
