import { computed } from "@preact/signals-core";

import type { ItemId, Location, Selection } from "../../core";
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

function samePortals(a: readonly ItemId[], b: readonly ItemId[]): boolean {
  return a.length === b.length && a.every((id, idx) => id === b[idx]);
}

function isItemSelectionOwnedByThisOutline(
  selection: Selection,
  portals: readonly ItemId[],
): selection is Extract<Selection, { type: "item" }> {
  return (
    selection.type === "item" &&
    samePortals(selection.anchor.portals, portals) &&
    samePortals(selection.head.portals, portals)
  );
}

function isSingleItemSelectionInThisOutline(
  selection: Selection,
  portals: readonly ItemId[],
): selection is Extract<Selection, { type: "item" }> {
  return (
    isItemSelectionOwnedByThisOutline(selection, portals) &&
    selection.anchor.item === selection.head.item
  );
}

export function handleOutlineItemNav(args: {
  core: UiCore;
  viewRootId: ItemId;
  portals: readonly ItemId[];
  location: Location;
  dir: "left" | "right" | "up" | "down";
}): void {
  const { core, viewRootId, portals, location, dir } = args;
  const fromId = location.item;
  let nextId: ItemId | null = null;
  if (dir === "left") nextId = parentOf(core, viewRootId, fromId);
  else if (dir === "right")
    nextId = firstChild(core, fromId) ?? nextSibling(core, fromId);
  else if (dir === "up") nextId = prevSibling(core, fromId);
  else if (dir === "down") nextId = nextSibling(core, fromId);
  if (!nextId) return;
  core.focus({ type: "item", location: { item: nextId, portals } });
}

export function buildOutlineRoot(
  core: UiCore,
  viewRootId: ItemId,
  portals: readonly ItemId[],
  onValueTab: (location: Location, shift: boolean, caret: number) => void,
  onItemTab: (location: Location, shift: boolean) => void,
  onItemDelete: (selection: Extract<Selection, { type: "item" }>) => void,
  onItemNav: (
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

    ctx.on(root, "keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.key !== "Tab") return;
      const selection = core.selection();
      if (!isSingleItemSelectionInThisOutline(selection, portals)) return;
      e.preventDefault();
      e.stopPropagation();
      onItemTab(selection.head, e.shiftKey);
    });

    ctx.on(root, "keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const selection = core.selection();

      if (
        isItemSelectionOwnedByThisOutline(selection, portals) &&
        !e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        !e.ctrlKey &&
        (e.key === "Backspace" || e.key === "Delete")
      ) {
        e.preventDefault();
        e.stopPropagation();
        onItemDelete(selection);
        return;
      }

      if (
        isSingleItemSelectionInThisOutline(selection, portals) &&
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
        onItemNav(selection.head, dir);
      }
    });

    return root;
  });
}
