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
import { boxByElement } from "./render";

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

function closestElementForBox(
  start: HTMLElement,
  targetBox: Box
): HTMLElement | null {
  let el: HTMLElement | null = start;
  while (el) {
    if (boxByElement.get(el) === targetBox) return el;
    el = el.parentElement;
  }
  return null;
}

function findFocusableForBoxInContainer(
  container: HTMLElement,
  box: Box
): HTMLElement | null {
  if (boxByElement.get(container) === box && container.tabIndex >= 0)
    return container;

  const all = container.querySelectorAll<HTMLElement>("*");

  for (const el of all) {
    if (boxByElement.get(el) === box && el.classList.contains("key")) {
      const maybeMount = el.nextElementSibling as HTMLElement | null;
      if (maybeMount && boxByElement.get(maybeMount) === box) {
        if (maybeMount.tabIndex >= 0) return maybeMount;
        return el;
      }
    }
  }

  for (const el of all) {
    if (boxByElement.get(el) === box && el.tabIndex >= 0) return el;
  }

  for (const el of all) {
    if (boxByElement.get(el) === box) return el;
  }

  return null;
}

function focusBoxInSameRender(
  fromEl: HTMLElement,
  parentBox: Box<BlockNode>,
  targetBox?: Box
) {
  if (!targetBox) return;
  const parentContainer = closestElementForBox(fromEl, parentBox);
  if (!parentContainer) return;
  const toFocus = findFocusableForBoxInContainer(parentContainer, targetBox);
  toFocus?.focus();
}

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
  focusOverride?: (next: Box, ctx: BoxContext) => void
) {
  const box = boxByElement.get(el);
  if (!box) return;

  const ctx = getBoxContext(box);
  if (!ctx) return;

  const next = mutate(box);
  if (!next) return;

  queueMicrotask(() => {
    if (focusOverride) {
      focusOverride(next, ctx);
    } else {
      focusBoxInSameRender(el, ctx.parentBox, next);
    }
  });
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
        withBoxContext(active, ({ all, allIdx, parentBox }) =>
          focusBoxInSameRender(active, parentBox, all[allIdx - 1])
        ),
      ArrowDown: () =>
        withBoxContext(active, ({ all, allIdx, parentBox }) =>
          focusBoxInSameRender(active, parentBox, all[allIdx + 1])
        ),
      ArrowLeft: () =>
        withBoxContext(active, ({ parentBox }) =>
          focusBoxInSameRender(active, parentBox, parentBox)
        ),
      ArrowRight: () => {
        const b = boxByElement.get(active);
        const n = b?.value.peek();
        if (n && isBlock(n)) {
          const first = getChildrenInOrder(n)[0];
          const parentBox = b as Box<BlockNode>;
          focusBoxInSameRender(active, parentBox, first);
        }
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
        (nextBox, ctx) => {
          const parentContainer = closestElementForBox(active, ctx.parentBox);
          if (!parentContainer) return;
          const all = parentContainer.querySelectorAll<HTMLElement>(".key");
          for (const el of all) {
            if (boxByElement.get(el) === nextBox) {
              el.focus();
              return;
            }
          }
          const fallback = findFocusableForBoxInContainer(
            parentContainer,
            nextBox
          );
          fallback?.focus();
        }
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
