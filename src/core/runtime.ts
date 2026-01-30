import { signal, type Signal } from "@preact/signals-core";
import type { ItemId, Model } from "./model";

export type Focus = { scopeId: ItemId; id: ItemId };

export type FocusTarget = string;

export type Caret = { start: number; end: number };

export type Selection =
  | { kind: "idle" }
  | { kind: "focused"; focus: Focus; target: FocusTarget; caret?: Caret };

export type Anchor = "top" | "bottom";

export type EditorEffect =
  | { type: "FOCUS"; focus: Focus; target: FocusTarget; anchor?: Anchor }
  | { type: "CLEAR_FOCUS" };

export type ViewHandle = {
  root: HTMLElement;
  onKeyDown?: (e: KeyboardEvent) => void;
};

export type BindingHandle = unknown;

export type Binding = {
  focus: Focus;
  elementFor(target: FocusTarget): BindingHandle | null;
  caret?: { set(pos: number): void; getLength(): number };
};

const keyOf = (f: Focus): string => `${String(f.scopeId)}::${String(f.id)}`;

const isTextInput = (
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement =>
  (el instanceof HTMLInputElement && el.type === "text") ||
  el instanceof HTMLTextAreaElement;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

function shouldBypassGlobalKeydown(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type === "text")
  );
}

function normalizeEffectsForSelection(
  sel: Selection,
  effects: EditorEffect[],
): EditorEffect[] {
  const hasClear = effects.some((e) => e.type === "CLEAR_FOCUS");
  const hasFocus = effects.some((e) => e.type === "FOCUS");

  if (sel.kind === "idle")
    return hasClear ? effects : [...effects, { type: "CLEAR_FOCUS" }];

  if (hasClear) return effects;
  if (hasFocus) return effects;

  return [...effects, { type: "FOCUS", focus: sel.focus, target: sel.target }];
}

function viewAtTarget(
  viewRoots: WeakMap<HTMLElement, ViewHandle>,
  target: EventTarget | null,
): ViewHandle | null {
  for (
    let el0 = target instanceof HTMLElement ? target : null;
    el0;
    el0 = el0.parentElement
  ) {
    const hit = viewRoots.get(el0);
    if (hit) return hit;
  }
  return null;
}

function computeAnchoredPos(
  text: string,
  column: number,
  anchor: Anchor,
): number {
  const nl = anchor === "top" ? text.indexOf("\n") : text.lastIndexOf("\n");
  if (nl === -1) return clamp(column, 0, text.length);
  const lineStart = anchor === "top" ? 0 : nl + 1;
  return lineStart + clamp(column, 0, text.length - lineStart);
}

