import {
  type NodePath,
  parentPath,
  siblingPath,
  firstChildPath,
  insertBefore,
  insertAfter,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
  removeChild,
} from "./tree";

/* Focus */

let activePath: NodePath | null = null;

const elByPath = new Map<string, HTMLElement>();
const pathToKey = (p: NodePath) => p.join(">");

function focusElForPath(path: NodePath | null) {
  if (!path) return;
  const el = elByPath.get(pathToKey(path));
  if (el) el.focus({ preventScroll: true });
}

export function registerFocusable(path: NodePath, el: HTMLElement) {
  el.tabIndex = 0;
  const k = pathToKey(path);
  elByPath.set(k, el);

  if (activePath && pathToKey(activePath) === k) {
    focusElForPath(path);
  }

  el.addEventListener("focus", () => {
    if (!activePath || pathToKey(activePath) !== k) {
      activePath = path.slice();
    }
  });
}

export function unregisterFocusable(path: NodePath) {
  elByPath.delete(pathToKey(path));
}

export function focusPath(path: NodePath | null) {
  if (!path) return;
  const nextKey = pathToKey(path);
  const prevKey = activePath ? pathToKey(activePath) : "";
  if (prevKey === nextKey) return;

  activePath = path.slice();
  focusElForPath(path);
}

/* Keyboard */

export function onRootKeyDown(e: KeyboardEvent) {
  const activeEl = document.activeElement as HTMLElement | null;
  if (!activeEl || activeEl.tagName === "INPUT") return;

  if (!activePath) return;

  if (e.shiftKey) {
    switch (e.key) {
      case "ArrowUp": {
        e.preventDefault();
        focusPath(insertBefore(activePath));
        return;
      }
      case "ArrowDown": {
        e.preventDefault();
        focusPath(insertAfter(activePath));
        return;
      }
      case "ArrowLeft": {
        e.preventDefault();
        focusPath(unwrapBlockIfSingleChild(activePath));
        return;
      }
      case "ArrowRight": {
        e.preventDefault();
        focusPath(wrapWithBlock(activePath));
        return;
      }
    }
    return;
  }

  if (e.key === "Backspace") {
    e.preventDefault();
    focusPath(removeChild(activePath));
    return;
  }

  switch (e.key) {
    case "ArrowUp": {
      e.preventDefault();
      focusPath(siblingPath(activePath, -1));
      return;
    }
    case "ArrowDown": {
      e.preventDefault();
      focusPath(siblingPath(activePath, 1));
      return;
    }
    case "ArrowLeft": {
      e.preventDefault();
      focusPath(parentPath(activePath));
      return;
    }
    case "ArrowRight": {
      e.preventDefault();
      focusPath(firstChildPath(activePath));
      return;
    }
  }
}
