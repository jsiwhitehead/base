import type { Signal } from "@preact/signals-core";
import { signal } from "@preact/signals-core";

import type { EntryId, Model, ViewName } from "./model";

export const DEFAULT_TARGET = "default" as const;
export const LABEL_TARGET = "label" as const;
export const VALUE_TARGET = "value" as const;
export const connTarget: (key: string) => string = (key) => `conn:${key}`;

type ItemId = string;

export type Focus = { container: ItemId; item: ItemId };
export type Caret = { start: number; end: number };

export type Selection =
  | { type: "idle" }
  | { type: "focused"; focus: Focus; target: string; caret?: Caret };

type Anchor = "top" | "bottom";

type RuntimeEffect =
  | { type: "FOCUS"; focus: Focus; target: string; anchor?: Anchor }
  | { type: "CLEAR_FOCUS" };

export type Intent =
  | {
      type: "NAV";
      dir: "left" | "right" | "up" | "down";
      mode: "step" | "jump";
    }
  | { type: "CONFIRM"; caret?: Caret }
  | { type: "CANCEL" }
  | { type: "TAB"; shift: boolean; caret?: Caret }
  | { type: "TYPE"; char: string }
  | { type: "DELETE"; dir: "backward" | "forward" };

export type ViewIntent = Exclude<Intent, { type: "CANCEL" }>;

type ViewHandle = {
  root: HTMLElement;
  onIntent?: (intent: ViewIntent) => void;
};

export type Component = { el: HTMLElement; dispose(): void };

export type DomView = {
  root: HTMLElement;
  onIntent?: (intent: ViewIntent) => void;
  dispose(): void;
};

export type ViewFactory<C> = (args: {
  core: C;
  id: ItemId;
  focus?: Focus;
}) => DomView;

const itemKey = (id: ItemId): string => id;
const keyOf = (f: Focus): string =>
  `${itemKey(f.container)}::${itemKey(f.item)}`;

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

