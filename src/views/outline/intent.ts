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
  blockSelectionItems,
  firstChild,
  nextSibling,
  parentOf,
  prevSibling,
} from "./navigation";

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

export function createOutlineValueTabHandler(args: {
  core: UiCore;
}): (location: Location, shift: boolean, caret: number) => void {
  const { core } = args;
  return (location: Location, shift: boolean, caret: number): void => {
    const nextFocus = shift
      ? outlineCmd.outdentInPlace(core, location)
      : outlineCmd.indentInPlace(core, location);
    if (!nextFocus) return;
    core.focus(
      { type: "editing", location: nextFocus, target: CONTENT_TEXT_TARGET },
      { caret },
    );
  };
}

export function createOutlineIntentHandler(args: {
  core: UiCore;
  viewRootId: ItemId;
  portals: readonly ItemId[];
}): (intent: Intent) => void {
  const { core, viewRootId, portals } = args;

  return (intent: Intent): void => {
    const selection = core.selection();
    if (
      selection.type !== "item" &&
      !(selection.type === "editing" && (intent.type === "INSERT" || intent.type === "EDIT_LABEL"))
    ) {
      return;
    }
    const sel = selection;

    const location: Location = sel.type === "item" ? sel.head : sel.location;
    const selectedItems =
      sel.type === "item"
        ? blockSelectionItems(core, viewRootId, sel, portals)
        : [];

    if (intent.type === "DELETE") {
      if (sel.type !== "item") return;
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
        removeBlockSelection(core, viewRootId, sel, portals, blockPlan);
        if (nextFocus) core.focus({ type: "item", location: nextFocus });
        return;
      }
      const id = sel.head.item;
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
      return;
    }

    switch (intent.type) {
      case "TAB": {
        if (sel.type !== "item") return;
        const nextFocus = intent.shift
          ? outlineCmd.outdentInPlace(core, location)
          : outlineCmd.indentInPlace(core, location);
        if (!nextFocus) return;
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "NAV": {
        if (sel.type !== "item") return;
        const dir = intent.dir === "out" ? "left" : intent.dir;
        const fromId = sel.head.item;
        let nextId: ItemId | null = null;
        if (dir === "left") nextId = parentOf(core, viewRootId, fromId);
        else if (dir === "right")
          nextId = firstChild(core, fromId) ?? nextSibling(core, fromId);
        else if (dir === "up") nextId = prevSibling(core, fromId);
        else if (dir === "down") nextId = nextSibling(core, fromId);
        if (!nextId) return;
        const nextFocus = { item: nextId, portals };
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "TYPE": {
        if (sel.type !== "item") return;
        const id = sel.head.item;
        const item = core.item(id);
        if (item.mode.type === "readonly") return;
        if (createFirstChildAndFocus(core, location, intent.char)) {
          return;
        }
        return;
      }
      case "CONFIRM": {
        if (sel.type !== "item") return;
        if (createFirstChildAndFocus(core, location, "")) {
          return;
        }
        if (focusFirstChildIfAny(core, location)) {
          return;
        }
        return;
      }
      case "EDIT_LABEL": {
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
