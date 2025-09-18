import { type Box } from "./data";
import { boxByElement } from "./render";

/* Focus Events */

type FocusDir = "next" | "prev" | "into" | "out";
type FocusTargetRole = "auto" | "key";

type FocusCommandNav = { kind: "nav"; dir: FocusDir; from: Box };
type FocusCommandTo = { kind: "to"; targetBox: Box; role: FocusTargetRole };
type FocusCommand = FocusCommandNav | FocusCommandTo;

export class FocusCommandEvent extends CustomEvent<FocusCommand> {
  constructor(detail: FocusCommand) {
    super("focus-command", { bubbles: true, composed: false, detail });
  }
}

function requestFocusCommand(fromEl: HTMLElement, cmd: FocusCommand) {
  fromEl.dispatchEvent(new FocusCommandEvent(cmd));
}

/* String Events */

type StringCommand =
  | { kind: "begin"; seed?: string }
  | { kind: "commit" }
  | { kind: "cancel" };

export class StringCommandEvent extends CustomEvent<StringCommand> {
  constructor(detail: StringCommand) {
    super("string-command", { bubbles: true, composed: false, detail });
  }
}

function requestStringCommand(fromEl: HTMLElement, cmd: StringCommand) {
  fromEl.dispatchEvent(new StringCommandEvent(cmd));
}

/* Block Events */

type BlockCommand =
  | { kind: "insert-before"; target: Box }
  | { kind: "insert-after"; target: Box }
  | { kind: "wrap"; target: Box }
  | { kind: "unwrap"; target: Box }
  | { kind: "remove"; target: Box };

export class BlockCommandEvent extends CustomEvent<BlockCommand> {
  constructor(detail: BlockCommand) {
    super("block-command", { bubbles: true, composed: false, detail });
  }
}

function requestBlockCommand(fromEl: HTMLElement, cmd: BlockCommand) {
  fromEl.dispatchEvent(new BlockCommandEvent(cmd));
}

/* Helpers */

const isCharKey = (e: KeyboardEvent) =>
  e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

const isStringInput = (el: Element | null): el is HTMLInputElement =>
  !!el && el.tagName === "INPUT";

/* Root Handlers */

export function onRootDblClick(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return;

  e.preventDefault();
  e.stopPropagation();

  requestStringCommand(t, { kind: "begin" });
}

export function onRootKeyDown(e: KeyboardEvent) {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return;

  if (isStringInput(active)) {
    switch (e.key) {
      case "Enter":
      case "Tab": {
        e.preventDefault();

        const isKeyInput = active.classList.contains("key");
        const box = boxByElement.get(active);

        if (isKeyInput && box) {
          requestFocusCommand(active, {
            kind: "to",
            targetBox: box,
            role: "auto",
          });
        } else {
          requestStringCommand(active, { kind: "commit" });
        }
        break;
      }
      case "Escape":
        e.preventDefault();
        requestStringCommand(active, { kind: "cancel" });
        break;
    }
    return;
  }

  if (
    e.shiftKey &&
    ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)
  ) {
    e.preventDefault();
    const activeBox = boxByElement.get(active);
    if (!activeBox) return;

    switch (e.key) {
      case "ArrowUp":
        requestBlockCommand(active, {
          kind: "insert-before",
          target: activeBox,
        });
        break;
      case "ArrowDown":
        requestBlockCommand(active, {
          kind: "insert-after",
          target: activeBox,
        });
        break;
      case "ArrowLeft":
        requestBlockCommand(active, { kind: "unwrap", target: activeBox });
        break;
      case "ArrowRight":
        requestBlockCommand(active, { kind: "wrap", target: activeBox });
        break;
    }
    return;
  }

  if (["ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    const activeBox = boxByElement.get(active);
    if (!activeBox) return;
    requestFocusCommand(active, {
      kind: "nav",
      dir: e.key === "ArrowUp" ? "prev" : "next",
      from: activeBox,
    });
    return;
  }

  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    const activeBox = boxByElement.get(active);
    if (!activeBox) return;
    requestFocusCommand(active, {
      kind: "nav",
      dir: e.key === "ArrowLeft" ? "out" : "into",
      from: activeBox,
    });
    return;
  }

  if (e.key === "Tab") {
    e.preventDefault();

    const isKey = active.classList.contains("key");
    if (isKey) {
      const nextEl = active.nextElementSibling as HTMLElement | null;
      nextEl?.focus();
    } else {
      const activeBox = boxByElement.get(active);
      if (activeBox) {
        requestFocusCommand(active, {
          kind: "to",
          targetBox: activeBox,
          role: "key",
        });
      }
    }
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    const activeBox = boxByElement.get(active);
    if (activeBox) {
      requestBlockCommand(active, { kind: "remove", target: activeBox });
    }
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    requestStringCommand(active, { kind: "begin" });
    return;
  }

  if (isCharKey(e)) {
    e.preventDefault();
    requestStringCommand(active, { kind: "begin", seed: e.key });
    return;
  }
}
