import { CONTENT_TEXT_TARGET, type Core, type Location } from "../../core";
import {
  getDomPointFromViewport,
  getDomSelectionPointsInRoot,
} from "../../dom";

import {
  isPlainValueItem,
  moveStop,
  textLengthForTarget,
  valueToText,
  type OutlineStop,
  type StopMove,
} from "./navigation";
import {
  domPositionToModel,
  getCollapsedCaretRect,
  getCaretBoundaryRect,
  itemSelectorById,
  valueCaretOffset,
  VALUE_SELECTOR,
} from "./dom-mapping";

export type ApplyEditingResult = (args: {
  location: Location;
  target: string;
  caret?: number;
  scrollIntoView?: { offset: number; defer?: boolean };
}) => void;

type OutlineTextStop = Extract<OutlineStop, { type: "editing" }>;

function getVerticalBoundaryTextStop(
  core: Core,
  root: HTMLElement,
  dir: "up" | "down",
): OutlineTextStop | null {
  const selection = core.selection();
  if (
    selection.type !== "editing" ||
    selection.target !== CONTENT_TEXT_TARGET
  ) {
    return null;
  }
  if (!getDomSelectionPointsInRoot(root)?.isCollapsed) return null;
  const caretOffset = valueCaretOffset(root, selection.location.item, true);
  if (caretOffset == null) return null;
  const snap = core.item(selection.location.item);
  if (!isPlainValueItem(snap)) return null;
  const text = valueToText(snap.content.value);
  const totalLogicalLines = text.split("\n").length;
  const logicalLineIdx = text.slice(0, caretOffset).split("\n").length - 1;
  const isBoundary =
    dir === "up"
      ? logicalLineIdx === 0
      : logicalLineIdx === totalLogicalLines - 1;
  if (!isBoundary) return null;
  return {
    type: "editing",
    location: selection.location,
    target: CONTENT_TEXT_TARGET,
  };
}

export function applyStopMove(
  core: Core,
  applyEditingResult: ApplyEditingResult,
  moved: StopMove,
  textCaret?: number,
  scrollIntoView?: { offset: number; defer?: boolean },
): true {
  if (moved.stop.type === "item") {
    core.focus({ type: "item", location: moved.stop.location });
    return true;
  }
  const caret =
    textCaret ??
    (moved.edge == null
      ? undefined
      : moved.edge === "start"
        ? 0
        : textLengthForTarget(
            core,
            moved.stop.location.item,
            moved.stop.target,
          ));
  applyEditingResult({
    location: moved.stop.location,
    target: moved.stop.target,
    ...(caret !== undefined ? { caret } : {}),
    ...(moved.stop.target === CONTENT_TEXT_TARGET && caret !== undefined
      ? { scrollIntoView: scrollIntoView ?? { offset: caret } }
      : {}),
  });
  return true;
}

function resolveAdjacentStopMove(
  stops: readonly OutlineStop[],
  current: OutlineStop,
  dir: "backward" | "forward",
): StopMove | null {
  return moveStop(stops, current, dir);
}

function resolveVerticalTextCaret(
  core: Core,
  root: HTMLElement,
  stickyCaretX: number | null,
  destination: OutlineTextStop,
  dir: "up" | "down",
): { caret: number; scrollIntoView: { offset: number; defer: false } } | null {
  const targetId = destination.location.item;
  const itemEl = root.querySelector<HTMLElement>(itemSelectorById(targetId));
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (!valueEl) return null;
  const valueRect = valueEl.getBoundingClientRect();
  const y =
    dir === "up"
      ? Math.max(valueRect.top + 1, valueRect.bottom - 1)
      : Math.min(valueRect.bottom - 1, valueRect.top + 1);
  const point =
    stickyCaretX == null
      ? null
      : getDomPointFromViewport(root, stickyCaretX, y);
  const pos =
    point && valueEl.contains(point.node)
      ? domPositionToModel(root, point.node, point.offset)
      : null;
  if (pos && pos.itemId === targetId) {
    return {
      caret: pos.offset,
      scrollIntoView: { offset: pos.offset, defer: false },
    };
  }
  const snap = core.item(targetId);
  const fallbackOffset =
    dir === "up" && isPlainValueItem(snap)
      ? valueToText(snap.content.value).length
      : 0;
  return {
    caret: fallbackOffset,
    scrollIntoView: { offset: fallbackOffset, defer: false },
  };
}

