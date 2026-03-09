import type { Intent, ItemId, Location } from "../../core";
import { CONTENT_TEXT_TARGET, LABEL_TARGET } from "../../core";
import type { UiCore } from "../../dom";

import {
  computePruneAncestorsForRemoval,
  outlineCmd,
  planBlockRemoval,
  removeBlockSelection,
  resolveFocusAfterOutlineRemove,
} from "./commands";
import {
  handleOutlineEditingEnter,
  handleOutlineEditingDelete,
  handleOutlineEditingNav,
} from "./editing-structural";
import { blockSelectionItems } from "./navigation";
import { handleOutlineItemNav } from "./runtime";

function focusFirstChildIfAny(core: UiCore, location: Location): boolean {
  const item = core.item(location.item);
  if (item.content.type !== "group") return false;
  const firstChildId = item.content.children[0] ?? null;
  if (!firstChildId) return false;
  core.focus({
    type: "item",
    location: { item: firstChildId, portals: location.portals },
  });
  return true;
}

function createFirstChildAndFocus(
  core: UiCore,
  location: Location,
  initialText: string,
): boolean {
  const item = core.item(location.item);
  if (item.mode.type === "readonly") return false;
  if (item.content.type !== "group") return false;
  if (item.content.children.length !== 0) return false;

  const childId = outlineCmd.createFirstChild(core, location, initialText);
  if (!childId) return false;
  core.focus(
    {
      type: "editing",
      location: { item: childId, portals: location.portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: initialText.length },
  );
  return true;
}

function focusInsertedItem(
  core: UiCore,
  itemId: ItemId,
  portals: readonly ItemId[],
): void {
  core.focus(
    {
      type: "editing",
      location: { item: itemId, portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: 0 },
  );
}

function nextOutlineTabFocus(
  core: UiCore,
  location: Location,
  shift: boolean,
): Location | null {
  return shift
    ? outlineCmd.outdentInPlace(core, location)
    : outlineCmd.indentInPlace(core, location);
}

export function createOutlineValueTabHandler(args: {
  core: UiCore;
  viewRootId: ItemId;
}): (location: Location, shift: boolean, caret: number) => void {
  const { core, viewRootId } = args;
  return (location: Location, shift: boolean, caret: number): void => {
    if (shift && location.item === viewRootId) return;
    const nextFocus = nextOutlineTabFocus(core, location, shift);
    if (!nextFocus) return;
    core.focus(
      { type: "editing", location: nextFocus, target: CONTENT_TEXT_TARGET },
      { caret },
    );
  };
}

export function createOutlineItemTabHandler(args: {
  core: UiCore;
}): (location: Location, shift: boolean) => void {
  const { core } = args;
  return (location, shift) => {
    const nextFocus = nextOutlineTabFocus(core, location, shift);
    if (!nextFocus) return;
    core.focus({ type: "item", location: nextFocus });
  };
}

function handleOutlineType(
  core: UiCore,
  location: Location,
  char: string,
): void {
  const item = core.item(location.item);
  if (item.mode.type === "readonly") return;
  createFirstChildAndFocus(core, location, char);
}

export function handleOutlineItemDelete(args: {
  core: UiCore;
  viewRootId: ItemId;
  portals: readonly ItemId[];
  selection: Extract<ReturnType<UiCore["selection"]>, { type: "item" }>;
}): void {
  const { core, viewRootId, portals, selection } = args;
  const selectedItems = blockSelectionItems(core, viewRootId, selection, portals);

  if (selectedItems.length > 1) {
    const lastId = selectedItems[selectedItems.length - 1]!;
    const blockPlan = planBlockRemoval(core, viewRootId, selectedItems);
    const nextFocus = resolveFocusAfterOutlineRemove(
      core,
      viewRootId,
      lastId,
      "next",
      portals,
      blockPlan.removedIds,
    );
    removeBlockSelection(core, viewRootId, selection, portals, blockPlan);
    if (nextFocus) core.focus({ type: "item", location: nextFocus });
    return;
  }

  const id = selection.head.item;
  if (!core.locate(id)) return;
  if (core.item(id).mode.type === "readonly") return;
  const removedIds = new Set<ItemId>([
    id,
    ...computePruneAncestorsForRemoval(core, viewRootId, id),
  ]);
  const nextFocus = resolveFocusAfterOutlineRemove(
    core,
    viewRootId,
    id,
    "next",
    portals,
    removedIds,
  );
  outlineCmd.removeAndPruneAncestors(core, viewRootId, id);
  if (nextFocus) core.focus({ type: "item", location: nextFocus });
}

export function createOutlineIntentHandler(args: {
  core: UiCore;
  viewRootId: ItemId;
  portals: readonly ItemId[];
}): (intent: Intent) => void {
  const { core, viewRootId, portals } = args;

  return (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type === "idle") return;
    const sel = selection;

    const location: Location = sel.type === "item" ? sel.head : sel.location;

    if (intent.type === "DELETE") {
      if (sel.type === "editing") {
        handleOutlineEditingDelete({
          core,
          viewRootId,
          location,
          portals,
          dir: intent.dir,
        });
        return;
      }
      handleOutlineItemDelete({
        core,
        viewRootId,
        portals,
        selection: sel,
      });
      return;
    }

    switch (intent.type) {
      case "NAV": {
        if (sel.type === "editing") {
          handleOutlineEditingNav({
            core,
            viewRootId,
            location,
            portals,
            dir: intent.dir,
          });
          return;
        }
        handleOutlineItemNav({
          core,
          viewRootId,
          portals,
          location,
          dir: intent.dir === "out" ? "left" : intent.dir,
        });
        return;
      }
      case "TYPE": {
        if (sel.type !== "item") return;
        handleOutlineType(core, location, intent.char);
        return;
      }
      case "ENTER": {
        if (sel.type === "editing") {
          handleOutlineEditingEnter({ core, location, intent, portals });
          return;
        }
        if (createFirstChildAndFocus(core, location, "")) {
          return;
        }
        if (focusFirstChildIfAny(core, location)) {
          return;
        }
        return;
      }
      case "LABEL": {
        core.focus(
          { type: "editing", location, target: LABEL_TARGET },
          { caret: "end" },
        );
        return;
      }
      case "INSERT": {
        const nextId = outlineCmd.insertForScope(
          core,
          viewRootId,
          location,
          intent.scope,
        );
        if (!nextId) return;
        focusInsertedItem(core, nextId, portals);
        return;
      }
    }
  };
}
