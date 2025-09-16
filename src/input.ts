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
  assignKey,
  removeChild,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
} from "./data";
import { boxByElement } from "./render";

/* Focus Event */

export type FocusDir = "next" | "prev" | "first" | "last";
export type FocusTargetRole = "auto" | "key" | "container";

type FocusRequestNav = { kind: "nav"; dir: FocusDir };
type FocusRequestTo = { kind: "to"; target: Box; role: FocusTargetRole };

export type FocusRequest = FocusRequestNav | FocusRequestTo;

export class FocusRequestEvent extends CustomEvent<FocusRequest> {
  constructor(detail: FocusRequest) {
    super("focusrequest", {
      bubbles: true,
      composed: false,
      detail,
    });
  }
}

export function requestFocusNav(fromEl: HTMLElement, dir: FocusDir) {
  fromEl.dispatchEvent(new FocusRequestEvent({ kind: "nav", dir }));
}

export function requestFocusTo(
  fromEl: HTMLElement,
  target: Box,
  role: FocusTargetRole = "auto"
) {
  fromEl.dispatchEvent(new FocusRequestEvent({ kind: "to", target, role }));
}

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
      requestFocusTo(el, next, "auto");
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
      ArrowRight: () => runMutationOnElement(active, wrapWithBlock),
    };
    shiftHandlers[e.key]?.();
    return;
  }

  if (["ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "ArrowUp") requestFocusNav(active, "prev");
    else requestFocusNav(active, "next");
    return;
  }

  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    const navHandlers: Record<string, () => void> = {
      ArrowLeft: () =>
        withBoxContext(active, ({ parentBox }) => {
          requestFocusTo(active, parentBox, "container");
        }),
      ArrowRight: () => {
        const b = boxByElement.get(active);
        const n = b?.value.peek();
        if (n && isBlock(n)) {
          const first = getChildrenInOrder(n)[0];
          if (first) {
            requestFocusTo(active, first, "auto");
          }
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
        (box) => assignKey(box, ""),
        (nextBox) => {
          requestFocusTo(active, nextBox, "key");
        }
      );
    }

    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    runMutationOnElement(active, removeChild);
    return;
  }
}
