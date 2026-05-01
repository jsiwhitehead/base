import { computed, signal, type Signal } from "@preact/signals-core";

import type { NodeId, Location, Selection } from "../../core";
import { sameLocation, CONTENT_TEXT_TARGET } from "../../core";
import {
  createSuppressionFlag,
  getMappedSelectionRangeInRoot,
  resolveEventTargetElement,
} from "../../dom";
import type { Ctx, SuppressionFlag, UiCore } from "../../dom";

import {
  domPositionToModel,
  NODE_SELECTOR,
  VALUE_SELECTOR,
} from "./dom-mapping";
import { blockSelectionLocations, locationKey } from "./navigation";

export type OutlinePointerIntent = "value" | "node" | null;

export type OutlinePointerRuntime = {
  beginPointerSelection: (
    pointerId: number,
    intent: Exclude<OutlinePointerIntent, null>,
  ) => void;
  finishPointerSelection: (pointerId: number) => boolean;
  clearPointerSelectionState: () => void;
  invalidatePointerFinalize: () => void;
  getSawSelectionChangeThisPointer: () => boolean;
  markSawSelectionChangeThisPointer: () => void;
  getPointerIntent: () => OutlinePointerIntent;
  nextPointerFinalizeToken: () => number;
  getPointerFinalizeToken: () => number;
  isPointerSelecting: () => boolean;
};

export type OutlineSelectionState = {
  selectedNodeKeys: Signal<Set<string>>;
  valueRangeSelectedNodeKeys: Signal<Set<string>>;
  valueSelectionCollapsed: Signal<boolean>;
};

export type OutlineSelectionEditingControls = {
  suppressSelectionSync: SuppressionFlag<boolean>;
  clearValueRangeSelectedNodes: () => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startNodeId?: NodeId;
    endNodeId?: NodeId;
  }) => void;
};

export type OutlineSelectionRuntime = {
  selectionState: OutlineSelectionState;
  onGutterPointerDown: (
    nodeId: NodeId,
    portals: readonly NodeId[],
    shiftKey: boolean,
    pointerId: number,
  ) => void;
  reconcileDomSelectionToModel: (
    allowNonCollapsedPointerDefer: boolean,
  ) => void;
  pointer: OutlinePointerRuntime;
  editingControls: OutlineSelectionEditingControls;
  bind: (args: {
    on: Ctx["on"];
    effect: Ctx["effect"];
    isComposing: () => boolean;
  }) => void;
};

type OutlinePointerZone =
  | "value"
  | "gutter"
  | "header"
  | "embedded"
  | "shell"
  | "unknown";

function classifyOutlinePointerZone(
  targetEl: Element | null,
): OutlinePointerZone {
  if (!targetEl) return "unknown";
  if (targetEl.closest(VALUE_SELECTOR)) return "value";
  if (targetEl.closest(".ui-outline-gutter")) return "gutter";
  if (targetEl.closest(".ui-header")) return "header";
  if (targetEl.closest(".ui-body:not(.ui-outline)")) return "embedded";
  if (targetEl.closest(".ui-frame.ui-outline-child")) return "shell";
  return "unknown";
}

function isPointerEditingTarget(targetEl: Element | null): boolean {
  const target = targetEl?.closest<HTMLElement>("[data-target]");
  return !!(
    target?.matches("[contenteditable='true']") ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  );
}

function resolveOutlinePointerNodeId(
  target: EventTarget | null,
  zones: readonly OutlinePointerZone[],
): NodeId | null {
  const targetEl = resolveEventTargetElement(target);
  if (!targetEl) return null;
  if (isPointerEditingTarget(targetEl)) return null;
  const zone = classifyOutlinePointerZone(targetEl);
  if (!zones.includes(zone)) return null;
  return targetEl.closest<HTMLElement>(NODE_SELECTOR)?.dataset.id ?? null;
}

export function resolveValuePointerNodeId(
  target: EventTarget | null,
): NodeId | null {
  return resolveOutlinePointerNodeId(target, ["value", "shell"]);
}

