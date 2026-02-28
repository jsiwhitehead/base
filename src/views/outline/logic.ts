import {
  indentItemInPlace,
  VALUE_TARGET,
  type Core,
  type Item,
  type ItemId,
  type Location,
  type Selection,
  type ValueOrBlank,
} from "../../core";

export type ModelPosition = { itemId: ItemId; charOffset: number };
export type EditStop = { focus: Location; target: string };
type EditStopMove = { stop: EditStop; edge: "start" | "end" | null };
export type OutlineValueSelectionRange = {
  range: Range;
  start: ModelPosition;
  end: ModelPosition;
};

const DEFAULT_STOP = "default" as const;

export function valueToText(v: ValueOrBlank): string {
  return v == null ? "" : String(v);
}

export function isPlainValueItem(
  item: Item,
): item is Item & { mode: { type: "plain" }; content: { type: "value" } } {
  return item.mode.type === "plain" && item.content.type === "value";
}

export function childrenOf(core: Core, id: ItemId): readonly ItemId[] {
  const content = core.item(id).content;
  return content.type === "group" ? content.children : [];
}

export function parentOf(
  core: Core,
  rootId: ItemId,
  id: ItemId,
): ItemId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  return loc ? loc.parentId : null;
}

export function focusFor(core: Core, rootId: ItemId, id: ItemId): Location {
  const parentId = parentOf(core, rootId, id);
  return { container: parentId ?? rootId, item: id };
}

