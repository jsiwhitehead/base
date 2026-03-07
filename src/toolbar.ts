import { computed } from "@preact/signals-core";
import type { ReadonlySignal } from "@preact/signals-core";

import type { Core, Item, ItemId, ViewName } from "./core";
import { sameLocation } from "./core";
import { createComponent, el } from "./dom";
import type { Component, UiCore } from "./dom";

export type ToolbarContentKind = "plain" | "formula" | "query";

export type ToolbarState = {
  selectedItemId: ItemId | null;
  canActOnSelectedItem: boolean;
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

function resolveToolbarItemId(core: Core): ItemId | null {
  const selection = core.selection();
  if (selection.type === "editing") return selection.location.item;
  if (
    selection.type === "item" &&
    sameLocation(selection.anchor, selection.head)
  ) {
    return selection.head.item;
  }
  return null;
}

function getToolbarContentKind(item: Item): ToolbarContentKind {
  if (item.mode.type === "connected") return item.mode.conn.type;
  return "plain";
}

function canSetConnectedContentKind(
  item: Item,
  kind: Extract<ToolbarContentKind, "formula" | "query">,
): boolean {
  if (item.mode.type === "readonly") return false;
  if (item.mode.type === "connected") return true;
  if (item.content.type !== "group") return true;
  if (item.content.children.length === 0) return true;
  return getToolbarContentKind(item) === kind;
}

export function getToolbarState(core: Core): ToolbarState {
  const selectedItemId = resolveToolbarItemId(core);
  if (!selectedItemId) {
    return {
      selectedItemId: null,
      canActOnSelectedItem: false,
      currentView: null,
      currentContentKind: null,
      enabledViews: [],
      enabledContentKinds: [],
    };
  }

  const item = core.item(selectedItemId);
  const canActOnSelectedItem = item.mode.type !== "readonly";
  const currentContentKind = getToolbarContentKind(item);

  return {
    selectedItemId,
    canActOnSelectedItem,
    currentView: core.view(selectedItemId),
    currentContentKind,
    enabledViews: canActOnSelectedItem ? TOOLBAR_VIEWS : [],
    enabledContentKinds: canActOnSelectedItem
      ? TOOLBAR_CONTENT_KINDS.filter((kind) =>
          kind === "plain" ? true : canSetConnectedContentKind(item, kind),
        )
      : [],
  };
}

export function setSelectedView(core: Core, view: ViewName): void {
  const state = getToolbarState(core);
  if (!state.canActOnSelectedItem || !state.selectedItemId) return;
  if (state.currentView === view) return;
  core.commit((t) => {
    t.setView(state.selectedItemId!, view);
  });
}

export function setSelectedContentKind(
  core: Core,
  kind: ToolbarContentKind,
): void {
  const state = getToolbarState(core);
  if (!state.canActOnSelectedItem || !state.selectedItemId) return;
  if (!state.enabledContentKinds.includes(kind)) return;
  if (state.currentContentKind === kind) return;

  const item = core.item(state.selectedItemId);
  core.commit((t) => {
    if (kind === "plain") {
      if (item.content.type === "group") {
        t.setGroup(state.selectedItemId!);
        return;
      }
      if (item.content.type === "value") {
        t.setValue(state.selectedItemId!, item.content.value);
        return;
      }
      t.setValue(state.selectedItemId!, null);
      return;
    }

    if (kind === "formula") {
      t.setConnected(state.selectedItemId!, { type: "formula", expr: "" });
      return;
    }

    t.setConnected(state.selectedItemId!, {
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
