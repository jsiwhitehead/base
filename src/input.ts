import { signal } from "@preact/signals-core";

import { type EditorFieldMode } from "./data";
import {
  type CellPath,
  firstChildPath,
  getCellNavContext,
  standardMove,
  setCellText,
  setCellAsFlow,
  insertCellBefore,
  insertCellAfter,
  wrapCellInList,
  unwrapSingleCellList,
  removeCellBackward,
  removeCellForward,
  splitCell,
  mergeCellWithPrev,
  mergeCellWithNext,
} from "./tree";

export type FocusTarget = { kind: "body" } | { kind: "header"; index: number };

export type FocusState =
  | { kind: "idle" }
  | { kind: "focused"; path: CellPath; target: FocusTarget };

export const focusSignal = signal<FocusState>({ kind: "idle" });

type Anchor = "top" | "bottom";

type MachineState =
  | { kind: "Idle"; goalColumn?: number }
  | {
      kind: "Focused";
      path: CellPath;
      target: FocusTarget;
      goalColumn?: number;
    };

type EditorEvent =
  | { type: "FOCUS"; path: CellPath; target: FocusTarget; caret?: number }
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
  insertCellBefore,
  insertCellAfter,
  wrapCellInList,
  unwrapSingleCellList,
  setCellAsFlow,
  removeCellBackward,
  removeCellForward,
  mergeCellWithPrev,
  mergeCellWithNext,
};

type HeaderSlot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  mode: EditorFieldMode;
  commit: (text: string) => void;
};

type PathBinding = {
  path: CellPath;
  cell: HTMLElement;
  body: HTMLElement;
  header: HeaderSlot[];
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

function defaultTargetForPath(path: CellPath): FocusTarget {
  const { hasExtraHeaderEditors } = getCellNavContext(path);
  return hasExtraHeaderEditors
    ? { kind: "header", index: 1 }
    : { kind: "body" };
}

function bindEditor(
  binding: PathBinding,
  path: CellPath,
  el: HTMLInputElement | HTMLTextAreaElement,
  mode: EditorFieldMode,
  commit: (text: string) => void
) {
  if (mode === "body") {
    binding.teardowns.push(on(el, "input", () => commit(el.value)));
  }

  binding.teardowns.push(
    on(el, "blur", () => {
      if (isTextInput(el)) el.setSelectionRange(0, 0);
      if (mode === "body") return;
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

      if (mode === "name") {
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
            if (e.shiftKey) {
              stop(e);
              return;
            }
            stop(e);
            commit(el.value);
            dispatch({ type: "FOCUS", path, target: { kind: "body" } });
            return;
          }

          case "Escape":
          case "Tab":
            stop(e);
            commit(el.value);
            dispatch({ type: "FOCUS", path, target: { kind: "body" } });
            return;
        }

        return;
      }

      const isSingleHeader = mode === "header" || mode === "pattern";
      const isMultiHeader = mode === "header-multi";

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const atStart = selStart === 0 && selEnd === 0;
          const atEnd = selStart === len && selEnd === len;

          if (modKey || (dir === -1 && atStart) || (dir === 1 && atEnd)) {
            stop(e);
            if (mode !== "body") commit(el.value);
            dispatch({
              type: "MOVE",
              dir: dir === -1 ? "left" : "right",
              mod: modKey,
              caret: selStart,
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
          if (mode !== "body") commit(text);

          dispatch({
            type: "MOVE",
            dir: dir === -1 ? "up" : "down",
            mod: modKey,
            caret: pos - (lineStart + 1),
          });
          break;
        }

        case "Enter": {
          if (e.shiftKey) {
            if (isSingleHeader) {
              stop(e);
              break;
            }

            if (isMultiHeader) {
              dispatch({ type: "CLEAR_GOAL_COLUMN" });
              break;
            }

            dispatch({ type: "CLEAR_GOAL_COLUMN" });
            break;
          }

          if (modKey && mode === "body") {
            stop(e);
            commit(el.value);
            dispatch({
              type: "FOCUS",
              path,
              target: { kind: "header", index: 0 },
            });
            break;
          }

          if (mode === "body") {
            stop(e);

            const { kind } = getCellNavContext(path);

            if (kind === "text") {
              dispatch({ type: "SPLIT", caret: selStart, selEnd });
              break;
            }

            const res = insertCellAfter(path);
            if (res) {
              dispatch({
                type: "FOCUS",
                path: res.path,
                target: { kind: "body" },
              });
            }
            break;
          }

          stop(e);
          commit(el.value);
          break;
        }

        case "Backspace": {
          if (mode === "body" && !hasSelection && selStart === 0) {
            stop(e);
            dispatch({
              type: "TRANSFORM",
              op: len === 0 ? "removeCellBackward" : "mergeCellWithPrev",
            });
          }
          break;
        }

        case "Delete": {
          if (mode === "body" && !hasSelection && selStart === len) {
            stop(e);
            dispatch({
              type: "TRANSFORM",
              op: len === 0 ? "removeCellForward" : "mergeCellWithNext",
            });
          }
          break;
        }

        case "=": {
          if (mode === "body" && !el.value) {
            stop(e);
            dispatch({ type: "TRANSFORM", op: "setCellAsFlow" });
          }
          break;
        }

        case "Tab": {
          stop(e);
          dispatch({
            type: "TRANSFORM",
            op: e.shiftKey ? "unwrapSingleCellList" : "wrapCellInList",
            caret: selStart,
          });
          break;
        }
      }
    })
  );
}

