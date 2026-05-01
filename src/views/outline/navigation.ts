import {
  CONTENT_TEXT_TARGET,
  sameLocation,
  type Core,
  type Node,
  type NodeId,
  type Location,
  type Selection,
  type ValueOrBlank,
} from "../../core";

export type ModelPosition = { nodeId: NodeId; offset: number };

export type OutlineStop =
  | { type: "editing"; location: Location; target: string }
  | { type: "node"; location: Location };

export type StopMove = { stop: OutlineStop; edge: "start" | "end" | null };

export function valueToText(v: ValueOrBlank): string {
  return v == null ? "" : String(v);
}

export function isPlainValueNode(
  node: Node,
): node is Node & { mode: { type: "plain" }; content: { type: "value" } } {
  return node.mode.type === "plain" && node.content.type === "value";
}

export function childrenOf(core: Core, id: NodeId): readonly NodeId[] {
  const content = core.node(id).content;
  return content.type === "item" ? content.children : [];
}

export function parentOf(
  core: Core,
  rootId: NodeId,
  id: NodeId,
): NodeId | null {
  if (id === rootId) return null;
  const loc = core.locate(id);
  return loc ? loc.parentId : null;
}

export function firstChild(core: Core, id: NodeId): NodeId | null {
  const kids = childrenOf(core, id);
  return kids[0] ?? null;
}

export function prevSibling(core: Core, id: NodeId): NodeId | null {
  const loc = core.locate(id);
  return loc ? (loc.siblings[loc.index - 1] ?? null) : null;
}

export function nextSibling(core: Core, id: NodeId): NodeId | null {
  const loc = core.locate(id);
  return loc ? (loc.siblings[loc.index + 1] ?? null) : null;
}

export function locationKey(location: Location): string {
  return `${location.portals.join("|")}::${location.node}`;
}

function collectVisibleNodeLocations(
  core: Core,
  rootId: NodeId,
  portals: readonly NodeId[],
): Location[] {
  const out: Location[] = [];
  const walk = (id: NodeId): void => {
    out.push({ node: id, portals });
    const snap = core.node(id);
    if (core.view(id) !== "outline" || snap.content.type !== "item") return;
    for (const childId of snap.content.children) walk(childId);
  };
  const rootSnap = core.node(rootId);
  if (rootSnap.content.type === "item") {
    for (const childId of rootSnap.content.children) walk(childId);
    return out;
  }
  walk(rootId);
  return out;
}

export function blockSelectionLocations(
  core: Core,
  rootId: NodeId,
  sel: Extract<Selection, { type: "node" }>,
  portals: readonly NodeId[],
): Location[] {
  const locations = collectVisibleNodeLocations(core, rootId, portals);
  const anchorIdx = locations.findIndex((location) =>
    sameLocation(location, sel.anchor),
  );
  const headIdx = locations.findIndex((location) =>
    sameLocation(location, sel.head),
  );
  if (anchorIdx < 0 || headIdx < 0) return [];
  const lo = Math.min(anchorIdx, headIdx);
  const hi = Math.max(anchorIdx, headIdx);
  return locations.slice(lo, hi + 1);
}

export function blockSelectionNodes(
  core: Core,
  rootId: NodeId,
  sel: Extract<Selection, { type: "node" }>,
  portals: readonly NodeId[],
): NodeId[] {
  const out: NodeId[] = [];
  const seen = new Set<NodeId>();
  for (const location of blockSelectionLocations(core, rootId, sel, portals)) {
    if (seen.has(location.node)) continue;
    seen.add(location.node);
    out.push(location.node);
  }
  return out;
}

export function extendBlockSelectionByArrow(
  core: Core,
  rootId: NodeId,
  sel: Extract<Selection, { type: "node" }>,
  dir: "up" | "down",
  portals: readonly NodeId[],
): Location | null {
  const locations = collectVisibleNodeLocations(core, rootId, portals);
  const headIdx = locations.findIndex((location) =>
    sameLocation(location, sel.head),
  );
  if (headIdx < 0) return null;
  return dir === "up"
    ? (locations[headIdx - 1] ?? null)
    : (locations[headIdx + 1] ?? null);
}

function stopForNode(
  core: Core,
  location: Location,
  node: Node,
): OutlineStop | null {
  if (core.view(location.node) !== "outline") {
    return { type: "node", location };
  }
  if (node.mode.type === "connected") {
    return { type: "node", location };
  }
  if (node.mode.type === "plain" && node.content.type === "value") {
    return { type: "editing", location, target: CONTENT_TEXT_TARGET };
  }
  return null;
}

export function collectStops(
  core: Core,
  rootId: NodeId,
  portals: readonly NodeId[],
): OutlineStop[] {
  const out: OutlineStop[] = [];
  const walk = (id: NodeId): void => {
    const snap = core.node(id);
    const location = { node: id, portals };
    const stop = stopForNode(core, location, snap);

    if (stop) {
      out.push(stop);
      return;
    }

    if (core.view(id) === "outline" && snap.content.type === "item") {
      for (const childId of snap.content.children) walk(childId);
      return;
    }
  };

  const rootSnap = core.node(rootId);
  if (rootSnap.content.type === "item") {
    for (const childId of rootSnap.content.children) walk(childId);
  } else {
    walk(rootId);
  }
  return out;
}

export function moveStop(
  stops: readonly OutlineStop[],
  current: OutlineStop,
  dir: "backward" | "forward",
): StopMove | null {
  const idx = stops.findIndex(
    (p) =>
      p.type === current.type &&
      sameLocation(p.location, current.location) &&
      (p.type === "editing" && current.type === "editing"
        ? p.target === current.target
        : true),
  );
  if (idx < 0) return null;
  const next = stops[dir === "backward" ? idx - 1 : idx + 1];
  if (!next) return null;
  if (next.type === "node") return { stop: next, edge: null };
  return { stop: next, edge: dir === "backward" ? "end" : "start" };
}

export function textLengthForTarget(
  core: Core,
  id: NodeId,
  target: string,
): number {
  const snap = core.node(id);
  if (target === CONTENT_TEXT_TARGET) {
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
