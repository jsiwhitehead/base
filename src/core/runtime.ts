import { signal, type Signal } from "@preact/signals-core";
import type { EntryId, Model, ViewKind, ViewName } from "./model";

export const DEFAULT_TARGET = "default" as const;

export type ItemId = string;

export type Focus = { container: ItemId; item: ItemId };
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

export type Component = { el: HTMLElement; dispose(): void };

export type DomView = {
  id: string;
  root: HTMLElement;
  onKeyDown?: (e: KeyboardEvent) => void;
  dispose(): void;
};

export type ViewFactoryArgs<C> = { core: C; id: ItemId; focus?: Focus };
export type ViewFactory<C> = (args: ViewFactoryArgs<C>) => DomView;

const itemKey = (id: ItemId): string => id;
const keyOf = (f: Focus): string =>
  `${itemKey(f.container)}::${itemKey(f.item)}`;

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
    active instanceof HTMLInputElement ||
    active instanceof HTMLSelectElement
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

export const itemIdFromEntryId = (entryId: EntryId): ItemId =>
  `${String(entryId)}:`;

export const entryIdFromItemId = (id: ItemId): EntryId | null => {
  const i = id.indexOf(":");
  const head = i === -1 ? id : id.slice(0, i);
  const n = Number(head);
  return Number.isFinite(n) ? (n as EntryId) : null;
};

type TargetBinding = {
  getEl: () => HTMLElement | null;
  caret?: { set(pos: number): void; getLength(): number };
};

type TargetBindingRec = {
  binding: TargetBinding;
  token: number;
};

export type Runtime<C> = {
  selectionSignal: Signal<Selection>;

  selection(): Selection;

  setSelection(next: Selection, effects?: RuntimeEffect[]): void;

  attachTarget(opts: {
    focus: Focus;
    target: string;
    getEl: () => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): () => void;

  mountView(opts: { id: ItemId; focus?: Focus }): Component;
  mountView(opts: {
    id: ItemId;
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

  const bindings = new Map<string, Map<string, TargetBindingRec>>();

  const viewRoots = new WeakMap<HTMLElement, ViewHandle>();
  const viewsSet = new Set<ViewHandle>();
  let activeView: ViewHandle | null = null;

  let pending: { sel: Selection; effects: RuntimeEffect[] } | null = null;
  let flushScheduled = false;

  const getActiveView = (): ViewHandle | null => activeView;

  const setActiveView = (v: ViewHandle | null): void => {
    activeView = v;
  };

  const focusMapFor = (focus: Focus): Map<string, TargetBindingRec> => {
    const k = keyOf(focus);
    let m = bindings.get(k);
    if (!m) {
      m = new Map();
      bindings.set(k, m);
    }
    return m;
  };

  const resolveBinding = (
    focus: Focus,
    target: string,
  ): TargetBinding | null => {
    const m = bindings.get(keyOf(focus));
    if (!m) return null;
    return m.get(target)?.binding ?? m.get(DEFAULT_TARGET)?.binding ?? null;
  };

  const applyDomFocus = (
    sel: Selection,
    focusEff: Extract<RuntimeEffect, { type: "FOCUS" }>,
  ): void => {
    if (sel.kind !== "focused") return;

    const b = resolveBinding(sel.focus, sel.target);
    const el0 = (b?.getEl() as HTMLElement | null) ?? null;
    if (!b || !el0) return;

    const wasFocused = document.activeElement === el0;
    if (!wasFocused) el0.focus({ preventScroll: true });

    const hitView = viewAtTarget(viewRoots, el0);
    if (hitView) setActiveView(hitView);

    const caret = sel.caret;
    const canCaret = !!caret && !!b.caret;
    const shouldUpdateCaret = canCaret && (!wasFocused || !!focusEff.anchor);

    if (shouldUpdateCaret) {
      const len = b.caret!.getLength();
      b.caret!.set(clamp(caret!.end, 0, len));
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

  const canReadItem = (id: ItemId): boolean => {
    const entryId = entryIdFromItemId(id);
    if (entryId == null) return false;
    try {
      model.peekEntry(entryId);
      return true;
    } catch {
      return false;
    }
  };

  const repairSelection = (sel: Selection): Selection => {
    if (sel.kind === "idle") return sel;

    if (canReadItem(sel.focus.item) && canReadItem(sel.focus.container))
      return sel;

    try {
      const rootEntryId = model.rootId();
      model.peekEntry(rootEntryId);
      const rootId = itemIdFromEntryId(rootEntryId);
      return {
        kind: "focused",
        focus: { container: rootId, item: rootId },
        target: DEFAULT_TARGET,
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

    return () => {
      viewsSet.delete(handle);
      if (getActiveView() === handle) setActiveView(null);
    };
  };

  const attachTarget = (b: {
    focus: Focus;
    target: string;
    getEl: () => HTMLElement | null;
    caret?: { set(pos: number): void; getLength(): number };
  }): (() => void) => {
    const m = focusMapFor(b.focus);
    const prev = m.get(b.target);
    const nextToken = (prev?.token ?? 0) + 1;

    m.set(b.target, {
      binding: { getEl: b.getEl, ...(b.caret ? { caret: b.caret } : {}) },
      token: nextToken,
    });

    const focusKey = keyOf(b.focus);
    const targetKey = b.target;
    const tokenAtAttach = nextToken;

    return () => {
      const mm = bindings.get(focusKey);
      const cur = mm?.get(targetKey);
      if (!mm || !cur) return;
      if (cur.token !== tokenAtAttach) return;

      mm.delete(targetKey);
      if (mm.size === 0) bindings.delete(focusKey);

      const sel = selectionSignal.peek();
      if (
        sel.kind === "focused" &&
        keyOf(sel.focus) === focusKey &&
        (sel.target === targetKey || targetKey === DEFAULT_TARGET)
      ) {
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

  const resolveWanted = (id: ItemId): ViewName => {
    const entryId = entryIdFromItemId(id);
    if (entryId == null) return "outline";

    let v: ViewKind = null;
    try {
      v = model.readEntry(entryId).view;
    } catch {
      v = null;
    }

    const wanted = (v ?? "outline") as ViewName;
    return (wanted in views ? wanted : "outline") as ViewName;
  };

  function mountView(opts2: { id: ItemId; focus?: Focus }): Component;
  function mountView(opts2: {
    id: ItemId;
    focus?: Focus;
    continueAs: ViewName;
  }): Component | null;
  function mountView(opts2: {
    id: ItemId;
    focus?: Focus;
    continueAs?: ViewName;
  }): Component | null {
    const id = opts2.id;
    const focus: Focus = opts2.focus ?? { container: id, item: id };

    const entryId = entryIdFromItemId(id);
    if (entryId == null)
      return opts2.continueAs
        ? null
        : { el: document.createElement("div"), dispose() {} };

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
    attachTarget,
    mountView,
    installGlobalListeners,
    dispose,
  };
}
