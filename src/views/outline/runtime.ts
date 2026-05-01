import { computed } from "@preact/signals-core";

import type { NodeId, Location, Selection } from "../../core";
import type { Component, UiCore } from "../../dom";
import { createComponent, createSuppressionFlag } from "../../dom";

import {
  createOutlineInputRuntime,
  createOutlineMutationSync,
} from "./runtime-input";
import {
  collectStops,
  firstChild,
  nextSibling,
  parentOf,
  prevSibling,
} from "./navigation";
import { buildOutlineNode, type OutlineMountCtx } from "./render";
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
  resolveValuePointerNodeId,
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

function samePortals(a: readonly NodeId[], b: readonly NodeId[]): boolean {
  return a.length === b.length && a.every((id, idx) => id === b[idx]);
}

function isNodeSelectionOwnedByThisOutline(
  selection: Selection,
  portals: readonly NodeId[],
): selection is Extract<Selection, { type: "node" }> {
  return (
    selection.type === "node" &&
    samePortals(selection.anchor.portals, portals) &&
    samePortals(selection.head.portals, portals)
  );
}

function isSingleNodeSelectionInThisOutline(
  selection: Selection,
  portals: readonly NodeId[],
): selection is Extract<Selection, { type: "node" }> {
  return (
    isNodeSelectionOwnedByThisOutline(selection, portals) &&
    selection.anchor.node === selection.head.node
  );
}

export function handleOutlineNodeNav(args: {
  core: UiCore;
  viewRootId: NodeId;
  portals: readonly NodeId[];
  location: Location;
  dir: "left" | "right" | "up" | "down";
}): void {
  const { core, viewRootId, portals, location, dir } = args;
  const fromId = location.node;
  let nextId: NodeId | null = null;
  if (dir === "left") nextId = parentOf(core, viewRootId, fromId);
  else if (dir === "right")
    nextId = firstChild(core, fromId) ?? nextSibling(core, fromId);
  else if (dir === "up") nextId = prevSibling(core, fromId);
  else if (dir === "down") nextId = nextSibling(core, fromId);
  if (!nextId) return;
  core.focus({ type: "node", location: { node: nextId, portals } });
}

export function buildOutlineRoot(
  core: UiCore,
  viewRootId: NodeId,
  portals: readonly NodeId[],
  onValueTab: (location: Location, shift: boolean, caret: number) => void,
  onNodeTab: (location: Location, shift: boolean) => void,
  onNodeDelete: (selection: Extract<Selection, { type: "node" }>) => void,
  onNodeNav: (
    location: Location,
    dir: "left" | "right" | "up" | "down",
  ) => void,
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
    const rootNode = buildOutlineNode(mountCtx, viewRootId);
    const root = rootNode.el;
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

    ctx.effect(() => () => rootNode.dispose());
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

    ctx.on(root, "keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Tab") return;
      const selection = core.selection();
      if (!isSingleNodeSelectionInThisOutline(selection, portals)) return;
      e.preventDefault();
      e.stopPropagation();
      onNodeTab(selection.head, e.shiftKey);
    });

    ctx.on(root, "keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const selection = core.selection();

      if (
        isNodeSelectionOwnedByThisOutline(selection, portals) &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "Backspace" || e.key === "Delete")
      ) {
        e.preventDefault();
        e.stopPropagation();
        onNodeDelete(selection);
        return;
      }

      if (
        isSingleNodeSelectionInThisOutline(selection, portals) &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "ArrowLeft" ||
          e.key === "ArrowRight" ||
          e.key === "ArrowUp" ||
          e.key === "ArrowDown")
      ) {
        const dir =
          e.key === "ArrowLeft"
            ? "left"
            : e.key === "ArrowRight"
              ? "right"
              : e.key === "ArrowUp"
                ? "up"
                : "down";
        e.preventDefault();
        e.stopPropagation();
        onNodeNav(selection.head, dir);
      }
    });

    return root;
  });
}
