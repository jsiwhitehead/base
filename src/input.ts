import {
  type NodePath,
  parentPath,
  siblingPath,
  firstChildPath,
  setText,
  assignKey,
  removeKey,
  insertBefore,
  insertAfter,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
  removeChild,
} from "./tree";

export type Role = "key" | "value";

type EditableConfig = {
  getText: () => string;
  anchorEl?: HTMLElement;
};

type RoleView = {
  el: HTMLElement;
  editable?: EditableConfig;
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
  | { type: "BEGIN_EDIT"; seed?: string }
  | { type: "END_EDIT"; reason: "commit" | "cancel"; refocus?: boolean }
  | { type: "NAVIGATE"; path: NodePath; role: Role }
  | { type: "CLEAR_FOCUS" };

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
  public readonly inputEl: HTMLInputElement;
  public readonly hostEl: HTMLElement;

  private replacedHostNode = false;

  constructor(roleView: RoleView, role: Role, seed?: string) {
    const hostEl = roleView.el;
    const meta = roleView.editable!;
    const input = document.createElement("input");

    const isExpr = hostEl.classList.contains("expr");

    // Only inherit host classes (e.g., "expr") when editing the value.
    if (role === "value") {
      for (const c of Array.from(hostEl.classList)) {
        if (c === "key" || c === "value") continue;
        input.classList.add(c);
      }
    }

    const anchor = role === "key" ? meta.anchorEl : undefined;

    // For key edits, always style as a "key" (never "expr").
    if (role === "key") {
      input.classList.add("key");
    } else if (!isExpr) {
      // For non-expr value edits, add the "value" class for styling.
      input.classList.add("value");
    }

    if (anchor && anchor.parentNode) {
      anchor.parentNode.insertBefore(input, anchor);
    } else {
      const parent = hostEl.parentNode as ParentNode | null;
      if (parent) parent.replaceChild(input, hostEl);
      this.replacedHostNode = true;
    }

    queueMicrotask(() => {
      input.focus({ preventScroll: true });
    });

    input.setAttribute("autocorrect", "off");
    input.setAttribute("autocomplete", "off");
    (input as any).autocapitalize = "off";
    input.spellcheck = false;
    input.value = seed ?? meta.getText();

    this.inputEl = input;
    this.hostEl = hostEl;
  }

  get value() {
    return this.inputEl.value;
  }

  dispose() {
    const p = this.inputEl.parentNode as ParentNode | null;
    if (this.replacedHostNode) {
      if (p) p.replaceChild(this.hostEl, this.inputEl);
      else if (this.hostEl.parentNode)
        this.hostEl.parentNode.appendChild(this.hostEl);
    } else if (p) {
      p.removeChild(this.inputEl);
    }
  }
}

function computeEntryState(
  binding: PathBinding,
  role: Role,
  seed?: string
): MachineState {
  if (role === "key") {
    if (binding.key?.editable) {
      const session = new InlineEditor(binding.key, "key", seed);
      return { kind: "Editing", role: "key", path: binding.path, session };
    }

    const hasAnchor = !!binding.value?.editable?.anchorEl;
    if (hasAnchor) {
      const session = new InlineEditor(binding.value!, "key", "");
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

    case "BEGIN_EDIT": {
      if (prev.kind !== "ViewingValue") return prev;
      const binding = getBinding(prev.path);
      const valueView = getRoleView(binding, "value");
      if (!valueView?.editable) return prev;
      const session = new InlineEditor(valueView, "value", ev.seed);
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

    case "CLEAR_FOCUS": {
      return { kind: "Idle" };
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

  setText(path, text);
}

export function registerBinding(
  path: NodePath,
  slots: {
    key?: { el: HTMLElement; editable?: EditableConfig };
    value?: { el: HTMLElement; editable?: EditableConfig };
  }
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
        dispatch({ type: "FOCUS", binding, role: "key" });
      },
      true
    );

    el.addEventListener("dblclick", () => {
      if (!binding.key!.editable) return;
      dispatch({ type: "FOCUS", binding, role: "key" });
      dispatch({ type: "BEGIN_EDIT" });
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
      if (!binding.value!.editable) return;
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
      const nextRole = flipRole(curRole);
      dispatch({ type: "NAVIGATE", path, role: nextRole });
    }
    return;
  }

  if (currentState.kind === "ViewingValue") {
    const binding = getBinding(currentState.path);
    const valueView = getRoleView(binding, "value");

    if (e.key === "Enter" && valueView?.editable) {
      preventAndStop();
      dispatch({ type: "BEGIN_EDIT" });
      return;
    }
    if (
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      valueView?.editable
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
    const path = currentState.path;
    const role = currentState.kind === "Editing" ? currentState.role : "value";

    const navigateTo = (next?: NodePath) =>
      next && dispatch({ type: "NAVIGATE", path: next, role });

    switch (e.key) {
      case "ArrowUp":
        preventAndStop();
        navigateTo(insertBefore(path));
        return;
      case "ArrowDown":
        preventAndStop();
        navigateTo(insertAfter(path));
        return;
      case "ArrowLeft":
        preventAndStop();
        navigateTo(unwrapBlockIfSingleChild(path));
        return;
      case "ArrowRight":
        preventAndStop();
        navigateTo(wrapWithBlock(path));
        return;
    }
  }

  if (
    e.key === "Backspace" &&
    (currentState.kind === "ViewingValue" || currentState.kind === "Editing")
  ) {
    preventAndStop();
    const path = currentState.path;
    const role = currentState.kind === "Editing" ? currentState.role : "value";
    const next = removeChild(path);

    if (next) {
      dispatch({ type: "NAVIGATE", path: next, role });
    } else {
      dispatch({ type: "CLEAR_FOCUS" });
    }
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
