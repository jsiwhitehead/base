import type { Core, Focus, Intent, ItemId, Selection, ViewName } from "../core";
import { DEFAULT_TARGET, parseKeyIntent } from "../core";

type Anchor = "top" | "bottom";

type RuntimeEffect =
  | { type: "FOCUS"; focus: Focus; target: string; anchor?: Anchor }
  | { type: "CLEAR_FOCUS" };

type ViewHandle = {
  root: HTMLElement;
  onIntent?: (intent: Intent) => void;
};

export type Component = { el: HTMLElement; dispose(): void };

export type DomView = {
  root: HTMLElement;
  onIntent?: (intent: Intent) => void;
  dispose(): void;
};

export type ViewFactory<C extends Core = Core> = (args: {
  core: C;
  id: ItemId;
  focus?: Focus;
}) => DomView;

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

export type DomRuntime = {
  syncSelection(next: Selection): void;

  attachTarget(opts: AttachTargetOpts): () => void;

  mountView(opts: MountViewOpts): Component;

  installGlobalListeners(win?: Window): () => void;

  getActiveViewOnIntent(): ((intent: Intent) => void) | null;

  dispose(): void;
};

export function createRuntime(opts: {
  getCore: () => UiCore;
  views: Partial<Record<ViewName, ViewFactory<UiCore>>>;
  dispatchIntent: (intent: Intent) => void;
  getSelection: () => Selection;
}): DomRuntime {
  const views = opts.views;

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

  const syncSelection = (next: Selection): void => {
    enqueueDomEffects(next, []);
  };

  const registerViewRoot = (view: {
    root: HTMLElement;
    onIntent?: (intent: Intent) => void;
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

      const sel = opts.getSelection();
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
    const intent = parseKeyIntent({
      key: e.key,
      ctrlKey: !!e.ctrlKey,
      metaKey: !!e.metaKey,
      altKey: !!e.altKey,
      shiftKey: !!e.shiftKey,
    });
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
    const factory = views[mountOpts.view] ?? views.outline;
    if (!factory) {
      throw new Error(
        `No view factory available for '${mountOpts.view}' and outline fallback is missing`,
      );
    }

    const core = opts.getCore();
    const view = factory({ core, id, focus });

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

  const getActiveViewOnIntent = (): ((intent: Intent) => void) | null =>
    getActiveView()?.onIntent ?? null;

  const dispose = (): void => {
    bindings.clear();
    activeView = null;
    pending = null;
    flushScheduled = false;
  };

  return {
    syncSelection,
    attachTarget,
    mountView,
    installGlobalListeners,
    getActiveViewOnIntent,
    dispose,
  };
}

export type UiCore = Core & {
  attachTarget(opts: AttachTargetOpts): () => void;
  mountView(opts: MountViewOpts): Component;
};

function createUiCore(core: Core, runtime: DomRuntime): UiCore {
  return {
    ...core,
    attachTarget(args) {
      return runtime.attachTarget(args);
    },
    mountView(args) {
      return runtime.mountView(args);
    },
  };
}

export function bindUiRuntime(args: {
  core: Core;
  views: Partial<Record<ViewName, ViewFactory<UiCore>>>;
}): {
  core: UiCore;
  runtime: DomRuntime;
} {
  let uiCore!: UiCore;
  const runtime = createRuntime({
    getCore: () => uiCore,
    views: args.views,
    dispatchIntent: (intent) => args.core.dispatch(intent),
    getSelection: () => args.core.selection(),
  });
  uiCore = createUiCore(args.core, runtime);
  runtime.syncSelection(args.core.selection());
  return { core: uiCore, runtime };
}
