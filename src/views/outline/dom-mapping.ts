import { CONTENT_TEXT_TARGET, type Core, type ItemId } from "../../core";
import {
  domPointToTextOffset,
  getCollapsedCaretRectInSurface,
  getMappedSelectionPointsInRoot,
  getTextSurfaceLineRects,
  textOffsetToDomPoint,
} from "../../dom";

import {
  isPlainValueItem,
  valueToText,
  type ModelPosition,
} from "./navigation";

export const ITEM_SELECTOR = "[data-id]";
export const VALUE_SELECTOR = ".ui-outline-value";

export function itemSelectorById(itemId: ItemId): string {
  return `[data-id="${CSS.escape(itemId)}"]`;
}

function getOutlineValueElement(
  outlineRoot: HTMLElement,
  itemId: ItemId,
): HTMLElement | null {
  const rootValueEl = outlineRoot.querySelector<HTMLElement>(
    `:scope > ${VALUE_SELECTOR}[data-target="${CONTENT_TEXT_TARGET}"]`,
  );
  const itemEl = outlineRoot.matches(itemSelectorById(itemId))
    ? outlineRoot
    : outlineRoot.querySelector<HTMLElement>(itemSelectorById(itemId));
  if (!itemEl) return null;
  return itemEl === outlineRoot
    ? rootValueEl
    : itemEl.querySelector<HTMLElement>(VALUE_SELECTOR);
}

export function domPositionToModel(
  outlineRoot: HTMLElement,
  node: Node,
  offset: number,
): ModelPosition | null {
  const rootValueEl = outlineRoot.querySelector<HTMLElement>(
    `:scope > ${VALUE_SELECTOR}[data-target="${CONTENT_TEXT_TARGET}"]`,
  );
  let cur: Node | null = node instanceof Text ? node.parentNode : node;

  while (cur) {
    if (cur instanceof HTMLElement) {
      const itemId = cur.dataset.id as ItemId | undefined;
      if (itemId) {
        const valueEl =
          cur === outlineRoot
            ? rootValueEl
            : cur.querySelector<HTMLElement>(VALUE_SELECTOR);
        if (!valueEl || !valueEl.contains(node)) return null;
        const textOffset = domPointToTextOffset(valueEl, node, offset);
        return textOffset == null ? null : { itemId, offset: textOffset };
      }
    }
    if (cur === outlineRoot) break;
    cur = cur.parentNode;
  }
  return null;
}

export function modelPositionToDom(
  outlineRoot: HTMLElement,
  itemId: ItemId,
  offset: number,
): { node: Node; offset: number } | null {
  const valueEl = getOutlineValueElement(outlineRoot, itemId);
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

export function getCollapsedCaretRect(
  root: HTMLElement,
  itemId: ItemId,
): { rect: DOMRect; valueEl: HTMLElement } | null {
  const valueEl = getOutlineValueElement(root, itemId);
  if (!valueEl) return null;
  const info = getCollapsedCaretRectInSurface(root, valueEl);
  if (!info) return null;
  return { rect: info.rect, valueEl };
}

export function getCaretBoundaryRect(
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
