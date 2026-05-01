import type { Intent, NodeId, Location } from "../../core";
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
  handleOutlineEditingEnter,
  handleOutlineEditingDelete,
  handleOutlineEditingNav,
} from "./editing-structural";
import { blockSelectionNodes } from "./navigation";
import { handleOutlineNodeNav } from "./runtime";

function focusFirstChildIfAny(core: UiCore, location: Location): boolean {
  const node = core.node(location.node);
  if (node.content.type !== "item") return false;
  const firstChildId = node.content.children[0] ?? null;
  if (!firstChildId) return false;
  core.focus({
    type: "node",
    location: { node: firstChildId, portals: location.portals },
  });
  return true;
}

function createFirstChildAndFocus(
  core: UiCore,
  location: Location,
  initialText: string,
): boolean {
  const node = core.node(location.node);
  if (node.mode.type === "readonly") return false;
  if (node.content.type !== "item") return false;
  if (node.content.children.length !== 0) return false;

  const childId = outlineCmd.createFirstChild(core, location, initialText);
  if (!childId) return false;
  core.focus(
    {
      type: "editing",
      location: { node: childId, portals: location.portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: initialText.length },
  );
  return true;
}

function focusInsertedNode(
  core: UiCore,
  nodeId: NodeId,
  portals: readonly NodeId[],
): void {
  core.focus(
    {
      type: "editing",
      location: { node: nodeId, portals },
      target: CONTENT_TEXT_TARGET,
    },
    { caret: 0 },
  );
}

function nextOutlineTabFocus(
  core: UiCore,
  location: Location,
  shift: boolean,
): Location | null {
  return shift
    ? outlineCmd.outdentInPlace(core, location)
    : outlineCmd.indentInPlace(core, location);
}

export function createOutlineValueTabHandler(args: {
  core: UiCore;
  viewRootId: NodeId;
}): (location: Location, shift: boolean, caret: number) => void {
  const { core, viewRootId } = args;
  return (location: Location, shift: boolean, caret: number): void => {
    if (shift && location.node === viewRootId) return;
    const nextFocus = nextOutlineTabFocus(core, location, shift);
    if (!nextFocus) return;
    core.focus(
      { type: "editing", location: nextFocus, target: CONTENT_TEXT_TARGET },
      { caret },
    );
  };
}

export function createOutlineNodeTabHandler(args: {
  core: UiCore;
}): (location: Location, shift: boolean) => void {
  const { core } = args;
  return (location, shift) => {
    const nextFocus = nextOutlineTabFocus(core, location, shift);
    if (!nextFocus) return;
    core.focus({ type: "node", location: nextFocus });
  };
}

function handleOutlineType(
  core: UiCore,
  location: Location,
  char: string,
): void {
  const node = core.node(location.node);
  if (node.mode.type === "readonly") return;
  createFirstChildAndFocus(core, location, char);
}

export function handleOutlineNodeDelete(args: {
  core: UiCore;
  viewRootId: NodeId;
  portals: readonly NodeId[];
  selection: Extract<ReturnType<UiCore["selection"]>, { type: "node" }>;
}): void {
  const { core, viewRootId, portals, selection } = args;
  const selectedNodes = blockSelectionNodes(
    core,
    viewRootId,
    selection,
    portals,
  );

  if (selectedNodes.length > 1) {
    const lastId = selectedNodes[selectedNodes.length - 1]!;
    const blockPlan = planBlockRemoval(core, viewRootId, selectedNodes);
    const nextFocus = resolveFocusAfterOutlineRemove(
      core,
      viewRootId,
      lastId,
      "next",
      portals,
      blockPlan.removedIds,
    );
    removeBlockSelection(core, viewRootId, selection, portals, blockPlan);
    if (nextFocus) core.focus({ type: "node", location: nextFocus });
    return;
  }

  const id = selection.head.node;
  if (!core.locate(id)) return;
  if (core.node(id).mode.type === "readonly") return;
  const removedIds = new Set<NodeId>([
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
  if (nextFocus) core.focus({ type: "node", location: nextFocus });
}

export function createOutlineIntentHandler(args: {
  core: UiCore;
  viewRootId: NodeId;
  portals: readonly NodeId[];
}): (intent: Intent) => void {
  const { core, viewRootId, portals } = args;

  return (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type === "idle") return;
    const sel = selection;

    const location: Location = sel.type === "node" ? sel.head : sel.location;

    if (intent.type === "DELETE") {
      if (sel.type === "editing") {
        handleOutlineEditingDelete({
          core,
          viewRootId,
          location,
          portals,
          dir: intent.dir,
        });
        return;
      }
      handleOutlineNodeDelete({
        core,
        viewRootId,
        portals,
        selection: sel,
      });
      return;
    }

    switch (intent.type) {
      case "NAV": {
        if (sel.type === "editing") {
          handleOutlineEditingNav({
            core,
            viewRootId,
            location,
            portals,
            dir: intent.dir,
          });
          return;
        }
        handleOutlineNodeNav({
          core,
          viewRootId,
          portals,
          location,
          dir: intent.dir === "out" ? "left" : intent.dir,
        });
        return;
      }
      case "TYPE": {
        if (sel.type !== "node") return;
        handleOutlineType(core, location, intent.char);
        return;
      }
      case "ENTER": {
        if (sel.type === "editing") {
          handleOutlineEditingEnter({ core, location, intent, portals });
          return;
        }
        if (createFirstChildAndFocus(core, location, "")) {
          return;
        }
        if (focusFirstChildIfAny(core, location)) {
          return;
        }
        return;
      }
      case "LABEL": {
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
        focusInsertedNode(core, nextId, portals);
        return;
      }
    }
  };
}
