import { signal } from "@preact/signals-core";

import type { EntryId, Model } from "./model";
import type { ItemId } from "./read";
import { entryIdFromItemId, itemIdOf } from "./read";

export type Location = { container: ItemId; item: ItemId };

export type Selection =
  | { type: "idle" }
  | { type: "editing"; location: Location; target: string }
  | { type: "item"; anchor: Location; head: Location };

export type FocusOpts = { caret?: number };
type ItemFocusSelectionInput =
  | Extract<Selection, { type: "item" }>
  | { type: "item"; location: Location };
export type NonEditingFocusSelection =
  | Extract<Selection, { type: "idle" }>
  | ItemFocusSelectionInput;

type RepairAnchorStep = { parentId: EntryId; index: number };
export type SelectionRepairAnchor = {
  steps: readonly RepairAnchorStep[];
  caret?: number;
};

export type SelectionController = {
  selection(): Selection;
  peekSelection(): Selection;
  setSelection(next: Selection, caret?: number): void;
  isValidSelection(sel: Selection): boolean;
  focus(
    next: Extract<Selection, { type: "editing" }>,
    focusOpts?: FocusOpts,
  ): void;
  focus(next: NonEditingFocusSelection, focusOpts?: never): void;
  captureRepairAnchor(): SelectionRepairAnchor | null;
  repairAfterLocalApply(anchor: SelectionRepairAnchor | null): void;
  coerceEditingToItem(): void;
  coerceAfterRemoteApply(): void;
  resetToRoot(): void;
};

type SelectionControllerOptions = {
  model: Model;
  rootEntryId: EntryId;
  rootFocus: Location;
  readCurrentCaret?: () => number | undefined;
  onSelectionChange?: (selection: Selection, caret?: number) => void;
};

export function createSelectionController(
  opts: SelectionControllerOptions,
): SelectionController {
  const selectionSignal = signal<Selection>({
    type: "item",
    anchor: opts.rootFocus,
    head: opts.rootFocus,
  });

  const isValidFocus = (focus: Location): boolean => {
    const model = opts.model;
    const itemEid = entryIdFromItemId(focus.item);
    const containerEid = entryIdFromItemId(focus.container);
    if (itemEid == null || containerEid == null) return false;
    if (!model.hasEntry(itemEid) || !model.hasEntry(containerEid)) return false;
    if (itemEid === containerEid) return itemEid === opts.rootEntryId;
    return true;
  };

  const isValidSelection = (sel: Selection): boolean => {
    if (sel.type === "idle") return true;
    if (sel.type === "editing") return isValidFocus(sel.location);
    return isValidFocus(sel.anchor) && isValidFocus(sel.head);
  };

  const setSelection = (next: Selection, caret?: number): void => {
    if (!isValidSelection(next)) return;

    selectionSignal.value = next;
    if (next.type === "editing") {
      opts.onSelectionChange?.(next, caret);
      return;
    }
    opts.onSelectionChange?.(next);
  };

  function focus(
    next: Extract<Selection, { type: "editing" }>,
    focusOpts?: FocusOpts,
  ): void;
  function focus(next: NonEditingFocusSelection, focusOpts?: never): void;
  function focus(
    next: Extract<Selection, { type: "editing" }> | NonEditingFocusSelection,
    focusOpts?: FocusOpts,
  ): void {
    if (next.type === "editing") {
      setSelection(next, focusOpts?.caret);
      return;
    }
    if (next.type === "item" && "location" in next) {
      setSelection({
        type: "item",
        anchor: next.location,
        head: next.location,
      });
      return;
    }
    setSelection(next);
  }

  const selection = (): Selection => selectionSignal.value;
  const peekSelection = (): Selection => selectionSignal.peek();

  const captureRepairAnchor = (): SelectionRepairAnchor | null => {
    const model = opts.model;
    const sel = selectionSignal.peek();
    const leafId =
      sel.type === "editing"
        ? (entryIdFromItemId(sel.location.item) ??
          entryIdFromItemId(sel.location.container))
        : sel.type === "item"
          ? (entryIdFromItemId(sel.anchor.item) ??
            entryIdFromItemId(sel.anchor.container))
          : null;
    if (leafId == null) return null;

    const steps: RepairAnchorStep[] = [];
    for (let cur: EntryId | null = leafId; cur != null; ) {
      const loc = model.locateInParent(cur);
      if (!loc) break;
      steps.push({ parentId: loc.parentId, index: loc.index });
      cur = loc.parentId;
    }

    const caret = opts.readCurrentCaret?.();
    return {
      steps,
      ...(caret !== undefined ? { caret } : {}),
    };
  };

  const resolveRepairAnchor = (
    anchor: SelectionRepairAnchor,
  ): Location | null => {
    const model = opts.model;

    for (let i = anchor.steps.length - 1; i >= 0; i -= 1) {
      const { parentId, index } = anchor.steps[i]!;
      if (!model.hasEntry(parentId)) continue;

      const siblings = model.childIdsOf(parentId);
      if (!siblings.length) continue;

      const childId = siblings[index] ?? siblings[siblings.length - 1] ?? null;
      if (childId == null || !model.hasEntry(childId)) continue;

      return { container: itemIdOf(parentId), item: itemIdOf(childId) };
    }

    return null;
  };

  const repairAfterLocalApply = (
    anchor: SelectionRepairAnchor | null,
  ): void => {
    const selNow = selectionSignal.peek();
    if (isValidSelection(selNow)) {
      setSelection(selNow, anchor?.caret);
      return;
    }

    if (anchor) {
      const focusLocation = resolveRepairAnchor(anchor);
      if (focusLocation) {
        setSelection({
          type: "item",
          anchor: focusLocation,
          head: focusLocation,
        });
        return;
      }
    }

    setSelection({
      type: "item",
      anchor: opts.rootFocus,
      head: opts.rootFocus,
    });
  };

  const coerceEditingToItem = (): void => {
    const selNow = selectionSignal.peek();
    if (selNow.type !== "editing") return;
    setSelection({
      type: "item",
      anchor: selNow.location,
      head: selNow.location,
    });
  };

  const coerceAfterRemoteApply = (): void => {
    const selNow = selectionSignal.peek();
    if (!isValidSelection(selNow)) setSelection({ type: "idle" });
  };

  const resetToRoot = (): void => {
    setSelection({
      type: "item",
      anchor: opts.rootFocus,
      head: opts.rootFocus,
    });
  };

  return {
    selection,
    peekSelection,
    setSelection,
    isValidSelection,
    focus,
    captureRepairAnchor,
    repairAfterLocalApply,
    coerceEditingToItem,
    coerceAfterRemoteApply,
    resetToRoot,
  };
}