function resolveNodePointerNodeId(target: EventTarget | null): NodeId | null {
  return resolveOutlinePointerNodeId(target, ["header", "shell"]);
}

export function isOutlineValueEditEvent(
  target: EventTarget | null,
  root: HTMLElement,
): boolean {
  const targetEl = resolveEventTargetElement(target);
  if (!targetEl || targetEl === root) return true;
  return classifyOutlinePointerZone(targetEl) === "value";
}

export function createOutlinePointerRuntime(): OutlinePointerRuntime {
  let isPointerSelecting = false;
  let activePointerId: number | null = null;
  let sawSelectionChangeThisPointer = false;
  let pointerIntent: OutlinePointerIntent = null;
  let pointerFinalizeToken = 0;

  return {
    clearPointerSelectionState: (): void => {
      isPointerSelecting = false;
      activePointerId = null;
      sawSelectionChangeThisPointer = false;
      pointerIntent = null;
    },
    invalidatePointerFinalize: (): void => {
      pointerFinalizeToken += 1;
    },
    finishPointerSelection: (pointerId: number): boolean => {
      if (
        !isPointerSelecting ||
        (activePointerId !== null && pointerId !== activePointerId)
      ) {
        return false;
      }
      isPointerSelecting = false;
      activePointerId = null;
      sawSelectionChangeThisPointer = false;
      pointerIntent = null;
      return true;
    },
    beginPointerSelection: (
      pointerId: number,
      intent: Exclude<OutlinePointerIntent, null>,
    ): void => {
      pointerFinalizeToken += 1;
      isPointerSelecting = true;
      activePointerId = pointerId;
      sawSelectionChangeThisPointer = false;
      pointerIntent = intent;
    },
    getSawSelectionChangeThisPointer: (): boolean =>
      sawSelectionChangeThisPointer,
    markSawSelectionChangeThisPointer: (): void => {
      sawSelectionChangeThisPointer = true;
    },
    getPointerIntent: (): OutlinePointerIntent => pointerIntent,
    nextPointerFinalizeToken: (): number => {
      pointerFinalizeToken += 1;
      return pointerFinalizeToken;
    },
    getPointerFinalizeToken: (): number => pointerFinalizeToken,
    isPointerSelecting: (): boolean => isPointerSelecting,
  };
}

