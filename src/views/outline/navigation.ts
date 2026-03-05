import {
  VALUE_TARGET,
  type Core,
  type Item,
  type ItemId,
  type Location,
  type Selection,
  type ValueOrBlank,
} from "../../core";

export type ModelPosition = { itemId: ItemId; offset: number };

export type NavPoint =
  | { type: "editing"; focus: Location; target: string }
  | { type: "item"; focus: Location };

type NavMove = { point: NavPoint; edge: "start" | "end" | null };

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
  a.item === b.item &&
  a.portals.length === b.portals.length &&
  a.portals.every((portal, i) => portal === b.portals[i]);

export function focusKey(focus: Location): string {
  return `${focus.portals.join("|")}::${focus.item}`;
}

function collectVisibleItemFocuses(
  core: Core,
  rootId: ItemId,
  portals: readonly ItemId[],
): Location[] {
  const out: Location[] = [];
  const walk = (id: ItemId): void => {
    out.push({ item: id, portals });
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
  portals: readonly ItemId[],
): Location[] {
  const focuses = collectVisibleItemFocuses(core, rootId, portals);
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
  portals: readonly ItemId[],
): ItemId[] {
  const out: ItemId[] = [];
  const seen = new Set<ItemId>();
  for (const focus of blockSelectionFocuses(core, rootId, sel, portals)) {
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
  portals: readonly ItemId[],
): Location | null {
  const focuses = collectVisibleItemFocuses(core, rootId, portals);
  const headIdx = focuses.findIndex((focus) => sameFocus(focus, sel.head));
  if (headIdx < 0) return null;
  return dir === "up"
    ? (focuses[headIdx - 1] ?? null)
    : (focuses[headIdx + 1] ?? null);
}

function isEditLeaf(core: Core, id: ItemId): boolean {
  if (core.view(id) !== "outline") return true;
  return core.item(id).content.type !== "group";
}

function editTargetsForItem(core: Core, id: ItemId): string[] {
  const snap = core.item(id);
  if (snap.mode.type === "readonly") return [];
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

export function collectNavPoints(
  core: Core,
  rootId: ItemId,
  portals: readonly ItemId[],
): NavPoint[] {
  const out: NavPoint[] = [];
  const walk = (id: ItemId): void => {
    const snap = core.item(id);
    if (core.view(id) === "outline" && snap.content.type === "group") {
      for (const childId of snap.content.children) walk(childId);
      return;
    }
    if (!isEditLeaf(core, id)) return;
    const focus = { item: id, portals };
    if (core.view(id) !== "outline") {
      out.push({ type: "item", focus });
      return;
    }
    for (const target of editTargetsForItem(core, id)) {
      out.push({ type: "editing", focus, target });
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

export function moveNavPoint(
  points: readonly NavPoint[],
  current: NavPoint,
  dir: "backward" | "forward",
): NavMove | null {
  const idx = points.findIndex(
    (p) =>
      p.type === current.type &&
      sameFocus(p.focus, current.focus) &&
      (p.type === "editing" && current.type === "editing"
        ? p.target === current.target
        : true),
  );
  if (idx < 0) return null;
  const next = points[dir === "backward" ? idx - 1 : idx + 1];
  if (!next) return null;
  if (next.type === "item") return { point: next, edge: null };
  return { point: next, edge: dir === "backward" ? "end" : "start" };
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
