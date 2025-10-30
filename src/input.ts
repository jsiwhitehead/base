import {
  type CellPath,
  parentPath,
  siblingPath,
  firstChildPath,
  getCellKind,
  neighborLeafPath,
  setText,
  toggleCodeText,
  setName,
  insertBefore,
  insertAfter,
  wrapWithList,
  unwrapListIfSingleChild,
  removeChild,
  splitCell,
  mergeWithPrevious,
} from "./tree";

export type Role = "name" | "value";

type MachineState =
  | { kind: "Idle"; goalColumn?: number }
  | { kind: "Focused"; path: CellPath; role: Role; goalColumn?: number };

type EditorEvent =
  | { type: "FOCUS"; path: CellPath; role: Role; caret?: number }
  | { type: "CLEAR_FOCUS" }
  | {
      type: "MOVE";
      dir: "up" | "down" | "left" | "right";
      mod?: boolean;
      caret?: number;
    }
  | { type: "SPLIT"; caret: number; selEnd?: number }
  | { type: "TRANSFORM"; op: keyof typeof TRANSFORMS }
  | { type: "CLEAR_GOAL_COLUMN" };

const TRANSFORMS = {
  "insert-before": insertBefore,
  "insert-after": insertAfter,
  wrap: wrapWithList,
  "unwrap-if-single-child": unwrapListIfSingleChild,
  "toggle-text-code": toggleCodeText,
  remove: removeChild,
  "merge-backward": mergeWithPrevious,
} as const;

type PathBinding = {
  path: CellPath;
  cell: HTMLElement;
  value: HTMLElement;
  name?: HTMLElement;
  teardowns: (() => void)[];
};

const bindings = new Map<string, PathBinding>();
let state: MachineState = { kind: "Idle", goalColumn: undefined };

const keyOf = (p: CellPath) => p.join(".");
const stop = (e: KeyboardEvent | MouseEvent) => {
  e.preventDefault();
  e.stopPropagation();
};

function on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
  el: T,
  type: K,
  handler: (e: HTMLElementEventMap[K]) => void
) {
  el.addEventListener(type, handler);
  return () => el.removeEventListener(type, handler);
}

export function dispatch(ev: EditorEvent): void {
  const prev = state;
  let caretPos: number | undefined;

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

      const kind = getCellKind(state.path);

      if (ev.dir === "left" || ev.dir === "right") {
        const sign = ev.dir === "left" ? -1 : (1 as const);
        state = { ...state, goalColumn: undefined };

        if (kind === "list") {
          const target =
            sign === -1 ? parentPath(state.path) : firstChildPath(state.path);
          if (!target) break;
          if (sign === -1 && target.length === 0) break;

          state = {
            kind: "Focused",
            path: target,
            role: "value",
            goalColumn: undefined,
          };
          if (sign === 1) caretPos = 0;
          break;
        }

        if (ev.mod && sign === -1) {
          const parent = parentPath(state.path);
          if (!parent || parent.length === 0) break;
          state = {
            kind: "Focused",
            path: parent,
            role: "value",
            goalColumn: undefined,
          };
          break;
        }

        const nextPath = neighborLeafPath(state.path, sign);
        if (!nextPath) break;

        state = {
          kind: "Focused",
          path: nextPath,
          role: "value",
          goalColumn: undefined,
        };
        caretPos = sign === -1 ? Infinity : 0;
        break;
      }

      if (ev.dir === "up" || ev.dir === "down") {
        const sign = ev.dir === "up" ? -1 : (1 as const);
        const isList = kind === "list";
        const goal = state.goalColumn ?? ev.caret ?? 0;
        const useSiblings = ev.mod || isList;

        const nextPath = useSiblings
          ? siblingPath(state.path, sign)
          : neighborLeafPath(state.path, sign);
        if (!nextPath) break;

        const targetKind = getCellKind(nextPath);
        const isTextToText =
          kind === "text" && targetKind === "text" && !!ev.mod;

        const nextGoal = isTextToText
          ? goal
          : useSiblings
          ? state.goalColumn
          : goal;
        const nextCaret = isTextToText
          ? goal
          : useSiblings
          ? state.goalColumn ?? goal
          : goal;

        state = {
          kind: "Focused",
          path: nextPath,
          role: "value",
          goalColumn: nextGoal,
        };
        caretPos = nextCaret;
      }
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
        caretPos = res.caret;
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

  updateDOMFocus(prev, state, caretPos);
}

function updateDOMFocus(
  prev: MachineState,
  next: MachineState,
  caretPos?: number
) {
  if (prev.kind !== "Focused" && next.kind !== "Focused") return;

  for (const { cell, value, name } of bindings.values()) {
    cell.classList.remove("focused");
    value.classList.remove("focused");
    name?.classList.remove("focused");
  }

  if (next.kind !== "Focused") return;

  const binding = bindings.get(keyOf(next.path));
  const targetEl = next.role === "name" ? binding?.name : binding?.value;
  if (!binding || !targetEl) return;

  binding.cell.classList.add("focused");
  targetEl.classList.add("focused");

  if (document.activeElement !== targetEl) {
    targetEl.focus({ preventScroll: true });
  }

  if (caretPos !== undefined && targetEl instanceof HTMLInputElement) {
    const pos = Math.max(0, Math.min(caretPos, targetEl.value.length));
    targetEl.setSelectionRange(pos, pos);
  }
}

