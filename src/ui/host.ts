import type {
  Anchor,
  Caret,
  EditorEffect,
  EditorRuntime,
  Focus,
  FocusTarget,
  Selection,
} from "../core/runtime";

const keyOf = (f: Focus): string => `${String(f.scopeId)}::${String(f.id)}`;

export type ViewId = string;

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";
export type NavOut = { dir: NavDir; mode: NavMode };
export type ViewKeyResult = void | { navOut: NavOut };

export type View = {
  id: ViewId;
  onKeyDown?: (e: unknown) => ViewKeyResult;
  onActivate?(): void;
  onDeactivate?(): void;
  dispose(): void;
};

export type BindingHandle = unknown;

export type Binding = {
  focus: Focus;
  elementFor(target: FocusTarget): BindingHandle | null;
  setCaret?: (pos: number) => void;
  getTextLength?: () => number;
};

type DomView = View & { root: HTMLElement };

export type DomHost = {
  runtime: EditorRuntime;

  installGlobalListeners(win?: Window): () => void;

  mountViewInto(host: HTMLElement, view: DomView): () => void;

  registerBinding(binding: Binding): void;
  unregisterBinding(focus: Focus): void;
  getBinding(focus: Focus): Binding | null;

  registerView(view: View): void;
  unregisterView(viewId: ViewId): void;

  getActiveViewId(): ViewId | null;
  getActiveView(): View | null;
  setActiveView(viewId: ViewId | null): void;

  setNavOutHandler(
    fn: ((fromViewId: ViewId, navOut: NavOut) => void) | null,
  ): void;
  dispatchKeyDown(e: unknown): void;

  dispose(): void;
};

