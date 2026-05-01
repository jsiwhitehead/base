import type {
  CaretPlacement,
  Core,
  Location,
  Intent,
  NodeId,
  ReaderForShape,
  Selection,
  ViewShape,
  ViewName,
} from "../core";
import { NODE_TARGET, parseGlobalKeyIntent } from "../core";

import {
  domPointToTextOffset,
  readPlainTextFromContentEditable,
  setContentEditableCaret,
} from "./contenteditable";

type RuntimeEffect =
  | {
      type: "FOCUS_TARGET";
      location: Location;
      target: string;
      caret?: CaretPlacement;
    }
  | { type: "FOCUS_STRUCTURAL"; el: HTMLElement }
  | { type: "CLEAR_DOM_SELECTION" }
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
  id: NodeId;
  location: Location;
}) => DomView;

export type ViewRegistration = {
  factory: ViewFactory<UiCore>;
  shape?: ViewShape;
};

type ViewMountArgs = { core: UiCore; id: NodeId; location: Location };

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
  id: NodeId;
  portals: readonly NodeId[];
  view: ViewName;
};

const nodeKey = (id: NodeId): string => id;
const keyOf = (f: Location): string =>
  `${f.portals.map(nodeKey).join("|")}::${nodeKey(f.node)}`;

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

function ensureProgrammaticFocus(el: HTMLElement): void {
  if (el.matches("input, textarea, button, select, a[href], [tabindex]")) {
    return;
  }
  if (el.isContentEditable) return;
  el.tabIndex = -1;
}

export type DomRuntime = {
  syncSelection(next: Selection, caret?: CaretPlacement): void;
  readCurrentCaret(): number | undefined;
  primaryContentTarget(location: Location): string | null;
  hasTarget(location: Location, target: string): boolean;

  attachTarget(opts: AttachTargetOpts): () => void;

  mountView(opts: MountViewOpts): Component;
  setRootOuterIntentHandler(handler: (intent: Intent) => void): void;

  installRootKeyBoundary(target: HTMLElement): () => void;

  handleIntent(selection: Selection, intent: Intent): void;

  dispose(): void;
};

