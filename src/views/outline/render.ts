import { computed } from "@preact/signals-core";

import { isNumericLikeValue, patchConn, VALUE_TARGET } from "../../core";
import type { ItemId, Location } from "../../core";
import type { Component, UiCore } from "../../dom";
import {
  buildItemHeader,
  createComponent,
  el,
  hasActiveSelectionInSurface,
  readPlainTextFromContentEditable,
  renderPlainTextToContentEditable,
  setBodyClasses,
} from "../../dom";
import { valueCaretOffset } from "./dom-mapping";
import { focusKey, sameFocus, valueToText } from "./navigation";
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

function buildOutlineValue(
  mountCtx: OutlineMountCtx,
  itemId: ItemId,
): Component {
  const { core, portals, discardPendingMutationRecords } = mountCtx;
  return createComponent(core, (ctx) => {
    const valueEl = el("span", "ui-outline-value");
    valueEl.dataset.target = "value";

    ctx.target(
      { item: itemId, portals },
      VALUE_TARGET,
      () => (valueEl.isConnected ? valueEl : null),
      {
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
    const itemEl = el("div", "ui-frame ui-outline-child");
    const itemFocus: Location = { item: itemId, portals };
    const itemKey = focusKey(itemFocus);
    itemEl.dataset.id = itemId;
    if (!itemEl.hasAttribute("tabindex")) itemEl.tabIndex = -1;

    const gutterEl = el("span", "ui-outline-gutter");
    gutterEl.dataset.dragStart = "handle";
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

      if (selection.target === VALUE_TARGET) {
        if (!valueSelectionCollapsed.value) {
          return valueRangeSelectedItemKeys.value.has(itemKey)
            ? "value"
            : "none";
        }
        if (!sameFocus(selection.location, itemFocus)) return "none";
        return "value";
      }
      if (!sameFocus(selection.location, itemFocus)) return "none";
      return "header";
    });
    const shouldShowHeader = computed(() => {
      const snap = core.item(itemId);
      const labelText = (snap.label ?? "").trim();
      return (
        labelText.length > 0 ||
        snap.mode.type === "connected" ||
        itemSelectionState.value === "header"
      );
    });

    ctx.effect(() => {
      itemEl.classList.toggle(
        "is-item-selected",
        itemSelectionState.value === "item",
      );
    });

    ctx.effect(() => {
      const snap = core.item(itemId);
      const isIssue = snap.content.type === "issue";
      const isNumeric =
        snap.content.type === "value" && isNumericLikeValue(snap.content.value);

      itemEl.classList.toggle(
        "is-selected",
        itemSelectionState.value !== "none",
      );
      itemEl.classList.toggle("is-issue", isIssue);
      itemEl.classList.toggle("is-numeric", isNumeric);
    });

    ctx.slot(itemEl, () => {
      if (!shouldShowHeader.value) return null;

      const focus: Location = { item: itemId, portals };
      const canEditLabel = () => core.item(itemId).mode.type !== "readonly";
      const commitLabel = (text: string) => {
        if (!canEditLabel()) return;
        if ((core.item(itemId).label ?? "") === text) return;
        core.commit((t) => t.setLabel(itemId, text));
      };
      const commitConnField = (key: string, text: string) => {
        const item = core.item(itemId);
        if (item.mode.type !== "connected") return;
        const { conn } = item.mode;
        core.commit((t) => t.setConnected(itemId, patchConn(conn, key, text)));
      };

      return buildItemHeader(core, {
        focus,
        id: itemId,
        canEditLabel,
        commitLabel,
        commitConnField,
      });
    });

    ctx.slot(itemEl, () => {
      const nextView = core.view(itemId);
      if (nextView === "outline") {
        return buildOutlineItem(mountCtx, itemId);
      }
      const snap = core.item(itemId);
      const childPortals =
        snap.mode.type === "connected" ? [...portals, itemId] : portals;
      const mounted = core.mountView({ id: itemId, portals: childPortals });
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
