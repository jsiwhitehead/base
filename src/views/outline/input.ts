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
  getDomSelectionPointsInRoot,
  getMappedSelectionPointsInRoot,
  getSurfaceFromNodeInRoot,
  getTextSurfaceLineRects,
  renderPlainTextToContentEditable,
  textOffsetToDomPoint,
} from "../../dom";
import {
  deleteMultiItemValueRange,
  deleteSingleItemValueRange,
  focusFor,
  isPlainValueItem,
  moveEditPoint,
  outlineCmd,
  textLengthForTarget,
  valueToText,
  type EditStop,
  type ModelPosition,
} from "./logic";

export const VALUE_SURFACE_SELECTOR = "[data-target='value']";
export const ITEM_SELECTOR = "[data-id]";
export const OUTLINE_VALUE_SELECTOR = ".ui-outline-value";

export type SavedOutlineSelection = {
  anchor: ModelPosition;
  focus: ModelPosition;
};

export type InputState = {
  isComposing: boolean;
  compositionEndedAt: number;
  stickyCaretX: number | null;
  savedSelectionOnEmbeddedBlur: SavedOutlineSelection | null;
  shouldRestoreSelectionOnFocus: boolean;
  lastValueSelectionKey: string | null;
};

export type ApplyEditingResult = (args: {
  location: Location;
  target: string;
  caret?: number;
  reveal?: { offset: number; defer?: boolean };
}) => void;

export type TurnSuppressionFlag<T> = {
  get: () => T;
  set: (next: T) => void;
  suppressForTurn: (next: T) => void;
};

export type EditCtx = {
  core: Core;
  rootId: ItemId;
  root: HTMLElement;
  editStops: Signal<readonly EditStop[]>;
  applyEditingResult: ApplyEditingResult;
  setCursorAndReveal: (itemId: ItemId, charOffset: number) => void;
  drainObserver: () => void;
  suppressMutationSync: TurnSuppressionFlag<boolean>;
  suppressHistoryKeydown: TurnSuppressionFlag<"undo" | "redo" | null>;
};

export function createTurnSuppressionFlag<T>(
  initial: T,
): TurnSuppressionFlag<T> {
  let value = initial;
  let token = 0;
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
    },
    suppressForTurn: (next: T) => {
      value = next;
      token += 1;
      const localToken = token;
      setTimeout(() => {
        if (token !== localToken) return;
        value = initial;
      }, 0);
    },
  };
}

function itemSelectorById(itemId: ItemId): string {
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
      const valueEl = cur.querySelector<HTMLElement>(VALUE_SURFACE_SELECTOR);
      if (!valueEl || !valueEl.contains(node)) return null;
      const charOffset = domPointToTextOffset(valueEl, node, offset);
      return charOffset == null ? null : { itemId, charOffset };
    }
    cur = cur.parentNode;
  }
  return null;
}

export function modelPositionToDom(
  outlineRoot: HTMLElement,
  itemId: ItemId,
  charOffset: number,
): { node: Node; offset: number } | null {
  const itemEl = outlineRoot.querySelector<HTMLElement>(
    itemSelectorById(itemId),
  );
  if (!itemEl) return null;
  const valueEl = itemEl.querySelector<HTMLElement>(VALUE_SURFACE_SELECTOR);
  if (!valueEl) return null;
  return textOffsetToDomPoint(valueEl, charOffset);
}

export function currentValueCaretOffset(
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
  return mapped.anchor.charOffset;
}

function getCollapsedCaretRect(
  root: HTMLElement,
  itemId: ItemId,
): { rect: DOMRect; valueEl: HTMLElement } | null {
  const itemEl = root.querySelector<HTMLElement>(itemSelectorById(itemId));
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SURFACE_SELECTOR);
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
  const caretOffset = currentValueCaretOffset(root, itemId, true);
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
  editStops: readonly EditStop[],
  fromId: ItemId,
  dir: "up" | "down",
): ItemId | null {
  const points = editStops.filter((p) => p.target === VALUE_TARGET);
  const idx = points.findIndex((p) => p.focus.item === fromId);
  if (idx < 0) return null;
  const next = points[dir === "up" ? idx - 1 : idx + 1];
  return next?.focus.item ?? null;
}

function moveVerticalAcrossOutlineValue(
  core: Core,
  root: HTMLElement,
  rootId: ItemId,
  editStops: readonly EditStop[],
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
    editStops,
    modelSel.location.item,
    dir,
  );
  if (!targetId) return false;
  if (state.stickyCaretX == null) state.stickyCaretX = boundaryRect.left;
  const itemEl = root.querySelector<HTMLElement>(itemSelectorById(targetId));
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SURFACE_SELECTOR);
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
  const targetLoc = focusFor(core, rootId, targetId);
  if (pos && pos.itemId === targetId) {
    applyEditingResult({
      location: targetLoc,
      target: VALUE_TARGET,
      caret: pos.charOffset,
      reveal: { offset: pos.charOffset, defer: false },
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
  editStops: readonly EditStop[],
  state: InputState,
  applyEditingResult: ApplyEditingResult,
  e: KeyboardEvent,
  dir: "backward" | "forward",
): boolean {
  state.stickyCaretX = null;
  const modelSel = core.selection();
  if (modelSel.type !== "editing" || modelSel.target !== VALUE_TARGET)
    return false;
  const caretOffset = currentValueCaretOffset(
    root,
    modelSel.location.item,
    true,
  );
  if (caretOffset == null) return false;
  const snap = core.item(modelSel.location.item);
  if (!isPlainValueItem(snap)) return false;
  const textLen = valueToText(snap.content.value).length;
  const atBoundary =
    dir === "backward" ? caretOffset === 0 : caretOffset === textLen;
  if (!atBoundary) return false;
  const moved = moveEditPoint(
    editStops,
    { focus: modelSel.location, target: VALUE_TARGET },
    dir,
  );
  if (!moved) return false;
  e.preventDefault();
  const caret =
    moved.edge == null
      ? undefined
      : moved.edge === "start"
        ? 0
        : textLengthForTarget(core, moved.stop.focus.item, moved.stop.target);
  applyEditingResult({
    location: moved.stop.focus,
    target: moved.stop.target,
    ...(caret !== undefined ? { caret } : {}),
    ...(moved.stop.target === VALUE_TARGET
      ? { reveal: { offset: caret ?? 0 } }
      : {}),
  });
  return true;
}

export function handleArrowVertical(
  core: Core,
  root: HTMLElement,
  rootId: ItemId,
  editStops: readonly EditStop[],
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
      rootId,
      editStops,
      state,
      applyEditingResult,
      dir,
    )
  )
    return false;
  e.preventDefault();
  return true;
}

