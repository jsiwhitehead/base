import {
  indentItemInPlace,
  CONTENT_TEXT_TARGET,
  type Core,
  type ItemId,
  type Location,
  type Selection,
} from "../../core";

import {
  blockSelectionItems,
  childrenOf,
  isPlainValueItem,
  parentOf,
  valueToText,
  type ModelPosition,
} from "./navigation";

export type BlockRemovalPlan = {
  removeRoots: ItemId[];
  pruneIds: ItemId[];
  removedIds: Set<ItemId>;
  shouldClearRoot: boolean;
};

export function resolveFocusAfterOutlineRemove(
  core: Core,
  rootId: ItemId,
  id: ItemId,
  prefer: "next" | "previous",
  portals: readonly ItemId[],
  removedIds: ReadonlySet<ItemId>,
): Location | null {
  const loc = core.locate(id);
  const findSibling = (dir: "next" | "previous"): ItemId | null => {
    if (!loc) return null;
    if (dir === "next") {
      for (let i = loc.index + 1; i < loc.siblings.length; i += 1) {
        const siblingId = loc.siblings[i]!;
        if (!removedIds.has(siblingId)) return siblingId;
      }
      return null;
    }
    for (let i = loc.index - 1; i >= 0; i -= 1) {
      const siblingId = loc.siblings[i]!;
      if (!removedIds.has(siblingId)) return siblingId;
    }
    return null;
  };

  const primary = findSibling(prefer === "next" ? "next" : "previous");
  if (primary) return { item: primary, portals };

  const fallback = findSibling(prefer === "next" ? "previous" : "next");
  if (fallback) return { item: fallback, portals };

  const parentId = parentOf(core, rootId, id);
  if (!parentId || removedIds.has(parentId)) return null;
  return { item: parentId, portals };
}

export function computePruneAncestorsForRemoval(
  core: Core,
  rootId: ItemId,
  removedId: ItemId,
): ItemId[] {
  const out: ItemId[] = [];
  let cur: ItemId = removedId;

  while (true) {
    const parentId = parentOf(core, rootId, cur);
    if (!parentId) break;
    if (parentId === rootId) break;

    const parent = core.item(parentId);
    if (parent.mode.type === "readonly") break;
    if (parent.content.type !== "group") break;

    const kids = parent.content.children;
    if (kids.length !== 1 || kids[0] !== cur) break;

    out.push(parentId);
    cur = parentId;
  }

  return out;
}

function itemDepth(core: Core, id: ItemId): number {
  let depth = 0;
  let cur: ItemId | null = id;
  while (cur) {
    const loc = core.locate(cur);
    if (!loc) break;
    depth += 1;
    cur = loc.parentId;
  }
  return depth;
}

function shouldClearRootAfterRemovals(
  core: Core,
  rootId: ItemId,
  removedIds: ReadonlySet<ItemId>,
): boolean {
  if (removedIds.size === 0) return false;
  const rootSnap = core.item(rootId);
  return (
    rootSnap.content.type === "group" &&
    rootSnap.content.children.every((cid) => removedIds.has(cid))
  );
}

function normalizeRemovalRoots(
  core: Core,
  itemIds: readonly ItemId[],
): ItemId[] {
  const candidate = new Set<ItemId>(itemIds);
  const out: ItemId[] = [];
  const seen = new Set<ItemId>();
  for (const id of itemIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    let curLoc = core.locate(id);
    let hasSelectedAncestor = false;
    while (curLoc) {
      const parentId = curLoc.parentId;
      if (candidate.has(parentId)) {
        hasSelectedAncestor = true;
        break;
      }
      curLoc = core.locate(parentId);
    }
    if (!hasSelectedAncestor) out.push(id);
  }
  return out;
}

