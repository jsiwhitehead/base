import { computed } from "@preact/signals-core";

import type { ItemId, Location } from "../../core";
import type { Component, UiCore } from "../../dom";
import { createComponent, createSuppressionFlag } from "../../dom";

import {
  createOutlineEditingRuntime,
  createOutlineMutationSync,
  type InputState,
} from "./runtime-editing";
import { collectNavPoints } from "./navigation";
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

export type { ApplyEditingResult, InputState } from "./runtime-editing";
export {
  createOutlineEditingRuntime,
  createOutlineMutationSync,
} from "./runtime-editing";

function configureOutlineRootElement(root: HTMLElement): void {
  root.contentEditable = "true";
  root.spellcheck = false;
  root.setAttribute("autocorrect", "off");
  root.setAttribute("autocapitalize", "off");
}

function createOutlineInputState(): {
  state: InputState;
  clearStickyCaretX: () => void;
} {
  const state: InputState = {
    compositionEndedAt: 0,
    stickyCaretX: null,
  };
  return {
    state,
    clearStickyCaretX: (): void => {
      state.stickyCaretX = null;
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
    const navPoints = computed(() =>
      collectNavPoints(core, viewRootId, portals),
    );
    const suppressMutationSync = createSuppressionFlag(false);
    const suppressHistoryKeydown = createSuppressionFlag<
      "undo" | "redo" | null
    >(null);
    let isComposing = false;
    const { state, clearStickyCaretX } = createOutlineInputState();

    let rootRef: HTMLElement | null = null;
    const selectionRuntime = createOutlineSelectionRuntime({
      core,
      rootId: viewRootId,
      portals,
      getRoot: () => rootRef,
      clearStickyCaretX,
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

    const editingRuntime = createOutlineEditingRuntime({
      core,
      rootId: viewRootId,
      portals,
      root,
      navPoints,
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
    editingRuntime.bind({
      on: ctx.on,
      state,
      onValueTab,
      setIsComposing: (next) => {
        isComposing = next;
      },
      clearStickyCaretX,
    });

    return root;
  });
}
