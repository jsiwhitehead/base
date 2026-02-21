import type { Signal } from "@preact/signals-core";
import { effect, signal } from "@preact/signals-core";

import type { Component, Core, ItemId, Tx } from "../core";
import { el } from "./base";

export type DropTarget =
  | {
      type: "gap";
      parentId: ItemId;
      at: number;
      side: "before" | "after";
      axis: "horizontal" | "vertical";
      anchorEl: HTMLElement;
    }
  | {
      type: "slot";
      itemId: ItemId;
      anchorEl: HTMLElement;
    };

export type DragState =
  | { type: "idle" }
  | {
      type: "pending";
      itemId: ItemId;
      pointerId: number;
      startX: number;
      startY: number;
    }
  | { type: "active"; itemId: ItemId; drop: DropTarget | null };

export type DragController = {
  state: Signal<DragState>;
  dispose(): void;
};

const DRAG_THRESHOLD_PX = 5;
const SLOT_EDGE_FRACTION = 0.25;

const INTERACTIVE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);

function isInteractiveEl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return INTERACTIVE_TAGS.has(target.tagName) || target.isContentEditable;
}

function nearestFrame(
  target: EventTarget | null,
): { el: HTMLElement; itemId: ItemId } | null {
  for (
    let node = target instanceof HTMLElement ? target : null;
    node;
    node = node.parentElement
  ) {
    const id = node.dataset.id;
    if (id && node.classList.contains("ui-frame"))
      return { el: node, itemId: id };
  }
  return null;
}

function parentFrameAxis(frameEl: HTMLElement): "horizontal" | "vertical" {
  for (let node = frameEl.parentElement; node; node = node.parentElement) {
    if (node.classList.contains("ui-frame"))
      return node.dataset.dragAxis === "horizontal" ? "horizontal" : "vertical";
  }
  return "vertical";
}

function computePruneList(core: Core, sourceItemId: ItemId): ItemId[] {
  const out: ItemId[] = [];
  let cur = sourceItemId;

  while (true) {
    const loc = core.locate(cur);
    if (!loc) break;

    const parent = core.item(loc.parentId);
    if (
      parent.mode.type !== "plain" ||
      parent.content.type !== "group" ||
      parent.content.children.length !== 1 ||
      parent.content.children[0] !== cur
    )
      break;

    out.push(loc.parentId);
    cur = loc.parentId;
  }

  return out;
}

function resolveDropTarget(
  core: Core,
  x: number,
  y: number,
  sourceItemId: ItemId,
  sourceEl: HTMLElement,
): DropTarget | null {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;

  const frame = nearestFrame(hit);
  if (!frame) return null;

  if (frame.itemId === sourceItemId || sourceEl.contains(frame.el)) return null;

  const rect = frame.el.getBoundingClientRect();

  if (frame.el.dataset.dragSlot) {
    const fraction = (y - rect.top) / rect.height;

    if (fraction > SLOT_EDGE_FRACTION && fraction < 1 - SLOT_EDGE_FRACTION)
      return { type: "slot", itemId: frame.itemId, anchorEl: frame.el };

    const parentFrame = nearestFrame(frame.el.parentElement);
    if (
      !parentFrame ||
      parentFrame.itemId === sourceItemId ||
      sourceEl.contains(parentFrame.el)
    )
      return null;

    const parentLoc = core.locate(parentFrame.itemId);
    if (!parentLoc) return null;

    if (core.item(parentLoc.parentId).mode.type !== "plain") return null;

    const side: "before" | "after" =
      fraction <= SLOT_EDGE_FRACTION ? "before" : "after";

    return {
      type: "gap",
      parentId: parentLoc.parentId,
      at: side === "before" ? parentLoc.index : parentLoc.index + 1,
      side,
      axis: parentFrameAxis(parentFrame.el),
      anchorEl: parentFrame.el,
    };
  }

  const loc = core.locate(frame.itemId);
  if (!loc) return null;

  if (core.item(loc.parentId).mode.type !== "plain") return null;

  const axis = parentFrameAxis(frame.el);
  const isBefore =
    axis === "horizontal"
      ? x < rect.left + rect.width / 2
      : y < rect.top + rect.height / 2;
  const side: "before" | "after" = isBefore ? "before" : "after";

  return {
    type: "gap",
    parentId: loc.parentId,
    at: side === "before" ? loc.index : loc.index + 1,
    side,
    axis,
    anchorEl: frame.el,
  };
}