export function createOutlineSelectionRuntime(args: {
  core: UiCore;
  rootId: NodeId;
  portals: readonly NodeId[];
  getRoot: () => HTMLElement | null;
  resetStickyCaretX: () => void;
}): OutlineSelectionRuntime {
  const { core, rootId, portals, getRoot, resetStickyCaretX } = args;
  const selectedNodeKeys = computed(() => {
    const sel = core.selection();
    if (sel.type !== "node") return new Set<string>();
    return new Set(
      blockSelectionLocations(core, rootId, sel, portals).map((location) =>
        locationKey(location),
      ),
    );
  });
  const valueRangeSelectedNodeKeys = signal(new Set<string>());
  const valueSelectionCollapsed = signal(true);

  const clearValueRangeSelectedNodes = (): void => {
    if (valueRangeSelectedNodeKeys.value.size === 0) return;
    valueRangeSelectedNodeKeys.value = new Set<string>();
  };

  const setValueSelectionRangeState = (args: {
    collapsed: boolean;
    startNodeId?: NodeId;
    endNodeId?: NodeId;
  }): void => {
    const { collapsed, startNodeId, endNodeId } = args;
    valueSelectionCollapsed.value = collapsed;
    if (collapsed || !startNodeId || !endNodeId) {
      clearValueRangeSelectedNodes();
      return;
    }
    valueRangeSelectedNodeKeys.value = new Set(
      blockSelectionLocations(
        core,
        rootId,
        {
          type: "node",
          anchor: { node: startNodeId, portals },
          head: { node: endNodeId, portals },
        },
        portals,
      ).map((location) => locationKey(location)),
    );
  };

  const suppressSelectionChangeFromGutter = createSuppressionFlag(false);
  const suppressSelectionSync = createSuppressionFlag(false);
  const pointer = createOutlinePointerRuntime();

  const onGutterPointerDown = (
    nodeId: NodeId,
    nodePortals: readonly NodeId[],
    shiftKey: boolean,
    pointerId: number,
  ): void => {
    pointer.beginPointerSelection(pointerId, "node");
    suppressSelectionChangeFromGutter.suppressForTurn(true);

    const nextFocus: Location = { node: nodeId, portals: nodePortals };
    if (shiftKey) {
      const sel = core.selection();
      if (sel.type === "node") {
        core.focus({ type: "node", anchor: sel.anchor, head: nextFocus });
        return;
      }
    }
    core.focus({ type: "node", location: nextFocus });
  };

  const reconcileDomSelectionToModel = (
    allowNonCollapsedPointerDefer: boolean,
  ): void => {
    const root = getRoot();
    if (!root) return;
    if (suppressSelectionChangeFromGutter.get()) return;
    if (suppressSelectionSync.get()) return;
    if (pointer.getPointerIntent() === "node") {
      setValueSelectionRangeState({ collapsed: true });
      return;
    }

    const winSel = window.getSelection();
    if (!winSel?.rangeCount) {
      setValueSelectionRangeState({ collapsed: true });
      return;
    }

    const mappedRange = getMappedSelectionRangeInRoot(root, (point) =>
      domPositionToModel(root, point.node, point.offset),
    );
    if (!mappedRange) {
      if (pointer.isPointerSelecting()) return;
      setValueSelectionRangeState({ collapsed: true });
      return;
    }
    const focusNode = winSel.focusNode;
    const focusPos =
      focusNode && root.contains(focusNode)
        ? domPositionToModel(root, focusNode, winSel.focusOffset)
        : null;

    const collapsed = mappedRange.range.collapsed;
    const startNodeId = mappedRange.start.nodeId;
    const endNodeId = mappedRange.end.nodeId;
    setValueSelectionRangeState({ collapsed, startNodeId, endNodeId });
    const shouldDeferNonCollapsedPointerSync =
      allowNonCollapsedPointerDefer &&
      pointer.isPointerSelecting() &&
      !collapsed;
    if (shouldDeferNonCollapsedPointerSync) {
      const focusNodeId = focusPos?.nodeId ?? endNodeId;
      const nodeFocus: Location = { node: focusNodeId, portals };
      const selNow = core.selection();
      if (
        !(
          selNow.type === "editing" &&
          selNow.target === CONTENT_TEXT_TARGET &&
          sameLocation(selNow.location, nodeFocus)
        )
      ) {
        core.focus({
          type: "editing",
          location: nodeFocus,
          target: CONTENT_TEXT_TARGET,
        });
      }
      return;
    }

    const focusNodeId = focusPos?.nodeId ?? endNodeId;
    const nodeFocus: Location = { node: focusNodeId, portals };
    const selNow = core.selection();
    if (
      selNow.type === "editing" &&
      selNow.target === CONTENT_TEXT_TARGET &&
      sameLocation(selNow.location, nodeFocus)
    ) {
      return;
    }
    core.focus(
      { type: "editing", location: nodeFocus, target: CONTENT_TEXT_TARGET },
      collapsed && focusPos ? { caret: focusPos.offset } : undefined,
    );
  };

  return {
    selectionState: {
      selectedNodeKeys,
      valueRangeSelectedNodeKeys,
      valueSelectionCollapsed,
    },
    onGutterPointerDown,
    reconcileDomSelectionToModel,
    pointer,
    editingControls: {
      suppressSelectionSync,
      clearValueRangeSelectedNodes,
      setValueSelectionRangeState,
    },
    bind: ({ on, effect, isComposing }): void => {
      const root = getRoot();
      if (!root) return;
      bindOutlineSelectionEvents({
        on,
        core,
        root,
        portals,
        clearValueRangeSelectedNodes,
        reconcileDomSelectionToModel: (allowNonCollapsedPointerDefer) => {
          if (isComposing()) return;
          reconcileDomSelectionToModel(allowNonCollapsedPointerDefer);
        },
        pointer,
      });
      bindOutlineSelectionCleanupEffect({
        effect,
        core,
        valueSelectionCollapsed,
        resetStickyCaretX,
        clearValueRangeSelectedNodes,
      });
    },
  };
}

