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
import { mountByBox, boxByElement } from "./render";

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

const focusBox = (box?: Box) => box && mountByBox.get(box)?.focus();

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
  const ctx = getBoxContext(boxByElement.get(el));
  if (ctx) fn(ctx);
}

function runMutationOnElement(
  el: HTMLElement,
  mutate: (box: Box) => Box | undefined
) {
  const box = boxByElement.get(el);
  if (!box) return;
  const next = mutate(box);
  if (next) queueMicrotask(() => focusBox(next));
}

/* Handlers */

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
        const b = boxByElement.get(active);
        const n = b?.value.peek();
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

    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    runMutationOnElement(active, removeChild);
    return;
  }
}