function computePruneAncestorsForRemovals(
  core: Core,
  rootId: ItemId,
  removedIds: readonly ItemId[],
): ItemId[] {
  const removed = new Set<ItemId>(removedIds);
  const pruneIds: ItemId[] = [];
  while (true) {
    const candidates = new Set<ItemId>();
    for (const removedId of removed) {
      let cur = removedId;
      while (true) {
        const parentId = parentOf(core, rootId, cur);
        if (!parentId || parentId === rootId) break;
        candidates.add(parentId);
        cur = parentId;
      }
    }

    let changed = false;
    for (const parentId of candidates) {
      if (removed.has(parentId)) continue;
      const parent = core.item(parentId);
      if (parent.mode.type === "readonly") continue;
      if (parent.content.type !== "group") continue;
      if (!parent.content.children.every((childId) => removed.has(childId))) {
        continue;
      }
      removed.add(parentId);
      pruneIds.push(parentId);
      changed = true;
    }
    if (!changed) break;
  }

  return pruneIds.sort((a, b) => itemDepth(core, b) - itemDepth(core, a));
}

export function planBlockRemoval(
  core: Core,
  rootId: ItemId,
  itemIds: readonly ItemId[],
): BlockRemovalPlan {
  const removeRoots = normalizeRemovalRoots(core, itemIds);
  const pruneIds = computePruneAncestorsForRemovals(core, rootId, removeRoots);
  const removedIds = new Set<ItemId>([...removeRoots, ...pruneIds]);
  const shouldClearRoot = shouldClearRootAfterRemovals(
    core,
    rootId,
    removedIds,
  );
  return { removeRoots, pruneIds, removedIds, shouldClearRoot };
}

export function removeBlockSelection(
  core: Core,
  rootId: ItemId,
  sel: Extract<Selection, { type: "item" }>,
  portals: readonly ItemId[],
  plan?: BlockRemovalPlan,
): void {
  const nextPlan =
    plan ??
    planBlockRemoval(
      core,
      rootId,
      blockSelectionItems(core, rootId, sel, portals),
    );
  if (nextPlan.removeRoots.length === 0) return;
  core.commit((t) => {
    for (const id of nextPlan.removeRoots) t.remove(id);
    for (const pruneId of nextPlan.pruneIds) t.remove(pruneId);
    if (nextPlan.shouldClearRoot) t.setValue(rootId, null);
  });
}

function insertSibling(
  core: Core,
  location: Location,
  side: "before" | "after",
): ItemId | null {
  const loc = core.locate(location.item);
  if (!loc) return null;

  const { parentId, index: idx } = loc;
  const at = side === "before" ? idx : idx + 1;

  let id!: ItemId;
  core.commit((t) => {
    id = t.insertChild(parentId, { at });
  });

  return id;
}

function insertAfterParentIfEdge(
  core: Core,
  rootId: ItemId,
  location: Location,
): ItemId | null {
  const childLoc = core.locate(location.item);
  if (!childLoc) return null;
  if (childLoc.index !== childLoc.siblings.length - 1) return null;

  const parentLoc = core.locate(childLoc.parentId);
  if (!parentLoc) return null;
  if (childLoc.parentId === rootId) return null;

  const parentSnap = core.item(childLoc.parentId);
  if (
    parentSnap.mode.type === "readonly" ||
    parentSnap.mode.type === "connected"
  ) {
    return null;
  }

  let nextId!: ItemId;
  core.commit((t) => {
    nextId = t.insertChild(parentLoc.parentId, { at: parentLoc.index + 1 });
  });

  return nextId;
}

