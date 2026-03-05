import type { Signal } from "@preact/signals-core";

import {
  VALUE_TARGET,
  type Core,
  type ItemId,
  type Location,
} from "../../core";
import {
  domPointToTextOffset,
  getCollapsedCaretRectInSurface,
  getDomPointFromViewport,
  getDomRangeInRoot,
  getMappedRange,
  getDomSelectionPointsInRoot,
  getMappedSelectionPointsInRoot,
  getSurfaceFromNodeInRoot,
  getTextSurfaceLineRects,
  renderPlainTextToContentEditable,
  textOffsetToDomPoint,
} from "../../dom";
import type { SuppressionFlag } from "../../dom";
import {
  deleteMultiItemRange,
  deleteSingleItemRange,
  isPlainValueItem,
  moveNavPoint,
  outlineCmd,
  textLengthForTarget,
  valueToText,
  type NavPoint,
  type ModelPosition,
} from "./logic";

export const ITEM_SELECTOR = "[data-id]";
export const VALUE_SELECTOR = ".ui-outline-value";

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
  flushPendingMutations: () => void;
  suppressMutationSync: SuppressionFlag<boolean>;
  suppressHistoryKeydown: SuppressionFlag<"undo" | "redo" | null>;
};
export function itemSelectorById(itemId: ItemId): string {
  return `[data-id="${CSS.escape(itemId)}"]`;
}

export function domPositionToModel(
  outlineRoot: HTMLElement,
  node: Node,
  offset: number,
): ModelPosition | null {
  let cur: Node | null = node instanceof Text ? node.parentNode : node;

  while (cur && cur !== outlineRoot) {
    if (!(cur instanceof HTMLElement)) {
      cur = cur.parentNode;
      continue;
    }
    const itemId = cur.dataset.id as ItemId | undefined;
    if (itemId) {
      const valueEl = cur.querySelector<HTMLElement>(VALUE_SELECTOR);
      if (!valueEl || !valueEl.contains(node)) return null;
      const textOffset = domPointToTextOffset(valueEl, node, offset);
      return textOffset == null ? null : { itemId, offset: textOffset };
    }
    cur = cur.parentNode;
  }
  return null;
}

export function modelPositionToDom(
  outlineRoot: HTMLElement,
  itemId: ItemId,
  offset: number,
): { node: Node; offset: number } | null {
  const itemEl = outlineRoot.querySelector<HTMLElement>(
    itemSelectorById(itemId),
  );
  if (!itemEl) return null;
  const valueEl = itemEl.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (!valueEl) return null;
  return textOffsetToDomPoint(valueEl, offset);
}

export function valueCaretOffset(
  root: HTMLElement,
  itemId: ItemId,
  collapsed = false,
): number | null {
  const mapped = getMappedSelectionPointsInRoot(root, (point) =>
    domPositionToModel(root, point.node, point.offset),
  );
  if (!mapped) return null;
  if (collapsed && !mapped.isCollapsed) return null;
  if (mapped.anchor.itemId !== itemId || mapped.focus.itemId !== itemId)
    return null;
  return mapped.anchor.offset;
}

function getCollapsedCaretRect(
  root: HTMLElement,
  itemId: ItemId,
): { rect: DOMRect; valueEl: HTMLElement } | null {
  const itemEl = root.querySelector<HTMLElement>(itemSelectorById(itemId));
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (!valueEl) return null;
  const info = getCollapsedCaretRectInSurface(root, valueEl);
  if (!info) return null;
  return { rect: info.rect, valueEl };
}

function getCaretBoundaryRect(
  root: HTMLElement,
  core: Core,
  itemId: ItemId,
  dir: "up" | "down",
): DOMRect | null {
  const info = getCollapsedCaretRect(root, itemId);
  if (!info) return null;
  const caretOffset = valueCaretOffset(root, itemId, true);
  const snap = core.item(itemId);
  if (caretOffset != null && isPlainValueItem(snap)) {
    const text = valueToText(snap.content.value);
    const totalLogicalLines = text.split("\n").length;
    if (totalLogicalLines > 1) {
      const logicalLineIdx = text.slice(0, caretOffset).split("\n").length - 1;
      const onLogicalBoundary =
        dir === "up"
          ? logicalLineIdx === 0
          : logicalLineIdx === totalLogicalLines - 1;
      if (!onLogicalBoundary) return null;
    }
  }
  const lineRects = getTextSurfaceLineRects(info.valueEl);
  if (lineRects.length === 0) return info.rect;
  const tol = 1;
  const firstTop = Math.min(...lineRects.map((r) => r.top));
  const lastBottom = Math.max(...lineRects.map((r) => r.bottom));
  const atBoundary =
    dir === "up"
      ? info.rect.top <= firstTop + tol
      : info.rect.bottom >= lastBottom - tol;
  return atBoundary ? info.rect : null;
}