function dispatch(ev: EditorEvent): void {
  const prev = state;
  let caretPos: number | undefined;
  let anchor: Anchor | undefined;

  switch (ev.type) {
    case "FOCUS": {
      state = {
        kind: "Focused",
        path: ev.path,
        target: ev.target,
        goalColumn: prev.kind === "Focused" ? prev.goalColumn : undefined,
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
      const nextPath = standardMove(state.path, dir, mod);
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
        target: defaultTargetForPath(nextPath),
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
        target: { kind: "body" },
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
          target: defaultTargetForPath(res.path),
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
      ? { kind: "focused", path: next.path, target: next.target }
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
    next.target.kind === "header"
      ? binding?.header[next.target.index]?.el
      : binding?.body;

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
    body: HTMLElement;
    header: HeaderSlot[];
  }
) {
  const k = keyOf(path);
  const prior = bindings.get(k);

  if (
    prior &&
    prior.cell === slots.cell &&
    prior.body === slots.body &&
    prior.header.length === slots.header.length &&
    prior.header.every(
      (h, i) => h.el === slots.header[i]!.el && h.mode === slots.header[i]!.mode
    )
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
    body: slots.body,
    header: slots.header,
    teardowns: [],
  };
  bindings.set(k, binding);

  binding.body.tabIndex = 0;

  binding.teardowns.push(
    on(binding.cell, "mousedown", (e) => {
      dispatch({ type: "FOCUS", path, target: { kind: "body" } });
      stop(e);
    })
  );

  binding.teardowns.push(
    on(binding.body, "mousedown", (e) => {
      dispatch({ type: "FOCUS", path, target: { kind: "body" } });
      if (
        binding.body instanceof HTMLInputElement ||
        binding.body instanceof HTMLTextAreaElement
      ) {
        e.stopPropagation();
      }
    })
  );

  for (let i = 0; i < binding.header.length; i++) {
    const slot = binding.header[i]!;
    binding.teardowns.push(
      on(slot.el, "mousedown", (e) => {
        dispatch({
          type: "FOCUS",
          path,
          target: { kind: "header", index: i },
        });
        e.stopPropagation();
      })
    );

    bindEditor(binding, path, slot.el, slot.mode, slot.commit);
  }

  if (isTextInput(binding.body)) {
    bindEditor(binding, path, binding.body, "body", (text) =>
      setCellText(path, text)
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
  if (state.kind !== "Focused" || state.target.kind === "header") return;

  const { kind } = getCellNavContext(state.path);
  if (kind !== "list") return;

  const mod = e.metaKey || e.ctrlKey;

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      stop(e);
      const dir = e.key === "ArrowLeft" ? "left" : "right";
      dispatch({ type: "MOVE", dir, mod });
      break;
    }

    case "ArrowUp":
    case "ArrowDown": {
      stop(e);
      const dir = e.key === "ArrowUp" ? "up" : "down";
      dispatch({ type: "MOVE", dir, mod });
      break;
    }

    case "Enter": {
      stop(e);

      if (mod) {
        dispatch({
          type: "FOCUS",
          path: state.path,
          target: { kind: "header", index: 0 },
        });
        break;
      }

      const res = e.shiftKey
        ? insertCellBefore(state.path)
        : insertCellAfter(state.path);
      if (res) {
        dispatch({ type: "FOCUS", path: res.path, target: { kind: "body" } });
      }
      break;
    }

    case "Backspace": {
      stop(e);
      dispatch({ type: "TRANSFORM", op: "removeCellBackward" });
      break;
    }

    case "Delete": {
      stop(e);
      dispatch({ type: "TRANSFORM", op: "removeCellForward" });
      break;
    }

    case "Tab": {
      stop(e);
      dispatch({
        type: "TRANSFORM",
        op: e.shiftKey ? "unwrapSingleCellList" : "wrapCellInList",
      });
      break;
    }
  }
}

export function focusFirstRootCell(): void {
  const p = firstChildPath([]);
  dispatch(
    p
      ? { type: "FOCUS", path: p, target: defaultTargetForPath(p) }
      : { type: "CLEAR_FOCUS" }
  );
}
