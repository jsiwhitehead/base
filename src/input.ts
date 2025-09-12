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
import { bindingByElement } from "./render";

export function onRootMouseDown(e: MouseEvent) {
  if (e.detail !== 2) return;
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT") return;
  e.preventDefault();
}

export function onRootDblClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target.tagName === "INPUT") return;
  const binding = bindingByElement.get(target);
  if (binding?.setEditing) {
    e.preventDefault();
    e.stopPropagation();
    binding.setEditing(true, true);
  }
}

export function onRootKeyDown(e: KeyboardEvent, root: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !root.contains(active)) return;

  if (active.tagName === "INPUT") return;

  if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    if (e.key === "ArrowUp") insertEmptyNodeBefore(active);
    else insertEmptyNodeAfter(active);
    return;
  }

  const binding = bindingByElement.get(active);
  if (
    binding?.setEditing &&
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey
  ) {
    e.preventDefault();
    binding.node.value = e.key;
    binding.setEditing(true);
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

  if (!binding) return;

  if (e.key === "Enter") {
    e.preventDefault();
    if (binding.setEditing) binding.setEditing(true);
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
