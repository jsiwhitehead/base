import { CONTENT_TEXT_TARGET, type Core, type NodeId } from "../../core";
import {
  domPointToTextOffset,
  getCollapsedCaretRectInSurface,
  getMappedSelectionPointsInRoot,
  getTextSurfaceLineRects,
  textOffsetToDomPoint,
} from "../../dom";

import {
  isPlainValueNode,
  valueToText,
  type ModelPosition,
} from "./navigation";

export const NODE_SELECTOR = "[data-id]";
export const VALUE_SELECTOR = ".ui-outline-value";

export function nodeSelectorById(nodeId: NodeId): string {
  return `[data-id="${CSS.escape(nodeId)}"]`;
}

function getOutlineValueElement(
  outlineRoot: HTMLElement,
  nodeId: NodeId,
): HTMLElement | null {
  const rootValueEl = outlineRoot.querySelector<HTMLElement>(
    `:scope > ${VALUE_SELECTOR}[data-target="${CONTENT_TEXT_TARGET}"]`,
  );
  const nodeEl = outlineRoot.matches(nodeSelectorById(nodeId))
    ? outlineRoot
    : outlineRoot.querySelector<HTMLElement>(nodeSelectorById(nodeId));
  if (!nodeEl) return null;
  return nodeEl === outlineRoot
    ? rootValueEl
    : nodeEl.querySelector<HTMLElement>(VALUE_SELECTOR);
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
      const nodeId = cur.dataset.id as NodeId | undefined;
      if (nodeId) {
        const valueEl =
          cur === outlineRoot
            ? rootValueEl
            : cur.querySelector<HTMLElement>(VALUE_SELECTOR);
        if (!valueEl || !valueEl.contains(node)) return null;
        const textOffset = domPointToTextOffset(valueEl, node, offset);
        return textOffset == null ? null : { nodeId, offset: textOffset };
      }
    }
    if (cur === outlineRoot) break;
    cur = cur.parentNode;
  }
  return null;
}

export function modelPositionToDom(
  outlineRoot: HTMLElement,
  nodeId: NodeId,
  offset: number,
): { node: Node; offset: number } | null {
  const valueEl = getOutlineValueElement(outlineRoot, nodeId);
  if (!valueEl) return null;
  return textOffsetToDomPoint(valueEl, offset);
}

export function valueCaretOffset(
  root: HTMLElement,
  nodeId: NodeId,
  collapsed = false,
): number | null {
  const mapped = getMappedSelectionPointsInRoot(root, (point) =>
    domPositionToModel(root, point.node, point.offset),
  );
  if (!mapped) return null;
  if (collapsed && !mapped.isCollapsed) return null;
  if (mapped.anchor.nodeId !== nodeId || mapped.focus.nodeId !== nodeId)
    return null;
  return mapped.anchor.offset;
}

export function getCollapsedCaretRect(
  root: HTMLElement,
  nodeId: NodeId,
): { rect: DOMRect; valueEl: HTMLElement } | null {
  const valueEl = getOutlineValueElement(root, nodeId);
  if (!valueEl) return null;
  const info = getCollapsedCaretRectInSurface(root, valueEl);
  if (!info) return null;
  return { rect: info.rect, valueEl };
}

export function getCaretBoundaryRect(
  root: HTMLElement,
  core: Core,
  nodeId: NodeId,
  dir: "up" | "down",
): DOMRect | null {
  const info = getCollapsedCaretRect(root, nodeId);
  if (!info) return null;
  const caretOffset = valueCaretOffset(root, nodeId, true);
  const snap = core.node(nodeId);
  if (caretOffset != null && isPlainValueNode(snap)) {
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
