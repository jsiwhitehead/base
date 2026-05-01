import { computed } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

import type { Core, Node, NodeId, ViewName } from "./core";
import { sameLocation } from "./core";
import { createComponent, el } from "./dom";
import type { Component, UiCore } from "./dom";

export type ToolbarContentKind = "plain" | "formula" | "query";

export type ToolbarState = {
  selectedNodeId: NodeId | null;
  canActOnSelectedNode: boolean;
  currentView: ViewName | null;
  currentContentKind: ToolbarContentKind | null;
  enabledViews: readonly ViewName[];
  enabledContentKinds: readonly ToolbarContentKind[];
};

type ToolbarCommandSpec =
  | { value: ViewName; label: string; kind: "view" }
  | { value: ToolbarContentKind; label: string; kind: "content" };

const TOOLBAR_VIEWS: readonly ViewName[] = ["outline", "table", "slider"];
const TOOLBAR_CONTENT_KINDS: readonly ToolbarContentKind[] = [
  "plain",
  "formula",
  "query",
];
const VIEW_COMMANDS: readonly ToolbarCommandSpec[] = [
  { value: "outline", label: "Outline", kind: "view" },
  { value: "table", label: "Table", kind: "view" },
  { value: "slider", label: "Slider", kind: "view" },
];
const CONTENT_COMMANDS: readonly ToolbarCommandSpec[] = [
  { value: "plain", label: "Plain", kind: "content" },
  { value: "formula", label: "Formula", kind: "content" },
  { value: "query", label: "Query", kind: "content" },
];

function resolveToolbarNodeId(core: Core): NodeId | null {
  const selection = core.selection();
  if (selection.type === "editing") return selection.location.node;
  if (
    selection.type === "node" &&
    sameLocation(selection.anchor, selection.head)
  ) {
    return selection.head.node;
  }
  return null;
}

function getToolbarContentKind(node: Node): ToolbarContentKind {
  if (node.mode.type === "connected") return node.mode.conn.type;
  return "plain";
}

function canSetConnectedContentKind(
  node: Node,
  kind: Extract<ToolbarContentKind, "formula" | "query">,
): boolean {
  if (node.mode.type === "readonly") return false;
  if (node.mode.type === "connected") return true;
  if (node.content.type !== "item") return true;
  if (node.content.children.length === 0) return true;
  return getToolbarContentKind(node) === kind;
}

export function getToolbarState(core: Core): ToolbarState {
  const selectedNodeId = resolveToolbarNodeId(core);
  if (!selectedNodeId) {
    return {
      selectedNodeId: null,
      canActOnSelectedNode: false,
      currentView: null,
      currentContentKind: null,
      enabledViews: [],
      enabledContentKinds: [],
    };
  }

  const node = core.node(selectedNodeId);
  const canActOnSelectedNode = node.mode.type !== "readonly";
  const currentContentKind = getToolbarContentKind(node);

  return {
    selectedNodeId,
    canActOnSelectedNode,
    currentView: core.view(selectedNodeId),
    currentContentKind,
    enabledViews: canActOnSelectedNode ? TOOLBAR_VIEWS : [],
    enabledContentKinds: canActOnSelectedNode
      ? TOOLBAR_CONTENT_KINDS.filter((kind) =>
          kind === "plain" ? true : canSetConnectedContentKind(node, kind),
        )
      : [],
  };
}

export function setSelectedView(core: Core, view: ViewName): void {
  const state = getToolbarState(core);
  if (!state.canActOnSelectedNode || !state.selectedNodeId) return;
  if (state.currentView === view) return;
  core.commit((t) => {
    t.setView(state.selectedNodeId!, view);
  });
}

export function setSelectedContentKind(
  core: Core,
  kind: ToolbarContentKind,
): void {
  const state = getToolbarState(core);
  if (!state.canActOnSelectedNode || !state.selectedNodeId) return;
  if (!state.enabledContentKinds.includes(kind)) return;
  if (state.currentContentKind === kind) return;

  const node = core.node(state.selectedNodeId);
  core.commit((t) => {
    if (kind === "plain") {
      if (node.content.type === "item") {
        t.setItem(state.selectedNodeId!);
        return;
      }
      if (node.content.type === "value") {
        t.setValue(state.selectedNodeId!, node.content.value);
        return;
      }
      t.setValue(state.selectedNodeId!, null);
      return;
    }

    if (kind === "formula") {
      t.setConnected(state.selectedNodeId!, { type: "formula", expr: "" });
      return;
    }

    t.setConnected(state.selectedNodeId!, {
      type: "query",
      from: "",
      where: "",
      orderBy: "",
    });
  });
}

function buildToolbarGroup(
  core: UiCore,
  specs: readonly ToolbarCommandSpec[],
  toolbarState: ReadonlySignal<ToolbarState>,
): Component {
  return createComponent(core, (ctx) => {
    const groupEl = el("div", "ui-toolbar-group");

    for (const spec of specs) {
      const buttonEl = el(
        "button",
        "ui-toolbar-button",
        spec.label,
      ) as HTMLButtonElement;
      buttonEl.setAttribute("type", "button");
      buttonEl.dataset.command = spec.value;

      ctx.on(buttonEl, "click", () => {
        if (spec.kind === "view") {
          setSelectedView(core, spec.value);
          return;
        }
        setSelectedContentKind(core, spec.value);
      });

      ctx.effect(() => {
        const state = toolbarState.value;
        const enabled =
          spec.kind === "view"
            ? state.enabledViews.includes(spec.value)
            : state.enabledContentKinds.includes(spec.value);
        const pressed =
          spec.kind === "view"
            ? state.currentView === spec.value
            : state.currentContentKind === spec.value;

        buttonEl.disabled = !enabled;
        buttonEl.setAttribute("aria-pressed", pressed ? "true" : "false");
        buttonEl.classList.toggle("is-active", pressed);
      });

      groupEl.append(buttonEl);
    }

    return groupEl;
  });
}

export function buildToolbar(core: UiCore): Component {
  return createComponent(core, (ctx) => {
    const toolbarState = computed(() => getToolbarState(core));

    const root = el("div", "ui-toolbar");
    const viewGroup = el("div", "ui-toolbar-section");
    const kindGroup = el("div", "ui-toolbar-section");

    ctx.mount(viewGroup, buildToolbarGroup(core, VIEW_COMMANDS, toolbarState));
    ctx.mount(
      kindGroup,
      buildToolbarGroup(core, CONTENT_COMMANDS, toolbarState),
    );

    root.append(viewGroup, kindGroup);
    return root;
  });
}
