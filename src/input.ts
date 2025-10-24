import {
  type CellPath,
  parentPath,
  siblingPath,
  firstChildPath,
  setText,
  toggleCodeText,
  setName,
  insertBefore,
  insertAfter,
  wrapWithList,
  unwrapListIfSingleChild,
  removeChild,
} from "./tree";

export type Role = "name" | "value";

type MachineState =
  | { kind: "Idle" }
  | { kind: "Focused"; path: CellPath; role: Role };

type EditorEvent =
  | { type: "FOCUS"; path: CellPath; role: Role }
  | { type: "CLEAR_FOCUS" }
  | {
      type: "TRANSFORM";
      op:
        | "toggle-text-code"
        | "insert-before"
        | "insert-after"
        | "unwrap-if-single-child"
        | "wrap"
        | "remove";
    };

type PathBinding = {
  path: CellPath;
  name?: HTMLElement;
  value?: HTMLElement;
  cell?: HTMLElement;
  teardowns: (() => void)[];
};

const serializePath = (p: CellPath) => JSON.stringify(p);
const bindingsByPath = new Map<string, PathBinding>();
let currentState: MachineState = { kind: "Idle" };

function getBinding(path: CellPath): PathBinding | undefined {
  return bindingsByPath.get(serializePath(path));
}

function on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
  el: T,
  type: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: boolean | AddEventListenerOptions
) {
  el.addEventListener(type, handler as any, opts);
  return () => el.removeEventListener(type, handler as any, opts);
}

function setFocusClasses() {
  for (const { name, value, cell } of bindingsByPath.values()) {
    name?.classList.remove("focused");
    value?.classList.remove("focused");
    cell?.classList.remove("focused");
  }

  if (currentState.kind === "Focused") {
    const b = getBinding(currentState.path);
    if (currentState.role === "name") {
      b?.name?.classList.add("focused");
    } else {
      b?.value?.classList.add("focused");
    }
    b?.cell?.classList.add("focused");
  }
}

function focusDomToActive() {
  if (currentState.kind !== "Focused") return;
  const b = getBinding(currentState.path);
  const el = currentState.role === "name" ? b?.name : b?.value;
  if (el && document.activeElement !== el) {
    el.focus({ preventScroll: true });
  }
}

function dispatch(ev: EditorEvent) {
  currentState = transition(currentState, ev);
  setFocusClasses();
  focusDomToActive();
}

function transition(prev: MachineState, ev: EditorEvent): MachineState {
  switch (ev.type) {
    case "FOCUS":
      return { kind: "Focused", path: ev.path, role: ev.role };

    case "TRANSFORM": {
      if (prev.kind !== "Focused") return prev;
      const target = prev.path;
      let nextPath: CellPath | undefined;
      switch (ev.op) {
        case "toggle-text-code":
          nextPath = toggleCodeText(target);
          break;
        case "insert-before":
          nextPath = insertBefore(target);
          break;
        case "insert-after":
          nextPath = insertAfter(target);
          break;
        case "unwrap-if-single-child":
          nextPath = unwrapListIfSingleChild(target);
          break;
        case "wrap":
          nextPath = wrapWithList(target);
          break;
        case "remove":
          nextPath = removeChild(target);
          break;
      }
      if (!nextPath) return { kind: "Idle" };
      return { kind: "Focused", path: nextPath, role: "value" };
    }

    case "CLEAR_FOCUS":
      return { kind: "Idle" };
  }
}

