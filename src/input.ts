import { signal } from "@preact/signals-core";

import {
  type CellPath,
  firstChildPath,
  getNavContext,
  navigatePath,
  setText,
  toggleTextCode,
  setName,
  insertBefore,
  insertAfter,
  wrapWithList,
  unwrapIfSingleChild,
  removeCell,
  splitCell,
  mergeBackward,
  mergeForward,
  setLinkFilter,
  setTemplateParam,
} from "./tree";

export type FocusRole = "name" | "value" | "filter";
export type FocusState =
  | { kind: "idle" }
  | { kind: "focused"; path: CellPath; role: FocusRole };

export const focusSignal = signal<FocusState>({ kind: "idle" });

export type Role = "name" | "value" | "filter";

type Anchor = "top" | "bottom";

type MachineState =
  | { kind: "Idle"; goalColumn?: number }
  | { kind: "Focused"; path: CellPath; role: Role; goalColumn?: number };

type EditorEvent =
  | { type: "FOCUS"; path: CellPath; role: Role; caret?: number }
  | { type: "CLEAR_FOCUS" }
  | {
      type: "MOVE";
      dir: "up" | "down" | "left" | "right";
      mod: boolean;
      caret?: number;
    }
  | { type: "SPLIT"; caret: number; selEnd?: number }
  | { type: "TRANSFORM"; op: keyof typeof TRANSFORMS; caret?: number }
  | { type: "CLEAR_GOAL_COLUMN" };

const TRANSFORMS = {
  insertBefore,
  insertAfter,
  wrapWithList,
  unwrapIfSingleChild,
  toggleTextCode,
  removeCell,
  mergeBackward,
  mergeForward,
};

type PathBinding = {
  path: CellPath;
  cell: HTMLElement;
  value: HTMLElement;
  name: HTMLInputElement | HTMLTextAreaElement;
  filter?: HTMLInputElement | HTMLTextAreaElement;
  param?: HTMLInputElement | HTMLTextAreaElement;
  teardowns: (() => void)[];
};

const bindings = new Map<string, PathBinding>();
let state: MachineState = { kind: "Idle", goalColumn: undefined };

function keyOf(p: CellPath) {
  return p.join(".");
}

function stop(e: KeyboardEvent | MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
}

function on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
  el: T,
  type: K,
  handler: (e: HTMLElementEventMap[K]) => void
) {
  el.addEventListener(type, handler);
  return () => el.removeEventListener(type, handler);
}

function isTextInput(
  el: HTMLElement
): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (el instanceof HTMLInputElement && el.type === "text") ||
    el instanceof HTMLTextAreaElement
  );
}

