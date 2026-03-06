import type { Location, Intent, ItemId, Selection } from "../core";
import {
  applyTypeToPrimaryTarget,
  connTarget,
  editTargetsForItem,
  getTextForTarget,
  primaryEditTarget,
} from "../core";
import type { UiCore } from "./runtime";

export type NavDirection = Extract<Intent, { type: "NAV" }>["dir"];

export function moveWithinItemEditTargets(
  core: UiCore,
  id: ItemId,
  fromTarget: string,
  dir: "backward" | "forward",
): { target: string; caret: number } | null {
  const targets = editTargetsForItem(core, id);
  const at = targets.indexOf(fromTarget);
  if (at < 0) return null;
  const nextIdx = dir === "backward" ? at - 1 : at + 1;
  const target = targets[nextIdx] ?? null;
  if (!target) return null;
  if (dir === "forward") return { target, caret: 0 };
  return { target, caret: getTextForTarget(core, id, target).length };
}

export function resolveFocusAfterRemove(
  core: UiCore,
  removedId: ItemId,
  prefer: "prev" | "next",
  portals: readonly ItemId[],
): Location | null {
  const loc = core.locate(removedId);
  if (!loc) return null;

  const prev = loc.siblings[loc.index - 1] ?? null;
  const next = loc.siblings[loc.index + 1] ?? null;
  const sibling =
    prefer === "prev" ? (prev ?? next ?? null) : (next ?? prev ?? null);
  if (sibling) {
    return { item: sibling, portals };
  }

  return { item: loc.parentId, portals };
}

export function handleItemIntent(args: {
  core: UiCore;
  sel: Extract<Selection, { type: "item" }>;
  intent: Extract<Intent, { type: "CONFIRM" | "TYPE" }>;
}): boolean {
  const { core, sel, intent } = args;

  const id = sel.head.item;
  const location: Location = sel.head;

  if (intent.type === "TYPE") {
    const item = core.item(id);
    const valueText =
      item.content.type === "value" ? String(item.content.value ?? "") : "";
    const isEmptyPlainValue =
      item.content.type === "value" && valueText.trim() === "";
    const isEmptyPlainGroup =
      item.content.type === "group" && item.content.children.length === 0;

    if (
      intent.char === "=" &&
      item.mode.type === "plain" &&
      (isEmptyPlainValue || isEmptyPlainGroup)
    ) {
      core.commit((t) => t.setConnected(id, { type: "formula", expr: "" }));
      core.focus(
        { type: "editing", location: location, target: connTarget("expr") },
        { caret: 0 },
      );
      return true;
    }

    const applied = applyTypeToPrimaryTarget(core, id, intent.char);
    if (!applied) return false;
    core.focus(
      { type: "editing", location: location, target: applied.target },
      { caret: applied.caret },
    );
    return true;
  }

  const target = primaryEditTarget(core, id);
  if (!target) return false;

  const text = getTextForTarget(core, id, target);
  const caretPos = text.length;
  core.focus(
    { type: "editing", location: location, target },
    { caret: caretPos },
  );
  return true;
}
