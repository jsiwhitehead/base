import {
  indentNodeInPlace,
  CONTENT_TEXT_TARGET,
  type Core,
  type NodeId,
  type Location,
  type Selection,
} from "../../core";

import {
  blockSelectionNodes,
  childrenOf,
  isPlainValueNode,
  parentOf,
  valueToText,
  type ModelPosition,
} from "./navigation";

export type BlockRemovalPlan = {
  removeRoots: NodeId[];
  pruneIds: NodeId[];
  removedIds: Set<NodeId>;
  shouldClearRoot: boolean;
};

export function resolveFocusAfterOutlineRemove(
  core: Core,
  rootId: NodeId,
  id: NodeId,
  prefer: "next" | "previous",
  portals: readonly NodeId[],
  removedIds: ReadonlySet<NodeId>,
): Location | null {
  const loc = core.locate(id);
  const findSibling = (dir: "next" | "previous"): NodeId | null => {
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
  if (primary) return { node: primary, portals };

  const fallback = findSibling(prefer === "next" ? "previous" : "next");
  if (fallback) return { node: fallback, portals };

  const parentId = parentOf(core, rootId, id);
  if (!parentId || removedIds.has(parentId)) return null;
  return { node: parentId, portals };
}

export function computePruneAncestorsForRemoval(
  core: Core,
  rootId: NodeId,
  removedId: NodeId,
): NodeId[] {
  const out: NodeId[] = [];
  let cur: NodeId = removedId;

  while (true) {
    const parentId = parentOf(core, rootId, cur);
    if (!parentId) break;
    if (parentId === rootId) break;

    const parent = core.node(parentId);
    if (parent.mode.type === "readonly") break;
    if (parent.content.type !== "item") break;

    const kids = parent.content.children;
    if (kids.length !== 1 || kids[0] !== cur) break;

    out.push(parentId);
    cur = parentId;
  }

  return out;
}

function nodeDepth(core: Core, id: NodeId): number {
  let depth = 0;
  let cur: NodeId | null = id;
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
  rootId: NodeId,
  removedIds: ReadonlySet<NodeId>,
): boolean {
  if (removedIds.size === 0) return false;
  const rootSnap = core.node(rootId);
  return (
    rootSnap.content.type === "item" &&
    rootSnap.content.children.every((cid) => removedIds.has(cid))
  );
}

function normalizeRemovalRoots(
  core: Core,
  nodeIds: readonly NodeId[],
): NodeId[] {
  const candidate = new Set<NodeId>(nodeIds);
  const out: NodeId[] = [];
  const seen = new Set<NodeId>();
  for (const id of nodeIds) {
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
  rootId: NodeId,
  removedIds: readonly NodeId[],
): NodeId[] {
  const removed = new Set<NodeId>(removedIds);
  const pruneIds: NodeId[] = [];
  while (true) {
    const candidates = new Set<NodeId>();
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
      const parent = core.node(parentId);
      if (parent.mode.type === "readonly") continue;
      if (parent.content.type !== "item") continue;
      if (!parent.content.children.every((childId) => removed.has(childId))) {
        continue;
      }
      removed.add(parentId);
      pruneIds.push(parentId);
      changed = true;
    }
    if (!changed) break;
  }

  return pruneIds.sort((a, b) => nodeDepth(core, b) - nodeDepth(core, a));
}

export function planBlockRemoval(
  core: Core,
  rootId: NodeId,
  nodeIds: readonly NodeId[],
): BlockRemovalPlan {
  const removeRoots = normalizeRemovalRoots(core, nodeIds);
  const pruneIds = computePruneAncestorsForRemovals(core, rootId, removeRoots);
  const removedIds = new Set<NodeId>([...removeRoots, ...pruneIds]);
  const shouldClearRoot = shouldClearRootAfterRemovals(
    core,
    rootId,
    removedIds,
  );
  return { removeRoots, pruneIds, removedIds, shouldClearRoot };
}

export function removeBlockSelection(
  core: Core,
  rootId: NodeId,
  sel: Extract<Selection, { type: "node" }>,
  portals: readonly NodeId[],
  plan?: BlockRemovalPlan,
): void {
  const nextPlan =
    plan ??
    planBlockRemoval(
      core,
      rootId,
      blockSelectionNodes(core, rootId, sel, portals),
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
): NodeId | null {
  const loc = core.locate(location.node);
  if (!loc) return null;

  const { parentId, index: idx } = loc;
  const at = side === "before" ? idx : idx + 1;

  let id!: NodeId;
  core.commit((t) => {
    id = t.insertChild(parentId, { at });
  });

  return id;
}

function insertAfterParentIfEdge(
  core: Core,
  rootId: NodeId,
  location: Location,
): NodeId | null {
  const childLoc = core.locate(location.node);
  if (!childLoc) return null;
  if (childLoc.index !== childLoc.siblings.length - 1) return null;

  const parentLoc = core.locate(childLoc.parentId);
  if (!parentLoc) return null;
  if (childLoc.parentId === rootId) return null;

  const parentSnap = core.node(childLoc.parentId);
  if (
    parentSnap.mode.type === "readonly" ||
    parentSnap.mode.type === "connected"
  ) {
    return null;
  }

  let nextId!: NodeId;
  core.commit((t) => {
    nextId = t.insertChild(parentLoc.parentId, { at: parentLoc.index + 1 });
  });

  return nextId;
}

export const outlineCmd = {
  removeAndPruneAncestors(core: Core, rootId: NodeId, id: NodeId): void {
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, id);
    const removedIds = new Set<NodeId>([id, ...pruneIds]);
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
  ): NodeId | null {
    const node = core.node(location.node);
    if (node.mode.type === "readonly") return null;
    if (node.content.type !== "item") return null;

    let id!: NodeId;
    core.commit((t) => {
      id = t.insertChild(location.node, { at: 0 });
      if (initialText) t.setValue(id, initialText);
    });

    return id;
  },

  insertForScope(
    core: Core,
    rootId: NodeId,
    location: Location,
    scope: "sibling" | "after-parent",
  ): NodeId | null {
    return scope === "after-parent"
      ? insertAfterParentIfEdge(core, rootId, location)
      : insertSibling(core, location, "after");
  },

  splitAt(
    core: Core,
    location: Location,
    caretStart: number,
    caretEnd = caretStart,
  ): NodeId | null {
    const id = location.node;
    const snap = core.node(id);

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

    let rightId!: NodeId;

    core.commit((t) => {
      t.setValue(id, left);
      rightId = t.insertChild(parentId, { at: idx + 1 });
      t.setValue(rightId, right);
    });

    return rightId;
  },

  splitAfterParent(
    core: Core,
    rootId: NodeId,
    location: Location,
    caretStart: number,
    caretEnd = caretStart,
  ): NodeId | null {
    const childLoc = core.locate(location.node);
    if (!childLoc) return null;
    if (childLoc.index !== childLoc.siblings.length - 1) return null;

    const parentLoc = core.locate(childLoc.parentId);
    if (!parentLoc) return null;
    if (childLoc.parentId === rootId) return null;

    const parentSnap = core.node(childLoc.parentId);
    if (
      parentSnap.mode.type === "readonly" ||
      parentSnap.mode.type === "connected"
    ) {
      return null;
    }

    const childSnap = core.node(location.node);
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

    let nextId!: NodeId;

    core.commit((t) => {
      t.setValue(location.node, left);
      nextId = t.insertChild(parentLoc.parentId, { at: parentLoc.index + 1 });
      t.setValue(nextId, right);
    });

    return nextId;
  },

  joinValues(
    core: Core,
    rootId: NodeId,
    leftId: NodeId,
    rightId: NodeId,
  ): { id: NodeId; caret: number } | null {
    const leftNode = core.node(leftId);
    const rightNode = core.node(rightId);

    if (
      !(leftNode.mode.type === "plain" && leftNode.content.type === "value")
    ) {
      return null;
    }
    if (
      !(rightNode.mode.type === "plain" && rightNode.content.type === "value")
    ) {
      return null;
    }

    const leftText = valueToText(leftNode.content.value);
    const rightText = valueToText(rightNode.content.value);
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, rightId);

    core.commit((t) => {
      t.setValue(leftId, leftText + rightText);
      t.remove(rightId);
      for (const pruneId of pruneIds) t.remove(pruneId);
    });

    return { id: leftId, caret: leftText.length };
  },

  indentInPlace(core: Core, location: Location): Location | null {
    const id = location.node;
    const childId = indentNodeInPlace(core, id);
    if (!childId) return null;
    return { node: childId, portals: location.portals };
  },

  outdentInPlace(core: Core, location: Location): Location | null {
    const childId = location.node;
    const loc = core.locate(childId);
    if (!loc) return null;
    const parentId = loc.parentId;
    const parentSnap = core.node(parentId);
    const childSnap = core.node(childId);
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
      childSnap.content.type !== "item"
    ) {
      return null;
    }

    const bodyType = childSnap.content.type;
    const bodyValue = bodyType === "value" ? childSnap.content.value : null;
    const bodyKids = bodyType === "item" ? [...childSnap.content.children] : [];
    const siblings = [...childrenOf(core, parentId)];

    core.commit((t) => {
      if (bodyType === "value") {
        for (const sid of siblings) t.remove(sid);
        t.setValue(parentId, bodyValue);
      } else {
        t.setItem(parentId);
        for (let i = 0; i < bodyKids.length; i += 1) {
          t.move(bodyKids[i]!, parentId, { at: i });
        }
        for (const sid of siblings) t.remove(sid);
      }
    });

    return { node: parentId, portals: location.portals };
  },
};

