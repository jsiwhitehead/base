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
  removeChild,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
} from "./data";
import { boxByElement } from "./render";

/* Focus Event */

type FocusDir = "next" | "prev" | "first" | "last";
type FocusTargetRole = "auto" | "key" | "container";

type FocusRequestNav = { kind: "nav"; dir: FocusDir };
type FocusRequestTo = { kind: "to"; targetBox: Box; role: FocusTargetRole };
type FocusRequest = FocusRequestNav | FocusRequestTo;

export class FocusRequestEvent extends CustomEvent<FocusRequest> {
  constructor(detail: FocusRequest) {
    super("focusrequest", { bubbles: true, composed: false, detail });
  }
}

function requestFocusNav(fromEl: HTMLElement, dir: FocusDir) {
  fromEl.dispatchEvent(new FocusRequestEvent({ kind: "nav", dir }));
}

function requestFocusTo(
  fromEl: HTMLElement,
  targetBox: Box,
  role: FocusTargetRole = "auto"
) {
  fromEl.dispatchEvent(new FocusRequestEvent({ kind: "to", targetBox, role }));
}

/* Edit Event */

type EditCommand =
  | { kind: "begin-edit"; seed?: string }
  | { kind: "commit" }
  | { kind: "cancel" };

export class EditCommandEvent extends CustomEvent<EditCommand> {
  constructor(detail: EditCommand) {
    super("editcommand", { bubbles: true, composed: false, detail });
  }
}

function requestEdit(fromEl: HTMLElement, cmd: EditCommand) {
  fromEl.dispatchEvent(new EditCommandEvent(cmd));
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

const isCharKey = (e: KeyboardEvent) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

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

/* Root Handlers */

export function onRootDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return;

  e.preventDefault();
  e.stopPropagation();

  requestEdit(t, { kind: "begin-edit" });
}

export function onRootKeyDown(e: KeyboardEvent) {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return;

  if (isTextInput(active)) {
    switch (e.key) {
      case "Enter":
      case "Tab": {
        e.preventDefault();

        const isKeyInput = active.classList.contains("key");
        const box = boxByElement.get(active);

        if (isKeyInput && box) {
          requestFocusTo(active, box, "auto");
        } else {
          requestEdit(active, { kind: "commit" });
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        requestEdit(active, { kind: "cancel" });
        break;
    }
    return;
  }

  if (
    e.shiftKey &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();

    switch (e.key) {
      case "ArrowUp":
        runMutationOnElement(active, (box) =>
          insertBefore(box, makeBox(makeLiteral(""), box.parent!))
        );
        break;
      case "ArrowDown":
        runMutationOnElement(active, (box) =>
          insertAfter(box, makeBox(makeLiteral(""), box.parent!))
        );
        break;
      case "ArrowLeft":
        runMutationOnElement(active, unwrapBlockIfSingleChild);
        break;
      case "ArrowRight":
        runMutationOnElement(active, wrapWithBlock);
        break;
    }
    return;
  }

  if (["ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    requestFocusNav(active, e.key === "ArrowUp" ? "prev" : "next");
    return;
  }

  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();

    if (e.key === "ArrowLeft") {
      withBoxContext(active, ({ parentBox }) => {
        requestFocusTo(active, parentBox, "container");
      });
    } else {
      const b = boxByElement.get(active);
      const n = b?.value.peek();

      if (n && isBlock(n)) {
        const first = getChildrenInOrder(n)[0];
        if (first) requestFocusTo(active, first, "auto");
      }
    }
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();

    const isKey = active.classList.contains("key");
    if (isKey) {
      const nextEl = active.nextElementSibling as HTMLElement | null;
      nextEl?.focus();
    } else {
      withBoxContext(active, ({ box }) => {
        requestFocusTo(active, box, "key");
      });
    }
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    runMutationOnElement(active, removeChild);
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    requestEdit(active, { kind: "begin-edit" });
    return;
  }

  if (isCharKey(e)) {
    e.preventDefault();
    requestEdit(active, { kind: "begin-edit", seed: e.key });
    return;
  }
}