const isTextInput = (
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement =>
  (el instanceof HTMLInputElement && el.type === "text") ||
  el instanceof HTMLTextAreaElement;

function assertNever(_exhaustive: never, message: string): never {
  throw new Error(message);
}

type TextCaret = {
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

export function typeCharIntoFocusedTextInput(text: string): void {
  const activeEl = document.activeElement;
  if (
    !(
      activeEl instanceof HTMLInputElement ||
      activeEl instanceof HTMLTextAreaElement
    )
  )
    return;
  if (activeEl.readOnly || activeEl.disabled) return;

  const start = activeEl.selectionStart ?? 0;
  const end = activeEl.selectionEnd ?? start;

  activeEl.setRangeText(text, start, end, "end");
  activeEl.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function parseKeydownIntent(e: KeyboardEvent): Intent | null {
  if (e.key === "Escape") return { type: "CANCEL" };
  if (e.key === "Tab") return { type: "TAB", shift: !!e.shiftKey };
  if (e.key === "Enter") return { type: "CONFIRM" };

  if (e.key === "Backspace") return { type: "DELETE", dir: "backward" };
  if (e.key === "Delete") return { type: "DELETE", dir: "forward" };

  let dir: "left" | "right" | "up" | "down" | null = null;
  switch (e.key) {
    case "ArrowLeft":
      dir = "left";
      break;
    case "ArrowRight":
      dir = "right";
      break;
    case "ArrowUp":
      dir = "up";
      break;
    case "ArrowDown":
      dir = "down";
      break;
  }
  if (dir) {
    return {
      type: "NAV",
      dir,
      mode: e.metaKey || e.ctrlKey ? "jump" : "step",
    };
  }

  if (!(e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1) {
    return { type: "TYPE", char: e.key };
  }

  return null;
}

function normalizeEffectsForSelection(
  sel: Selection,
  effects: RuntimeEffect[],
): RuntimeEffect[] {
  const hasClear = effects.some((e) => e.type === "CLEAR_FOCUS");
  const hasFocus = effects.some((e) => e.type === "FOCUS");

  if (sel.type === "idle")
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
    let el = target instanceof HTMLElement ? target : null;
    el;
    el = el.parentElement
  ) {
    const hit = viewRoots.get(el);
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

const itemIdFromEntryId = (entryId: EntryId): ItemId => `${String(entryId)}:`;

const entryIdFromItemId = (id: ItemId): EntryId | null => {
  const i = id.indexOf(":");
  const head = i === -1 ? id : id.slice(0, i);
  const n = Number(head);
  return Number.isFinite(n) ? (n as EntryId) : null;
};

type TargetBinding = {
  getEl: () => HTMLElement | null;
  caret?: { set(pos: number): void; getLength(): number };
};

type TargetBindingRecord = {
  binding: TargetBinding;
  token: number;
};

type AttachTargetOpts = {
  focus: Focus;
  target: string;
  getEl: () => HTMLElement | null;
  caret?: { set(pos: number): void; getLength(): number };
};

type MountViewOpts = {
  id: ItemId;
  focus?: Focus;
  view: ViewName;
};

type Runtime = {
  selectionSignal: Signal<Selection>;

  selection(): Selection;

  setSelection(next: Selection, effects?: RuntimeEffect[]): void;

  attachTarget(opts: AttachTargetOpts): () => void;

  mountView(opts: MountViewOpts): Component;

  installGlobalListeners(win?: Window): () => void;

  getActiveViewRoot(): HTMLElement | null;

  getActiveViewOnIntent(): ((intent: ViewIntent) => void) | null;

  dispose(): void;
};

export function createRuntime<C>(opts: {
  model: Model;
  getCore: () => C;
  views: Partial<Record<ViewName, ViewFactory<C>>>;
  dispatchIntent: (intent: Intent) => void;
  initialSelection?: Selection;
}): Runtime {
  const { model } = opts;
  const views = opts.views;

  const selectionSignal = signal<Selection>(
    opts.initialSelection ?? { type: "idle" },
  );

  const bindings = new Map<string, Map<string, TargetBindingRecord>>();

  const viewRoots = new WeakMap<HTMLElement, ViewHandle>();
  let activeView: ViewHandle | null = null;

  let pending: { selection: Selection; effects: RuntimeEffect[] } | null = null;
  let flushScheduled = false;

  const getActiveView = (): ViewHandle | null => activeView;

  const setActiveView = (v: ViewHandle | null): void => {
    activeView = v;
  };

  const updateActiveViewForTarget = (target: EventTarget | null): void => {
    const hit = viewAtTarget(viewRoots, target);
    setActiveView(hit);
  };

  const focusMapFor = (focus: Focus): Map<string, TargetBindingRecord> => {
    const focusKey = keyOf(focus);
    let targetBindings = bindings.get(focusKey);
    if (!targetBindings) {
      targetBindings = new Map();
      bindings.set(focusKey, targetBindings);
    }
    return targetBindings;
  };

  const resolveBinding = (
    focus: Focus,
    target: string,
  ): TargetBinding | null => {
    const targetBindings = bindings.get(keyOf(focus));
    if (!targetBindings) return null;
    return (
      targetBindings.get(target)?.binding ??
      targetBindings.get(DEFAULT_TARGET)?.binding ??
      null
    );
  };

  const applyDomFocus = (
    sel: Selection,
    focusEff: Extract<RuntimeEffect, { type: "FOCUS" }>,
  ): void => {
    if (sel.type !== "focused") return;

    const binding = resolveBinding(sel.focus, sel.target);
    const targetEl = (binding?.getEl() as HTMLElement | null) ?? null;
    if (!binding || !targetEl) return;

    updateActiveViewForTarget(targetEl);

    const wasFocused = document.activeElement === targetEl;
    if (!wasFocused) targetEl.focus({ preventScroll: true });

    const caret = sel.caret;
    const canCaret = !!caret && !!binding.caret;
    const shouldUpdateCaret = canCaret && (!wasFocused || !!focusEff.anchor);

    if (shouldUpdateCaret) {
      const len = binding.caret!.getLength();
      binding.caret!.set(clamp(caret!.end, 0, len));
      return;
    }

    if (!isTextInput(targetEl) || wasFocused) return;

    const pos = focusEff.anchor
      ? computeAnchoredPos(
          targetEl.value,
          targetEl.value.length,
          focusEff.anchor,
        )
      : targetEl.value.length;

    targetEl.setSelectionRange(pos, pos);
  };

  const applyDomEffects = (sel: Selection, effects: RuntimeEffect[]): void => {
    for (const eff of effects) {
      switch (eff.type) {
        case "FOCUS":
          applyDomFocus(sel, eff);
          break;
        case "CLEAR_FOCUS": {
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          setActiveView(null);
          break;
        }
        default:
          assertNever(eff, "Unhandled runtime effect");
      }
    }
  };

  const scheduleEffects = (sel: Selection, effects: RuntimeEffect[]): void => {
    if (!effects.length) return;

    pending = pending
      ? { selection: sel, effects: [...pending.effects, ...effects] }
      : { selection: sel, effects };

    if (flushScheduled) return;
    flushScheduled = true;

    queueMicrotask(() => {
      flushScheduled = false;
      const next = pending;
      pending = null;
      if (next) applyDomEffects(next.selection, next.effects);
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
    if (sel.type === "idle") return sel;

    if (canReadItem(sel.focus.item) && canReadItem(sel.focus.container))
      return sel;

    try {
      const rootEntryId = model.rootId();
      model.peekEntry(rootEntryId);
      const rootId = itemIdFromEntryId(rootEntryId);
      return {
        type: "focused",
        focus: { container: rootId, item: rootId },
        target: DEFAULT_TARGET,
      };
    } catch {
      return { type: "idle" };
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

  const registerViewRoot = (view: {
    root: HTMLElement;
    onIntent?: (intent: ViewIntent) => void;
  }): (() => void) => {
    const handle: ViewHandle = {
      root: view.root,
      ...(view.onIntent ? { onIntent: view.onIntent } : {}),
    };

    viewRoots.set(handle.root, handle);

    return () => {
      if (getActiveView() === handle) setActiveView(null);
    };
  };

  const attachTarget = (target: AttachTargetOpts): (() => void) => {
    const targetBindings = focusMapFor(target.focus);
    const prev = targetBindings.get(target.target);
    const nextToken = (prev?.token ?? 0) + 1;

    targetBindings.set(target.target, {
      binding: {
        getEl: target.getEl,
        ...(target.caret ? { caret: target.caret } : {}),
      },
      token: nextToken,
    });

    const focusKey = keyOf(target.focus);
    const targetKey = target.target;
    const tokenAtAttach = nextToken;

    return () => {
      const targetBindingsAtFocus = bindings.get(focusKey);
      const cur = targetBindingsAtFocus?.get(targetKey);
      if (!targetBindingsAtFocus || !cur) return;
      if (cur.token !== tokenAtAttach) return;

      targetBindingsAtFocus.delete(targetKey);
      if (targetBindingsAtFocus.size === 0) bindings.delete(focusKey);

      const sel = selectionSignal.peek();
      if (
        sel.type === "focused" &&
        keyOf(sel.focus) === focusKey &&
        (sel.target === targetKey || targetKey === DEFAULT_TARGET)
      ) {
        scheduleEffects(sel, [{ type: "CLEAR_FOCUS" }]);
      }
    };
  };

  const dispatchKeyDown = (e: KeyboardEvent) => {
    const intent = parseKeydownIntent(e);
    if (!intent) return;

    e.preventDefault();

    if (intent.type === "CONFIRM" || intent.type === "TAB") {
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      ) {
        const start = active.selectionStart ?? 0;
        const end = active.selectionEnd ?? start;
        intent.caret = { start, end };
      }
    }

    opts.dispatchIntent(intent);
  };

  const installGlobalListeners = (win: Window = window): (() => void) => {
    const onKeyDown = (e: KeyboardEvent) => {
      dispatchKeyDown(e);
    };

    const onPointerDownCapture = (e: PointerEvent) => {
      updateActiveViewForTarget(e.target);
    };

    const onFocusInCapture = (e: FocusEvent) => {
      updateActiveViewForTarget(e.target);
    };

    win.addEventListener("keydown", onKeyDown);
    win.addEventListener("pointerdown", onPointerDownCapture, true);
    win.addEventListener("focusin", onFocusInCapture, true);

    return () => {
      win.removeEventListener("keydown", onKeyDown);
      win.removeEventListener("pointerdown", onPointerDownCapture, true);
      win.removeEventListener("focusin", onFocusInCapture, true);
    };
  };

  const mountView = (mountOpts: MountViewOpts): Component => {
    const id = mountOpts.id;
    const focus: Focus = mountOpts.focus ?? { container: id, item: id };

    const entryId = entryIdFromItemId(id);
    const i = id.indexOf(":");
    const isMountable = i !== -1 && id.slice(i + 1) === "";

    if (entryId == null || !isMountable) {
      throw new Error(`mountView expects a mountable item id, got: ${id}`);
    }
    if (!model.hasEntry(entryId)) {
      throw new Error(`mountView expects an existing item id, got: ${id}`);
    }

    const factory = views[mountOpts.view] ?? views.outline;
    if (!factory) {
      throw new Error(
        `No view factory available for '${mountOpts.view}' and outline fallback is missing`,
      );
    }

    const view = factory({ core: opts.getCore(), id, focus });

    const unreg = registerViewRoot({
      root: view.root,
      ...(view.onIntent ? { onIntent: view.onIntent } : {}),
    });

    return {
      el: view.root,
      dispose() {
        unreg();
        view.dispose();
      },
    };
  };

  const getActiveViewRoot = (): HTMLElement | null =>
    getActiveView()?.root ?? null;

  const getActiveViewOnIntent = (): ((intent: ViewIntent) => void) | null =>
    getActiveView()?.onIntent ?? null;

  const dispose = (): void => {
    bindings.clear();
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
    getActiveViewRoot,
    getActiveViewOnIntent,
    dispose,
  };
}