export function registerBinding(
  path: CellPath,
  slots: { name?: HTMLElement; value?: HTMLElement; cell?: HTMLElement }
) {
  const k = serializePath(path);
  const prior = bindingsByPath.get(k);

  if (
    prior &&
    prior.name === slots.name &&
    prior.value === slots.value &&
    prior.cell === slots.cell
  ) {
    setFocusClasses();
    return;
  }

  if (prior) {
    for (const td of prior.teardowns) td();
    bindingsByPath.delete(k);
  }

  const binding: PathBinding = {
    path: path.slice(),
    name: slots.name,
    value: slots.value,
    cell: slots.cell,
    teardowns: [],
  };
  bindingsByPath.set(k, binding);

  if (binding.name) {
    const el = binding.name;

    binding.teardowns.push(
      on(
        el,
        "focus",
        (e: FocusEvent) => {
          if (e.target !== el) return;
          dispatch({ type: "FOCUS", path, role: "name" });
        },
        true
      )
    );

    if (el instanceof HTMLInputElement) {
      binding.teardowns.push(
        on(el, "blur", () => {
          setName(path, el.value.trim());
          if (binding.value) {
            dispatch({ type: "FOCUS", path, role: "value" });
          } else {
            dispatch({ type: "CLEAR_FOCUS" });
          }
        })
      );

      binding.teardowns.push(
        on(el, "keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            el.blur();
            return;
          }
          if (e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            dispatch({ type: "FOCUS", path, role: "value" });
          }
        })
      );

      binding.teardowns.push(
        on(el, "mousedown", (e: MouseEvent) => e.stopPropagation())
      );
    } else {
      binding.teardowns.push(
        on(el, "mousedown", (e: MouseEvent) => {
          if (binding.value) {
            e.preventDefault();
            e.stopPropagation();
            dispatch({ type: "FOCUS", path, role: "value" });
          }
        })
      );
    }
  }

  if (binding.value) {
    const el = binding.value;
    if (!(el instanceof HTMLInputElement)) el.tabIndex = 0;

    binding.teardowns.push(
      on(
        el,
        "focus",
        (e: FocusEvent) => {
          if (e.target !== el) return;
          dispatch({ type: "FOCUS", path, role: "value" });
        },
        true
      )
    );

    binding.teardowns.push(
      on(el, "mousedown", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        el.focus({ preventScroll: true });
        dispatch({ type: "FOCUS", path, role: "value" });
      })
    );

    if (el instanceof HTMLInputElement) {
      binding.teardowns.push(on(el, "blur", () => setText(path, el.value)));

      binding.teardowns.push(
        on(el, "keydown", (e: KeyboardEvent) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            el.blur();
            return;
          }
          if (e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            const b = getBinding(path);
            if (b?.name instanceof HTMLInputElement) {
              b.name.focus({ preventScroll: true });
            }
            return;
          }
          if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === "=") {
            e.preventDefault();
            e.stopPropagation();
            dispatch({ type: "TRANSFORM", op: "toggle-text-code" });
            return;
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            const up = siblingPath(path, -1);
            if (up) dispatch({ type: "FOCUS", path: up, role: "value" });
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            e.stopPropagation();
            const down = siblingPath(path, 1);
            if (down) dispatch({ type: "FOCUS", path: down, role: "value" });
            return;
          }
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            e.stopPropagation();
            const left = parentPath(path);
            if (left) dispatch({ type: "FOCUS", path: left, role: "value" });
            return;
          }
          if (e.key === "ArrowRight") {
            e.preventDefault();
            e.stopPropagation();
            const right = firstChildPath(path);
            if (right) dispatch({ type: "FOCUS", path: right, role: "value" });
            return;
          }
          if (
            e.key === "Backspace" &&
            el.selectionStart === 0 &&
            el.selectionEnd === 0
          ) {
            e.preventDefault();
            e.stopPropagation();
            dispatch({ type: "TRANSFORM", op: "remove" });
          }
        })
      );
    }
  }

  setFocusClasses();
}

export function unregisterBinding(path: CellPath) {
  const k = serializePath(path);
  const binding = bindingsByPath.get(k);

  if (binding) {
    for (const td of binding.teardowns) td();
    bindingsByPath.delete(k);
  }

  const isSame = (p: CellPath) => serializePath(p) === k;
  if (currentState.kind === "Focused" && isSame(currentState.path)) {
    dispatch({ type: "CLEAR_FOCUS" });
  }
}

export function onRootKeyDown(e: KeyboardEvent) {
  const activeEl = document.activeElement as HTMLElement | null;
  if (!activeEl || activeEl.tagName === "INPUT") return;
  if (currentState.kind === "Idle") return;

  const prevent = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (currentState.kind === "Focused") {
    const cur = currentState.path;

    if (e.key === "=") {
      prevent();
      dispatch({ type: "TRANSFORM", op: "toggle-text-code" });
      return;
    }

    if (e.key === "Backspace") {
      prevent();
      dispatch({ type: "TRANSFORM", op: "remove" });
      return;
    }

    switch (e.key) {
      case "ArrowUp":
        prevent();
        {
          const up = siblingPath(cur, -1);
          if (up) dispatch({ type: "FOCUS", path: up, role: "value" });
        }
        return;
      case "ArrowDown":
        prevent();
        {
          const down = siblingPath(cur, 1);
          if (down) dispatch({ type: "FOCUS", path: down, role: "value" });
        }
        return;
      case "ArrowLeft":
        prevent();
        {
          const left = parentPath(cur);
          if (left) dispatch({ type: "FOCUS", path: left, role: "value" });
        }
        return;
      case "ArrowRight":
        prevent();
        {
          const right = firstChildPath(cur);
          if (right) dispatch({ type: "FOCUS", path: right, role: "value" });
        }
        return;
    }
  }
}

export function focusFirstRootCell(): void {
  const p = firstChildPath([]);
  if (p) {
    dispatch({ type: "FOCUS", path: p, role: "value" });
  } else {
    dispatch({ type: "CLEAR_FOCUS" });
  }
}
