import type { Intent, ItemId, Location, Selection } from "../../core";
import {
  applyTypeToPrimaryTarget,
  handleItemIntent,
  VALUE_TARGET,
} from "../../core";
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

function convertEmptyGroupToValueAndFocus(
  core: UiCore,
  location: Location,
  initialText: string,
): boolean {
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
  viewRootId: ItemId;
  portals: readonly ItemId[];
}): (intent: Intent) => void {
  const { core, viewRootId, portals } = args;

  return (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type !== "item") return;
    const sel = selection;

    const location: Location = sel.head;
    const selectedItems = blockSelectionItems(core, viewRootId, sel, portals);

    if (intent.type === "DELETE") {
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
        const id = sel.head.item;
        const item = core.item(id);
        if (item.mode.type === "readonly") return;
        if (intent.char === "=" && handleItemIntent({ core, sel, intent })) {
          return;
        }
        if (convertEmptyGroupToValueAndFocus(core, location, intent.char)) {
          return;
        }
        if (
          handleOutlineItemTypeIntent({
            core,
            portals,
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
        if (convertEmptyGroupToValueAndFocus(core, location, "")) {
          return;
        }
        if (handleItemIntent({ core, sel, intent })) return;
        if (
          location.item === viewRootId &&
          focusFirstChildIfAny(core, location)
        ) {
          return;
        }
        const nextId = outlineCmd.insertSibling(core, location, "after");
        if (!nextId) return;
        core.focus(
          {
            type: "editing",
            location: { item: nextId, portals },
            target: VALUE_TARGET,
          },
          { caret: 0 },
        );
      }
    }
  };
}
