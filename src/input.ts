import {
  type BlockNode,
  type Box,
  isBlock,
  makeLiteral,
  makeBox,
  getChildrenInOrder,
  getChildKey,
  insertBefore,
  insertAfter,
  deleteChild,
  convertItemToKeyValue,
  wrapInBlock,
  unwrapBlockIfSingleChild,
} from "./data";
import { mountByBox, boxByElement } from "./render";

/* Helpers */

type BoxContext = {
  box: Box;
  parentBox: Box<BlockNode>;
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
  const all = getChildrenInOrder(block);
  const allIdx = all.indexOf(box);
  if (allIdx < 0) return null;

  const itemIdx = block.items.indexOf(box);
  const valueKey = getChildKey(box);

  return { box, parentBox: box.parent, all, allIdx, itemIdx, valueKey };
}

function withBoxContext(el: HTMLElement, fn: (ctx: BoxContext) => void) {
  const ctx = getBoxContext(boxByElement.get(el));
  if (ctx) fn(ctx);
}

function runMutationOnElement(
  el: HTMLElement,
  mutate: (box: Box) => Box | undefined,
  focusOverride?: (next: Box) => void
) {
  const box = boxByElement.get(el);
  if (!box) return;
  const next = mutate(box);
  if (next) {
    queueMicrotask(() => {
      if (focusOverride) focusOverride(next);
      else focusBox(next);
    });
  }
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
          insertBefore(box, makeBox(makeLiteral(""), box.parent!))
        ),
      ArrowDown: () =>
        runMutationOnElement(active, (box) =>
          insertAfter(box, makeBox(makeLiteral(""), box.parent!))
        ),
      ArrowLeft: () => runMutationOnElement(active, unwrapBlockIfSingleChild),
      ArrowRight: () => runMutationOnElement(active, wrapInBlock),
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
        if (n && isBlock(n)) focusBox(getChildrenInOrder(n)[0]);
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
      runMutationOnElement(
        active,
        (box) => convertItemToKeyValue(box, ""),
        (nextBox) =>
          (
            mountByBox.get(nextBox)!.element
              .previousElementSibling as HTMLElement
          ).focus()
      );
    }

    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    runMutationOnElement(active, deleteChild);
    return;
  }
}