function moveVerticalFromBoundaryStop(
  core: Core,
  root: HTMLElement,
  stops: readonly OutlineStop[],
  current: OutlineTextStop,
  getStickyCaretX: () => number | null,
  setStickyCaretX: (next: number) => void,
  applyEditingResult: ApplyEditingResult,
  dir: "up" | "down",
): boolean {
  const moved = resolveAdjacentStopMove(
    stops,
    current,
    dir === "up" ? "backward" : "forward",
  );
  if (!moved) return false;
  const boundaryRect = getCaretBoundaryRect(
    root,
    core,
    current.location.item,
    dir,
  );
  if (getStickyCaretX() == null && boundaryRect)
    setStickyCaretX(boundaryRect.left);
  if (moved.stop.type === "item")
    return applyStopMove(core, applyEditingResult, moved);
  const destination = resolveVerticalTextCaret(
    core,
    root,
    getStickyCaretX(),
    moved.stop,
    dir,
  );
  if (!destination) return false;
  return applyStopMove(
    core,
    applyEditingResult,
    moved,
    destination.caret,
    destination.scrollIntoView,
  );
}

export function handleArrowHorizontal(
  core: Core,
  root: HTMLElement,
  stops: readonly OutlineStop[],
  resetStickyCaretX: () => void,
  applyEditingResult: ApplyEditingResult,
  e: KeyboardEvent,
  dir: "backward" | "forward",
): boolean {
  let atValueBoundaryWithNoNavMove = false;
  const resolveStopMove = (): StopMove | null => {
    const modelSel = core.selection();
    if (
      modelSel.type === "editing" &&
      modelSel.target === CONTENT_TEXT_TARGET
    ) {
      const caretOffset = valueCaretOffset(root, modelSel.location.item, true);
      if (caretOffset == null) return null;
      const snap = core.item(modelSel.location.item);
      if (!isPlainValueItem(snap)) return null;
      const textLen = valueToText(snap.content.value).length;
      const atBoundary =
        dir === "backward" ? caretOffset === 0 : caretOffset === textLen;
      if (!atBoundary) return null;
      const moved = resolveAdjacentStopMove(
        stops,
        {
          type: "editing",
          location: modelSel.location,
          target: CONTENT_TEXT_TARGET,
        },
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
      return resolveAdjacentStopMove(
        stops,
        { type: "item", location: modelSel.head },
        dir,
      );
    }
    return null;
  };

  resetStickyCaretX();
  const moved = resolveStopMove();
  if (!moved) {
    if (atValueBoundaryWithNoNavMove) {
      e.preventDefault();
      return true;
    }
    return false;
  }
  e.preventDefault();
  return applyStopMove(core, applyEditingResult, moved);
}

export function handleVerticalArrowIntent(
  core: Core,
  root: HTMLElement,
  stops: readonly OutlineStop[],
  getStickyCaretX: () => number | null,
  setStickyCaretX: (next: number) => void,
  resetStickyCaretX: () => void,
  applyEditingResult: ApplyEditingResult,
  e: KeyboardEvent,
  dir: "up" | "down",
): boolean {
  const boundaryStop = getVerticalBoundaryTextStop(core, root, dir);
  if (!boundaryStop) return false;
  const caretRect = getCollapsedCaretRect(root, boundaryStop.location.item);
  if (getStickyCaretX() == null && caretRect) {
    setStickyCaretX(caretRect.rect.left);
  }
  if (
    moveVerticalFromBoundaryStop(
      core,
      root,
      stops,
      boundaryStop,
      getStickyCaretX,
      setStickyCaretX,
      applyEditingResult,
      dir,
    )
  ) {
    e.preventDefault();
    return true;
  }
  e.preventDefault();
  resetStickyCaretX();
  core.dispatch({ type: "NAV", dir });
  return true;
}
