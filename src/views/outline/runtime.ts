import { computed } from "@preact/signals-core";

import type { ItemId, Location } from "../../core";
import type { Component, UiCore } from "../../dom";
import { createComponent, createSuppressionFlag } from "../../dom";

import {
  createOutlineInputRuntime,
  createOutlineMutationSync,
} from "./runtime-input";
import { collectStops } from "./navigation";
import { buildOutlineItem, type OutlineMountCtx } from "./render";
export type {
  OutlineSelectionEditingControls,
  OutlinePointerIntent,
  OutlinePointerRuntime,
  OutlineSelectionRuntime,
  OutlineSelectionState,
} from "./runtime-selection";
export {
  createOutlineSelectionRuntime,
  isOutlineValueEditEvent,
  resolveValuePointerItemId,
} from "./runtime-selection";
import { createOutlineSelectionRuntime } from "./runtime-selection";

export type { ApplyEditingResult } from "./runtime-navigation";
export {
  createOutlineInputRuntime,
  createOutlineMutationSync,
} from "./runtime-input";

function configureOutlineRootElement(root: HTMLElement): void {
  root.contentEditable = "true";
  root.spellcheck = false;
  root.setAttribute("autocorrect", "off");
  root.setAttribute("autocapitalize", "off");
}

function createOutlineRuntimeState(): {
  getCompositionEndedAt: () => number;
  setCompositionEndedAt: (next: number) => void;
  getStickyCaretX: () => number | null;
  setStickyCaretX: (next: number) => void;
  resetStickyCaretX: () => void;
} {
  let compositionEndedAt = 0;
  let stickyCaretX: number | null = null;
  return {
    getCompositionEndedAt: (): number => compositionEndedAt,
    setCompositionEndedAt: (next: number): void => {
      compositionEndedAt = next;
    },
    getStickyCaretX: (): number | null => stickyCaretX,
    setStickyCaretX: (next: number): void => {
      stickyCaretX = next;
    },
    resetStickyCaretX: (): void => {
      stickyCaretX = null;
    },
  };
}

export function buildOutlineRoot(
  core: UiCore,
  viewRootId: ItemId,
  portals: readonly ItemId[],
  onValueTab: (location: Location, shift: boolean, caret: number) => void,
): Component {
  return createComponent(core, (ctx) => {
    const stops = computed(() => collectStops(core, viewRootId, portals));
    const suppressMutationSync = createSuppressionFlag(false);
    const suppressHistoryKeydown = createSuppressionFlag<
      "undo" | "redo" | null
    >(null);
    let isComposing = false;
    const {
      getCompositionEndedAt,
      setCompositionEndedAt,
      getStickyCaretX,
      setStickyCaretX,
      resetStickyCaretX,
    } = createOutlineRuntimeState();

    let rootRef: HTMLElement | null = null;
    const selectionRuntime = createOutlineSelectionRuntime({
      core,
      rootId: viewRootId,
      portals,
      getRoot: () => rootRef,
      resetStickyCaretX,
    });

    let mutationSync: ReturnType<typeof createOutlineMutationSync> | null =
      null;
    const discardPendingMutationRecords = (): void => {
      mutationSync?.discardPendingMutationRecords();
    };

    const mountCtx: OutlineMountCtx = {
      core,
      portals,
      onGutterPointerDown: selectionRuntime.onGutterPointerDown,
      selectionState: selectionRuntime.selectionState,
      discardPendingMutationRecords,
      onValueTab,
    };
    const rootItem = buildOutlineItem(mountCtx, viewRootId);
    const root = rootItem.el;
    rootRef = root;
    configureOutlineRootElement(root);

    mutationSync = createOutlineMutationSync({
      core,
      root,
      suppressMutationSync,
      isComposing: () => isComposing,
    });

    const inputRuntime = createOutlineInputRuntime({
      core,
      rootId: viewRootId,
      portals,
      root,
      stops,
      resetStickyCaretX,
      discardPendingMutationRecords,
      suppressMutationSync,
      suppressHistoryKeydown,
      selection: selectionRuntime.editingControls,
    });

    ctx.effect(() => () => rootItem.dispose());
    selectionRuntime.bind({
      on: ctx.on,
      effect: ctx.effect,
      isComposing: () => isComposing,
    });
    mutationSync.bind(ctx.effect);
    inputRuntime.bind({
      on: ctx.on,
      getCompositionEndedAt,
      setCompositionEndedAt,
      getStickyCaretX,
      setStickyCaretX,
      resetStickyCaretX,
      onValueTab,
      setIsComposing: (next) => {
        isComposing = next;
      },
    });

    return root;
  });
}
