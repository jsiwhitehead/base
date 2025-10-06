import {
  type ChildSignal,
  createSignal,
  createBlank,
  insertBefore,
  insertAfter,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
  removeChild,
  getPreviousSibling,
  getNextSibling,
  getParentChild,
  getFirstChild,
} from "./data";

/* Focus  */

let activeFocus: ChildSignal | null = null;

const elBySig = new WeakMap<ChildSignal, HTMLElement>();

function focusElFor(sig: ChildSignal | null) {
  if (!sig) return;
  const el = elBySig.get(sig);
  if (el) el.focus({ preventScroll: true });
}

export function registerFocusable(sig: ChildSignal, el: HTMLElement) {
  el.tabIndex = 0;
  elBySig.set(sig, el);

  if (activeFocus === sig) {
    focusElFor(sig);
  }

  el.addEventListener("focus", () => {
    if (activeFocus !== sig) {
      activeFocus = sig;
    }
  });
}

export function unregisterFocusable(sig: ChildSignal, el: HTMLElement) {
  if (elBySig.get(sig) === el) elBySig.delete(sig);
}

export function focusNode(sig: ChildSignal | null) {
  const changed = activeFocus !== sig;
  activeFocus = sig;
  if (!changed || sig) {
    focusElFor(sig);
  }
}

/* Keyboard */

export function onRootKeyDown(e: KeyboardEvent) {
  const activeEl = document.activeElement as HTMLElement | null;
  if (!activeEl || activeEl.tagName === "INPUT") return;

  if (!activeFocus) return;

  if (e.shiftKey) {
    switch (e.key) {
      case "ArrowUp": {
        e.preventDefault();
        const newItem = createSignal(createBlank());
        const next = insertBefore(activeFocus, newItem);
        focusNode(next);
        return;
      }
      case "ArrowDown": {
        e.preventDefault();
        const newItem = createSignal(createBlank());
        const next = insertAfter(activeFocus, newItem);
        focusNode(next);
        return;
      }
      case "ArrowLeft": {
        e.preventDefault();
        const next = unwrapBlockIfSingleChild(activeFocus);
        focusNode(next);
        return;
      }
      case "ArrowRight": {
        e.preventDefault();
        const next = wrapWithBlock(activeFocus);
        focusNode(next);
        return;
      }
    }
    return;
  }

  switch (e.key) {
    case "ArrowUp": {
      e.preventDefault();
      const n = getPreviousSibling(activeFocus);
      if (n) focusNode(n);
      return;
    }
    case "ArrowDown": {
      e.preventDefault();
      const n = getNextSibling(activeFocus);
      if (n) focusNode(n);
      return;
    }
    case "ArrowLeft": {
      e.preventDefault();
      const n = getParentChild(activeFocus);
      if (n) focusNode(n);
      return;
    }
    case "ArrowRight": {
      e.preventDefault();
      const n = getFirstChild(activeFocus);
      if (n) focusNode(n);
      return;
    }
    case "Backspace": {
      e.preventDefault();
      const next = removeChild(activeFocus);
      focusNode(next);
      return;
    }
  }
}