function computePruneAncestorsForRemoval(
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

export function firstChild(core: Core, id: ItemId): ItemId | null {
  const kids = childrenOf(core, id);
  return kids[0] ?? null;
}

export function prevSibling(core: Core, id: ItemId): ItemId | null {
  const loc = core.locate(id);
  return loc ? (loc.siblings[loc.index - 1] ?? null) : null;
}

export function nextSibling(core: Core, id: ItemId): ItemId | null {
  const loc = core.locate(id);
  return loc ? (loc.siblings[loc.index + 1] ?? null) : null;
}

export const sameFocus = (a: Location, b: Location): boolean =>
  a.container === b.container && a.item === b.item;

export function focusKey(focus: Location): string {
  return `${focus.container}:${focus.item}`;
}

function collectVisibleRowFocuses(core: Core, rootId: ItemId): Location[] {
  const out: Location[] = [];
  const walk = (id: ItemId): void => {
    out.push(focusFor(core, rootId, id));
    const snap = core.item(id);
    if (core.view(id) !== "outline" || snap.content.type !== "group") return;
    for (const childId of snap.content.children) walk(childId);
  };
  const rootSnap = core.item(rootId);
  if (rootSnap.content.type === "group") {
    for (const childId of rootSnap.content.children) walk(childId);
    return out;
  }
  walk(rootId);
  return out;
}

export function blockSelectionFocuses(
  core: Core,
  rootId: ItemId,
  sel: Extract<Selection, { type: "item" }>,
): Location[] {
  const focuses = collectVisibleRowFocuses(core, rootId);
  const anchorIdx = focuses.findIndex((focus) => sameFocus(focus, sel.anchor));
  const headIdx = focuses.findIndex((focus) => sameFocus(focus, sel.head));
  if (anchorIdx < 0 || headIdx < 0) return [];
  const lo = Math.min(anchorIdx, headIdx);
  const hi = Math.max(anchorIdx, headIdx);
  return focuses.slice(lo, hi + 1);
}

export function blockSelectionItems(
  core: Core,
  rootId: ItemId,
  sel: Extract<Selection, { type: "item" }>,
): ItemId[] {
  const out: ItemId[] = [];
  const seen = new Set<ItemId>();
  for (const focus of blockSelectionFocuses(core, rootId, sel)) {
    if (seen.has(focus.item)) continue;
    seen.add(focus.item);
    out.push(focus.item);
  }
  return out;
}

export function extendBlockSelectionByArrow(
  core: Core,
  rootId: ItemId,
  sel: Extract<Selection, { type: "item" }>,
  dir: "up" | "down",
): Location | null {
  const focuses = collectVisibleRowFocuses(core, rootId);
  const headIdx = focuses.findIndex((focus) => sameFocus(focus, sel.head));
  if (headIdx < 0) return null;
  return dir === "up"
    ? (focuses[headIdx - 1] ?? null)
    : (focuses[headIdx + 1] ?? null);
}

export function deleteBlockSelection(
  core: Core,
  rootId: ItemId,
  sel: Extract<Selection, { type: "item" }>,
): void {
  const itemIds = blockSelectionItems(core, rootId, sel);
  if (itemIds.length === 0) return;
  core.commit((t) => {
    for (const id of itemIds) t.remove(id);
  });
}

function isEditLeaf(core: Core, id: ItemId): boolean {
  if (core.view(id) !== "outline") return true;
  return core.item(id).content.type !== "group";
}

function editTargetsForItem(core: Core, id: ItemId): string[] {
  const snap = core.item(id);
  if (snap.mode.type === "readonly") return [];
  if (core.view(id) !== "outline") return [DEFAULT_STOP];
  if (snap.mode.type === "connected") {
    return snap.mode.conn.type === "formula"
      ? ["conn:expr"]
      : ["conn:from", "conn:where", "conn:orderBy"];
  }
  if (snap.mode.type === "plain" && snap.content.type === "value") {
    return [VALUE_TARGET];
  }
  return [];
}

export function collectEditPoints(core: Core, rootId: ItemId): EditStop[] {
  const out: EditStop[] = [];
  const walk = (id: ItemId): void => {
    const snap = core.item(id);
    if (core.view(id) === "outline" && snap.content.type === "group") {
      for (const childId of snap.content.children) walk(childId);
      return;
    }
    if (!isEditLeaf(core, id)) return;
    const focus = focusFor(core, rootId, id);
    for (const target of editTargetsForItem(core, id)) {
      out.push({ focus, target });
    }
  };

  const rootSnap = core.item(rootId);
  if (rootSnap.content.type === "group") {
    for (const childId of rootSnap.content.children) walk(childId);
  } else {
    walk(rootId);
  }
  return out;
}

export function moveEditPoint(
  points: readonly EditStop[],
  current: EditStop,
  dir: "backward" | "forward",
): EditStopMove | null {
  const idx = points.findIndex(
    (p) =>
      p.focus.item === current.focus.item &&
      p.focus.container === current.focus.container &&
      p.target === current.target,
  );
  if (idx < 0) return null;
  const next = points[dir === "backward" ? idx - 1 : idx + 1];
  if (!next) return null;
  if (next.target === DEFAULT_STOP) return { stop: next, edge: null };
  return { stop: next, edge: dir === "backward" ? "end" : "start" };
}

export function textLengthForTarget(
  core: Core,
  id: ItemId,
  target: string,
): number {
  const snap = core.item(id);
  if (target === VALUE_TARGET) {
    return snap.content.type === "value"
      ? valueToText(snap.content.value).length
      : 0;
  }
  if (!target.startsWith("conn:") || snap.mode.type !== "connected") return 0;
  const key = target.slice(5);
  if (snap.mode.conn.type === "formula") {
    return key === "expr" ? snap.mode.conn.expr.length : 0;
  }
  if (key === "from") return snap.mode.conn.from.length;
  if (key === "where") return snap.mode.conn.where.length;
  if (key === "orderBy") return snap.mode.conn.orderBy.length;
  return 0;
}

export const outlineCmd = {
  removeAndPruneAncestors(core: Core, rootId: ItemId, id: ItemId): void {
    const pruneIds = computePruneAncestorsForRemoval(core, rootId, id);
    const rootSnap = core.item(rootId);
    const removedIds = new Set<ItemId>([id, ...pruneIds]);
    const shouldBlankRoot =
      rootSnap.content.type === "group" &&
      rootSnap.content.children.every((cid) => removedIds.has(cid));

    core.commit((t) => {
      t.remove(id);
      for (const pruneId of pruneIds) t.remove(pruneId);
      if (shouldBlankRoot) t.setValue(rootId, null);
    });
  },

  insertSibling(
    core: Core,
    sel: { location: Location },
    side: "before" | "after",
  ): ItemId | null {
    const loc = core.locate(sel.location.item);
    if (!loc) return null;

    const { parentId, index: idx } = loc;
    const at = side === "before" ? idx : idx + 1;

    let id!: ItemId;
    core.commit((t) => {
      id = t.insertChild(parentId, { at });
    });

    return id;
  },

  splitAt(
    core: Core,
    sel: { location: Location },
    caretStart: number,
    caretEnd = caretStart,
  ): ItemId | null {
    const id = sel.location.item;
    const snap = core.item(id);

    const loc = core.locate(id);
    if (!loc) return null;

    const { parentId, index: idx } = loc;

    if (!(snap.mode.type === "plain" && snap.content.type === "value")) {
      return outlineCmd.insertSibling(core, sel, "after");
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

  joinBoundary(
    core: Core,
    rootId: ItemId,
    sel: { location: Location },
    dir: "backward" | "forward",
  ): { id: ItemId; caret: number } | null {
    const loc = core.locate(sel.location.item);
    if (!loc) return null;

    const { index: idx, siblings } = loc;

    const neighbor =
      dir === "backward"
        ? (siblings[idx - 1] ?? null)
        : (siblings[idx + 1] ?? null);
    if (!neighbor) return null;

    const leftId = dir === "backward" ? neighbor : sel.location.item;
    const rightId = dir === "backward" ? sel.location.item : neighbor;

    const leftItem = core.item(leftId);
    const rightItem = core.item(rightId);

    if (!(leftItem.mode.type === "plain" && leftItem.content.type === "value"))
      return null;
    if (
      !(rightItem.mode.type === "plain" && rightItem.content.type === "value")
    )
      return null;

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

  indentInPlace(core: Core, sel: { location: Location }): Location | null {
    const id = sel.location.item;
    const childId = indentItemInPlace(core, id);
    if (!childId) return null;
    return { container: id, item: childId };
  },

  outdentInPlace(
    core: Core,
    rootId: ItemId,
    sel: { location: Location },
  ): Location | null {
    const childId = sel.location.item;
    const loc = core.locate(childId);
    if (!loc) return null;
    const parentId = loc.parentId;
    const parentSnap = core.item(parentId);
    const childSnap = core.item(childId);
    if (
      parentSnap.mode.type === "readonly" ||
      parentSnap.mode.type === "connected"
    )
      return null;
    if (
      childSnap.mode.type === "readonly" ||
      childSnap.mode.type === "connected"
    )
      return null;
    if (
      childSnap.content.type !== "value" &&
      childSnap.content.type !== "group"
    )
      return null;

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

    return focusFor(core, rootId, parentId);
  },
};

export function readOutlineSelectionPlainText(
  core: Core,
  rangeSel: OutlineValueSelectionRange,
): string | null {
  const { range, start, end } = rangeSel;
  if (range.collapsed) return "";

  if (start.itemId === end.itemId) {
    const snap = core.item(start.itemId);
    if (!isPlainValueItem(snap)) return null;
    const text = valueToText(snap.content.value);
    return text.slice(start.charOffset, end.charOffset);
  }

  const startLoc = core.locate(start.itemId);
  const endLoc = core.locate(end.itemId);
  if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId)
    return null;

  const startSnap = core.item(start.itemId);
  const endSnap = core.item(end.itemId);
  if (!isPlainValueItem(startSnap)) return null;
  if (!isPlainValueItem(endSnap)) return null;

  const parts: string[] = [];
  const startText = valueToText(startSnap.content.value);
  parts.push(startText.slice(start.charOffset));

  for (let i = startLoc.index + 1; i < endLoc.index; i += 1) {
    const id = startLoc.siblings[i];
    if (!id) return null;
    const snap = core.item(id);
    if (!isPlainValueItem(snap)) return null;
    parts.push(valueToText(snap.content.value));
  }

  const endText = valueToText(endSnap.content.value);
  parts.push(endText.slice(0, end.charOffset));
  return parts.join("\n");
}

export function deleteSingleItemValueRange(
  core: Core,
  rootId: ItemId,
  start: ModelPosition,
  end: ModelPosition,
  placeCursor: (itemId: ItemId, charOffset: number) => void,
): boolean {
  if (start.itemId !== end.itemId) return false;
  if (start.charOffset === end.charOffset) return false;

  const snap = core.item(start.itemId);
  if (!isPlainValueItem(snap)) return false;

  const text = valueToText(snap.content.value);
  const nextText = text.slice(0, start.charOffset) + text.slice(end.charOffset);
  core.commit((t) => t.setValue(start.itemId, nextText));
  core.focus({
    type: "editing",
    location: focusFor(core, rootId, start.itemId),
    target: VALUE_TARGET,
  });
  placeCursor(start.itemId, start.charOffset);
  return true;
}

export function deleteMultiItemValueRange(
  core: Core,
  rootId: ItemId,
  start: ModelPosition,
  end: ModelPosition,
  placeCursor: (itemId: ItemId, charOffset: number) => void,
): boolean {
  if (start.itemId === end.itemId) return false;

  const startLoc = core.locate(start.itemId);
  const endLoc = core.locate(end.itemId);
  if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId)
    return false;

  const startSnap = core.item(start.itemId);
  const endSnap = core.item(end.itemId);
  if (!isPlainValueItem(startSnap)) return false;
  if (!isPlainValueItem(endSnap)) return false;

  const startText = valueToText(startSnap.content.value).slice(
    0,
    start.charOffset,
  );
  const endText = valueToText(endSnap.content.value).slice(end.charOffset);
  const toDelete = [
    ...startLoc.siblings.slice(startLoc.index + 1, endLoc.index + 1),
  ];

  core.commit((t) => {
    t.setValue(start.itemId, startText + endText);
    for (const id of toDelete) t.remove(id);
  });
  core.focus({
    type: "editing",
    location: focusFor(core, rootId, start.itemId),
    target: VALUE_TARGET,
  });
  placeCursor(start.itemId, start.charOffset);
  return true;
}