function adjacentOutlineValueItem(
  navPoints: readonly NavPoint[],
  fromId: ItemId,
  dir: "up" | "down",
): ItemId | null {
  const points = navPoints.filter(
    (p): p is Extract<NavPoint, { type: "editing" }> =>
      p.type === "editing" && p.target === VALUE_TARGET,
  );
  const idx = points.findIndex((p) => p.focus.item === fromId);
  if (idx < 0) return null;
  const next = points[dir === "up" ? idx - 1 : idx + 1];
  return next?.focus.item ?? null;
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

export function handleArrowHorizontal(
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
        { type: "editing", focus: modelSel.location, target: VALUE_TARGET },
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
      )
        return null;
      return moveNavPoint(
        navPoints,
        { type: "item", focus: modelSel.head },
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
    core.focus({ type: "item", location: moved.point.focus });
    return true;
  }
  e.preventDefault();
  const caret =
    moved.edge == null
      ? undefined
      : moved.edge === "start"
        ? 0
        : textLengthForTarget(core, moved.point.focus.item, moved.point.target);
  applyEditingResult({
    location: moved.point.focus,
    target: moved.point.target,
    ...(caret !== undefined ? { caret } : {}),
    ...(moved.point.target === VALUE_TARGET
      ? { reveal: { offset: caret ?? 0 } }
      : {}),
  });
  return true;
}

export function handleArrowVertical(
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
  )
    return false;
  e.preventDefault();
  return true;
}

export function deleteSelection(
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

export function handleHistoryBeforeInput(
  ctx: EditCtx,
  e: InputEvent,
  kind: "undo" | "redo",
): void {
  e.preventDefault();
  ctx.suppressHistoryKeydown.suppressForTurn(kind);
  if (kind === "undo") ctx.core.undo();
  else ctx.core.redo();
}

export function handleInsertLineBreakBeforeInput(
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

export function handleInsertParagraphBeforeInput(
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
    )
      return;
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

export function handleDeleteBeforeInput(
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
    ctx.flushPendingMutations();
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

export function handleBoundaryDeleteBeforeInput(
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
        { type: "editing", focus: modelSel.location, target: modelSel.target },
        dir,
      );
      ctx.suppressMutationSync.suppressForTurn(true);
      outlineCmd.removeAndPruneAncestors(ctx.core, ctx.rootId, pos.itemId);
      if (!nextStop) return;
      if (nextStop.point.type === "item") {
        ctx.core.focus({ type: "item", location: nextStop.point.focus });
        return;
      }
      const caret =
        nextStop.edge == null
          ? undefined
          : nextStop.edge === "start"
            ? 0
            : textLengthForTarget(
                ctx.core,
                nextStop.point.focus.item,
                nextStop.point.target,
              );
      ctx.applyEditingResult({
        location: nextStop.point.focus,
        target: nextStop.point.target,
        ...(caret !== undefined ? { caret } : {}),
        ...(nextStop.point.target === VALUE_TARGET
          ? { reveal: { offset: caret ?? 0 } }
          : {}),
      });
      return;
    }
    const joined = outlineCmd.joinBoundary(
      ctx.core,
      ctx.rootId,
      modelSel.location,
      dir,
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

export function handleInsertReplacementTextBeforeInput(
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
    ctx.flushPendingMutations();
    renderPlainTextToContentEditable(valueEl, nextText);
  }
  ctx.applyEditingResult({
    location: { item: startPos.itemId, portals: ctx.portals },
    target: VALUE_TARGET,
    caret: nextCaret,
    reveal: { offset: nextCaret, defer: false },
  });
}

export function insertText(
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
  const lines = text.split("\n");
  const loc = ctx.core.locate(startPos.itemId);
  if (!loc) return;

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
  if (startValueEl) {
    const startSnap = ctx.core.item(startPos.itemId);
    if (isPlainValueItem(startSnap)) {
      ctx.flushPendingMutations();
      renderPlainTextToContentEditable(
        startValueEl,
        valueToText(startSnap.content.value),
      );
    }
  }
  const lastId = insertedIds[insertedIds.length - 1] ?? startPos.itemId;
  const lastOffset =
    lastId === startPos.itemId
      ? before.length + (lines[0]?.length ?? 0)
      : (lines[lines.length - 1]?.length ?? 0);
  ctx.applyEditingResult({
    location: { item: lastId, portals: ctx.portals },
    target: VALUE_TARGET,
    caret: lastOffset,
    reveal: { offset: lastOffset, defer: false },
  });
}
