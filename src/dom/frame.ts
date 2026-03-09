import { computed } from "@preact/signals-core";

import type { Location, ViewName } from "../core";
import { ITEM_TARGET, isNumericLikeValue, sameLocation } from "../core";

import { resolveEventTargetElement } from "./component";
import type { Ctx } from "./component";
import type { UiCore } from "./runtime";

export function bindItemFrame(
  ctx: Ctx,
  spec: { core: UiCore; location: Location; isItemSelected?: () => boolean },
  frameEl: HTMLElement,
): void {
  frameEl.classList.add("ui-frame");
  frameEl.dataset.id = spec.location.item;
  if (!frameEl.hasAttribute("tabindex")) frameEl.tabIndex = -1;

  const isItemSelected = computed(() => {
    const overrideSelected = spec.isItemSelected?.();
    if (overrideSelected !== undefined) return overrideSelected;
    const sel = spec.core.selection();
    if (sel.type === "item") {
      return (
        sameLocation(sel.anchor, spec.location) ||
        sameLocation(sel.head, spec.location)
      );
    }
    return false;
  });

  const isEditingOnItem = computed(() => {
    const sel = spec.core.selection();
    if (sel.type !== "editing") return false;
    return sameLocation(sel.location, spec.location);
  });
  const isSelected = computed(() => {
    return isItemSelected.value || isEditingOnItem.value;
  });

  const isIssue = computed(() => {
    return spec.core.item(spec.location.item).content.type === "issue";
  });

  const isNumeric = computed(() => {
    const content = spec.core.item(spec.location.item).content;
    return content.type === "value" && isNumericLikeValue(content.value);
  });
  const isEditingTarget = (node: Element | null): boolean => {
    const target = node?.closest<HTMLElement>("[data-target]");
    return !!(
      target?.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    );
  };
  const isInNestedContentEditable = (node: Element | null): boolean => {
    const host = node?.closest<HTMLElement>("[contenteditable='true']");
    return !!(host && host !== frameEl && frameEl.contains(host));
  };

  ctx.on(frameEl, "pointerdown", (e: PointerEvent) => {
    if (e.defaultPrevented) return;
    if ((e.button ?? 0) !== 0) return;
    const targetEl = resolveEventTargetElement(e.target);
    if (isInNestedContentEditable(targetEl) || isEditingTarget(targetEl)) {
      e.stopPropagation();
      return;
    }

    if (targetEl === frameEl) {
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const start = sel.getRangeAt(0).startContainer;
        const startEl = start instanceof Element ? start : start.parentElement;
        if (startEl && frameEl.contains(startEl) && isEditingTarget(startEl)) {
          e.stopPropagation();
          return;
        }
      }
    }
    spec.core.focus({ type: "item", location: spec.location });
    e.stopPropagation();
  });
  ctx.target(spec.location, ITEM_TARGET, () => frameEl);

  ctx.effect(() => {
    frameEl.classList.toggle("is-selected", isSelected.value);
    frameEl.classList.toggle("is-item-selected", isItemSelected.value);
    frameEl.classList.toggle("is-issue", isIssue.value);
    frameEl.classList.toggle("is-numeric", isNumeric.value);
  });
}

export function setBodyClasses(root: HTMLElement, view: ViewName): void {
  root.classList.add("ui-body", `ui-${String(view)}`);
  delete root.dataset.drag;
}