function bindEditor(
  binding: PathBinding,
  path: CellPath,
  el: HTMLInputElement | HTMLTextAreaElement,
  mode: "normal" | "eval" | "filter",
  commit: (text: string) => void
) {
  if (mode === "normal") {
    binding.teardowns.push(on(el, "input", () => commit(el.value)));
  }

  binding.teardowns.push(
    on(el, "blur", () => {
      if (isTextInput(el)) el.setSelectionRange(0, 0);
      queueMicrotask(() => commit(el.value));
    })
  );

  binding.teardowns.push(
    on(el, "keydown", (e: KeyboardEvent) => {
      const modKey = e.metaKey || e.ctrlKey;
      const len = el.value.length;
      const selStart = el.selectionStart ?? 0;
      const selEnd = el.selectionEnd ?? selStart;
      const hasSelection = selStart !== selEnd;

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const atStart = selStart === 0 && selEnd === 0;
          const atEnd = selStart === len && selEnd === len;

          if (modKey) {
            stop(e);
            commit(el.value);
            dispatch({
              type: "MOVE",
              dir: dir === -1 ? "left" : "right",
              mod: true,
              caret: selStart,
            });
            break;
          }

          if ((dir === -1 && atStart) || (dir === 1 && atEnd)) {
            stop(e);
            commit(el.value);
            dispatch({
              type: "MOVE",
              dir: dir === -1 ? "left" : "right",
              mod: false,
            });
            break;
          }

          dispatch({ type: "CLEAR_GOAL_COLUMN" });
          break;
        }

        case "ArrowUp":
        case "ArrowDown": {
          const dir = e.key === "ArrowUp" ? -1 : 1;
          const text = el.value;
          const pos = selStart;

          const lineStart = text.lastIndexOf("\n", pos - 1);
          const lineEnd = text.indexOf("\n", pos);

          const structuralMove =
            modKey ||
            (dir === -1 && lineStart === -1) ||
            (dir === 1 && lineEnd === -1);

          if (!structuralMove) {
            dispatch({ type: "CLEAR_GOAL_COLUMN" });
            break;
          }

          stop(e);
          commit(text);

          dispatch({
            type: "MOVE",
            dir: dir === -1 ? "up" : "down",
            mod: modKey,
            caret: pos - (lineStart + 1),
          });
          break;
        }

        case "Enter": {
          if (modKey) {
            stop(e);
            commit(el.value);
            dispatch({ type: "FOCUS", path, role: "name" });
            break;
          }

          if (e.shiftKey) {
            commit(el.value);
            break;
          }

          if (mode === "normal") {
            stop(e);
            dispatch({ type: "SPLIT", caret: selStart, selEnd });
            break;
          }

          if (mode === "filter") {
            stop(e);
            commit(el.value);
            dispatch({ type: "FOCUS", path, role: "filter", caret: selStart });
            break;
          }

          stop(e);
          commit(el.value);
          break;
        }

        case "Backspace": {
          if (mode === "eval") {
            if (!el.value.trim()) {
              stop(e);
              dispatch({ type: "TRANSFORM", op: "toggleTextCode" });
              break;
            }
            e.stopPropagation();
            break;
          }

          if (mode === "normal") {
            if (hasSelection || selStart !== 0 || selEnd !== 0) break;
            stop(e);
            dispatch({ type: "TRANSFORM", op: "mergeBackward" });
            break;
          }

          break;
        }

        case "Delete": {
          if (mode !== "normal") break;
          if (hasSelection || selStart !== len || selEnd !== len) break;
          stop(e);
          dispatch({ type: "TRANSFORM", op: "mergeForward" });
          break;
        }

        case "=": {
          if (mode !== "normal") break;
          if (el.value) break;
          stop(e);
          dispatch({ type: "TRANSFORM", op: "toggleTextCode" });
          break;
        }

        case "Tab": {
          stop(e);
          dispatch({
            type: "TRANSFORM",
            op: e.shiftKey ? "unwrapIfSingleChild" : "wrapWithList",
            caret: selStart,
          });
          break;
        }
      }
    })
  );
}

export function dispatch(ev: EditorEvent): void {
  const prev = state;
  let caretPos: number | undefined;
  let anchor: Anchor | undefined;

  switch (ev.type) {
    case "FOCUS": {
      const keepGoal = prev.kind === "Focused" ? prev.goalColumn : undefined;
      state = {
        kind: "Focused",
        path: ev.path,
        role: ev.role,
        goalColumn: keepGoal,
      };
      caretPos = ev.caret;
      break;
    }

    case "CLEAR_FOCUS": {
      state = { kind: "Idle", goalColumn: undefined };
      break;
    }

    case "MOVE": {
      if (state.kind !== "Focused") break;

      const { dir, mod } = ev;
      const nextPath = navigatePath(state.path, dir, mod);
      if (!nextPath) break;

      let goalColumn = state.goalColumn;

      if (dir === "left" || dir === "right") {
        const caret = ev.caret ?? goalColumn ?? 0;
        goalColumn = mod ? caret : undefined;
        caretPos = mod ? caret : dir === "left" ? Infinity : 0;
      } else {
        goalColumn = goalColumn ?? ev.caret ?? 0;
        anchor = dir === "up" ? "bottom" : "top";
      }

      state = {
        kind: "Focused",
        path: nextPath,
        role: "value",
        goalColumn,
      };

      break;
    }

    case "SPLIT": {
      if (state.kind !== "Focused") break;
      const np = splitCell(state.path, ev.caret, ev.selEnd ?? ev.caret);
      state = {
        kind: "Focused",
        path: np,
        role: "value",
        goalColumn: undefined,
      };
      caretPos = 0;
      break;
    }

    case "TRANSFORM": {
      if (state.kind !== "Focused") break;
      const res = TRANSFORMS[ev.op]?.(state.path);
      if (res) {
        state = {
          kind: "Focused",
          path: res.path,
          role: "value",
          goalColumn: undefined,
        };
        caretPos = res.caret ?? ev.caret;
      }
      break;
    }

    case "CLEAR_GOAL_COLUMN": {
      if (state.kind === "Focused" && state.goalColumn !== undefined) {
        state = { ...state, goalColumn: undefined };
      }
      break;
    }
  }

  publishFocus(state);
  updateDOMFocus(state, caretPos, anchor);
}

