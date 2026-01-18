import { signal } from "@preact/signals-core";

import type { InputFieldMode } from "./interact";
import {
  type Focus,
  rootContainer,
  firstChildOf,
  standardMove,
  updateItemText,
  setItemAsDerived,
  addItemBefore,
  addItemAfter,
  wrapInGroup,
  unwrapGroup,
  removeItemBackward,
  removeItemForward,
  splitItemAt,
  joinWithBefore,
  joinWithAfter,
  getItemUpdateKind,
  getEditableFields,
} from "./interact";

export type FocusTarget =
  | { kind: "content" }
  | { kind: "header"; index: number };

export type FocusState =
  | { kind: "idle" }
  | { kind: "focused"; focus: Focus; target: FocusTarget };

export const focusSignal = signal<FocusState>({ kind: "idle" });

type Anchor = "top" | "bottom";

type MachineState =
  | { kind: "Idle"; goalColumn?: number }
  | {
      kind: "Focused";
      focus: Focus;
      target: FocusTarget;
      goalColumn?: number;
    };

type InputEvent =
  | { type: "FOCUS"; focus: Focus; target: FocusTarget; caret?: number }
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
  addItemBefore,
  addItemAfter,
  wrapInGroup,
  unwrapGroup,
  setItemAsDerived,
  removeItemBackward,
  removeItemForward,
  joinWithBefore,
  joinWithAfter,
};

type HeaderSlot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  mode: InputFieldMode;
  commit: (text: string) => void;
};

type FocusBinding = {
  focus: Focus;
  item: HTMLElement;
  content: HTMLElement;
  header: HeaderSlot[];
  teardowns: (() => void)[];
};

const bindings = new Map<string, FocusBinding>();
let state: MachineState = { kind: "Idle", goalColumn: undefined };

function keyOf(f: Focus) {
  return `${String(f.containerId)}::${String(f.id)}`;
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

function hasHeaderFields(id: Focus["id"]): boolean {
  return getEditableFields(id).some((f) => f.slot === "header");
}

function defaultTargetForFocus(focus: Focus): FocusTarget {
  return hasHeaderFields(focus.id)
    ? { kind: "header", index: 0 }
    : { kind: "content" };
}

function bindInput(
  binding: FocusBinding,
  focus: Focus,
  el: HTMLInputElement | HTMLTextAreaElement,
  mode: InputFieldMode,
  commit: (text: string) => void
) {
  if (mode === "content") {
    binding.teardowns.push(on(el, "input", () => commit(el.value)));
  }

  binding.teardowns.push(
    on(el, "blur", () => {
      if (isTextInput(el)) el.setSelectionRange(0, 0);
      if (mode === "content") return;
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

      if (mode === "label") {
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
            dispatch({ type: "FOCUS", focus, target: { kind: "content" } });
            return;
          }

          case "Escape":
          case "Tab":
            stop(e);
            commit(el.value);
            dispatch({ type: "FOCUS", focus, target: { kind: "content" } });
            return;
        }

        return;
      }

      const isSingleHeader = mode === "header";
      const isMultiHeader = mode === "header-multi";

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowRight": {
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const atStart = selStart === 0 && selEnd === 0;
          const atEnd = selStart === len && selEnd === len;

          if (modKey || (dir === -1 && atStart) || (dir === 1 && atEnd)) {
            stop(e);
            if (mode !== "content") commit(el.value);

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
          if (mode !== "content") commit(text);

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
            dispatch({ type: "CLEAR_GOAL_COLUMN" });
            break;
          }

          if (modKey && mode === "content") {
            if (hasHeaderFields(focus.id)) {
              stop(e);
              commit(el.value);
              dispatch({
                type: "FOCUS",
                focus,
                target: { kind: "header", index: 0 },
              });
            }
            break;
          }

          if (mode === "content") {
            stop(e);

            const kind = getItemUpdateKind(focus.id);

            if (kind === "text") {
              dispatch({ type: "SPLIT", caret: selStart, selEnd });
              break;
            }

            const res = addItemAfter(focus);
            dispatch({
              type: "FOCUS",
              focus: res.focus,
              target: { kind: "content" },
            });
            break;
          }

          stop(e);
          commit(el.value);
          break;
        }

        case "Backspace": {
          if (mode === "content" && !hasSelection && selStart === 0) {
            stop(e);
            dispatch({
              type: "TRANSFORM",
              op: len === 0 ? "removeItemBackward" : "joinWithBefore",
            });
          }
          break;
        }

        case "Delete": {
          if (mode === "content" && !hasSelection && selStart === len) {
            stop(e);
            dispatch({
              type: "TRANSFORM",
              op: len === 0 ? "removeItemForward" : "joinWithAfter",
            });
          }
          break;
        }

        case "=": {
          if (mode === "content" && !el.value) {
            stop(e);
            dispatch({ type: "TRANSFORM", op: "setItemAsDerived" });
          }
          break;
        }

        case "Tab": {
          stop(e);
          dispatch({
            type: "TRANSFORM",
            op: e.shiftKey ? "unwrapGroup" : "wrapInGroup",
            caret: selStart,
          });
          break;
        }
      }
    })
  );
}

