import { computed } from "@preact/signals-core";

import {
  CONTENT_TEXT_TARGET,
  ITEM_TARGET,
  isNumericLikeValue,
  sameLocation,
} from "../../core";
import type { ItemId, Location } from "../../core";
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

type OutlineItemSelectionState = "none" | "item" | "value" | "header";
export type OutlineMountCtx = {
  core: UiCore;
  portals: readonly ItemId[];
  onGutterPointerDown: (
    itemId: ItemId,
    portals: readonly ItemId[],
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
  itemEl: HTMLElement;
  itemFocus: Location;
  itemSelectionState: { value: OutlineItemSelectionState };
}): void {
  const { core, ctx, itemEl, itemFocus, itemSelectionState } = args;

  itemEl.classList.add("ui-frame");
  itemEl.dataset.id = itemFocus.item;
  if (!itemEl.hasAttribute("tabindex")) itemEl.tabIndex = -1;

  ctx.target(itemFocus, ITEM_TARGET, () =>
    itemEl.isConnected ? itemEl : null,
  );

  ctx.effect(() => {
    const snap = core.item(itemFocus.item);
    const isIssue = snap.content.type === "issue";
    const isNumeric =
      snap.content.type === "value" && isNumericLikeValue(snap.content.value);

    itemEl.classList.toggle(
      "is-item-selected",
      itemSelectionState.value === "item",
    );
    itemEl.classList.toggle("is-selected", itemSelectionState.value !== "none");
    itemEl.classList.toggle("is-issue", isIssue);
    itemEl.classList.toggle("is-numeric", isNumeric);
  });
}

function buildOutlineValue(
  mountCtx: OutlineMountCtx,
  itemId: ItemId,
): Component {
  const { core, portals, discardPendingMutationRecords } = mountCtx;
  return createComponent(core, (ctx) => {
    const valueEl = el("span", "ui-outline-value");
    valueEl.dataset.target = CONTENT_TEXT_TARGET;

    ctx.target(
      { item: itemId, portals },
      CONTENT_TEXT_TARGET,
      () => (valueEl.isConnected ? valueEl : null),
      {
        primary: true,
        getCaret: () => {
          const host = valueEl.closest("[contenteditable='true']");
          if (!(host instanceof HTMLElement)) return undefined;
          return valueCaretOffset(host, itemId) ?? undefined;
        },
      },
    );

    ctx.effect(() => {
      const snap = core.item(itemId);
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
      const snap = core.item(itemId);
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
  itemId: ItemId,
): Component {
  const {
    core,
    portals,
    onGutterPointerDown,
    selectionState: {
      selectedItemKeys,
      valueRangeSelectedItemKeys,
      valueSelectionCollapsed,
    },
  } = mountCtx;
  return createComponent(core, (ctx) => {
    const itemEl = el("div", "ui-outline-child");
    const itemFocus: Location = { item: itemId, portals };
    const itemKey = locationKey(itemFocus);

    const gutterEl = el("span", "ui-outline-gutter");
    gutterEl.dataset.drag = "reorder";
    gutterEl.contentEditable = "false";
    gutterEl.addEventListener("pointerdown", (e) => {
      if ((e.button ?? 0) !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      onGutterPointerDown(itemId, portals, e.shiftKey, e.pointerId);
    });
    itemEl.append(gutterEl);

    const itemSelectionState = computed<OutlineItemSelectionState>(() => {
      const selection = core.selection();
      if (selection.type === "item") {
        if (!selectedItemKeys.value.has(itemKey)) return "none";
        return "item";
      }
      if (selection.type !== "editing") return "none";

      if (selection.target === CONTENT_TEXT_TARGET) {
        if (!valueSelectionCollapsed.value) {
          return valueRangeSelectedItemKeys.value.has(itemKey)
            ? "value"
            : "none";
        }
        if (!sameLocation(selection.location, itemFocus)) return "none";
        return "value";
      }
      if (!sameLocation(selection.location, itemFocus)) return "none";
      return "header";
    });
    bindOutlineFrame({
      core,
      ctx,
      itemEl,
      itemFocus,
      itemSelectionState,
    });

    mountHeader(ctx, {
      core,
      host: itemEl,
      location: { item: itemId, portals },
      id: itemId,
    });

    const childView = computed(() => core.view(itemId));
    const childUsesPortal = computed(() => {
      const mode = core.item(itemId).mode;
      return mode.type === "connected" && mode.conn.type === "query";
    });

    ctx.slot(itemEl, () => {
      const view = childView.value;
      if (view === "outline") return buildOutlineItem(mountCtx, itemId);
      const childPortals = childUsesPortal.value ? [...portals, itemId] : portals;
      const mounted = core.mountView({
        id: itemId,
        portals: childPortals,
        view,
      });
      mounted.el.contentEditable = "false";
      return mounted;
    });

    return itemEl;
  });
}

export function buildOutlineItem(
  mountCtx: OutlineMountCtx,
  itemId: ItemId,
): Component {
  const { core } = mountCtx;
  return createComponent(core, (ctx) => {
    const bodyEl = el("div");
    setBodyClasses(bodyEl, "outline");
    bodyEl.dataset.id = itemId;
    const renderKind = computed<"value" | "group" | "placeholder">(() => {
      const snap = core.item(itemId);
      if (snap.content.type !== "group") return "value";
      if (snap.content.children.length === 0) return "placeholder";
      return "group";
    });
    const kids = computed(() => {
      const snap = core.item(itemId);
      if (snap.content.type !== "group") return [] as ItemId[];
      return [...snap.content.children];
    });

    ctx.slot(bodyEl, () => {
      const kind = renderKind.value;
      if (kind === "value") return buildOutlineValue(mountCtx, itemId);
      if (kind === "placeholder") {
        return createComponent(core, () => {
          const placeholderEl = el(
            "div",
            "ui-outline-placeholder",
            "Empty group",
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
