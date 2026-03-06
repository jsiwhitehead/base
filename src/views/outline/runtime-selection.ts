import { computed, signal, type Signal } from "@preact/signals-core";

import type { ItemId, Location, Selection } from "../../core";
import { sameLocation, VALUE_TARGET } from "../../core";
import {
  createSuppressionFlag,
  getMappedSelectionRangeInRoot,
  resolveEventTargetElement,
} from "../../dom";
import type { Ctx, SuppressionFlag, UiCore } from "../../dom";

import {
  domPositionToModel,
  ITEM_SELECTOR,
  VALUE_SELECTOR,
} from "./dom-mapping";
import { blockSelectionLocations, locationKey } from "./navigation";

export type OutlinePointerIntent = "value" | "item" | null;

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
  selectedItemKeys: Signal<Set<string>>;
  valueRangeSelectedItemKeys: Signal<Set<string>>;
  valueSelectionCollapsed: Signal<boolean>;
};

export type OutlineSelectionEditingControls = {
  suppressSelectionSync: SuppressionFlag<boolean>;
  clearValueRangeSelectedItems: () => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startItemId?: ItemId;
    endItemId?: ItemId;
  }) => void;
};

export type OutlineSelectionRuntime = {
  selectionState: OutlineSelectionState;
  onGutterPointerDown: (
    itemId: ItemId,
    portals: readonly ItemId[],
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

export function resolveValuePointerItemId(
  target: EventTarget | null,
): ItemId | null {
  const targetEl = resolveEventTargetElement(target);
  const zone = classifyOutlinePointerZone(targetEl);
  if (zone !== "value" && zone !== "shell") return null;
  return targetEl?.closest<HTMLElement>(ITEM_SELECTOR)?.dataset.id ?? null;
}

export function isOutlineValueEditEvent(
  target: EventTarget | null,
  root: HTMLElement,
): boolean {
  const targetEl = resolveEventTargetElement(target);
  if (!targetEl || targetEl === root) return true;
  return classifyOutlinePointerZone(targetEl) === "value";
}

export function createOutlinePointerRuntime(args: {
  clearStickyCaretX: () => void;
}): OutlinePointerRuntime {
  const { clearStickyCaretX } = args;
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
      clearStickyCaretX();
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
  rootId: ItemId;
  portals: readonly ItemId[];
  getRoot: () => HTMLElement | null;
  clearStickyCaretX: () => void;
}): OutlineSelectionRuntime {
  const { core, rootId, portals, getRoot, clearStickyCaretX } = args;
  const selectedItemKeys = computed(() => {
    const sel = core.selection();
    if (sel.type !== "item") return new Set<string>();
    return new Set(
      blockSelectionLocations(core, rootId, sel, portals).map((location) =>
        locationKey(location),
      ),
    );
  });
  const valueRangeSelectedItemKeys = signal(new Set<string>());
  const valueSelectionCollapsed = signal(true);

  const clearValueRangeSelectedItems = (): void => {
    if (valueRangeSelectedItemKeys.value.size === 0) return;
    valueRangeSelectedItemKeys.value = new Set<string>();
  };

  const setValueSelectionRangeState = (args: {
    collapsed: boolean;
    startItemId?: ItemId;
    endItemId?: ItemId;
  }): void => {
    const { collapsed, startItemId, endItemId } = args;
    valueSelectionCollapsed.value = collapsed;
    if (collapsed || !startItemId || !endItemId) {
      clearValueRangeSelectedItems();
      return;
    }
    valueRangeSelectedItemKeys.value = new Set(
      blockSelectionLocations(
        core,
        rootId,
        {
          type: "item",
          anchor: { item: startItemId, portals },
          head: { item: endItemId, portals },
        },
        portals,
      ).map((location) => locationKey(location)),
    );
  };

  const suppressSelectionChangeFromGutter = createSuppressionFlag(false);
  const suppressSelectionSync = createSuppressionFlag(false);
  const pointer = createOutlinePointerRuntime({ clearStickyCaretX });

  const onGutterPointerDown = (
    itemId: ItemId,
    itemPortals: readonly ItemId[],
    shiftKey: boolean,
    pointerId: number,
  ): void => {
    pointer.beginPointerSelection(pointerId, "item");
    suppressSelectionChangeFromGutter.suppressForTurn(true);

    const nextFocus: Location = { item: itemId, portals: itemPortals };
    if (shiftKey) {
      const sel = core.selection();
      if (sel.type === "item") {
        core.focus({ type: "item", anchor: sel.anchor, head: nextFocus });
        return;
      }
    }
    core.focus({ type: "item", location: nextFocus });
  };

  const reconcileDomSelectionToModel = (
    allowNonCollapsedPointerDefer: boolean,
  ): void => {
    const root = getRoot();
    if (!root) return;
    if (suppressSelectionChangeFromGutter.get()) return;
    if (suppressSelectionSync.get()) return;
    if (pointer.getPointerIntent() === "item") {
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
    const startItemId = mappedRange.start.itemId;
    const endItemId = mappedRange.end.itemId;
    setValueSelectionRangeState({ collapsed, startItemId, endItemId });
    const shouldDeferNonCollapsedPointerSync =
      allowNonCollapsedPointerDefer &&
      pointer.isPointerSelecting() &&
      !collapsed;
    if (shouldDeferNonCollapsedPointerSync) {
      const focusItemId = focusPos?.itemId ?? endItemId;
      const itemFocus: Location = { item: focusItemId, portals };
      const selNow = core.selection();
      if (
        !(
          selNow.type === "editing" &&
          selNow.target === VALUE_TARGET &&
          sameLocation(selNow.location, itemFocus)
        )
      ) {
        core.focus({
          type: "editing",
          location: itemFocus,
          target: VALUE_TARGET,
        });
      }
      return;
    }

    const focusItemId = focusPos?.itemId ?? endItemId;
    const itemFocus: Location = { item: focusItemId, portals };
    const selNow = core.selection();
    if (
      selNow.type === "editing" &&
      selNow.target === VALUE_TARGET &&
      sameLocation(selNow.location, itemFocus)
    ) {
      return;
    }
    core.focus(
      { type: "editing", location: itemFocus, target: VALUE_TARGET },
      collapsed && focusPos ? { caret: focusPos.offset } : undefined,
    );
  };

  return {
    selectionState: {
      selectedItemKeys,
      valueRangeSelectedItemKeys,
      valueSelectionCollapsed,
    },
    onGutterPointerDown,
    reconcileDomSelectionToModel,
    pointer,
    editingControls: {
      suppressSelectionSync,
      clearValueRangeSelectedItems,
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
        clearStickyCaretX,
        clearValueRangeSelectedItems,
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
        clearValueRangeSelectedItems,
      });
    },
  };
}

