import type { Intent, ItemId, Location, Selection } from "../../core";
import { applyTypeToPrimaryTarget, VALUE_TARGET } from "../../core";
import type { UiCore } from "../../dom";
import { handleItemIntent } from "../../dom";

import {
  computePruneAncestorsForRemoval,
  deleteBlockSelection,
  outlineCmd,
  planBlockRemoval,
  resolveFocusAfterOutlineRemove,
} from "./commands";
import {
  blockSelectionItems,
  firstChild,
  nextSibling,
  parentOf,
  prevSibling,
} from "./navigation";

function handleOutlineItemTypeIntent(args: {
  core: UiCore;
  portals: readonly ItemId[];
  sel: Extract<Selection, { type: "item" }>;
  intent: Extract<Intent, { type: "TYPE" }>;
}): boolean {
  const { core, portals, sel, intent } = args;

  const id = sel.head.item;
  if (core.view(id) !== "outline") return false;

  const item = core.item(id);
  if (item.mode.type !== "plain") return false;
  if (item.content.type !== "value") return false;

  const applied = applyTypeToPrimaryTarget(core, id, intent.char);
  if (!applied || applied.target !== VALUE_TARGET) return false;
  core.focus(
    {
      type: "editing",
      location: { item: id, portals },
      target: applied.target,
    },
    { caret: applied.caret },
  );
  return true;
}

function convertEmptyGroupToValueAndFocus(args: {
  core: UiCore;
  location: Location;
  initialText: string;
}): boolean {
  const { core, location, initialText } = args;
  const item = core.item(location.item);
  if (item.mode.type === "readonly") return false;
  if (item.content.type !== "group") return false;
  if (item.content.children.length !== 0) return false;

  core.commit((t) => t.setValue(location.item, initialText));
  core.focus(
    { type: "editing", location, target: VALUE_TARGET },
    { caret: initialText.length },
  );
  return true;
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
      { type: "editing", location: nextFocus, target: VALUE_TARGET },
      { caret },
    );
  };
}

export function createOutlineIntentHandler(args: {
  core: UiCore;
  rootId: ItemId;
  rootPortals: readonly ItemId[];
}): (intent: Intent) => void {
  const { core, rootId, rootPortals } = args;

  return (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type !== "item") return;
    const sel = selection;

    const location: Location = sel.head;
    const selectedItems = blockSelectionItems(core, rootId, sel, rootPortals);

    if (intent.type === "DELETE") {
      if (selectedItems.length > 1) {
        const lastId = selectedItems[selectedItems.length - 1]!;
        const blockPlan = planBlockRemoval(core, rootId, selectedItems);
        const nextFocus = resolveFocusAfterOutlineRemove(
          core,
          rootId,
          lastId,
          "next",
          rootPortals,
          blockPlan.removedIds,
        );
        deleteBlockSelection(core, rootId, sel, rootPortals, blockPlan);
        if (nextFocus) core.focus({ type: "item", location: nextFocus });
        return;
      }
      const id = sel.head.item;
      if (core.item(id).mode.type === "readonly") return;
      const removedIds = new Set<ItemId>([
        id,
        ...computePruneAncestorsForRemoval(core, rootId, id),
      ]);
      const nextFocus = resolveFocusAfterOutlineRemove(
        core,
        rootId,
        id,
        "next",
        rootPortals,
        removedIds,
      );
      outlineCmd.removeAndPruneAncestors(core, rootId, id);
      if (nextFocus) core.focus({ type: "item", location: nextFocus });
      return;
    }

    switch (intent.type) {
      case "TAB": {
        const nextFocus = intent.shift
          ? outlineCmd.outdentInPlace(core, location)
          : outlineCmd.indentInPlace(core, location);
        if (!nextFocus) return;
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "NAV": {
        const dir = intent.dir === "out" ? "left" : intent.dir;
        const fromId = sel.head.item;
        let nextId: ItemId | null = null;
        if (dir === "left") nextId = parentOf(core, rootId, fromId);
        else if (dir === "right")
          nextId = firstChild(core, fromId) ?? nextSibling(core, fromId);
        else if (dir === "up") nextId = prevSibling(core, fromId);
        else if (dir === "down") nextId = nextSibling(core, fromId);
        if (!nextId) return;
        const nextFocus = { item: nextId, portals: rootPortals };
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "TYPE": {
        const id = sel.head.item;
        const item = core.item(id);
        if (item.mode.type === "readonly") return;
        if (intent.char === "=" && handleItemIntent({ core, sel, intent })) {
          return;
        }
        if (
          convertEmptyGroupToValueAndFocus({
            core,
            location,
            initialText: intent.char,
          })
        ) {
          return;
        }
        if (
          handleOutlineItemTypeIntent({
            core,
            portals: rootPortals,
            sel,
            intent,
          })
        ) {
          return;
        }
        handleItemIntent({ core, sel, intent });
        return;
      }
      case "CONFIRM": {
        if (
          convertEmptyGroupToValueAndFocus({ core, location, initialText: "" })
        ) {
          return;
        }
        if (handleItemIntent({ core, sel, intent })) return;
        const nextId = outlineCmd.insertSibling(core, location, "after");
        if (!nextId) return;
        core.focus(
          {
            type: "editing",
            location: { item: nextId, portals: rootPortals },
            target: VALUE_TARGET,
          },
          { caret: 0 },
        );
      }
    }
  };
}
