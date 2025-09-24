import { type Signal } from "./data";
import { signalByElement } from "./render";

/* Focus Events */

type FocusDir = "next" | "prev" | "into" | "out";
type FocusTargetRole = "auto" | "key";

type FocusCommandNav = { kind: "nav"; dir: FocusDir; from: Signal };
type FocusCommandTo = {
  kind: "to";
  targetSignal: Signal;
  role: FocusTargetRole;
};
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
  | { kind: "insert-before"; target: Signal }
  | { kind: "insert-after"; target: Signal }
  | { kind: "wrap"; target: Signal }
  | { kind: "unwrap"; target: Signal }
  | { kind: "remove"; target: Signal };

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
        const sig = signalByElement.get(active);

        if (isKeyInput && sig) {
          requestFocusCommand(active, {
            kind: "to",
            targetSignal: sig,
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
    const activeSig = signalByElement.get(active);
    if (!activeSig) return;

    switch (e.key) {
      case "ArrowUp":
        requestBlockCommand(active, {
          kind: "insert-before",
          target: activeSig,
        });
        break;
      case "ArrowDown":
        requestBlockCommand(active, {
          kind: "insert-after",
          target: activeSig,
        });
        break;
      case "ArrowLeft":
        requestBlockCommand(active, { kind: "unwrap", target: activeSig });
        break;
      case "ArrowRight":
        requestBlockCommand(active, { kind: "wrap", target: activeSig });
        break;
    }
    return;
  }

  if (["ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    const activeSig = signalByElement.get(active);
    if (!activeSig) return;
    requestFocusCommand(active, {
      kind: "nav",
      dir: e.key === "ArrowUp" ? "prev" : "next",
      from: activeSig,
    });
    return;
  }

  if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
    e.preventDefault();
    const activeSig = signalByElement.get(active);
    if (!activeSig) return;
    requestFocusCommand(active, {
      kind: "nav",
      dir: e.key === "ArrowLeft" ? "out" : "into",
      from: activeSig,
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
      const activeSig = signalByElement.get(active);
      if (activeSig) {
        requestFocusCommand(active, {
          kind: "to",
          targetSignal: activeSig,
          role: "key",
        });
      }
    }
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    const activeSig = signalByElement.get(active);
    if (activeSig) {
      requestBlockCommand(active, { kind: "remove", target: activeSig });
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
