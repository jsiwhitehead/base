import { computed } from "@preact/signals-core";

import {
  CONTENT_TEXT_TARGET,
  NODE_TARGET,
  isNumericLikeValue,
  sameLocation,
} from "../../core";
import type { NodeId, Location } from "../../core";
import type { Component, Ctx, UiCore } from "../../dom";
import {
  createComponent,
  el,
  hasActiveSelectionInSurface,
  mountHeader,
  readPlainTextFromContentEditable,
  renderPlainTextToContentEditable,
  setBodyClasses,
} from "../../dom";
import { valueCaretOffset } from "./dom-mapping";
import { locationKey, valueToText } from "./navigation";
import type { OutlineSelectionState } from "./runtime";

type OutlineNodeSelectionState = "none" | "node" | "value" | "header";
export type OutlineMountCtx = {
  core: UiCore;
  portals: readonly NodeId[];
  onGutterPointerDown: (
    nodeId: NodeId,
    portals: readonly NodeId[],
    shiftKey: boolean,
    pointerId: number,
  ) => void;
  selectionState: OutlineSelectionState;
  discardPendingMutationRecords: () => void;
  onValueTab: (location: Location, shift: boolean, caret: number) => void;
};

function bindOutlineFrame(args: {
  core: UiCore;
  ctx: Ctx;
  nodeEl: HTMLElement;
  nodeFocus: Location;
  nodeSelectionState: { value: OutlineNodeSelectionState };
}): void {
  const { core, ctx, nodeEl, nodeFocus, nodeSelectionState } = args;

  nodeEl.classList.add("ui-frame");
  nodeEl.dataset.id = nodeFocus.node;
  if (!nodeEl.hasAttribute("tabindex")) nodeEl.tabIndex = -1;

  ctx.target(nodeFocus, NODE_TARGET, () =>
    nodeEl.isConnected ? nodeEl : null,
  );

  ctx.effect(() => {
    const snap = core.node(nodeFocus.node);
    const isIssue = snap.content.type === "issue";
    const isNumeric =
      snap.content.type === "value" && isNumericLikeValue(snap.content.value);

    nodeEl.classList.toggle(
      "is-node-selected",
      nodeSelectionState.value === "node",
    );
    nodeEl.classList.toggle("is-selected", nodeSelectionState.value !== "none");
    nodeEl.classList.toggle("is-issue", isIssue);
    nodeEl.classList.toggle("is-numeric", isNumeric);
  });
}

function buildOutlineValue(
  mountCtx: OutlineMountCtx,
  nodeId: NodeId,
): Component {
  const { core, portals, discardPendingMutationRecords } = mountCtx;
  return createComponent(core, (ctx) => {
    const valueEl = el("span", "ui-outline-value");
    valueEl.dataset.target = CONTENT_TEXT_TARGET;

    ctx.target(
      { node: nodeId, portals },
      CONTENT_TEXT_TARGET,
      () => (valueEl.isConnected ? valueEl : null),
      {
        primary: true,
        getCaret: () => {
          const host = valueEl.closest("[contenteditable='true']");
          if (!(host instanceof HTMLElement)) return undefined;
          return valueCaretOffset(host, nodeId) ?? undefined;
        },
      },
    );

    ctx.effect(() => {
      const snap = core.node(nodeId);
      const newText =
        snap.content.type === "value"
          ? valueToText(snap.content.value)
          : snap.content.type === "issue"
            ? (snap.content.message ?? "")
            : "";

      const currentText = readPlainTextFromContentEditable(valueEl);
      if (hasActiveSelectionInSurface(valueEl) && currentText === newText) {
        return;
      }
      discardPendingMutationRecords();
      renderPlainTextToContentEditable(valueEl, newText);
    });

    ctx.effect(() => {
      const snap = core.node(nodeId);
      if (snap.mode.type === "plain" && snap.content.type === "value") {
        valueEl.removeAttribute("contenteditable");
        return;
      }
      valueEl.contentEditable = "false";
    });

    return valueEl;
  });
}

