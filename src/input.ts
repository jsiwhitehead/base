import { bindingByElement } from "./render";
import {
  focusFirstChild,
  focusNextSibling,
  focusParent,
  focusPreviousSibling,
  focusToggleKeyValue,
  insertEmptyNodeAfter,
  insertEmptyNodeBefore,
  removeNodeAtElement,
  itemToEmptyKeyValue,
  wrapNodeInBlock,
  unwrapNodeFromBlock,
} from "./utils";

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

  if (
    e.shiftKey &&
    (e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight")
  ) {
    e.preventDefault();
    if (e.key === "ArrowUp") insertEmptyNodeBefore(active);
    else if (e.key === "ArrowDown") insertEmptyNodeAfter(active);
    else if (e.key === "ArrowLeft") unwrapNodeFromBlock(active);
    else wrapNodeInBlock(active);
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

  if (e.key === "Tab") {
    e.preventDefault();
    if (
      active.classList.contains("key") ||
      active.previousElementSibling?.classList.contains("key")
    ) {
      focusToggleKeyValue(active);
    } else {
      itemToEmptyKeyValue(active);
    }
    queueMicrotask(() => {
      const newBinding = bindingByElement.get(
        document.activeElement as HTMLElement
      );
      if (
        document.activeElement?.classList.contains("key") &&
        newBinding?.setEditing
      ) {
        newBinding.setEditing(true, true);
      }
    });
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    removeNodeAtElement(active);
    return;
  }

  if (!binding) return;

  if (e.key === "Enter") {
    e.preventDefault();
    if (binding.setEditing) binding.setEditing(true);
    return;
  }
}
