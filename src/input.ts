import {
  type NodePath,
  parentPath,
  siblingPath,
  firstChildPath,
  setText,
  toggleCodeText,
  assignKey,
  removeKey,
  insertBefore,
  insertAfter,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
  removeChild,
} from "./tree";

export type Role = "key" | "value";

type RoleView = {
  el: HTMLElement;
  getText?: () => string;
  keyAnchorEl?: HTMLElement;
};

type PathBinding = {
  path: NodePath;
  key?: RoleView;
  value?: RoleView;
};

type MachineState =
  | { kind: "Idle" }
  | { kind: "ViewingValue"; path: NodePath }
  | {
      kind: "Editing";
      role: Role;
      path: NodePath;
      session: InlineEditor;
    };

type EditorEvent =
  | { type: "FOCUS"; binding: PathBinding; role: Role }
  | { type: "NAVIGATE"; path: NodePath; role: Role }
  | { type: "CLEAR_FOCUS" }
  | { type: "BEGIN_EDIT"; seed?: string }
  | { type: "END_EDIT"; reason: "commit" | "cancel"; refocus?: boolean }
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

const serializePath = (p: NodePath) => JSON.stringify(p);

const bindingsByPath = new Map<string, PathBinding>();

let currentState: MachineState = { kind: "Idle" };

function getBinding(path: NodePath): PathBinding | undefined {
  return bindingsByPath.get(serializePath(path));
}

function getRoleView(
  binding: PathBinding | undefined,
  role: Role
): RoleView | undefined {
  if (!binding) return undefined;
  return role === "key" ? binding.key : binding.value;
}

const flipRole = (role: Role): Role => (role === "key" ? "value" : "key");

class InlineEditor {
  readonly inputEl = document.createElement("input");

  constructor(readonly role: Role, readonly roleView: RoleView, seed?: string) {
    if (role === "key") {
      this.inputEl.classList.add("key");
    } else {
      this.inputEl.classList.add(...roleView.el.classList);
    }

    if (role === "key" && roleView.keyAnchorEl) {
      roleView.keyAnchorEl.parentNode!.insertBefore(
        this.inputEl,
        roleView.keyAnchorEl
      );
    } else {
      roleView.el.parentNode!.replaceChild(this.inputEl, roleView.el);
    }

    queueMicrotask(() => {
      this.inputEl.focus({ preventScroll: true });
    });

    this.inputEl.setAttribute("autocorrect", "off");
    this.inputEl.setAttribute("autocomplete", "off");
    (this.inputEl as any).autocapitalize = "off";
    this.inputEl.spellcheck = false;

    this.inputEl.value = seed ?? (roleView.getText ? roleView.getText() : "");
  }

  get value() {
    return this.inputEl.value;
  }

  dispose() {
    if (this.role === "key" && this.roleView.keyAnchorEl) {
      this.inputEl.parentNode!.removeChild(this.inputEl);
    } else {
      this.inputEl.parentNode!.replaceChild(this.roleView.el, this.inputEl);
    }
  }
}

function computeEntryState(
  binding: PathBinding,
  role: Role,
  seed?: string
): MachineState {
  if (role === "key") {
    if (binding.key?.getText) {
      const session = new InlineEditor("key", binding.key, seed);
      return { kind: "Editing", role: "key", path: binding.path, session };
    }
    if (binding.value?.keyAnchorEl) {
      const session = new InlineEditor("key", binding.value, "");
      return { kind: "Editing", role: "key", path: binding.path, session };
    }
    return { kind: "Idle" };
  }

  return binding.value
    ? { kind: "ViewingValue", path: binding.path }
    : { kind: "Idle" };
}

