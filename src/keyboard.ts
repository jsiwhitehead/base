import { elInfo } from "./code";
import {
  focusFirstChild,
  focusNextSibling,
  focusParent,
  focusPreviousSibling,
  insertEmptyNodeAfter,
  insertEmptyNodeBefore,
  removeNodeAtElement,
  wrapNodeInBlock,
  unwrapNodeFromBlock,
} from "./data";

export function handleRootKeyDown(e: KeyboardEvent, root: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !root.contains(active)) return;

  if (active.tagName === "INPUT") return;

  if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    if (e.key === "ArrowUp") insertEmptyNodeBefore(active);
    else insertEmptyNodeAfter(active);
    return;
  }

  const info = elInfo.get(active);
  if (
    info?.setEditing &&
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    e.preventDefault();
    info.node.value = e.key;
    info.setEditing(true);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    focusPreviousSibling(active);
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusNextSibling(active);
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    focusParent(active);
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    focusFirstChild(active);
    return;
  }

  if (!info) return;

  if (e.key === "Enter") {
    e.preventDefault();
    if (info.setEditing) info.setEditing(true);
    else {
      if (e.shiftKey) insertEmptyNodeBefore(active);
      else insertEmptyNodeAfter(active);
    }
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    removeNodeAtElement(active);
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    if (e.shiftKey) unwrapNodeFromBlock(active);
    else wrapNodeInBlock(active);
    return;
  }
}