export function bindOutlineSelectionEvents(args: {
  on: Ctx["on"];
  core: UiCore;
  root: HTMLElement;
  portals: readonly ItemId[];
  clearStickyCaretX: () => void;
  clearValueRangeSelectedItems: () => void;
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
    clearStickyCaretX,
    clearValueRangeSelectedItems,
    reconcileDomSelectionToModel,
    pointer,
  } = args;

  on(root, "focus", (): void => {
    clearStickyCaretX();
  });
  on(root, "blur", (e: FocusEvent): void => {
    const next = e.relatedTarget;
    if (!(next instanceof Node) || !root.contains(next)) {
      pointer.clearPointerSelectionState();
      pointer.invalidatePointerFinalize();
      clearValueRangeSelectedItems();
    }
  });
  on(root, "focusout", (): void => {
    clearStickyCaretX();
  });

  on(root, "pointerdown", (e: PointerEvent): void => {
    if ((e.button ?? 0) !== 0) return;
    const targetItemId = resolveValuePointerItemId(e.target);
    if (!targetItemId) return;
    pointer.beginPointerSelection(e.pointerId, "value");
    const selNow = core.selection();
    if (
      selNow.type !== "editing" ||
      selNow.target !== VALUE_TARGET ||
      selNow.location.item !== targetItemId
    ) {
      core.focus({
        type: "editing",
        location: { item: targetItemId, portals },
        target: VALUE_TARGET,
      });
    }
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
  clearValueRangeSelectedItems: () => void;
}): void {
  const {
    effect,
    core,
    valueSelectionCollapsed,
    clearValueRangeSelectedItems,
  } = args;
  effect(() => {
    const selNow: Selection = core.selection();
    if (selNow.type !== "editing" || selNow.target !== VALUE_TARGET) {
      clearValueRangeSelectedItems();
      return;
    }
    if (valueSelectionCollapsed.value) clearValueRangeSelectedItems();
  });
}
