import { signal, type Signal } from "@preact/signals-core";
import type { EntryId, Model, ViewKind, ViewName } from "./model";

export type ItemRef = { entryId: EntryId; path: readonly number[] };

export type Focus = { scope: ItemRef; ref: ItemRef };
export type Caret = { start: number; end: number };

export type Selection =
  | { kind: "idle" }
  | { kind: "focused"; focus: Focus; target: string; caret?: Caret };

export type Anchor = "top" | "bottom";

export type RuntimeEffect =
  | { type: "FOCUS"; focus: Focus; target: string; anchor?: Anchor }
  | { type: "CLEAR_FOCUS" };

export type ViewHandle = {
  root: HTMLElement;
  onKeyDown?: (e: KeyboardEvent) => void;
};

export type FocusBinding = {
  focus: Focus;
  elementFor(target: string): HTMLElement | null;
  caret?: { set(pos: number): void; getLength(): number };
};

export type Component = { el: HTMLElement; dispose(): void };

export type DomView = {
  id: string;
  root: HTMLElement;
  onKeyDown?: (e: KeyboardEvent) => void;
  dispose(): void;
};

export type ViewFactoryArgs<C> = { core: C; id: EntryId; focus?: Focus };
export type ViewFactory<C> = (args: ViewFactoryArgs<C>) => DomView;

const refKey = (r: ItemRef): string =>
  `${String(r.entryId)}:${r.path.length ? r.path.join(",") : ""}`;

const keyOf = (f: Focus): string => `${refKey(f.scope)}::${refKey(f.ref)}`;

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