export function readSelectionText(
  core: Core,
  rangeSel: { range: Range; start: ModelPosition; end: ModelPosition },
): string | null {
  const { range, start, end } = rangeSel;
  if (range.collapsed) return "";

  if (start.nodeId === end.nodeId) {
    const snap = core.node(start.nodeId);
    if (!isPlainValueNode(snap)) return null;
    const text = valueToText(snap.content.value);
    return text.slice(start.offset, end.offset);
  }

  const startLoc = core.locate(start.nodeId);
  const endLoc = core.locate(end.nodeId);
  if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId) {
    return null;
  }

  const startSnap = core.node(start.nodeId);
  const endSnap = core.node(end.nodeId);
  if (!isPlainValueNode(startSnap)) return null;
  if (!isPlainValueNode(endSnap)) return null;

  const parts: string[] = [];
  const startText = valueToText(startSnap.content.value);
  parts.push(startText.slice(start.offset));

  for (let i = startLoc.index + 1; i < endLoc.index; i += 1) {
    const id = startLoc.siblings[i];
    if (!id) return null;
    const snap = core.node(id);
    if (!isPlainValueNode(snap)) return null;
    parts.push(valueToText(snap.content.value));
  }

  const endText = valueToText(endSnap.content.value);
  parts.push(endText.slice(0, end.offset));
  return parts.join("\n");
}