function buildOutlineChild(
  mountCtx: OutlineMountCtx,
  nodeId: NodeId,
): Component {
  const {
    core,
    portals,
    onGutterPointerDown,
    selectionState: {
      selectedNodeKeys,
      valueRangeSelectedNodeKeys,
      valueSelectionCollapsed,
    },
  } = mountCtx;
  return createComponent(core, (ctx) => {
    const nodeEl = el("div", "ui-outline-child");
    const nodeFocus: Location = { node: nodeId, portals };
    const nodeKey = locationKey(nodeFocus);

    const gutterEl = el("span", "ui-outline-gutter");
    gutterEl.dataset.drag = "reorder";
    gutterEl.contentEditable = "false";
    gutterEl.addEventListener("pointerdown", (e) => {
      if ((e.button ?? 0) !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onGutterPointerDown(nodeId, portals, e.shiftKey, e.pointerId);
    });
    nodeEl.append(gutterEl);

    const nodeSelectionState = computed<OutlineNodeSelectionState>(() => {
      const selection = core.selection();
      if (selection.type === "node") {
        if (!selectedNodeKeys.value.has(nodeKey)) return "none";
        return "node";
      }
      if (selection.type !== "editing") return "none";

      if (selection.target === CONTENT_TEXT_TARGET) {
        if (!valueSelectionCollapsed.value) {
          return valueRangeSelectedNodeKeys.value.has(nodeKey)
            ? "value"
            : "none";
        }
        if (!sameLocation(selection.location, nodeFocus)) return "none";
        return "value";
      }
      if (!sameLocation(selection.location, nodeFocus)) return "none";
      return "header";
    });
    bindOutlineFrame({
      core,
      ctx,
      nodeEl,
      nodeFocus,
      nodeSelectionState,
    });

    mountHeader(ctx, {
      core,
      host: nodeEl,
      location: { node: nodeId, portals },
      id: nodeId,
    });

    const childView = computed(() => core.view(nodeId));
    const childUsesPortal = computed(() => {
      const mode = core.node(nodeId).mode;
      return mode.type === "connected" && mode.conn.type === "query";
    });

    ctx.slot(nodeEl, () => {
      const view = childView.value;
      if (view === "outline") return buildOutlineNode(mountCtx, nodeId);
      const childPortals = childUsesPortal.value
        ? [...portals, nodeId]
        : portals;
      const mounted = core.mountView({
        id: nodeId,
        portals: childPortals,
        view,
      });
      mounted.el.contentEditable = "false";
      return mounted;
    });

    return nodeEl;
  });
}

export function buildOutlineNode(
  mountCtx: OutlineMountCtx,
  nodeId: NodeId,
): Component {
  const { core } = mountCtx;
  return createComponent(core, (ctx) => {
    const bodyEl = el("div");
    setBodyClasses(bodyEl, "outline");
    bodyEl.dataset.id = nodeId;
    const renderKind = computed<"value" | "item" | "placeholder">(() => {
      const snap = core.node(nodeId);
      if (snap.content.type !== "item") return "value";
      if (snap.content.children.length === 0) return "placeholder";
      return "item";
    });
    const kids = computed(() => {
      const snap = core.node(nodeId);
      if (snap.content.type !== "item") return [] as NodeId[];
      return [...snap.content.children];
    });

    ctx.slot(bodyEl, () => {
      const kind = renderKind.value;
      if (kind === "value") return buildOutlineValue(mountCtx, nodeId);
      if (kind === "placeholder") {
        return createComponent(core, () => {
          const placeholderEl = el(
            "div",
            "ui-outline-placeholder",
            "Empty item",
          );
          placeholderEl.contentEditable = "false";
          placeholderEl.setAttribute("aria-hidden", "true");
          return placeholderEl;
        });
      }
      return null;
    });

    ctx.list(
      bodyEl,
      () => kids.value,
      (childId) => buildOutlineChild(mountCtx, childId),
    );

    return bodyEl;
  });
}