export const isTextInput = (
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement =>
  (el instanceof HTMLInputElement && el.type === "text") ||
  el instanceof HTMLTextAreaElement;

export type TextCaret = {
  read(): Caret;
  set(pos: number): void;
  getLength(): number;
};

export function defaultTextCaret(
  getActive: () => Element | null = () => document.activeElement,
): TextCaret {
  const activeTextEl = (): HTMLInputElement | HTMLTextAreaElement | null => {
    const a = getActive();
    return a instanceof HTMLElement && isTextInput(a) ? a : null;
  };

  return {
    read(): Caret {
      const el = activeTextEl();
      if (!el) return { start: 0, end: 0 };
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? start;
      return { start, end };
    },
    set(pos: number): void {
      const el = activeTextEl();
      if (!el) return;
      const len = el.value.length;
      const p = clamp(pos, 0, len);
      el.setSelectionRange(p, p);
    },
    getLength(): number {
      const el = activeTextEl();
      return el ? el.value.length : 0;
    },
  };
}

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
  effects: RuntimeEffect[],
): RuntimeEffect[] {
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

const entryRef = (entryId: EntryId): ItemRef => ({ entryId, path: [] });

export type Runtime<C> = {
  selectionSignal: Signal<Selection>;

  selection(): Selection;

  setSelection(next: Selection, effects?: RuntimeEffect[]): void;

  attachFocus(opts: {
    focus: Focus;
    elementFor: (target: string) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  mountView(opts: { id: EntryId; focus?: Focus }): Component;
  mountView(opts: {
    id: EntryId;
    focus?: Focus;
    continueAs: ViewName;
  }): Component | null;

  installGlobalListeners(win?: Window): () => void;

  dispose(): void;
};

export function createRuntime<C>(opts: {
  model: Model;
  getCore: () => C;
  views: Partial<Record<ViewName, ViewFactory<C>>>;
  initialSelection?: Selection;
}): Runtime<C> {
  const { model } = opts;
  const views = opts.views;

  const selectionSignal = signal<Selection>(
    opts.initialSelection ?? { kind: "idle" },
  );

  const bindings = new Map<string, FocusBinding>();

  const viewRoots = new WeakMap<HTMLElement, ViewHandle>();
  const viewsSet = new Set<ViewHandle>();
  let activeView: ViewHandle | null = null;

  let pending: { sel: Selection; effects: RuntimeEffect[] } | null = null;
  let flushScheduled = false;

  const getActiveView = (): ViewHandle | null => activeView;

  const setActiveView = (v: ViewHandle | null): void => {
    activeView = v;
  };

  const getBinding = (focus: Focus): FocusBinding | null =>
    bindings.get(keyOf(focus)) ?? null;

  const applyDomFocus = (
    sel: Selection,
    focusEff: Extract<RuntimeEffect, { type: "FOCUS" }>,
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

  const applyDomEffects = (sel: Selection, effects: RuntimeEffect[]): void => {
    for (const eff of effects) {
      if (eff.type === "FOCUS") {
        applyDomFocus(sel, eff);
      } else {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
    }
  };

  const scheduleEffects = (sel: Selection, effects: RuntimeEffect[]): void => {
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

  const enqueueDomEffects = (
    sel: Selection,
    effects: RuntimeEffect[],
  ): void => {
    scheduleEffects(sel, normalizeEffectsForSelection(sel, effects));
  };

  const canReadEntry = (id: EntryId): boolean => {
    try {
      model.peekEntry(id);
      return true;
    } catch {
      return false;
    }
  };

  const repairSelection = (sel: Selection): Selection => {
    if (sel.kind === "idle") return sel;

    if (
      canReadEntry(sel.focus.ref.entryId) &&
      canReadEntry(sel.focus.scope.entryId)
    )
      return sel;

    try {
      const rootId = model.rootId();
      model.peekEntry(rootId);
      const r = entryRef(rootId);
      return {
        kind: "focused",
        focus: { scope: r, ref: r },
        target: "content",
      };
    } catch {
      return { kind: "idle" };
    }
  };

  const selection = (): Selection => selectionSignal.value;

  const setSelection = (
    next: Selection,
    effects: RuntimeEffect[] = [],
  ): void => {
    const repaired = repairSelection(next);
    selectionSignal.value = repaired;
    enqueueDomEffects(repaired, effects);
  };

  const registerViewRoot = (v: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
  }): (() => void) => {
    const handle: ViewHandle = { root: v.root, onKeyDown: v.onKeyDown };
    viewRoots.set(handle.root, handle);
    viewsSet.add(handle);

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
      viewsSet.delete(handle);
      if (getActiveView() === handle) setActiveView(null);
    };
  };

  const attachFocus = (b: {
    focus: Focus;
    elementFor: (target: string) => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): (() => void) => {
    const binding: FocusBinding = {
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

  const resolveWanted = (id: EntryId): ViewName => {
    let v: ViewKind = null;
    try {
      v = model.readEntry(id).view;
    } catch {
      v = null;
    }

    const wanted = (v ?? "outline") as ViewName;
    return (wanted in views ? wanted : "outline") as ViewName;
  };

  function mountView(opts2: { id: EntryId; focus?: Focus }): Component;
  function mountView(opts2: {
    id: EntryId;
    focus?: Focus;
    continueAs: ViewName;
  }): Component | null;
  function mountView(opts2: {
    id: EntryId;
    focus?: Focus;
    continueAs?: ViewName;
  }): Component | null {
    const id = opts2.id;
    const baseRef = entryRef(id);
    const focus: Focus = opts2.focus ?? { scope: baseRef, ref: baseRef };
    const wanted = resolveWanted(id);

    if (opts2.continueAs && wanted === opts2.continueAs) return null;

    const factory = views[wanted];
    if (!factory) return null;

    const view = factory({ core: opts.getCore(), id, focus });

    const unreg = registerViewRoot({
      root: view.root,
      onKeyDown: view.onKeyDown,
    });

    return {
      el: view.root,
      dispose() {
        unreg();
        view.dispose();
      },
    };
  }

  const dispose = (): void => {
    bindings.clear();
    viewsSet.clear();
    activeView = null;
    pending = null;
    flushScheduled = false;
  };

  return {
    selectionSignal,
    selection,
    setSelection,
    attachFocus,
    mountView: mountView as any,
    installGlobalListeners,
    dispose,
  };
}
