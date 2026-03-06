import { signal } from "@preact/signals-core";

import type { EntryId, Model } from "./model";
import type { ItemId } from "./read";
import { entryIdFromItemId, itemIdOf } from "./read";

export const LABEL_TARGET = "label" as const;
export const ITEM_TARGET = "item" as const;
export const VALUE_TARGET = "value" as const;
export const connTarget: (key: string) => string = (key) => `conn:${key}`;

export type Location = { item: ItemId; portals: readonly ItemId[] };

export function sameLocation(a: Location, b: Location): boolean {
  return (
    a.item === b.item &&
    a.portals.length === b.portals.length &&
    a.portals.every((portal, i) => portal === b.portals[i])
  );
}

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
  rootLocation: Location;
  readCurrentCaret?: () => number | undefined;
  onSelectionChange?: (selection: Selection, caret?: number) => void;
};

export function createSelectionController(
  opts: SelectionControllerOptions,
): SelectionController {
  const selectionSignal = signal<Selection>({
    type: "item",
    anchor: opts.rootLocation,
    head: opts.rootLocation,
  });

  const isValidLocation = (location: Location): boolean => {
    const model = opts.model;
    const itemEid = entryIdFromItemId(location.item);
    if (itemEid == null) return false;
    if (!model.hasEntry(itemEid)) return false;
    for (const portalItemId of location.portals) {
      const portalEid = entryIdFromItemId(portalItemId);
      if (portalEid == null || !model.hasEntry(portalEid)) return false;
      const contentType = model.contentTypeOf(portalEid);
      if (contentType !== "formula" && contentType !== "query") return false;
    }
    return true;
  };

  const isValidSelection = (sel: Selection): boolean => {
    if (sel.type === "idle") return true;
    if (sel.type === "editing") return isValidLocation(sel.location);
    return isValidLocation(sel.anchor) && isValidLocation(sel.head);
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
        ? entryIdFromItemId(sel.location.item)
        : sel.type === "item"
          ? entryIdFromItemId(sel.anchor.item)
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
    return { steps, ...(caret !== undefined ? { caret } : {}) };
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

      return { item: itemIdOf(childId), portals: [] };
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
      const repairedLocation = resolveRepairAnchor(anchor);
      if (repairedLocation) {
        if (anchor.caret !== undefined) {
          setSelection(
            {
              type: "editing",
              location: repairedLocation,
              target: VALUE_TARGET,
            },
            anchor.caret,
          );
        } else {
          setSelection({
            type: "item",
            anchor: repairedLocation,
            head: repairedLocation,
          });
        }
        return;
      }
    }

    setSelection({
      type: "item",
      anchor: opts.rootLocation,
      head: opts.rootLocation,
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
      anchor: opts.rootLocation,
      head: opts.rootLocation,
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