export type Shell = {
  selectionSignal: Signal<Selection>;

  selection(): Selection;

  setSelection(next: Selection, effects?: EditorEffect[]): void;
  focus(focus: Focus, target: FocusTarget, opts?: { caret?: Caret }): void;
  blur(): void;

  mountViewRoot(opts: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
  }): () => void;

  bindFocus(opts: {
    focus: Focus;
    elementFor: (target: FocusTarget) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  installGlobalListeners(win?: Window): () => void;

  dispose(): void;
};

export function createShell(opts: {
  model: Model;
  initialSelection?: Selection;
}): Shell {
  const { model } = opts;

  const selectionSignal = signal<Selection>(
    opts.initialSelection ?? { kind: "idle" },
  );

  const bindings = new Map<string, Binding>();

  const viewRoots = new WeakMap<HTMLElement, ViewHandle>();
  const views = new Set<ViewHandle>();
  let activeView: ViewHandle | null = null;

  let pending: { sel: Selection; effects: EditorEffect[] } | null = null;
  let flushScheduled = false;

  const getActiveView = (): ViewHandle | null => activeView;

  const setActiveView = (v: ViewHandle | null): void => {
    activeView = v;
  };

  const getBinding = (focus: Focus): Binding | null =>
    bindings.get(keyOf(focus)) ?? null;

  const applyDomFocus = (
    sel: Selection,
    focusEff: Extract<EditorEffect, { type: "FOCUS" }>,
  ): void => {
    if (sel.kind !== "focused") return;

    const binding = getBinding(sel.focus);
    const el0 = (binding?.elementFor(sel.target) as HTMLElement | null) ?? null;
    if (!binding || !el0) return;

    const wasFocused = document.activeElement === el0;
    if (!wasFocused) el0.focus({ preventScroll: true });

    const hitView = viewAtTarget(viewRoots, el0);
    if (hitView) setActiveView(hitView);

    const caret = sel.caret;
    const canCaret = !!caret && !!binding.caret;
    const shouldUpdateCaret = canCaret && (!wasFocused || !!focusEff.anchor);

    if (shouldUpdateCaret) {
      const len = binding.caret!.getLength();
      binding.caret!.set(clamp(caret!.end, 0, len));
      return;
    }

    if (!isTextInput(el0) || wasFocused) return;

    const pos = focusEff.anchor
      ? computeAnchoredPos(el0.value, el0.value.length, focusEff.anchor)
      : el0.value.length;

    el0.setSelectionRange(pos, pos);
  };

  const applyDomEffects = (sel: Selection, effects: EditorEffect[]): void => {
    for (const eff of effects) {
      if (eff.type === "FOCUS") {
        applyDomFocus(sel, eff);
      } else {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
    }
  };

  const scheduleEffects = (sel: Selection, effects: EditorEffect[]): void => {
    if (!effects.length) return;

    pending = pending
      ? { sel, effects: [...pending.effects, ...effects] }
      : { sel, effects };

    if (flushScheduled) return;
    flushScheduled = true;

    queueMicrotask(() => {
      flushScheduled = false;
      const next = pending;
      pending = null;
      if (next) applyDomEffects(next.sel, next.effects);
    });
  };

  const repairSelection = (sel: Selection): Selection => {
    if (sel.kind === "idle") return sel;

    try {
      model.peekItem(sel.focus.id);
      return sel;
    } catch {
      try {
        const rootId = model.rootId();
        model.peekItem(rootId);
        return {
          kind: "focused",
          focus: { scopeId: rootId, id: rootId },
          target: "content",
        };
      } catch {
        return { kind: "idle" };
      }
    }
  };

  const selection = (): Selection => selectionSignal.value;

  const setSelection = (
    next: Selection,
    effects: EditorEffect[] = [],
  ): void => {
    const repaired = repairSelection(next);
    selectionSignal.value = repaired;
    scheduleEffects(repaired, normalizeEffectsForSelection(repaired, effects));
  };

  const focus = (
    focus0: Focus,
    target: FocusTarget,
    opts2: { caret?: Caret } = {},
  ): void => {
    const next: Selection = {
      kind: "focused",
      focus: focus0,
      target,
      ...(opts2.caret ? { caret: opts2.caret } : {}),
    };
    setSelection(next);
  };

  const blur = (): void => {
    setSelection({ kind: "idle" });
  };

  const mountViewRoot = (v: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
  }): (() => void) => {
    const handle: ViewHandle = { root: v.root, onKeyDown: v.onKeyDown };
    viewRoots.set(handle.root, handle);
    views.add(handle);

    const onPointerDown = (e: PointerEvent) => {
      const hit = viewAtTarget(viewRoots, e.target);
      if (hit) setActiveView(hit);
    };

    handle.root.addEventListener("pointerdown", onPointerDown, {
      capture: true,
    });

    return () => {
      handle.root.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      } as any);
      views.delete(handle);
      if (getActiveView() === handle) setActiveView(null);

      for (const [k, b] of bindings) {
        if (
          keyOf(b.focus) === k &&
          viewAtTarget(viewRoots, b.elementFor("content") as any) === handle
        ) {
          void b;
        }
      }
    };
  };

  const bindFocus = (b: {
    focus: Focus;
    elementFor: (target: FocusTarget) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): (() => void) => {
    const binding: Binding = {
      focus: b.focus,
      elementFor: (t) => b.elementFor(t),
      ...(b.caret ? { caret: b.caret } : {}),
    };

    const k = keyOf(binding.focus);
    bindings.set(k, binding);

    return () => {
      bindings.delete(k);

      const sel = selectionSignal.peek();
      if (sel.kind === "focused" && keyOf(sel.focus) === k) {
        scheduleEffects(sel, [{ type: "CLEAR_FOCUS" }]);
      }
    };
  };

  const dispatchKeyDown = (e: KeyboardEvent) => {
    if (shouldBypassGlobalKeydown()) return;

    const v = getActiveView();
    if (!v?.onKeyDown) return;
    v.onKeyDown(e);
  };

  const installGlobalListeners = (win: Window = window): (() => void) => {
    const onKeyDown = (e: KeyboardEvent) => {
      dispatchKeyDown(e);
    };

    win.addEventListener("keydown", onKeyDown);
    return () => win.removeEventListener("keydown", onKeyDown);
  };

  const dispose = (): void => {
    bindings.clear();
    views.clear();
    activeView = null;
    pending = null;
    flushScheduled = false;
  };

  return {
    selectionSignal,
    selection,
    setSelection,
    focus,
    blur,
    mountViewRoot,
    bindFocus,
    installGlobalListeners,
    dispose,
  };
}