export function bindOutlineSelectionEvents(args: {
  on: Ctx["on"];
  core: UiCore;
  root: HTMLElement;
  portals: readonly NodeId[];
  clearValueRangeSelectedNodes: () => void;
  reconcileDomSelectionToModel: (
    allowNonCollapsedPointerDefer: boolean,
  ) => void;
  pointer: OutlinePointerRuntime;
}): void {
  const {
    on,
    core,
    root,
    portals,
    clearValueRangeSelectedNodes,
    reconcileDomSelectionToModel,
    pointer,
  } = args;

  on(root, "blur", (e: FocusEvent): void => {
    const next = e.relatedTarget;
    if (!(next instanceof Node) || !root.contains(next)) {
      pointer.clearPointerSelectionState();
      pointer.invalidatePointerFinalize();
      clearValueRangeSelectedNodes();
    }
  });

  on(root, "pointerdown", (e: PointerEvent): void => {
    if ((e.button ?? 0) !== 0) return;
    const targetNodeId = resolveValuePointerNodeId(e.target);
    if (targetNodeId) {
      pointer.beginPointerSelection(e.pointerId, "value");
      const selNow = core.selection();
      if (
        selNow.type !== "editing" ||
        selNow.target !== CONTENT_TEXT_TARGET ||
        selNow.location.node !== targetNodeId
      ) {
        core.focus({
          type: "editing",
          location: { node: targetNodeId, portals },
          target: CONTENT_TEXT_TARGET,
        });
      }
      return;
    }

    const nodeTargetId = resolveNodePointerNodeId(e.target);
    if (!nodeTargetId) return;
    pointer.beginPointerSelection(e.pointerId, "node");
    core.focus({
      type: "node",
      location: { node: nodeTargetId, portals },
    });
    e.stopPropagation();
  });

  on(document, "pointerup", (e: PointerEvent): void => {
    const sawSelectionChange = pointer.getSawSelectionChangeThisPointer();
    const intentAtPointerUp = pointer.getPointerIntent();
    if (!pointer.finishPointerSelection(e.pointerId)) return;
    const finalizeToken = pointer.nextPointerFinalizeToken();
    if (sawSelectionChange || intentAtPointerUp !== "value") return;
    setTimeout(() => {
      if (finalizeToken !== pointer.getPointerFinalizeToken()) return;
      reconcileDomSelectionToModel(false);
    }, 0);
  });

  on(document, "pointercancel", (e: PointerEvent): void => {
    if (!pointer.finishPointerSelection(e.pointerId)) return;
    pointer.invalidatePointerFinalize();
  });

  on(window, "blur", (): void => {
    pointer.clearPointerSelectionState();
    pointer.invalidatePointerFinalize();
  });

  on(document, "visibilitychange", (): void => {
    if (document.visibilityState !== "hidden") return;
    pointer.clearPointerSelectionState();
    pointer.invalidatePointerFinalize();
  });

  on(document, "selectionchange", (): void => {
    if (pointer.isPointerSelecting())
      pointer.markSawSelectionChangeThisPointer();
    reconcileDomSelectionToModel(true);
  });
}

export function bindOutlineSelectionCleanupEffect(args: {
  effect: Ctx["effect"];
  core: UiCore;
  valueSelectionCollapsed: Signal<boolean>;
  resetStickyCaretX: () => void;
  clearValueRangeSelectedNodes: () => void;
}): void {
  const {
    effect,
    core,
    valueSelectionCollapsed,
    resetStickyCaretX,
    clearValueRangeSelectedNodes,
  } = args;
  effect(() => {
    const selNow: Selection = core.selection();
    if (selNow.type !== "editing" || selNow.target !== CONTENT_TEXT_TARGET) {
      resetStickyCaretX();
      clearValueRangeSelectedNodes();
      return;
    }
    if (!valueSelectionCollapsed.value) {
      resetStickyCaretX();
      return;
    }
    clearValueRangeSelectedNodes();
  });
}