export function deleteSingleNodeRange(
  core: Core,
  portals: readonly NodeId[],
  start: ModelPosition,
  end: ModelPosition,
  placeCursor: (nodeId: NodeId, offset: number) => void,
): boolean {
  if (start.nodeId !== end.nodeId) return false;
  if (start.offset === end.offset) return false;

  const snap = core.node(start.nodeId);
  if (!isPlainValueNode(snap)) return false;

  const text = valueToText(snap.content.value);
  const nextText = text.slice(0, start.offset) + text.slice(end.offset);
  core.commit((t) => t.setValue(start.nodeId, nextText));
  core.focus({
    type: "editing",
    location: { node: start.nodeId, portals },
    target: CONTENT_TEXT_TARGET,
  });
  placeCursor(start.nodeId, start.offset);
  return true;
}

export function deleteMultiNodeRange(
  core: Core,
  portals: readonly NodeId[],
  start: ModelPosition,
  end: ModelPosition,
  placeCursor: (nodeId: NodeId, offset: number) => void,
): boolean {
  if (start.nodeId === end.nodeId) return false;

  const startLoc = core.locate(start.nodeId);
  const endLoc = core.locate(end.nodeId);
  if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId) {
    return false;
  }

  const startSnap = core.node(start.nodeId);
  const endSnap = core.node(end.nodeId);
  if (!isPlainValueNode(startSnap)) return false;
  if (!isPlainValueNode(endSnap)) return false;

  const startText = valueToText(startSnap.content.value).slice(0, start.offset);
  const endText = valueToText(endSnap.content.value).slice(end.offset);
  const toRemove = [
    ...startLoc.siblings.slice(startLoc.index + 1, endLoc.index + 1),
  ];

  core.commit((t) => {
    t.setValue(start.nodeId, startText + endText);
    for (const id of toRemove) t.remove(id);
  });
  core.focus({
    type: "editing",
    location: { node: start.nodeId, portals },
    target: CONTENT_TEXT_TARGET,
  });
  placeCursor(start.nodeId, start.offset);
  return true;
}
