import { signal } from "@preact/signals-core";

import type { EntryId, Model } from "./model";
import type { NodeId } from "./read";
import { entryIdFromNodeId, nodeIdOf } from "./read";

export const LABEL_TARGET = "label" as const;
export const NODE_TARGET = "node" as const;
export const connTarget: (key: string) => string = (key) => `conn:${key}`;
export const contentTarget: (kind: string) => string = (kind) =>
  `content:${kind}`;
export const CONTENT_TEXT_TARGET = contentTarget("text");

export type Location = { node: NodeId; portals: readonly NodeId[] };

export function sameLocation(a: Location, b: Location): boolean {
  return (
    a.node === b.node &&
    a.portals.length === b.portals.length &&
    a.portals.every((portal, i) => portal === b.portals[i])
  );
}

export type Selection =
  | { type: "idle" }
  | { type: "editing"; location: Location; target: string }
  | { type: "node"; anchor: Location; head: Location };

export type CaretPlacement = number | "end";
export type FocusOpts = { caret?: CaretPlacement };
type NodeFocusSelectionInput =
  | Extract<Selection, { type: "node" }>
  | { type: "node"; location: Location };
export type NonEditingFocusSelection =
  | Extract<Selection, { type: "idle" }>
  | NodeFocusSelectionInput;

type RepairAnchorStep = { parentId: EntryId; index: number };
export type SelectionRepairAnchor = {
  steps: readonly RepairAnchorStep[];
  caret?: number;
};

export type SelectionController = {
  selection(): Selection;
  peekSelection(): Selection;
  setSelection(next: Selection, caret?: CaretPlacement): void;
  isValidSelection(sel: Selection): boolean;
  focus(
    next: Extract<Selection, { type: "editing" }>,
    focusOpts?: FocusOpts,
  ): void;
  focus(next: NonEditingFocusSelection, focusOpts?: never): void;
  captureRepairAnchor(): SelectionRepairAnchor | null;
  repairAfterLocalApply(anchor: SelectionRepairAnchor | null): void;
  coerceEditingToNode(): void;
  coerceAfterRemoteApply(): void;
  resetToRoot(): void;
};

type SelectionControllerOptions = {
  model: Model;
  rootLocation: Location;
  readCurrentCaret?: () => number | undefined;
  onSelectionChange?: (selection: Selection, caret?: CaretPlacement) => void;
};

export function createSelectionController(
  opts: SelectionControllerOptions,
): SelectionController {
  const selectionSignal = signal<Selection>({
    type: "node",
    anchor: opts.rootLocation,
    head: opts.rootLocation,
  });

  const isValidLocation = (location: Location): boolean => {
    const model = opts.model;
    const nodeEid = entryIdFromNodeId(location.node);
    if (nodeEid == null) return false;
    if (!model.hasEntry(nodeEid)) return false;
    for (const portalNodeId of location.portals) {
      const portalEid = entryIdFromNodeId(portalNodeId);
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

  const setSelection = (next: Selection, caret?: CaretPlacement): void => {
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
    if (next.type === "node" && "location" in next) {
      setSelection({
        type: "node",
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
        ? entryIdFromNodeId(sel.location.node)
        : sel.type === "node"
          ? entryIdFromNodeId(sel.anchor.node)
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

      return { node: nodeIdOf(childId), portals: [] };
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
        setSelection({
          type: "node",
          anchor: repairedLocation,
          head: repairedLocation,
        });
        return;
      }
    }

    setSelection({
      type: "node",
      anchor: opts.rootLocation,
      head: opts.rootLocation,
    });
  };

  const coerceEditingToNode = (): void => {
    const selNow = selectionSignal.peek();
    if (selNow.type !== "editing") return;
    setSelection({
      type: "node",
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
      type: "node",
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
    coerceEditingToNode,
    coerceAfterRemoteApply,
    resetToRoot,
  };
}
