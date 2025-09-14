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

const isTextInput = (el: Element | null): el is HTMLInputElement =>
  !!el && el.tagName === "INPUT";

const isTypingChar = (e: KeyboardEvent) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

const focusBox = (box?: Box) => box && mountByBox.get(box)?.element.focus();

function getBoxContext(box?: Box): BoxContext | null {
  if (!box?.parent) return null;

  const block = box.parent.value.peek() as BlockNode;
  const all = orderedChildren(block);
  const allIdx = all.indexOf(box);
  if (allIdx < 0) return null;

  const itemIdx = block.items.indexOf(box);
  const valueKey = keyOfChild(box);

  return { box, parentBox: box.parent, all, allIdx, itemIdx, valueKey };
}

function withBoxContext(el: HTMLElement, fn: (ctx: BoxContext) => void) {
  const binding = bindingByElement.get(el);
  const ctx = getBoxContext(binding?.box);
  if (ctx) fn(ctx);
}

function runMutationOnElement(
  el: HTMLElement,
  mutate: (box: Box) => Box | undefined
) {
  const binding = bindingByElement.get(el);
  if (!binding) return;
  const next = mutate(binding.box);
  if (next) queueMicrotask(() => focusBox(next));
}

/* Handlers */

export function onRootMouseDown(e: MouseEvent) {
  if (e.detail === 2 && !isTextInput(e.target as HTMLElement)) {
    e.preventDefault();
  }
}

export function onRootDblClick(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (isTextInput(target)) return;

  const binding = bindingByElement.get(target);
  if (!binding?.setEditing) return;

  e.preventDefault();
  e.stopPropagation();
  binding.setEditing(true, true);
}

export function onRootKeyDown(e: KeyboardEvent, root: HTMLElement) {
  const active = document.activeElement as HTMLElement | null;
  if (!active || !root.contains(active) || isTextInput(active)) return;

  if (
    e.shiftKey &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();
    const shiftHandlers: Record<string, () => void> = {
      ArrowUp: () =>
        runMutationOnElement(active, (box) =>
          insertItemBefore(box, makeBox(makeLiteral(""), box.parent!))
        ),
      ArrowDown: () =>
        runMutationOnElement(active, (box) =>
          insertItemAfter(box, makeBox(makeLiteral(""), box.parent!))
        ),
      ArrowLeft: () => runMutationOnElement(active, unwrapSingleChildBlock),
      ArrowRight: () => runMutationOnElement(active, wrapChildInShallowBlock),
    };
    shiftHandlers[e.key]?.();
    return;
  }

  const binding = bindingByElement.get(active);

  if (binding?.setEditing && isTypingChar(e)) {
    e.preventDefault();
    binding.box.value.value = makeLiteral(e.key);
    binding.setEditing(true);
    return;
  }

  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    const navHandlers: Record<string, () => void> = {
      ArrowUp: () =>
        withBoxContext(active, ({ all, allIdx }) => focusBox(all[allIdx - 1])),
      ArrowDown: () =>
        withBoxContext(active, ({ all, allIdx }) => focusBox(all[allIdx + 1])),
      ArrowLeft: () =>
        withBoxContext(active, ({ parentBox }) => focusBox(parentBox)),
      ArrowRight: () => {
        const b = bindingByElement.get(active);
        const n = b?.box.value.peek();
        if (n && isBlock(n)) focusBox(orderedChildren(n)[0]);
      },
    };
    navHandlers[e.key]?.();
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();

    const isKey = active.classList.contains("key");
    const prevIsKey = active.previousElementSibling?.classList.contains("key");

    if (isKey || prevIsKey) {
      const nextEl = isKey
        ? (active.nextElementSibling as HTMLElement | null)
        : (active.previousElementSibling as HTMLElement | null);
      nextEl?.focus();
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
    runMutationOnElement(active, removeChild);
    return;
  }

  if (e.key === "Enter" && binding?.setEditing) {
    e.preventDefault();
    binding.setEditing(true);
  }
}
