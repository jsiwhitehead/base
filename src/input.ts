import {
  type Box,
  type BlockBox,
  type BlockNode,
  isBlock,
  makeLiteral,
  makeBox,
  orderedChildren,
  keyOfChild,
  insertItemBefore,
  insertItemAfter,
  removeChild,
  itemToKeyValue,
  wrapChildInShallowBlock,
  unwrapSingleChildBlock,
} from "./data";

import { mountByBox, bindingByElement } from "./render";

/* Helpers */

type BoxContext = {
  box: Box;
  parentBox: BlockBox;
  all: Box[];
  allIdx: number;
  itemIdx: number;
  valueKey: string | undefined;
};

function getBoxContext(box?: Box): BoxContext | null {
  if (!box) return null;
  const parentBox = box.parent;
  if (!parentBox) return null;

  const block = parentBox.value.peek() as BlockNode;
  const all = orderedChildren(block);
  const allIdx = all.indexOf(box);
  if (allIdx < 0) return null;

  const itemIdx = block.items.indexOf(box);
  const valueKey = keyOfChild(box);

  return { box, parentBox, all, allIdx, itemIdx, valueKey };
}

function withBoxCtx(el: HTMLElement, fn: (ctx: BoxContext) => void) {
  const binding = bindingByElement.get(el);
  if (!binding) return;
  const ctx = getBoxContext(binding.box);
  if (ctx) fn(ctx);
}

function runMutationOnElement(
  el: HTMLElement,
  mutate: (box: Box) => Box | undefined
) {
  const binding = bindingByElement.get(el);
  if (!binding) return;

  const next = mutate(binding.box);
  if (next) queueMicrotask(() => mountByBox.get(next)?.element.focus());
}

/* Handlers */

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
    if (e.key === "ArrowUp") {
      runMutationOnElement(active, (box) =>
        insertItemBefore(box, makeBox(makeLiteral(""), box.parent!))
      );
    } else if (e.key === "ArrowDown") {
      runMutationOnElement(active, (box) =>
        insertItemAfter(box, makeBox(makeLiteral(""), box.parent!))
      );
    } else if (e.key === "ArrowLeft") {
      runMutationOnElement(active, (box) => unwrapSingleChildBlock(box));
    } else {
      runMutationOnElement(active, (box) => wrapChildInShallowBlock(box));
    }
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
    binding.box.value.value = makeLiteral(e.key);
    binding.setEditing(true);
    return;
  }

  if (e.key === "ArrowUp") {
    e.preventDefault();
    withBoxCtx(active, ({ all, allIdx }) => {
      const prev = all[allIdx - 1];
      if (prev) mountByBox.get(prev)?.element.focus();
    });
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    withBoxCtx(active, ({ all, allIdx }) => {
      const next = all[allIdx + 1];
      if (next) mountByBox.get(next)?.element.focus();
    });
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    withBoxCtx(active, ({ parentBox }) => {
      mountByBox.get(parentBox)?.element.focus();
    });
    return;
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    const b = bindingByElement.get(active);
    if (b) {
      const n = b.box.value.peek();
      if (isBlock(n)) {
        const first = orderedChildren(n)[0];
        if (first) mountByBox.get(first)?.element.focus();
      }
    }
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();
    if (
      active.classList.contains("key") ||
      active.previousElementSibling?.classList.contains("key")
    ) {
      if (active.classList.contains("key")) {
        (active.nextElementSibling as HTMLElement | null)?.focus();
      } else if (
        active.classList.contains("value") &&
        active.previousElementSibling?.classList.contains("key")
      ) {
        (active.previousElementSibling as HTMLElement | null)?.focus();
      }
    } else {
      runMutationOnElement(active, (box) => itemToKeyValue(box, ""));
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
    runMutationOnElement(active, (box) => removeChild(box));
    return;
  }

  if (!binding) return;

  if (e.key === "Enter") {
    e.preventDefault();
    if (binding.setEditing) binding.setEditing(true);
    return;
  }
}
