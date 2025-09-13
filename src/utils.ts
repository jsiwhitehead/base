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

const focusBox = (box?: Box) => {
  if (box) mountByBox.get(box)?.element.focus();
};

/* Navigation */

export function focusPreviousSibling(el: HTMLElement) {
  withBoxCtx(el, ({ all, allIdx }) => focusBox(all[allIdx - 1]));
}

export function focusNextSibling(el: HTMLElement) {
  withBoxCtx(el, ({ all, allIdx }) => focusBox(all[allIdx + 1]));
}

export function focusParent(el: HTMLElement) {
  withBoxCtx(el, ({ parentBox }) => focusBox(parentBox));
}

export function focusFirstChild(el: HTMLElement) {
  const binding = bindingByElement.get(el);
  if (!binding) return;

  const n = binding.box.value.peek();
  if (!isBlock(n)) return;

  const first = orderedChildren(n)[0];
  if (first) focusBox(first);
}

export function focusToggleKeyValue(el: Element) {
  if (el.classList.contains("key")) {
    (el.nextElementSibling as HTMLElement | null)?.focus();
  } else if (
    el.classList.contains("value") &&
    el.previousElementSibling?.classList.contains("key")
  ) {
    (el.previousElementSibling as HTMLElement | null)?.focus();
  }
}

/* Mutations */

export function insertEmptyNodeBefore(el: HTMLElement) {
  withBoxCtx(el, ({ box, parentBox }) => {
    const newItem = makeBox(makeLiteral(""), parentBox);
    insertItemBefore(box, newItem);
    queueMicrotask(() => focusBox(newItem));
  });
}

export function insertEmptyNodeAfter(el: HTMLElement) {
  withBoxCtx(el, ({ box, parentBox }) => {
    const newItem = makeBox(makeLiteral(""), parentBox);
    insertItemAfter(box, newItem);
    queueMicrotask(() => focusBox(newItem));
  });
}

export function removeNodeAtElement(el: HTMLElement) {
  withBoxCtx(el, ({ box, parentBox, all, allIdx }) => {
    const focusTarget = all[allIdx - 1] ?? all[allIdx + 1] ?? parentBox;
    removeChild(box);
    queueMicrotask(() => focusBox(focusTarget));
  });
}

export function itemToEmptyKeyValue(el: HTMLElement) {
  withBoxCtx(el, ({ box, itemIdx }) => {
    if (itemIdx < 0) return;
    itemToKeyValue(box, "");
    queueMicrotask(() => {
      (
        mountByBox.get(box)?.element.previousElementSibling as HTMLElement
      ).focus();
    });
  });
}

export function wrapNodeInBlock(el: HTMLElement) {
  withBoxCtx(el, ({ box }) => {
    wrapChildInShallowBlock(box);
    queueMicrotask(() => focusBox(box));
  });
}

export function unwrapNodeFromBlock(el: HTMLElement) {
  const binding = bindingByElement.get(el);
  if (!binding) return;

  const wrapper = binding.box as BlockBox;
  const n = wrapper.value.peek();
  if (!isBlock(n)) return;

  const children = orderedChildren(n);
  if (children.length !== 1) return;

  const onlyChild = children[0]!;
  unwrapSingleChildBlock(wrapper);
  queueMicrotask(() => focusBox(onlyChild));
}
