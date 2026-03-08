import type {
  Core,
  Location,
  Intent,
  ItemId,
  ReaderForShape,
  Selection,
  ViewShape,
  ViewName,
} from "../core";
import { ITEM_TARGET, parseKeyIntent } from "../core";

import {
  domPointToTextOffset,
  setContentEditableCaret,
} from "./contenteditable";

type RuntimeEffect =
  | { type: "FOCUS"; location: Location; target: string; caret?: number }
  | { type: "CLEAR_FOCUS" };

type ViewHandle = { root: HTMLElement; onIntent: (intent: Intent) => void };

export type Component = { el: HTMLElement; dispose(): void };

export type DomView = {
  bodyRoot?: object;
  root: HTMLElement;
  onIntent: (intent: Intent) => void;
  dispose(): void;
};

export type ViewFactory<C extends Core = Core> = (args: {
  core: C;
  id: ItemId;
  location: Location;
}) => DomView;

export type ViewRegistration = {
  factory: ViewFactory<UiCore>;
  shape?: ViewShape;
};

type ViewMountArgs = { core: UiCore; id: ItemId; location: Location };

export type AuthoredView = {
  onIntent: (intent: Intent) => void;
  bodyRoot: Component;
};

export type ShapedViewRegistration<S extends ViewShape> = {
  factory: ViewFactory<UiCore>;
  shape: S;
};

function authoredViewToDomView(view: AuthoredView): DomView {
  return {
    bodyRoot: view.bodyRoot,
    root: view.bodyRoot.el,
    onIntent: view.onIntent,
    dispose() {
      view.bodyRoot.dispose();
    },
  };
}

export function defineView(
  mount: (args: ViewMountArgs) => AuthoredView,
): ViewRegistration {
  return {
    factory: (args) => authoredViewToDomView(mount(args)),
  };
}

export function defineShapedView<S extends ViewShape>(
  shape: S,
  mount: (
    args: Omit<ViewMountArgs, "location"> & {
      reader: ReaderForShape<S>;
      location: Location;
    },
  ) => AuthoredView,
): ShapedViewRegistration<S> {
  return {
    shape,
    factory: ({ core, id, location }) =>
      authoredViewToDomView(
        mount({ core, id, reader: core.reader(id, shape), location }),
      ),
  };
}

type TargetBinding = {
  getEl: () => HTMLElement | null;
  primary?: boolean;
  setCaret?: { set(pos: number): void; getLength(): number };
  getCaret?: () => number | undefined;
};

type TargetBindingRecord = { binding: TargetBinding; token: number };

type AttachTargetOpts = {
  location: Location;
  target: string;
  getEl: () => HTMLElement | null;
  primary?: boolean;
  setCaret?: { set(pos: number): void; getLength(): number };
  getCaret?: () => number | undefined;
};

type MountViewOpts = {
  id: ItemId;
  portals: readonly ItemId[];
  view: ViewName;
};

const itemKey = (id: ItemId): string => id;
const keyOf = (f: Location): string =>
  `${f.portals.map(itemKey).join("|")}::${itemKey(f.item)}`;

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