export function registerBinding(
  path: CellPath,
  slots: { cell: HTMLElement; value: HTMLElement; name?: HTMLElement }
) {
  const k = keyOf(path);
  const prior = bindings.get(k);

  if (
    prior &&
    prior.cell === slots.cell &&
    prior.value === slots.value &&
    prior.name === slots.name
  ) {
    updateDOMFocus(state, state);
    return;
  }

  if (prior) {
    for (const fn of prior.teardowns) fn();
    bindings.delete(k);
  }

  const binding: PathBinding = { path: path.slice(), ...slots, teardowns: [] };
  bindings.set(k, binding);

  binding.value.tabIndex = 0;

  if (binding.name) {
    const nameEl = binding.name! as HTMLInputElement;

    binding.teardowns.push(
      on(nameEl, "blur", () => {
        nameEl.setSelectionRange(0, 0);
        queueMicrotask(() => {
          setName(path, nameEl.value.trim());
          dispatch({ type: "FOCUS", path, role: "value" });
        });
      })
    );

    binding.teardowns.push(
      on(nameEl, "keydown", (e: KeyboardEvent) => {
        switch (e.key) {
          case "Enter":
          case "Escape":
            stop(e);
            nameEl.blur();
            return;
          case "Tab":
            stop(e);
            dispatch({ type: "FOCUS", path, role: "value" });
            return;
        }
      })
    );

    binding.teardowns.push(
      on(nameEl, "mousedown", (e: MouseEvent) => {
        e.stopPropagation();
        dispatch({ type: "FOCUS", path, role: "name" });
      })
    );
  }

  const valueEl = binding.value;

  binding.teardowns.push(
    on(valueEl, "mousedown", (e: MouseEvent) => {
      if (valueEl instanceof HTMLInputElement) {
        e.stopPropagation();
        dispatch({ type: "FOCUS", path, role: "value" });
        return;
      }

      stop(e);
      dispatch({ type: "FOCUS", path, role: "value" });
    })
  );

  if (valueEl instanceof HTMLInputElement) {
    if (getCellKind(path) !== "flow") {
      binding.teardowns.push(
        on(valueEl, "input", () => {
          setText(path, valueEl.value);
        })
      );
    }

    binding.teardowns.push(
      on(valueEl, "blur", () => {
        valueEl.setSelectionRange(0, 0);
        queueMicrotask(() => {
          setText(path, valueEl.value);
        });
      })
    );

    binding.teardowns.push(
      on(valueEl, "keydown", (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;
        const len = valueEl.value.length;
        const selStart = valueEl.selectionStart ?? 0;
        const selEnd = valueEl.selectionEnd ?? selStart;
        const kind = getCellKind(path);

        switch (e.key) {
          case "ArrowLeft":
          case "ArrowRight": {
            const dir = e.key === "ArrowLeft" ? -1 : 1;
            const atStart = selStart === 0 && selEnd === 0;
            const atEnd = selStart === len && selEnd === len;

            if (!mod && ((dir === -1 && atStart) || (dir === 1 && atEnd))) {
              stop(e);
              setText(path, valueEl.value);
              dispatch({ type: "MOVE", dir: dir === -1 ? "left" : "right" });
              return;
            }

            if (mod && dir === -1 && atStart) {
              stop(e);
              setText(path, valueEl.value);
              const parent = parentPath(path);
              if (!parent || parent.length === 0) return;
              dispatch({ type: "MOVE", dir: "left", mod: true });
              return;
            }

            if (mod && dir === 1 && atEnd) {
              stop(e);
              setText(path, valueEl.value);
              if (kind === "flow") {
                dispatch({ type: "MOVE", dir: "right" });
              }
              return;
            }

            dispatch({ type: "CLEAR_GOAL_COLUMN" });
            return;
          }

          case "ArrowUp":
          case "ArrowDown": {
            stop(e);
            setText(path, valueEl.value);
            const caret = selStart;
            const dir = e.key === "ArrowUp" ? "up" : "down";
            dispatch({ type: "MOVE", dir, mod, caret });
            return;
          }

          case "Enter": {
            stop(e);
            if (kind === "flow") {
              setText(path, valueEl.value);
              return;
            }
            const start = selStart ?? len;
            const end = selEnd ?? start;
            dispatch({ type: "SPLIT", caret: start, selEnd: end });
            return;
          }

          case "=": {
            if (kind !== "flow") {
              if (!valueEl.value) {
                stop(e);
                dispatch({ type: "TRANSFORM", op: "toggle-text-code" });
                return;
              }
            }
            return;
          }

          case "Backspace": {
            if (!(selStart === 0 && selEnd === 0)) return;

            if (kind === "flow") {
              if (!valueEl.value.trim()) {
                stop(e);
                dispatch({ type: "TRANSFORM", op: "toggle-text-code" });
                return;
              }
              stop(e);
              return;
            }

            stop(e);
            dispatch({ type: "TRANSFORM", op: "merge-backward" });
            return;
          }

          case "Tab": {
            stop(e);
            dispatch({
              type: "TRANSFORM",
              op: e.shiftKey ? "unwrap-if-single-child" : "wrap",
            });
            return;
          }
        }
      })
    );
  }

  updateDOMFocus(state, state);
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
  const kind = getCellKind(state.path);

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowRight": {
      if (kind !== "list") return;
      stop(e);
      const dir = e.key === "ArrowLeft" ? "left" : "right";
      dispatch({ type: "MOVE", dir });
      return;
    }

    case "ArrowUp":
    case "ArrowDown": {
      stop(e);
      const mod = e.metaKey || e.ctrlKey;
      const dir = e.key === "ArrowUp" ? "up" : "down";
      dispatch({ type: "MOVE", dir, mod });
      return;
    }

    case "Tab": {
      stop(e);
      dispatch({
        type: "TRANSFORM",
        op: e.shiftKey ? "unwrap-if-single-child" : "wrap",
      });
      return;
    }
  }
}

export function focusFirstRootCell(): void {
  const p = firstChildPath([]);
  dispatch(
    p ? { type: "FOCUS", path: p, role: "value" } : { type: "CLEAR_FOCUS" }
  );
}