export function createRuntime(opts: {
  getCore: () => UiCore;
  rootId: NodeId;
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
    const el = resolveBinding(location, target)?.getEl() ?? null;
    if (!el) return null;
    return viewAtTarget(viewRoots, el);
  };

  const isExactRootLocation = (location: Location): boolean =>
    location.node === opts.rootId && location.portals.length === 0;

  const resolveStructuralFocusEl = (
    sel: Extract<Selection, { type: "node" }>,
  ): HTMLElement | null => {
    const exactRoot =
      isExactRootLocation(sel.anchor) && isExactRootLocation(sel.head);

    if (exactRoot) {
      const rootNodeTarget = resolveBinding(sel.head, NODE_TARGET)?.getEl();
      if (rootNodeTarget) return rootNodeTarget;
      return mountedViewsByLocation.get(keyOf(sel.head))?.root ?? null;
    }

    return resolveBinding(sel.head, NODE_TARGET)?.getEl() ?? null;
  };

  const resolveNodeSelectionOwnerView = (
    selection: Extract<Selection, { type: "node" }>,
  ): ViewHandle | null => {
    const anchorIsRoot = isExactRootLocation(selection.anchor);
    const headIsRoot = isExactRootLocation(selection.head);

    if (anchorIsRoot || headIsRoot) {
      if (!anchorIsRoot || !headIsRoot) {
        throw new Error(
          `Mixed root/non-root node selection is invalid: anchor=${keyOf(selection.anchor)} head=${keyOf(selection.head)}`,
        );
      }
      return null;
    }

    const anchorView = resolveViewForLocationTarget(
      selection.anchor,
      NODE_TARGET,
    );
    if (!anchorView) {
      throw new Error(
        `Missing NODE_TARGET binding for node selection anchor at ${keyOf(selection.anchor)}`,
      );
    }

    const headView = resolveViewForLocationTarget(selection.head, NODE_TARGET);
    if (!headView) {
      throw new Error(
        `Missing NODE_TARGET binding for node selection head at ${keyOf(selection.head)}`,
      );
    }

    if (anchorView !== headView) {
      throw new Error(
        `Cross-view node selection is invalid: anchor=${keyOf(selection.anchor)} head=${keyOf(selection.head)}`,
      );
    }

    return headView;
  };

  const applyTargetFocus = (
    sel: Selection,
    locationEff: Extract<RuntimeEffect, { type: "FOCUS_TARGET" }>,
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
      const nextCaret = caret === "end" ? len : clamp(caret, 0, len);
      const currentCaret = binding.getCaret?.();
      if (currentCaret === nextCaret) return;
      binding.setCaret!.set(nextCaret);
      return;
    }

    if (caret !== undefined && targetEl.isContentEditable) {
      const nextCaret =
        caret === "end"
          ? readPlainTextFromContentEditable(targetEl).length
          : Math.max(0, caret);
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

  const applyStructuralFocus = (
    eff: Extract<RuntimeEffect, { type: "FOCUS_STRUCTURAL" }>,
  ): void => {
    const focusEl = eff.el;
    if (!focusEl.isConnected) return;
    ensureProgrammaticFocus(focusEl);

    if (document.activeElement !== focusEl) {
      focusEl.focus({ preventScroll: true });
    }
  };

  const clearDocumentSelection = (): void => {
    window.getSelection()?.removeAllRanges();
  };

  const planEditingSelectionEffects = (
    sel: Extract<Selection, { type: "editing" }>,
    caret?: CaretPlacement,
  ): RuntimeEffect[] => [
    {
      type: "FOCUS_TARGET",
      location: sel.location,
      target: sel.target,
      ...(caret !== undefined ? { caret } : {}),
    },
  ];

  const planNodeSelectionEffects = (
    sel: Extract<Selection, { type: "node" }>,
  ): RuntimeEffect[] => {
    const focusEl = resolveStructuralFocusEl(sel);
    return focusEl
      ? [
          { type: "CLEAR_DOM_SELECTION" },
          { type: "FOCUS_STRUCTURAL", el: focusEl },
        ]
      : [{ type: "CLEAR_DOM_SELECTION" }, { type: "CLEAR_FOCUS" }];
  };

  const planIdleSelectionEffects = (): RuntimeEffect[] => [
    { type: "CLEAR_DOM_SELECTION" },
    { type: "CLEAR_FOCUS" },
  ];

  const planDomEffectsForSelection = (
    sel: Selection,
    caret?: CaretPlacement,
  ): RuntimeEffect[] => {
    switch (sel.type) {
      case "editing":
        return planEditingSelectionEffects(sel, caret);
      case "node":
        return planNodeSelectionEffects(sel);
      case "idle":
        return planIdleSelectionEffects();
      default:
        return assertNever(sel, "Unhandled selection for DOM effect planning");
    }
  };

  const applyDomEffects = (sel: Selection, effects: RuntimeEffect[]): void => {
    for (const eff of effects) {
      switch (eff.type) {
        case "FOCUS_TARGET":
          applyTargetFocus(sel, eff);
          break;
        case "FOCUS_STRUCTURAL":
          applyStructuralFocus(eff);
          break;
        case "CLEAR_DOM_SELECTION": {
          clearDocumentSelection();
          break;
        }
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

  const syncSelection = (next: Selection, caret?: CaretPlacement): void => {
    scheduleEffects(next, planDomEffectsForSelection(next, caret));
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

  const dispatchGlobalKeyIntent = (e: KeyboardEvent) => {
    const targetEl = e.target as HTMLElement | null;
    if (targetEl?.matches("[contenteditable='true']")) return;

    const intent = parseGlobalKeyIntent({
      key: e.key,
      ctrlKey: !!e.ctrlKey,
      metaKey: !!e.metaKey,
      altKey: !!e.altKey,
      shiftKey: !!e.shiftKey,
    });
    if (!intent) return;
    const selection = opts.getSelection();
    if (
      selection.type === "editing" &&
      (intent.type === "ENTER" || intent.type === "TYPE")
    ) {
      return;
    }

    e.preventDefault();

    opts.dispatchIntent(intent);
  };

  const installRootKeyBoundary = (target: HTMLElement): (() => void) => {
    const onKeyDown = (e: KeyboardEvent) => {
      dispatchGlobalKeyIntent(e);
    };

    target.addEventListener("keydown", onKeyDown);

    return () => {
      target.removeEventListener("keydown", onKeyDown);
    };
  };

  const mountView = (mountOpts: MountViewOpts): Component => {
    const id = mountOpts.id;
    const location: Location = { node: id, portals: mountOpts.portals };
    const core = opts.getCore();

    const factory = views[mountOpts.view] ?? views.outline;
    if (!factory) {
      throw new Error(
        `No view factory available for '${mountOpts.view}' and outline fallback is missing`,
      );
    }

    const view = factory({ core, id, location });
    ensureProgrammaticFocus(view.root);

    const onViewKeyDown = (e: KeyboardEvent): void => {
      e.stopPropagation();
      if (e.defaultPrevented) return;
      dispatchGlobalKeyIntent(e);
    };
    view.root.addEventListener("keydown", onViewKeyDown);

    const unreg = registerViewRoot({
      location,
      root: view.root,
      onIntent: view.onIntent,
    });

    return {
      el: view.root,
      dispose() {
        view.root.removeEventListener("keydown", onViewKeyDown);
        unreg();
        view.dispose();
      },
    };
  };

  const hasTarget = (location: Location, target: string): boolean =>
    resolveBinding(location, target) !== null;

  const resolveIntentHandler = (
    selection: Selection,
  ): ((intent: Intent) => void) | null => {
    if (selection.type === "idle") return null;

    const nodeSelection =
      selection.type === "node"
        ? selection
        : {
            type: "node" as const,
            anchor: selection.location,
            head: selection.location,
          };

    return (
      resolveNodeSelectionOwnerView(nodeSelection)?.onIntent ??
      rootOuterIntentHandler
    );
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
    hasTarget,
    attachTarget,
    mountView,
    setRootOuterIntentHandler(handler) {
      rootOuterIntentHandler = handler;
    },
    installRootKeyBoundary,
    handleIntent(selection, intent) {
      resolveIntentHandler(selection)?.(intent);
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
  rootId: NodeId;
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
