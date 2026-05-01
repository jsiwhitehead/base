import type { Core, Intent, NodeId, Location } from "../../core";
import { CONTENT_TEXT_TARGET } from "../../core";

import { outlineCmd } from "./commands";
import {
  collectStops,
  isPlainValueNode,
  moveStop,
  textLengthForTarget,
  valueToText,
} from "./navigation";
import { valueCaretOffset } from "./dom-mapping";

type EditingNavIntent = Extract<Intent, { type: "NAV" }>;
type EditingDeleteIntent = Extract<Intent, { type: "DELETE" }>;
type EditingEnterIntent = Extract<Intent, { type: "ENTER" }>;

function focusStop(
  core: Core,
  stop: ReturnType<typeof moveStop> extends { stop: infer T } | null
    ? T
    : never,
  edge: "start" | "end" | null,
): void {
  if (stop.type === "node") {
    core.focus({ type: "node", location: stop.location });
    return;
  }
  const caret =
    edge == null
      ? undefined
      : edge === "start"
        ? 0
        : textLengthForTarget(core, stop.location.node, stop.target);
  core.focus(
    { type: "editing", location: stop.location, target: stop.target },
    caret === undefined ? undefined : { caret },
  );
}

export function isHorizontalEditingBoundary(
  core: Core,
  root: HTMLElement,
  dir: "left" | "right",
): boolean {
  const selection = core.selection();
  if (
    selection.type !== "editing" ||
    selection.target !== CONTENT_TEXT_TARGET
  ) {
    return false;
  }
  const caretOffset = valueCaretOffset(root, selection.location.node, true);
  if (caretOffset == null) return false;
  const snap = core.node(selection.location.node);
  if (!isPlainValueNode(snap)) return false;
  const textLen = valueToText(snap.content.value).length;
  return dir === "left" ? caretOffset === 0 : caretOffset === textLen;
}

export function handleOutlineEditingEnter(args: {
  core: Core;
  location: Location;
  intent: EditingEnterIntent;
  portals: readonly NodeId[];
}): boolean {
  const { core, intent, portals } = args;
  let { location } = args;
  const range = intent.range;
  if (range) {
    if (range.start.nodeId !== range.end.nodeId) {
      const startLoc = core.locate(range.start.nodeId);
      const endLoc = core.locate(range.end.nodeId);
      if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId) {
        return false;
      }
      core.commit((t) => {
        const startSnap = core.node(range.start.nodeId);
        const endSnap = core.node(range.end.nodeId);
        if (
          startSnap.mode.type !== "plain" ||
          startSnap.content.type !== "value" ||
          endSnap.mode.type !== "plain" ||
          endSnap.content.type !== "value"
        ) {
          return;
        }
        const startText = String(startSnap.content.value ?? "").slice(
          0,
          range.start.offset,
        );
        const endText = String(endSnap.content.value ?? "").slice(
          range.end.offset,
        );
        t.setValue(range.start.nodeId, startText + endText);
        for (const id of startLoc.siblings.slice(
          startLoc.index + 1,
          endLoc.index + 1,
        )) {
          t.remove(id);
        }
      });
      location = { node: range.start.nodeId, portals };
    }
    const newId = outlineCmd.splitAt(
      core,
      location,
      range.start.offset,
      range.start.nodeId === range.end.nodeId
        ? range.end.offset
        : range.start.offset,
    );
    if (!newId) return false;
    core.focus(
      {
        type: "editing",
        location: { node: newId, portals },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );
    return true;
  }

  const newId = outlineCmd.splitAt(core, location, 0);
  if (!newId) return false;
  core.focus(
    {
      type: "editing",
      location: { node: newId, portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: 0 },
  );
  return true;
}

export function handleOutlineEditingNav(args: {
  core: Core;
  viewRootId: NodeId;
  location: Location;
  portals: readonly NodeId[];
  dir: EditingNavIntent["dir"];
}): boolean {
  const { core, viewRootId, location, portals, dir } = args;
  const stops = collectStops(core, viewRootId, portals);
  const moved = moveStop(
    stops,
    { type: "editing", location, target: CONTENT_TEXT_TARGET },
    dir === "left" || dir === "up" ? "backward" : "forward",
  );
  if (!moved) return false;
  focusStop(core, moved.stop, moved.edge);
  return true;
}

export function handleOutlineEditingDelete(args: {
  core: Core;
  viewRootId: NodeId;
  location: Location;
  portals: readonly NodeId[];
  dir: EditingDeleteIntent["dir"];
}): boolean {
  const { core, viewRootId, location, portals, dir } = args;
  const snap = core.node(location.node);
  if (snap.mode.type !== "plain" || snap.content.type !== "value") return false;
  const text = String(snap.content.value ?? "");
  const stops = collectStops(core, viewRootId, portals);
  const current = {
    type: "editing" as const,
    location,
    target: CONTENT_TEXT_TARGET,
  };
  if (text.length === 0) {
    const nextStop = moveStop(stops, current, dir);
    outlineCmd.removeAndPruneAncestors(core, viewRootId, location.node);
    if (!nextStop) return true;
    focusStop(core, nextStop.stop, nextStop.edge);
    return true;
  }
  const adjacentStop = moveStop(stops, current, dir);
  if (
    !adjacentStop ||
    adjacentStop.stop.type !== "editing" ||
    adjacentStop.stop.target !== CONTENT_TEXT_TARGET
  ) {
    return false;
  }
  const joined = outlineCmd.joinValues(
    core,
    viewRootId,
    dir === "backward" ? adjacentStop.stop.location.node : location.node,
    dir === "backward" ? location.node : adjacentStop.stop.location.node,
  );
  if (!joined) return false;
  core.focus(
    {
      type: "editing",
      location: { node: joined.id, portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: joined.caret },
  );
  return true;
}