function transition(prev: MachineState, ev: EditorEvent): MachineState {
  switch (ev.type) {
    case "FOCUS": {
      return computeEntryState(ev.binding, ev.role);
    }
    case "NAVIGATE": {
      const next = getBinding(ev.path);
      if (!next) return { kind: "Idle" };
      return computeEntryState(next, ev.role);
    }
    case "CLEAR_FOCUS": {
      return { kind: "Idle" };
    }

    case "BEGIN_EDIT": {
      if (prev.kind !== "ViewingValue") return prev;
      const binding = getBinding(prev.path);
      const valueView = getRoleView(binding, "value");
      if (!valueView?.getText) return prev;
      const session = new InlineEditor("value", valueView, ev.seed);
      return { kind: "Editing", role: "value", path: prev.path, session };
    }
    case "END_EDIT": {
      if (prev.kind !== "Editing") return prev;
      const { path, role } = prev;

      if (role === "key") {
        const binding = getBinding(path);
        const hasValue = !!binding?.value;
        return hasValue ? { kind: "ViewingValue", path } : { kind: "Idle" };
      }
      return { kind: "ViewingValue", path };
    }

    case "TRANSFORM": {
      if (prev.kind !== "ViewingValue" && prev.kind !== "Editing") return prev;

      const path = prev.path;
      let nextPath: NodePath | undefined;

      switch (ev.op) {
        case "toggle-text-code":
          nextPath = toggleCodeText(path);
          break;
        case "insert-before":
          nextPath = insertBefore(path);
          break;
        case "insert-after":
          nextPath = insertAfter(path);
          break;
        case "unwrap-if-single-child":
          nextPath = unwrapBlockIfSingleChild(path);
          break;
        case "wrap":
          nextPath = wrapWithBlock(path);
          break;
        case "remove":
          nextPath = removeChild(path);
          break;
      }

      return nextPath
        ? { kind: "ViewingValue", path: nextPath }
        : { kind: "Idle" };
    }
  }
}

function dispatch(ev: EditorEvent) {
  const prev = currentState;
  const next = transition(prev, ev);
  currentState = next;
  syncEditingDom(prev, next, ev);
  syncFocusDom(prev, next, ev);
}

function syncEditingDom(
  prev: MachineState,
  next: MachineState,
  ev: EditorEvent
) {
  if (prev.kind !== "Editing" && next.kind === "Editing") {
    const { inputEl } = next.session;

    const onKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Enter":
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "END_EDIT", reason: "commit", refocus: true });
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          dispatch({ type: "END_EDIT", reason: "cancel", refocus: true });
          break;
      }
    };

    const onBlur = () => {
      dispatch({ type: "END_EDIT", reason: "commit", refocus: false });
    };

    inputEl.addEventListener("keydown", onKeyDown);
    inputEl.addEventListener("blur", onBlur);
  }

  if (prev.kind === "Editing" && next.kind !== "Editing") {
    const { session, role, path } = prev;

    const reason: "commit" | "cancel" =
      ev.type === "END_EDIT"
        ? ev.reason
        : ev.type === "CLEAR_FOCUS"
        ? "cancel"
        : "commit";

    const text = session.value;
    session.dispose();

    const binding = getBinding(path);
    if (!binding) return;

    if (reason === "commit") {
      applyCommittedEdit(binding, text, role);
    }
  }
}

function syncFocusDom(prev: MachineState, next: MachineState, ev: EditorEvent) {
  if (next.kind !== "ViewingValue") return;
  if (ev.type === "END_EDIT" && ev.refocus === false) return;

  const el = getBinding(next.path)?.value?.el;
  if (!el) return;
  if (document.activeElement === el) return;

  el.focus({ preventScroll: true });
}

function applyCommittedEdit(binding: PathBinding, text: string, role: Role) {
  const { path } = binding;

  if (role === "key") {
    const trimmed = text.trim();
    if (trimmed === "") removeKey(path);
    else assignKey(path, trimmed);
    return;
  }

  if (!binding.value?.getText) return;
  setText(path, text);
}

export function registerBinding(
  path: NodePath,
  slots: { key?: RoleView; value?: RoleView }
) {
  const k = serializePath(path);
  const binding: PathBinding = {
    path: path.slice(),
    key: slots.key,
    value: slots.value,
  };
  bindingsByPath.set(k, binding);

  if (binding.key) {
    const el = binding.key.el;
    el.tabIndex = 0;

    el.addEventListener(
      "focus",
      (e: FocusEvent) => {
        if (e.target !== el) return;
        dispatch({ type: "FOCUS", binding, role: "value" });
      },
      true
    );

    el.addEventListener("dblclick", () => {
      if (!binding.key!.getText) return;
      dispatch({ type: "FOCUS", binding, role: "key" });
    });
  }

  if (binding.value) {
    const el = binding.value.el;
    el.tabIndex = 0;

    el.addEventListener(
      "focus",
      (e: FocusEvent) => {
        if (e.target !== el) return;
        dispatch({ type: "FOCUS", binding, role: "value" });
      },
      true
    );

    el.addEventListener("dblclick", () => {
      if (!binding.value!.getText) return;
      dispatch({ type: "FOCUS", binding, role: "value" });
      dispatch({ type: "BEGIN_EDIT" });
    });
  }
}