export function deleteOutlineValueSelection(
  ctx: EditCtx,
  start: ModelPosition,
  end: ModelPosition,
): boolean {
  return (
    deleteSingleItemValueRange(
      ctx.core,
      ctx.rootId,
      start,
      end,
      ctx.setCursorAndReveal,
    ) ||
    deleteMultiItemValueRange(
      ctx.core,
      ctx.rootId,
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
  range: Range,
): void {
  e.preventDefault();
  const startPos = domPositionToModel(
    ctx.root,
    range.startContainer,
    range.startOffset,
  );
  const endPos = domPositionToModel(
    ctx.root,
    range.endContainer,
    range.endOffset,
  );
  const rangePos = startPos && endPos ? { start: startPos, end: endPos } : null;
  if (!rangePos) return;
  if (rangePos.start.itemId !== rangePos.end.itemId) return;
  const snap = ctx.core.item(rangePos.start.itemId);
  if (!isPlainValueItem(snap)) return;

  const text = valueToText(snap.content.value);
  const start = rangePos.start.charOffset;
  const end = rangePos.end.charOffset;
  const nextText = text.slice(0, start) + "\n" + text.slice(end);
  const nextCaret = start + 1;
  ctx.core.commit((t) => t.setValue(rangePos.start.itemId, nextText));
  ctx.applyEditingResult({
    location: focusFor(ctx.core, ctx.rootId, rangePos.start.itemId),
    target: VALUE_TARGET,
    caret: nextCaret,
    reveal: { offset: nextCaret },
  });
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
      dir === "backward"
        ? pos.charOffset === 0
        : pos.charOffset === text.length;
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
      const nextStop = moveEditPoint(
        ctx.editStops.value,
        { focus: modelSel.location, target: modelSel.target },
        dir,
      );
      ctx.suppressMutationSync.suppressForTurn(true);
      outlineCmd.removeAndPruneAncestors(ctx.core, ctx.rootId, pos.itemId);
      if (!nextStop) return;
      const caret =
        nextStop.edge == null
          ? undefined
          : nextStop.edge === "start"
            ? 0
            : textLengthForTarget(
                ctx.core,
                nextStop.stop.focus.item,
                nextStop.stop.target,
              );
      ctx.applyEditingResult({
        location: nextStop.stop.focus,
        target: nextStop.stop.target,
        ...(caret !== undefined ? { caret } : {}),
        ...(nextStop.stop.target === VALUE_TARGET
          ? { reveal: { offset: caret ?? 0 } }
          : {}),
      });
      return;
    }
    const joined = outlineCmd.joinBoundary(ctx.core, ctx.rootId, modelSel, dir);
    if (!joined) return;
    ctx.applyEditingResult({
      location: focusFor(ctx.core, ctx.rootId, joined.id),
      target: VALUE_TARGET,
      caret: joined.caret,
      reveal: { offset: joined.caret },
    });
    return;
  }

  const rStart = domPositionToModel(
    ctx.root,
    range.startContainer,
    range.startOffset,
  );
  const rEnd = domPositionToModel(
    ctx.root,
    range.endContainer,
    range.endOffset,
  );
  const rangePos = rStart && rEnd ? { start: rStart, end: rEnd } : null;
  if (!rangePos) return;
  if (
    !deleteMultiItemValueRange(
      ctx.core,
      ctx.rootId,
      rangePos.start,
      rangePos.end,
      ctx.setCursorAndReveal,
    )
  )
    return;
  e.preventDefault();
}

export function insertTextFromExternal(ctx: EditCtx, text: string): void {
  if (!text) return;
  const modelSel = ctx.core.selection();
  if (modelSel.type !== "editing") return;
  const range = getDomRangeInRoot(ctx.root);
  if (!range) return;
  const startValueEl = getSurfaceFromNodeInRoot(
    ctx.root,
    range.startContainer,
    VALUE_SURFACE_SELECTOR,
  );
  const startPos = domPositionToModel(
    ctx.root,
    range.startContainer,
    range.startOffset,
  );
  if (!startPos) return;
  if (!range.collapsed) {
    const endPos = domPositionToModel(
      ctx.root,
      range.endContainer,
      range.endOffset,
    );
    if (!endPos) return;
    if (!deleteOutlineValueSelection(ctx, startPos, endPos)) return;
  }
  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return;
  const current = valueToText(snap.content.value);
  const caretStart = startPos.charOffset;
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
      ctx.drainObserver();
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
    location: focusFor(ctx.core, ctx.rootId, lastId),
    target: VALUE_TARGET,
    caret: lastOffset,
    reveal: { offset: lastOffset, defer: false },
  });
}