export const outlineCmd = {
  removeAndPruneAncestors(core: Core, rootId: ItemId, id: ItemId): void {
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, id);
    const removedIds = new Set<ItemId>([id, ...pruneIds]);
    const shouldClearRoot = shouldClearRootAfterRemovals(
      core,
      rootId,
      removedIds,
    );

    core.commit((t) => {
      t.remove(id);
      for (const pruneId of pruneIds) t.remove(pruneId);
      if (shouldClearRoot) t.setValue(rootId, null);
    });
  },

  createFirstChild(
    core: Core,
    location: Location,
    initialText = "",
  ): ItemId | null {
    const item = core.item(location.item);
    if (item.mode.type === "readonly") return null;
    if (item.content.type !== "group") return null;

    let id!: ItemId;
    core.commit((t) => {
      id = t.insertChild(location.item, { at: 0 });
      if (initialText) t.setValue(id, initialText);
    });

    return id;
  },

  insertForScope(
    core: Core,
    rootId: ItemId,
    location: Location,
    scope: "sibling" | "after-parent",
  ): ItemId | null {
    return scope === "after-parent"
      ? insertAfterParentIfEdge(core, rootId, location)
      : insertSibling(core, location, "after");
  },

  splitAt(
    core: Core,
    location: Location,
    caretStart: number,
    caretEnd = caretStart,
  ): ItemId | null {
    const id = location.item;
    const snap = core.item(id);

    const loc = core.locate(id);
    if (!loc) return null;

    const { parentId, index: idx } = loc;

    if (!(snap.mode.type === "plain" && snap.content.type === "value")) {
      return insertSibling(core, location, "after");
    }

    const curText = valueToText(snap.content.value);
    const len = curText.length;

    const start = Math.max(0, Math.min(caretStart, len));
    const end = Math.max(0, Math.min(caretEnd, len));

    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let rightId!: ItemId;

    core.commit((t) => {
      t.setValue(id, left);
      rightId = t.insertChild(parentId, { at: idx + 1 });
      t.setValue(rightId, right);
    });

    return rightId;
  },

  splitAfterParent(
    core: Core,
    rootId: ItemId,
    location: Location,
    caretStart: number,
    caretEnd = caretStart,
  ): ItemId | null {
    const childLoc = core.locate(location.item);
    if (!childLoc) return null;
    if (childLoc.index !== childLoc.siblings.length - 1) return null;

    const parentLoc = core.locate(childLoc.parentId);
    if (!parentLoc) return null;
    if (childLoc.parentId === rootId) return null;

    const parentSnap = core.item(childLoc.parentId);
    if (
      parentSnap.mode.type === "readonly" ||
      parentSnap.mode.type === "connected"
    ) {
      return null;
    }

    const childSnap = core.item(location.item);
    if (
      !(childSnap.mode.type === "plain" && childSnap.content.type === "value")
    ) {
      return null;
    }
    const curText = valueToText(childSnap.content.value);
    const len = curText.length;
    const start = Math.max(0, Math.min(caretStart, len));
    const end = Math.max(0, Math.min(caretEnd, len));
    const left = curText.slice(0, start);
    const right = curText.slice(end);

    let nextId!: ItemId;

    core.commit((t) => {
      t.setValue(location.item, left);
      nextId = t.insertChild(parentLoc.parentId, { at: parentLoc.index + 1 });
      t.setValue(nextId, right);
    });

    return nextId;
  },

  joinValues(
    core: Core,
    rootId: ItemId,
    leftId: ItemId,
    rightId: ItemId,
  ): { id: ItemId; caret: number } | null {
    const leftItem = core.item(leftId);
    const rightItem = core.item(rightId);

    if (
      !(leftItem.mode.type === "plain" && leftItem.content.type === "value")
    ) {
      return null;
    }
    if (
      !(rightItem.mode.type === "plain" && rightItem.content.type === "value")
    ) {
      return null;
    }

    const leftText = valueToText(leftItem.content.value);
    const rightText = valueToText(rightItem.content.value);
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, rightId);

    core.commit((t) => {
      t.setValue(leftId, leftText + rightText);
      t.remove(rightId);
      for (const pruneId of pruneIds) t.remove(pruneId);
    });

    return { id: leftId, caret: leftText.length };
  },

  indentInPlace(core: Core, location: Location): Location | null {
    const id = location.item;
    const childId = indentItemInPlace(core, id);
    if (!childId) return null;
    return { item: childId, portals: location.portals };
  },

  outdentInPlace(core: Core, location: Location): Location | null {
    const childId = location.item;
    const loc = core.locate(childId);
    if (!loc) return null;
    const parentId = loc.parentId;
    const parentSnap = core.item(parentId);
    const childSnap = core.item(childId);
    if (
      parentSnap.mode.type === "readonly" ||
      parentSnap.mode.type === "connected"
    ) {
      return null;
    }
    if (
      childSnap.mode.type === "readonly" ||
      childSnap.mode.type === "connected"
    ) {
      return null;
    }
    if (
      childSnap.content.type !== "value" &&
      childSnap.content.type !== "group"
    ) {
      return null;
    }

    const bodyType = childSnap.content.type;
    const bodyValue = bodyType === "value" ? childSnap.content.value : null;
    const bodyKids =
      bodyType === "group" ? [...childSnap.content.children] : [];
    const siblings = [...childrenOf(core, parentId)];

    core.commit((t) => {
      if (bodyType === "value") {
        for (const sid of siblings) t.remove(sid);
        t.setValue(parentId, bodyValue);
      } else {
        t.setGroup(parentId);
        for (let i = 0; i < bodyKids.length; i += 1) {
          t.move(bodyKids[i]!, parentId, { at: i });
        }
        for (const sid of siblings) t.remove(sid);
      }
    });

    return { item: parentId, portals: location.portals };
  },
};