export function unregisterBinding(path: NodePath) {
  const k = serializePath(path);
  bindingsByPath.delete(k);

  const pathsEqual = (p: NodePath) =>
    JSON.stringify(p) === JSON.stringify(path);
  if (
    (currentState.kind === "ViewingValue" && pathsEqual(currentState.path)) ||
    (currentState.kind === "Editing" && pathsEqual(currentState.path))
  ) {
    dispatch({ type: "CLEAR_FOCUS" });
  }
}

export function onRootKeyDown(e: KeyboardEvent) {
  const activeEl = document.activeElement as HTMLElement | null;
  if (!activeEl || activeEl.tagName === "INPUT") return;

  if (currentState.kind === "Idle") return;

  const preventAndStop = () => {
    e.preventDefault();
    e.stopPropagation();
  };

  if (e.key === "Tab") {
    preventAndStop();

    if (
      currentState.kind === "ViewingValue" ||
      currentState.kind === "Editing"
    ) {
      const path = currentState.path;
      if (!parentPath(path)) return;

      const curRole: Role =
        currentState.kind === "Editing" ? currentState.role : "value";
      const nextRole = (curRole === "key" ? "value" : "key") as Role;
      dispatch({ type: "NAVIGATE", path, role: nextRole });
    }
    return;
  }

  if (currentState.kind === "ViewingValue" && e.key === "=") {
    preventAndStop();
    dispatch({ type: "TRANSFORM", op: "toggle-text-code" });
    return;
  }

  if (currentState.kind === "ViewingValue") {
    const binding = getBinding(currentState.path);
    const valueView = getRoleView(binding, "value");

    if (e.key === "Enter" && valueView?.getText) {
      preventAndStop();
      dispatch({ type: "BEGIN_EDIT" });
      return;
    }
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      valueView?.getText
    ) {
      preventAndStop();
      dispatch({ type: "BEGIN_EDIT", seed: e.key });
      return;
    }
  }

  if (
    e.shiftKey &&
    (currentState.kind === "ViewingValue" || currentState.kind === "Editing")
  ) {
    preventAndStop();
    switch (e.key) {
      case "ArrowUp":
        dispatch({ type: "TRANSFORM", op: "insert-before" });
        return;
      case "ArrowDown":
        dispatch({ type: "TRANSFORM", op: "insert-after" });
        return;
      case "ArrowLeft":
        dispatch({ type: "TRANSFORM", op: "unwrap-if-single-child" });
        return;
      case "ArrowRight":
        dispatch({ type: "TRANSFORM", op: "wrap" });
        return;
    }
  }

  if (
    e.key === "Backspace" &&
    (currentState.kind === "ViewingValue" || currentState.kind === "Editing")
  ) {
    preventAndStop();
    dispatch({ type: "TRANSFORM", op: "remove" });
    return;
  }

  if (currentState.kind === "ViewingValue" || currentState.kind === "Editing") {
    const path = currentState.path;
    const role = currentState.kind === "Editing" ? currentState.role : "value";

    switch (e.key) {
      case "ArrowUp": {
        preventAndStop();
        const up = siblingPath(path, -1);
        if (up) dispatch({ type: "NAVIGATE", path: up, role });
        return;
      }
      case "ArrowDown": {
        preventAndStop();
        const down = siblingPath(path, 1);
        if (down) dispatch({ type: "NAVIGATE", path: down, role });
        return;
      }
      case "ArrowLeft": {
        preventAndStop();
        const left = parentPath(path);
        if (left) dispatch({ type: "NAVIGATE", path: left, role });
        return;
      }
      case "ArrowRight": {
        preventAndStop();
        const right = firstChildPath(path);
        if (right) dispatch({ type: "NAVIGATE", path: right, role });
        return;
      }
    }
  }
}