export function createDragController(core: Core): DragController {
  const state = signal<DragState>({ type: "idle" });

  let activeSourceEl: HTMLElement | null = null;
  let escapeHandler: ((e: KeyboardEvent) => void) | null = null;

  function cancel(): void {
    activeSourceEl?.classList.remove("is-dragging");
    activeSourceEl = null;
    if (escapeHandler) {
      window.removeEventListener("keydown", escapeHandler);
      escapeHandler = null;
    }
    delete document.documentElement.dataset.dragState;
    state.value = { type: "idle" };
  }

  function activate(
    itemId: ItemId,
    frameEl: HTMLElement,
    x: number,
    y: number,
  ): void {
    activeSourceEl = frameEl;
    frameEl.classList.add("is-dragging");
    document.documentElement.dataset.dragState = "active";

    escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", escapeHandler);

    state.value = {
      type: "active",
      itemId,
      drop: resolveDropTarget(core, x, y, itemId, frameEl),
    };
  }

  function commitDrop(s: Extract<DragState, { type: "active" }>): void {
    if (s.drop) {
      const isSlotSource = activeSourceEl?.dataset.dragSlot === "true";
      const sourceLoc = isSlotSource ? core.locate(s.itemId) : null;
      const sourceLabel = isSlotSource ? core.item(s.itemId).label : null;
      const pruneList = isSlotSource ? [] : computePruneList(core, s.itemId);

      const applySourceOps = (tx: Tx): void => {
        if (sourceLoc) {
          const newId = tx.insertChild(sourceLoc.parentId, {
            at: sourceLoc.index,
          });
          if (sourceLabel) tx.setLabel(newId, sourceLabel);
        } else {
          for (const id of pruneList) tx.remove(id);
        }
      };

      try {
        if (s.drop.type === "gap") {
          const drop = s.drop;
          core.commit((tx) => {
            tx.move(s.itemId, drop.parentId, { at: drop.at });
            if (isSlotSource) tx.setLabel(s.itemId, "");
            applySourceOps(tx);
          });
        } else {
          const drop = s.drop;
          const slotLoc = core.locate(drop.itemId);
          const displacedLabel = core.item(drop.itemId).label;
          if (slotLoc) {
            core.commit((tx) => {
              tx.move(s.itemId, slotLoc.parentId, { at: slotLoc.index });
              tx.remove(drop.itemId);
              if (displacedLabel) tx.setLabel(s.itemId, displacedLabel);
              applySourceOps(tx);
            });
          }
        }
      } catch {}
    }
    cancel();
  }

  const onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || state.value.type !== "idle") return;
    if (isInteractiveEl(e.target)) return;

    const frame = nearestFrame(e.target);
    if (!frame) return;
    if (core.item(frame.itemId).mode.type === "readonly") return;

    document.documentElement.dataset.dragState = "pending";
    state.value = {
      type: "pending",
      itemId: frame.itemId,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
    };
  };

  const onPointerMove = (e: PointerEvent): void => {
    const s = state.value;

    if (s.type === "pending" && e.pointerId === s.pointerId) {
      const dx = e.clientX - s.startX;
      const dy = e.clientY - s.startY;
      if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;

      const frameEl = document.querySelector<HTMLElement>(
        `.ui-frame[data-id="${CSS.escape(s.itemId)}"]`,
      );
      if (!frameEl) {
        state.value = { type: "idle" };
        return;
      }
      activate(s.itemId, frameEl, e.clientX, e.clientY);
      return;
    }

    if (s.type === "active") {
      const drop = resolveDropTarget(
        core,
        e.clientX,
        e.clientY,
        s.itemId,
        activeSourceEl!,
      );
      state.value = { ...s, drop };
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    const s = state.value;
    if (s.type === "pending" && e.pointerId === s.pointerId) {
      delete document.documentElement.dataset.dragState;
      state.value = { type: "idle" };
    } else if (s.type === "active") {
      commitDrop(s);
    }
  };

  const onPointerCancel = (e: PointerEvent): void => {
    const s = state.value;
    if (s.type === "active" || (s.type === "pending" && e.pointerId === s.pointerId))
      cancel();
  };

  window.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerCancel);

  return {
    state,
    dispose() {
      cancel();
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    },
  };
}

export function buildDropIndicator(dragState: Signal<DragState>): Component {
  const indicator = el("div", "ui-drop-indicator");
  let prevSlotEl: HTMLElement | null = null;

  const stopEffect = effect(() => {
    prevSlotEl?.classList.remove("is-drop-target");
    prevSlotEl = null;

    const s = dragState.value;

    if (s.type !== "active" || !s.drop) {
      indicator.hidden = true;
      return;
    }

    if (s.drop.type === "slot") {
      indicator.hidden = true;
      s.drop.anchorEl.classList.add("is-drop-target");
      prevSlotEl = s.drop.anchorEl;
      return;
    }

    const { anchorEl, side, axis } = s.drop;
    const rect = anchorEl.getBoundingClientRect();

    indicator.hidden = false;
    indicator.dataset.side = side;
    indicator.dataset.axis = axis;

    if (axis === "horizontal") {
      indicator.style.left = `${side === "before" ? rect.left : rect.right}px`;
      indicator.style.top = `${rect.top}px`;
      indicator.style.height = `${rect.height}px`;
      indicator.style.width = "";
    } else {
      indicator.style.top = `${side === "before" ? rect.top : rect.bottom}px`;
      indicator.style.left = `${rect.left}px`;
      indicator.style.width = `${rect.width}px`;
      indicator.style.height = "";
    }
  });

  return {
    el: indicator,
    dispose() {
      prevSlotEl?.classList.remove("is-drop-target");
      stopEffect();
    },
  };
}
