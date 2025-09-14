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

/* Navigation */

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

function runMutationOnElement(
  el: HTMLElement,
  mutate: (box: Box) => Box | undefined
) {
  const binding = bindingByElement.get(el);
  if (!binding) return;

  const next = mutate(binding.box);
  if (next) queueMicrotask(() => mountByBox.get(next)?.element.focus());
}

export function insertEmptyNodeBefore(el: HTMLElement) {
  runMutationOnElement(el, (box) =>
    insertItemBefore(box, makeBox(makeLiteral(""), box.parent!))
  );
}

export function insertEmptyNodeAfter(el: HTMLElement) {
  runMutationOnElement(el, (box) =>
    insertItemAfter(box, makeBox(makeLiteral(""), box.parent!))
  );
}

export function removeNodeAtElement(el: HTMLElement) {
  runMutationOnElement(el, (box) => removeChild(box));
}

export function itemToEmptyKeyValue(el: HTMLElement) {
  runMutationOnElement(el, (box) => itemToKeyValue(box, ""));
}

export function wrapNodeInBlock(el: HTMLElement) {
  runMutationOnElement(el, (box) => wrapChildInShallowBlock(box));
}

export function unwrapNodeFromBlock(el: HTMLElement) {
  runMutationOnElement(el, (box) => unwrapSingleChildBlock(box));
}
