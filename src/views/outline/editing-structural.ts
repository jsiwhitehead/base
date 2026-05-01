import type { Core, Intent, ItemId, Location } from "../../core";
import { CONTENT_TEXT_TARGET } from "../../core";

import { outlineCmd } from "./commands";
import {
  collectStops,
  isPlainValueItem,
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
  if (stop.type === "item") {
    core.focus({ type: "item", location: stop.location });
    return;
  }
  const caret =
    edge == null
      ? undefined
      : edge === "start"
        ? 0
        : textLengthForTarget(core, stop.location.item, stop.target);
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
  const caretOffset = valueCaretOffset(root, selection.location.item, true);
  if (caretOffset == null) return false;
  const snap = core.item(selection.location.item);
  if (!isPlainValueItem(snap)) return false;
  const textLen = valueToText(snap.content.value).length;
  return dir === "left" ? caretOffset === 0 : caretOffset === textLen;
}

export function handleOutlineEditingEnter(args: {
  core: Core;
  location: Location;
  intent: EditingEnterIntent;
  portals: readonly ItemId[];
}): boolean {
  const { core, intent, portals } = args;
  let { location } = args;
  const range = intent.range;
  if (range) {
    if (range.start.itemId !== range.end.itemId) {
      const startLoc = core.locate(range.start.itemId);
      const endLoc = core.locate(range.end.itemId);
      if (!startLoc || !endLoc || startLoc.parentId !== endLoc.parentId) {
        return false;
      }
      core.commit((t) => {
        const startSnap = core.item(range.start.itemId);
        const endSnap = core.item(range.end.itemId);
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
        t.setValue(range.start.itemId, startText + endText);
        for (const id of startLoc.siblings.slice(
          startLoc.index + 1,
          endLoc.index + 1,
        )) {
          t.remove(id);
        }
      });
      location = { item: range.start.itemId, portals };
    }
    const newId = outlineCmd.splitAt(
      core,
      location,
      range.start.offset,
      range.start.itemId === range.end.itemId
        ? range.end.offset
        : range.start.offset,
    );
    if (!newId) return false;
    core.focus(
      {
        type: "editing",
        location: { item: newId, portals },
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
      location: { item: newId, portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: 0 },
  );
  return true;
}

export function handleOutlineEditingNav(args: {
  core: Core;
  viewRootId: ItemId;
  location: Location;
  portals: readonly ItemId[];
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
  viewRootId: ItemId;
  location: Location;
  portals: readonly ItemId[];
  dir: EditingDeleteIntent["dir"];
}): boolean {
  const { core, viewRootId, location, portals, dir } = args;
  const snap = core.item(location.item);
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
    outlineCmd.removeAndPruneAncestors(core, viewRootId, location.item);
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
    dir === "backward" ? adjacentStop.stop.location.item : location.item,
    dir === "backward" ? location.item : adjacentStop.stop.location.item,
  );
  if (!joined) return false;
  core.focus(
    {
      type: "editing",
      location: { item: joined.id, portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: joined.caret },
  );
  return true;
}