export function readSelectionText(
  core: Core,
  rangeSel: { range: Range; start: ModelPosition; end: ModelPosition },
): string | null {
  const { range, start, end } = rangeSel;
  if (range.collapsed) return "";

  if (start.itemId === end.itemId) {
    const snap = core.item(start.itemId);
    if (!isPlainValueItem(snap)) return null;
    const text = valueToText(snap.content.value);
    return text.slice(start.offset, end.offset);
  }

  const startLoc = core.locate(start.itemId);
  const endLoc = core.locate(end.itemId);
  if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId) {
    return null;
  }

  const startSnap = core.item(start.itemId);
  const endSnap = core.item(end.itemId);
  if (!isPlainValueItem(startSnap)) return null;
  if (!isPlainValueItem(endSnap)) return null;

  const parts: string[] = [];
  const startText = valueToText(startSnap.content.value);
  parts.push(startText.slice(start.offset));

  for (let i = startLoc.index + 1; i < endLoc.index; i += 1) {
    const id = startLoc.siblings[i];
    if (!id) return null;
    const snap = core.item(id);
    if (!isPlainValueItem(snap)) return null;
    parts.push(valueToText(snap.content.value));
  }

  const endText = valueToText(endSnap.content.value);
  parts.push(endText.slice(0, end.offset));
  return parts.join("\n");
}

export function deleteSingleItemRange(
  core: Core,
  portals: readonly ItemId[],
  start: ModelPosition,
  end: ModelPosition,
  placeCursor: (itemId: ItemId, offset: number) => void,
): boolean {
  if (start.itemId !== end.itemId) return false;
  if (start.offset === end.offset) return false;

  const snap = core.item(start.itemId);
  if (!isPlainValueItem(snap)) return false;

  const text = valueToText(snap.content.value);
  const nextText = text.slice(0, start.offset) + text.slice(end.offset);
  core.commit((t) => t.setValue(start.itemId, nextText));
  core.focus({
    type: "editing",
    location: { item: start.itemId, portals },
    target: CONTENT_TEXT_TARGET,
  });
  placeCursor(start.itemId, start.offset);
  return true;
}

export function deleteMultiItemRange(
  core: Core,
  portals: readonly ItemId[],
  start: ModelPosition,
  end: ModelPosition,
  placeCursor: (itemId: ItemId, offset: number) => void,
): boolean {
  if (start.itemId === end.itemId) return false;

  const startLoc = core.locate(start.itemId);
  const endLoc = core.locate(end.itemId);
  if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId) {
    return false;
  }

  const startSnap = core.item(start.itemId);
  const endSnap = core.item(end.itemId);
  if (!isPlainValueItem(startSnap)) return false;
  if (!isPlainValueItem(endSnap)) return false;

  const startText = valueToText(startSnap.content.value).slice(0, start.offset);
  const endText = valueToText(endSnap.content.value).slice(end.offset);
  const toRemove = [
    ...startLoc.siblings.slice(startLoc.index + 1, endLoc.index + 1),
  ];

  core.commit((t) => {
    t.setValue(start.itemId, startText + endText);
    for (const id of toRemove) t.remove(id);
  });
  core.focus({
    type: "editing",
    location: { item: start.itemId, portals },
    target: CONTENT_TEXT_TARGET,
  });
  placeCursor(start.itemId, start.offset);
  return true;
}