export function createDomHost(opts: { runtime: EditorRuntime }): DomHost {
  const runtime = opts.runtime;

  const bindings = new Map<string, Binding>();

  const views = new Map<ViewId, View>();
  let activeViewId: ViewId | null = null;

  let navOutHandler: ((fromViewId: ViewId, navOut: NavOut) => void) | null =
    null;

  const viewRoots = new WeakMap<HTMLElement, ViewId>();

  const getActiveViewId = (): ViewId | null => activeViewId;

  const getActiveView = (): View | null => {
    const id = activeViewId;
    return id ? (views.get(id) ?? null) : null;
  };

  const setActiveView = (viewId: ViewId | null): void => {
    if (viewId === activeViewId) return;

    const prevId = activeViewId;
    const prev = prevId ? views.get(prevId) : null;
    const next = viewId ? views.get(viewId) : null;

    prev?.onDeactivate?.();
    activeViewId = viewId;
    next?.onActivate?.();
  };

  const setNavOutHandler = (
    fn: ((fromViewId: ViewId, navOut: NavOut) => void) | null,
  ): void => {
    navOutHandler = fn;
  };

  const registerView = (view: View): void => {
    views.set(view.id, view);
  };

  const unregisterView = (viewId: ViewId): void => {
    if (activeViewId === viewId) setActiveView(null);
    views.delete(viewId);
  };

  const dispatchKeyDown = (e: unknown): void => {
    const viewId = activeViewId;
    if (!viewId) return;

    const res = views.get(viewId)?.onKeyDown?.(e);
    if (res && "navOut" in res && res.navOut) {
      navOutHandler?.(viewId, res.navOut);
    }
  };

  const registerBinding = (binding: Binding): void => {
    bindings.set(keyOf(binding.focus), binding);
  };

  const unregisterBinding = (focus: Focus): void => {
    const k = keyOf(focus);
    bindings.delete(k);

    const sel = runtime.selection.peek() as Selection;
    if (sel.kind !== "focused" || keyOf(sel.focus) !== k) return;

    runtime.scheduleEffects(sel, [{ type: "CLEAR_FOCUS" }]);
  };

  const getBinding = (focus: Focus): Binding | null =>
    bindings.get(keyOf(focus)) ?? null;

  const clamp = (n: number, lo: number, hi: number): number =>
    Math.max(lo, Math.min(hi, n));

  const isTextInput = (
    el: HTMLElement,
  ): el is HTMLInputElement | HTMLTextAreaElement =>
    (el instanceof HTMLInputElement && el.type === "text") ||
    el instanceof HTMLTextAreaElement;

  const computeAnchoredPos = (
    text: string,
    column: number,
    anchor: Anchor,
  ): number => {
    const nl = anchor === "top" ? text.indexOf("\n") : text.lastIndexOf("\n");
    if (nl === -1) return clamp(column, 0, text.length);
    const lineStart = anchor === "top" ? 0 : nl + 1;
    return lineStart + clamp(column, 0, text.length - lineStart);
  };

  const viewAtTarget = (target: EventTarget | null): ViewId | null => {
    for (
      let el0 = target instanceof HTMLElement ? target : null;
      el0;
      el0 = el0.parentElement
    ) {
      const hit = viewRoots.get(el0);
      if (hit) return hit;
    }
    return null;
  };

  const updateDOMFocus = (sel: Selection, anchor?: Anchor): void => {
    if (sel.kind !== "focused") return;

    const binding = getBinding(sel.focus);
    const targetEl =
      (binding?.elementFor(sel.target) as HTMLElement | null) ?? null;
    if (!binding || !targetEl) return;

    const wasFocused = document.activeElement === targetEl;
    if (!wasFocused) targetEl.focus({ preventScroll: true });

    const hitView = viewAtTarget(targetEl);
    if (hitView) setActiveView(hitView);

    const caret = (sel as any).caret as Caret | undefined;
    const canSetCaret =
      !!caret && !!binding.setCaret && !!binding.getTextLength;
    const shouldUpdateCaret = canSetCaret && (!wasFocused || !!anchor);

    if (shouldUpdateCaret) {
      const len = binding.getTextLength!();
      binding.setCaret!(clamp(caret!.end, 0, len));
      return;
    }

    if (!isTextInput(targetEl) || wasFocused) return;

    const pos = anchor
      ? computeAnchoredPos(targetEl.value, targetEl.value.length, anchor)
      : targetEl.value.length;

    targetEl.setSelectionRange(pos, pos);
  };

  const applyDomEffects = (sel: Selection, effects: EditorEffect[]): void => {
    for (const eff of effects) {
      if (eff.type === "FOCUS") {
        updateDOMFocus(sel, eff.anchor);
      } else {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
    }
  };

  runtime.setEffectsApplier((sel, effects) =>
    applyDomEffects(sel as Selection, effects),
  );

  const shouldBypassGlobalKeydown = (): boolean => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return false;
    if (active.isContentEditable) return true;
    return (
      active instanceof HTMLTextAreaElement ||
      (active instanceof HTMLInputElement && active.type === "text")
    );
  };

  const installGlobalListeners = (win: Window = window): (() => void) => {
    const onPointerDown = (e: PointerEvent) =>
      setActiveView(viewAtTarget(e.target));

    const pointerOptions = { capture: true } as const;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!activeViewId || shouldBypassGlobalKeydown()) return;
      dispatchKeyDown(e);
    };

    win.addEventListener("pointerdown", onPointerDown, pointerOptions);
    win.addEventListener("keydown", onKeyDown);

    return () => {
      win.removeEventListener("pointerdown", onPointerDown, pointerOptions);
      win.removeEventListener("keydown", onKeyDown);
    };
  };

  const mountViewInto = (host: HTMLElement, view: DomView): (() => void) => {
    viewRoots.set(view.root, view.id);
    registerView(view);
    host.replaceChildren(view.root);
    return () => {
      unregisterView(view.id);
      view.dispose();
      host.replaceChildren();
    };
  };

  const dispose = (): void => {
    bindings.clear();
    for (const v of views.values()) v.dispose();
    views.clear();
    activeViewId = null;
    navOutHandler = null;
  };

  return {
    runtime,

    installGlobalListeners,
    mountViewInto,

    registerBinding,
    unregisterBinding,
    getBinding,

    registerView,
    unregisterView,

    getActiveViewId,
    getActiveView,
    setActiveView,

    setNavOutHandler,
    dispatchKeyDown,

    dispose,
  };
}