function publishFocus(next: MachineState) {
  focusSignal.value =
    next.kind === "Focused"
      ? { kind: "focused", path: next.path, role: next.role }
      : { kind: "idle" };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function computeAnchoredPos(
  text: string,
  column: number,
  anchor: Anchor
): number {
  const nl = anchor === "top" ? text.indexOf("\n") : text.lastIndexOf("\n");
  if (nl === -1) {
    return clamp(column, 0, text.length);
  }
  const lineStart = anchor === "top" ? 0 : nl + 1;
  const lineLen = text.length - lineStart;
  return lineStart + clamp(column, 0, lineLen);
}

function updateDOMFocus(
  next: MachineState,
  caretPos?: number,
  anchor?: Anchor
) {
  if (next.kind !== "Focused") return;

  const binding = bindings.get(keyOf(next.path));
  const targetEl =
    next.role === "name"
      ? binding?.name
      : next.role === "filter"
      ? binding?.filter
      : binding?.value;

  if (!binding || !targetEl) return;

  const wasFocused = document.activeElement === targetEl;
  if (!wasFocused) targetEl.focus({ preventScroll: true });

  if (!isTextInput(targetEl)) return;

  let pos: number | null = null;

  if (caretPos !== undefined) {
    pos = clamp(caretPos, 0, targetEl.value.length);
  } else if (!wasFocused && next.goalColumn !== undefined && anchor) {
    pos = computeAnchoredPos(targetEl.value, next.goalColumn, anchor);
  } else if (!wasFocused) {
    pos = targetEl.value.length;
  }

  if (pos != null) {
    targetEl.setSelectionRange(pos, pos);
  }
}

export function registerBinding(
  path: CellPath,
  slots: {
    cell: HTMLElement;
    value: HTMLElement;
    name: HTMLInputElement | HTMLTextAreaElement;
    filter?: HTMLInputElement | HTMLTextAreaElement;
    param?: HTMLInputElement | HTMLTextAreaElement;
  }
) {
  const k = keyOf(path);
  const prior = bindings.get(k);

  if (
    prior &&
    prior.cell === slots.cell &&
    prior.value === slots.value &&
    prior.name === slots.name &&
    prior.filter === slots.filter &&
    prior.param === slots.param
  ) {
    updateDOMFocus(state);
    return;
  }

  if (prior) {
    for (const fn of prior.teardowns) fn();
    bindings.delete(k);
  }

  const binding: PathBinding = {
    path: path.slice(),
    cell: slots.cell,
    value: slots.value,
    name: slots.name,
    filter: slots.filter,
    param: slots.param,
    teardowns: [],
  };
  bindings.set(k, binding);

  binding.value.tabIndex = 0;

  const nameEl = binding.name;
  const valueEl = binding.value;
  const cellEl = binding.cell;
  const filterEl = binding.filter;
  const paramEl = binding.param;

  binding.teardowns.push(
    on(nameEl, "mousedown", (e) => {
      dispatch({ type: "FOCUS", path, role: "name" });
      e.stopPropagation();
    })
  );

  binding.teardowns.push(on(valueEl, "mousedown", (e) => e.stopPropagation()));

  binding.teardowns.push(
    on(cellEl, "mousedown", (e) => {
      dispatch({ type: "FOCUS", path, role: "value" });
      stop(e);
    })
  );

  binding.teardowns.push(
    on(nameEl, "keydown", (e: KeyboardEvent) => {
      if (e.key === " ") {
        e.preventDefault();
        return;
      }

      if (e.key === "Backspace") {
        e.stopPropagation();
        return;
      }

      switch (e.key) {
        case "Enter": {
          stop(e);
          setName(path, nameEl.value);
          dispatch({ type: "FOCUS", path, role: "value" });
          break;
        }

        case "Escape":
        case "Tab": {
          stop(e);
          dispatch({ type: "FOCUS", path, role: "value" });
          break;
        }
      }
    })
  );

  binding.teardowns.push(
    on(nameEl, "blur", () => {
      setName(path, nameEl.value);
    })
  );

  binding.teardowns.push(
    on(valueEl, "mousedown", (e: MouseEvent) => {
      dispatch({ type: "FOCUS", path, role: "value" });
      if (isTextInput(valueEl)) {
        e.stopPropagation();
        return;
      }
    })
  );

  if (isTextInput(valueEl)) {
    const kindNow = getNavContext(path).kind;
    bindEditor(
      binding,
      path,
      valueEl,
      kindNow === "flow" || kindNow === "link" ? "eval" : "normal",
      (text) => setText(path, text)
    );
  }

  if (filterEl) {
    binding.teardowns.push(
      on(filterEl, "mousedown", (e: MouseEvent) => {
        dispatch({ type: "FOCUS", path, role: "filter" });
        e.stopPropagation();
      })
    );

    bindEditor(binding, path, filterEl, "filter", (text) =>
      setLinkFilter(path, text)
    );
  }

  if (paramEl) {
    binding.teardowns.push(
      on(paramEl, "mousedown", (e: MouseEvent) => {
        e.stopPropagation();
      })
    );

    bindEditor(binding, path, paramEl, "eval", (text) =>
      setTemplateParam(path, text)
    );
  }

  updateDOMFocus(state);
}

export function unregisterBinding(path: CellPath) {
  const k = keyOf(path);
  const binding = bindings.get(k);
  if (binding) {
    for (const fn of binding.teardowns) fn();
    bindings.delete(k);
  }
  if (state.kind === "Focused" && keyOf(state.path) === k) {
    dispatch({ type: "CLEAR_FOCUS" });
  }
}

export function onRootKeyDown(e: KeyboardEvent) {
  if (state.kind !== "Focused") return;

  const { kind } = getNavContext(state.path);
  if (!kind || kind === "text" || kind === "flow" || kind === "link") return;

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      stop(e);
      const mod = e.metaKey || e.ctrlKey;
      const dir = e.key === "ArrowLeft" ? "left" : "right";
      dispatch({ type: "MOVE", dir, mod });
      break;
    }

    case "ArrowUp":
    case "ArrowDown": {
      stop(e);
      const mod = e.metaKey || e.ctrlKey;
      const dir = e.key === "ArrowUp" ? "up" : "down";
      dispatch({ type: "MOVE", dir, mod });
      break;
    }

    case "Enter": {
      stop(e);

      const mod = e.metaKey || e.ctrlKey;

      if (mod) {
        dispatch({ type: "FOCUS", path: state.path, role: "name" });
        break;
      }

      const res = e.shiftKey
        ? insertBefore(state.path)
        : insertAfter(state.path);
      if (res) {
        dispatch({ type: "FOCUS", path: res.path, role: "value" });
      }
      break;
    }

    case "Backspace": {
      if (kind === "list") {
        stop(e);
        dispatch({ type: "TRANSFORM", op: "removeCell" });
      }
      break;
    }

    case "Tab": {
      stop(e);
      dispatch({
        type: "TRANSFORM",
        op: e.shiftKey ? "unwrapIfSingleChild" : "wrapWithList",
      });
      break;
    }
  }
}

export function focusFirstRootCell(): void {
  const p = firstChildPath([]);
  dispatch(
    p ? { type: "FOCUS", path: p, role: "value" } : { type: "CLEAR_FOCUS" }
  );
}
