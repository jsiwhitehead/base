import { computed } from "@preact/signals-core";

import type { ItemId, Location } from "../../core";
import type { Component, UiCore } from "../../dom";
import { createComponent, createSuppressionFlag } from "../../dom";

import {
  createOutlineEditingRuntime,
  createOutlineMutationSync,
  type InputState,
} from "./editing-runtime";
import { collectNavPoints } from "./navigation";
import { buildOutlineItem, type OutlineMountCtx } from "./render";
export type {
  OutlineSelectionEditingControls,
  OutlinePointerIntent,
  OutlinePointerRuntime,
  OutlineSelectionRuntime,
  OutlineSelectionState,
} from "./selection-runtime";
export {
  createOutlineSelectionRuntime,
  isOutlineValueEditEvent,
  resolveValuePointerItemId,
} from "./selection-runtime";
import { createOutlineSelectionRuntime } from "./selection-runtime";

export type { ApplyEditingResult, InputState } from "./editing-runtime";
export {
  createOutlineEditingRuntime,
  createOutlineMutationSync,
} from "./editing-runtime";

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
  rootId: ItemId,
  portals: readonly ItemId[],
  onValueTab: (location: Location, shift: boolean, caret: number) => void,
): Component {
  return createComponent(core, (ctx) => {
    // Shared editor session state.
    const navPoints = computed(() => collectNavPoints(core, rootId, portals));
    const suppressMutationSync = createSuppressionFlag(false);
    const suppressHistoryKeydown = createSuppressionFlag<
      "undo" | "redo" | null
    >(null);
    let isComposing = false;
    const { state, clearStickyCaretX } = createOutlineInputState();

    // Selection state needs the root element lazily while the tree mounts.
    let rootRef: HTMLElement | null = null;
    const selectionRuntime = createOutlineSelectionRuntime({
      core,
      rootId,
      portals,
      getRoot: () => rootRef,
      clearStickyCaretX,
    });

    let mutationSync: ReturnType<typeof createOutlineMutationSync> | null =
      null;
    const discardPendingMutationRecords = (): void => {
      mutationSync?.discardPendingMutationRecords();
    };

    // Rendering stays in render.ts; runtime just provides the mount context.
    const mountCtx: OutlineMountCtx = {
      core,
      portals,
      onGutterPointerDown: selectionRuntime.onGutterPointerDown,
      selectionState: selectionRuntime.selectionState,
      discardPendingMutationRecords,
      onValueTab,
    };
    const rootItem = buildOutlineItem(mountCtx, rootId);
    const root = rootItem.el;
    rootRef = root;
    configureOutlineRootElement(root);

    // Editing and mutation runtimes share the root element and session flags.
    mutationSync = createOutlineMutationSync({
      core,
      root,
      suppressMutationSync,
      isComposing: () => isComposing,
    });

    const editingRuntime = createOutlineEditingRuntime({
      core,
      rootId,
      portals,
      root,
      navPoints,
      discardPendingMutationRecords,
      suppressMutationSync,
      suppressHistoryKeydown,
      selection: selectionRuntime.editingControls,
    });

    // Bind runtime lifecycles after the root tree exists.
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