function normalizeEffectsForSelection(
  sel: Selection,
  effects: RuntimeEffect[],
  caret?: number,
): RuntimeEffect[] {
  const hasClear = effects.some((e) => e.type === "CLEAR_FOCUS");
  const hasFocus = effects.some((e) => e.type === "FOCUS");

  if (sel.type === "idle" || sel.type === "item")
    return hasClear ? effects : [...effects, { type: "CLEAR_FOCUS" }];

  if (hasClear) return effects;
  if (hasFocus) return effects;

  return [
    ...effects,
    {
      type: "FOCUS",
      location: sel.location,
      target: sel.target,
      ...(caret !== undefined ? { caret } : {}),
    },
  ];
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

export type DomRuntime = {
  syncSelection(next: Selection, caret?: number): void;
  readCurrentCaret(): number | undefined;
  primaryContentTarget(location: Location): string | null;

  attachTarget(opts: AttachTargetOpts): () => void;

  mountView(opts: MountViewOpts): Component;
  setRootOuterIntentHandler(handler: (intent: Intent) => void): void;

  installGlobalListeners(win?: Window): () => void;

  handleIntent(selection: Selection, intent: Intent): void;

  dispose(): void;
};

export function createRuntime(opts: {
  getCore: () => UiCore;
  rootId: ItemId;
  views: Partial<Record<ViewName, ViewFactory<UiCore>>>;
  dispatchIntent: (intent: Intent) => void;
  getSelection: () => Selection;
}): DomRuntime {
  const views = opts.views;
  const bindings = new Map<string, Map<string, TargetBindingRecord>>();
  const viewRoots = new WeakMap<HTMLElement, ViewHandle>();
  const mountedViewsByLocation = new Map<string, ViewHandle>();
  let pending: { selection: Selection; effects: RuntimeEffect[] } | null = null;
  let flushScheduled = false;
  let rootOuterIntentHandler: ((intent: Intent) => void) | null = null;

  const locationMapFor = (
    location: Location,
  ): Map<string, TargetBindingRecord> => {
    const locationKey = keyOf(location);
    let targetBindings = bindings.get(locationKey);
    if (!targetBindings) {
      targetBindings = new Map();
      bindings.set(locationKey, targetBindings);
    }
    return targetBindings;
  };

  const resolveBinding = (
    location: Location,
    target: string,
  ): TargetBinding | null => {
    const targetBindings = bindings.get(keyOf(location));
    if (!targetBindings) return null;
    return targetBindings.get(target)?.binding ?? null;
  };

  const primaryContentTarget = (location: Location): string | null => {
    const targetBindings = bindings.get(keyOf(location));
    if (!targetBindings) return null;
    for (const [target, record] of targetBindings) {
      if (!target.startsWith("content:")) continue;
      if (!record.binding.primary) continue;
      return target;
    }
    return null;
  };

  const resolveViewForLocationTarget = (
    location: Location,
    target: string,
  ): ViewHandle | null => {
    const fromBinding = (binding: TargetBinding | null): ViewHandle | null => {
      const el = binding?.getEl() ?? null;
      if (!el) return null;
      return viewAtTarget(viewRoots, el);
    };

    return fromBinding(resolveBinding(location, target));
  };

  const isExactRootLocation = (location: Location): boolean =>
    location.item === opts.rootId && location.portals.length === 0;

  const resolveItemSelectionView = (
    selection: Extract<Selection, { type: "item" }>,
  ): ViewHandle | null => {
    const anchorIsRoot = isExactRootLocation(selection.anchor);
    const headIsRoot = isExactRootLocation(selection.head);

    if (anchorIsRoot || headIsRoot) {
      if (!anchorIsRoot || !headIsRoot) {
        throw new Error(
          `Mixed root/non-root item selection is invalid: anchor=${keyOf(selection.anchor)} head=${keyOf(selection.head)}`,
        );
      }
      return null;
    }

    const anchorView = resolveViewForLocationTarget(
      selection.anchor,
      ITEM_TARGET,
    );
    if (!anchorView) {
      throw new Error(
        `Missing ITEM_TARGET binding for item selection anchor at ${keyOf(selection.anchor)}`,
      );
    }

    const headView = resolveViewForLocationTarget(selection.head, ITEM_TARGET);
    if (!headView) {
      throw new Error(
        `Missing ITEM_TARGET binding for item selection head at ${keyOf(selection.head)}`,
      );
    }

    if (anchorView !== headView) {
      throw new Error(
        `Cross-view item selection is invalid: anchor=${keyOf(selection.anchor)} head=${keyOf(selection.head)}`,
      );
    }

    return headView;
  };

  const applyDomFocus = (
    sel: Selection,
    locationEff: Extract<RuntimeEffect, { type: "FOCUS" }>,
  ): void => {
    if (sel.type !== "editing") return;

    const binding = resolveBinding(sel.location, sel.target);
    const targetEl = (binding?.getEl() as HTMLElement | null) ?? null;
    if (!binding || !targetEl) return;
    const editingHost = targetEl.isContentEditable
      ? targetEl.closest<HTMLElement>("[contenteditable='true']")
      : null;
    const focusEl = editingHost ?? targetEl;

    const activeEl = document.activeElement;
    const wasFocused =
      activeEl === focusEl ||
      (activeEl instanceof Node && focusEl.contains(activeEl));
    if (!wasFocused) focusEl.focus({ preventScroll: true });

    const caret = locationEff.caret;
    if (caret !== undefined && binding.setCaret) {
      const len = binding.setCaret!.getLength();
      const nextCaret = clamp(caret!, 0, len);
      const currentCaret = binding.getCaret?.();
      if (currentCaret === nextCaret) return;
      binding.setCaret!.set(nextCaret);
      return;
    }

    if (caret !== undefined && targetEl.isContentEditable) {
      const nextCaret = Math.max(0, caret);
      const sel = window.getSelection();
      const currentCaret =
        sel?.rangeCount &&
        sel.isCollapsed &&
        sel.focusNode &&
        targetEl.contains(sel.focusNode)
          ? domPointToTextOffset(targetEl, sel.focusNode, sel.focusOffset)
          : null;
      if (currentCaret === nextCaret) return;
      setContentEditableCaret(targetEl, nextCaret);
      return;
    }

    if (!isTextInput(targetEl) || wasFocused) return;

    targetEl.setSelectionRange(targetEl.value.length, targetEl.value.length);
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
    caret?: number,
  ): void => {
    scheduleEffects(sel, normalizeEffectsForSelection(sel, effects, caret));
  };

  const syncSelection = (next: Selection, caret?: number): void => {
    enqueueDomEffects(next, [], caret);
  };

  const readCurrentCaret = (): number | undefined => {
    const sel = opts.getSelection();
    if (sel.type !== "editing") return undefined;

    return resolveBinding(sel.location, sel.target)?.getCaret?.();
  };

  const registerViewRoot = (view: {
    location: Location;
    root: HTMLElement;
    onIntent: (intent: Intent) => void;
  }): (() => void) => {
    const handle: ViewHandle = {
      root: view.root,
      onIntent: view.onIntent,
    };

    viewRoots.set(handle.root, handle);
    mountedViewsByLocation.set(keyOf(view.location), handle);

    return () => {
      viewRoots.delete(handle.root);
      mountedViewsByLocation.delete(keyOf(view.location));
    };
  };

  const attachTarget = (target: AttachTargetOpts): (() => void) => {
    const targetBindings = locationMapFor(target.location);
    const prev = targetBindings.get(target.target);
    const nextToken = (prev?.token ?? 0) + 1;

    targetBindings.set(target.target, {
      binding: {
        getEl: target.getEl,
        ...(target.primary !== undefined ? { primary: target.primary } : {}),
        ...(target.setCaret ? { setCaret: target.setCaret } : {}),
        ...(target.getCaret ? { getCaret: target.getCaret } : {}),
      },
      token: nextToken,
    });

    const locationKey = keyOf(target.location);
    const targetKey = target.target;
    const tokenAtAttach = nextToken;

    return () => {
      const targetBindingsAtLocation = bindings.get(locationKey);
      const cur = targetBindingsAtLocation?.get(targetKey);
      if (!targetBindingsAtLocation || !cur) return;
      if (cur.token !== tokenAtAttach) return;

      targetBindingsAtLocation.delete(targetKey);
      if (targetBindingsAtLocation.size === 0) bindings.delete(locationKey);

      const sel = opts.getSelection();
      if (
        sel.type === "editing" &&
        keyOf(sel.location) === locationKey &&
        sel.target === targetKey
      ) {
        scheduleEffects(sel, [{ type: "CLEAR_FOCUS" }]);
      }
    };
  };

  const dispatchKeyDown = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.isContentEditable) return;

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
        intent.caret = active.selectionEnd ?? active.selectionStart ?? 0;
      }
    }

    opts.dispatchIntent(intent);
  };

  const installGlobalListeners = (win: Window = window): (() => void) => {
    const onKeyDown = (e: KeyboardEvent) => {
      dispatchKeyDown(e);
    };

    win.addEventListener("keydown", onKeyDown);

    return () => {
      win.removeEventListener("keydown", onKeyDown);
    };
  };

  const mountView = (mountOpts: MountViewOpts): Component => {
    const id = mountOpts.id;
    const location: Location = { item: id, portals: mountOpts.portals };
    const core = opts.getCore();

    const factory = views[mountOpts.view] ?? views.outline;
    if (!factory) {
      throw new Error(
        `No view factory available for '${mountOpts.view}' and outline fallback is missing`,
      );
    }

    const view = factory({ core, id, location });

    const unreg = registerViewRoot({
      location,
      root: view.root,
      onIntent: view.onIntent,
    });

    return {
      el: view.root,
      dispose() {
        unreg();
        view.dispose();
      },
    };
  };

  const resolveIntentHandler = (
    selection: Selection,
    intent: Intent,
  ): ((intent: Intent) => void) | null => {
    if (selection.type === "idle") return null;

    if (selection.type === "item") {
      const view = resolveItemSelectionView(selection);
      return view?.onIntent ?? rootOuterIntentHandler;
    }

    if (intent.type === "INSERT") {
      const view = resolveItemSelectionView({
        type: "item",
        anchor: selection.location,
        head: selection.location,
      });
      return view?.onIntent ?? rootOuterIntentHandler;
    }

    if (
      isExactRootLocation(selection.location) &&
      !selection.target.startsWith("content:")
    ) {
      return rootOuterIntentHandler;
    }
    const view = resolveViewForLocationTarget(
      selection.location,
      selection.target,
    );
    return view?.onIntent ?? null;
  };

  const dispose = (): void => {
    bindings.clear();
    mountedViewsByLocation.clear();
    pending = null;
    flushScheduled = false;
  };

  return {
    syncSelection,
    readCurrentCaret,
    primaryContentTarget,
    attachTarget,
    mountView,
    setRootOuterIntentHandler(handler) {
      rootOuterIntentHandler = handler;
    },
    installGlobalListeners,
    handleIntent(selection, intent) {
      resolveIntentHandler(selection, intent)?.(intent);
    },
    dispose,
  };
}

export type UiCore = Core & {
  attachTarget(opts: AttachTargetOpts): () => void;
  mountView(opts: MountViewOpts): Component;
  primaryContentTarget(location: Location): string | null;
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
    primaryContentTarget(location) {
      return runtime.primaryContentTarget(location);
    },
  };
}

export function bindUiRuntime(args: {
  core: Core;
  rootId: ItemId;
  views: Partial<Record<ViewName, ViewFactory<UiCore>>>;
}): { core: UiCore; runtime: DomRuntime } {
  let uiCore!: UiCore;
  const runtime = createRuntime({
    getCore: () => uiCore,
    rootId: args.rootId,
    views: args.views,
    dispatchIntent: (intent) => args.core.dispatch(intent),
    getSelection: () => args.core.selection(),
  });
  uiCore = createUiCore(args.core, runtime);
  runtime.syncSelection(args.core.selection());
  return { core: uiCore, runtime };
}