function dispatch(ev: InputEvent): void {
  const prev = state;
  let caretPos: number | undefined;
  let anchor: Anchor | undefined;

  switch (ev.type) {
    case "FOCUS": {
      state = {
        kind: "Focused",
        focus: ev.focus,
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

      const nextFocus = standardMove(state.focus, ev.dir, ev.mod);
      if (!nextFocus) break;

      let goalColumn = state.goalColumn;

      if (ev.dir === "left" || ev.dir === "right") {
        const caret = ev.caret ?? goalColumn ?? 0;
        goalColumn = ev.mod ? caret : undefined;
        caretPos = ev.mod ? caret : ev.dir === "left" ? Infinity : 0;
      } else {
        goalColumn = goalColumn ?? ev.caret ?? 0;
        anchor = ev.dir === "up" ? "bottom" : "top";
      }

      state = {
        kind: "Focused",
        focus: nextFocus,
        target: defaultTargetForFocus(nextFocus),
        goalColumn,
      };

      break;
    }

    case "SPLIT": {
      if (state.kind !== "Focused") break;

      const res = splitItemAt(state.focus, ev.caret, ev.selEnd ?? ev.caret);
      state = {
        kind: "Focused",
        focus: res.focus,
        target: { kind: "content" },
        goalColumn: undefined,
      };
      caretPos = res.caret ?? 0;
      break;
    }

    case "TRANSFORM": {
      if (state.kind !== "Focused") break;

      const fn = TRANSFORMS[ev.op];
      const res = fn ? fn(state.focus) : { focus: state.focus };

      state = {
        kind: "Focused",
        focus: res.focus,
        target: defaultTargetForFocus(res.focus),
        goalColumn: undefined,
      };
      caretPos = res.caret ?? ev.caret;
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
      ? { kind: "focused", focus: next.focus, target: next.target }
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
  if (nl === -1) return clamp(column, 0, text.length);

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

  const binding = bindings.get(keyOf(next.focus));
  if (!binding) return;

  const targetEl =
    next.target.kind === "header"
      ? binding.header[next.target.index]?.el
      : binding.content;

  if (!targetEl) return;

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

  if (pos != null) targetEl.setSelectionRange(pos, pos);
}

export function registerBinding(
  focus: Focus,
  slots: { item: HTMLElement; content: HTMLElement; header: HeaderSlot[] }
) {
  const k = keyOf(focus);
  const prior = bindings.get(k);

  if (
    prior &&
    prior.item === slots.item &&
    prior.content === slots.content &&
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

  const binding: FocusBinding = {
    focus: { ...focus },
    item: slots.item,
    content: slots.content,
    header: slots.header,
    teardowns: [],
  };
  bindings.set(k, binding);

  binding.content.tabIndex = 0;

  binding.teardowns.push(
    on(binding.item, "mousedown", (e) => {
      dispatch({ type: "FOCUS", focus, target: { kind: "content" } });
      stop(e);
    })
  );

  binding.teardowns.push(
    on(binding.content, "mousedown", (e) => {
      dispatch({ type: "FOCUS", focus, target: { kind: "content" } });
      if (
        binding.content instanceof HTMLInputElement ||
        binding.content instanceof HTMLTextAreaElement
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
          focus,
          target: { kind: "header", index: i },
        });
        e.stopPropagation();
      })
    );

    bindInput(binding, focus, slot.el, slot.mode, slot.commit);
  }

  if (isTextInput(binding.content)) {
    bindInput(binding, focus, binding.content, "content", (text) => {
      updateItemText(focus, text);
    });
  }

  updateDOMFocus(state);
}

export function unregisterBinding(focus: Focus) {
  const k = keyOf(focus);
  const binding = bindings.get(k);

  if (binding) {
    for (const fn of binding.teardowns) fn();
    bindings.delete(k);
  }

  if (state.kind === "Focused" && keyOf(state.focus) === k) {
    dispatch({ type: "CLEAR_FOCUS" });
  }
}

export function onRootKeyDown(e: KeyboardEvent) {
  if (state.kind !== "Focused" || state.target.kind === "header") return;

  const kind = getItemUpdateKind(state.focus.id);
  if (kind !== "group") return;

  const mod = e.metaKey || e.ctrlKey;

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      stop(e);
      dispatch({
        type: "MOVE",
        dir: e.key === "ArrowLeft" ? "left" : "right",
        mod,
      });
      break;
    }

    case "ArrowUp":
    case "ArrowDown": {
      stop(e);
      dispatch({ type: "MOVE", dir: e.key === "ArrowUp" ? "up" : "down", mod });
      break;
    }

    case "Enter": {
      stop(e);

      if (mod) {
        if (hasHeaderFields(state.focus.id)) {
          dispatch({
            type: "FOCUS",
            focus: state.focus,
            target: { kind: "header", index: 0 },
          });
        }
        break;
      }

      const res = e.shiftKey
        ? addItemBefore(state.focus)
        : addItemAfter(state.focus);
      dispatch({
        type: "FOCUS",
        focus: res.focus,
        target: { kind: "content" },
      });
      break;
    }

    case "Backspace": {
      stop(e);
      dispatch({ type: "TRANSFORM", op: "removeItemBackward" });
      break;
    }

    case "Delete": {
      stop(e);
      dispatch({ type: "TRANSFORM", op: "removeItemForward" });
      break;
    }

    case "Tab": {
      stop(e);
      dispatch({
        type: "TRANSFORM",
        op: e.shiftKey ? "unwrapGroup" : "wrapInGroup",
      });
      break;
    }
  }
}

export function focusFirstRootCell(): void {
  const root = rootContainer();
  const first = firstChildOf(root);

  dispatch(
    first
      ? { type: "FOCUS", focus: first, target: defaultTargetForFocus(first) }
      : { type: "CLEAR_FOCUS" }
  );
}
