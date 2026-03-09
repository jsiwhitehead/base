import { CONTENT_TEXT_TARGET, type Core, type ItemId } from "../../core";
import {
  getDomRangeInRoot,
  getMappedRange,
  getSurfaceFromNodeInRoot,
  renderPlainTextToContentEditable,
} from "../../dom";
import type { Ctx } from "../../dom";

import {
  deleteMultiItemRange,
  deleteSingleItemRange,
  outlineCmd,
} from "./commands";
import {
  isPlainValueItem,
  moveStop,
  valueToText,
  type ModelPosition,
} from "./navigation";
import {
  domPositionToModel,
  itemSelectorById,
  VALUE_SELECTOR,
} from "./dom-mapping";
import { applyStopMove } from "./runtime-navigation";
import type { InputCtx } from "./runtime-input";

function deleteSelection(
  ctx: InputCtx,
  start: ModelPosition,
  end: ModelPosition,
): void {
  if (
    deleteSingleItemRange(
      ctx.core,
      ctx.portals,
      start,
      end,
      ctx.setCursorAndScrollIntoView,
    )
  ) {
    return;
  }
  deleteMultiItemRange(
    ctx.core,
    ctx.portals,
    start,
    end,
    ctx.setCursorAndScrollIntoView,
  );
}

function handleHistoryBeforeInput(
  ctx: InputCtx,
  e: InputEvent,
  kind: "undo" | "redo",
): void {
  e.preventDefault();
  ctx.suppressHistoryKeydown.suppressForTurn(kind);
  if (kind === "undo") ctx.core.undo();
  else ctx.core.redo();
}

function handleInsertLineBreakBeforeInput(
  ctx: InputCtx,
  e: InputEvent,
  range: AbstractRange,
): void {
  e.preventDefault();
  const rangePos = getMappedRange(range, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return;
  if (rangePos.start.itemId !== rangePos.end.itemId) return;
  const snap = ctx.core.item(rangePos.start.itemId);
  if (!isPlainValueItem(snap)) return;

  const text = valueToText(snap.content.value);
  const start = rangePos.start.offset;
  const end = rangePos.end.offset;
  const nextText = text.slice(0, start) + "\n" + text.slice(end);
  const nextCaret = start + 1;
  ctx.core.commit((t) => t.setValue(rangePos.start.itemId, nextText));
  ctx.applyEditingResult({
    location: { item: rangePos.start.itemId, portals: ctx.portals },
    target: CONTENT_TEXT_TARGET,
    caret: nextCaret,
    scrollIntoView: { offset: nextCaret },
  });
}

function handleInsertParagraphBeforeInput(
  ctx: InputCtx,
  e: InputEvent,
  range: AbstractRange,
): void {
  e.preventDefault();
  const rangePos = getMappedRange(range, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return;
  if (ctx.core.selection().type !== "editing") return;

  const caretStart = rangePos.start.offset;
  let caretEnd = caretStart;
  const multiItem =
    !range.collapsed && rangePos.start.itemId !== rangePos.end.itemId;
  if (multiItem) {
    ctx.suppressMutationSync.suppressForTurn(true);
    if (
      !deleteMultiItemRange(
        ctx.core,
        ctx.portals,
        rangePos.start,
        rangePos.end,
        ctx.setCursorAndScrollIntoView,
      )
    ) {
      return;
    }
  } else if (!range.collapsed) {
    caretEnd = rangePos.end.offset;
  }

  const splitLoc = { item: rangePos.start.itemId, portals: ctx.portals };
  const newId = outlineCmd.splitAt(ctx.core, splitLoc, caretStart, caretEnd);
  if (!newId) return;
  ctx.applyEditingResult({
    location: { item: newId, portals: ctx.portals },
    target: CONTENT_TEXT_TARGET,
    caret: 0,
    scrollIntoView: { offset: 0, defer: false },
  });
}

function handleDeleteBeforeInput(
  ctx: InputCtx,
  e: InputEvent,
  targetRange: StaticRange,
): boolean {
  const rangePos = getMappedRange(targetRange, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return false;
  const startPos = rangePos.start;
  const endPos = rangePos.end;
  if (startPos.itemId !== endPos.itemId) return false;
  if (startPos.offset === endPos.offset) return false;

  e.preventDefault();
  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return true;
  const text = valueToText(snap.content.value);
  const nextText = text.slice(0, startPos.offset) + text.slice(endPos.offset);

  ctx.core.commit((t) => t.setValue(startPos.itemId, nextText));

  const itemEl = ctx.root.querySelector<HTMLElement>(
    itemSelectorById(startPos.itemId),
  );
  const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (valueEl) {
    ctx.discardPendingMutationRecords();
    renderPlainTextToContentEditable(valueEl, nextText);
  }
  ctx.applyEditingResult({
    location: { item: startPos.itemId, portals: ctx.portals },
    target: CONTENT_TEXT_TARGET,
    caret: startPos.offset,
    scrollIntoView: { offset: startPos.offset, defer: false },
  });
  return true;
}

function handleBoundaryDeleteBeforeInput(
  ctx: InputCtx,
  e: InputEvent,
  dir: "backward" | "forward",
  range: Range,
): void {
  if (range.collapsed) {
    const pos = domPositionToModel(
      ctx.root,
      range.startContainer,
      range.startOffset,
    );
    if (!pos) return;
    const snap = ctx.core.item(pos.itemId);
    const text =
      snap.content.type === "value" ? valueToText(snap.content.value) : "";
    const atBoundary =
      dir === "backward" ? pos.offset === 0 : pos.offset === text.length;
    if (!atBoundary) return;
    e.preventDefault();
    const modelSel = ctx.core.selection();
    if (modelSel.type !== "editing") return;
    if (
      modelSel.target === CONTENT_TEXT_TARGET &&
      snap.mode.type === "plain" &&
      snap.content.type === "value" &&
      text.length === 0
    ) {
      const nextStop = moveStop(
        ctx.stops.value,
        {
          type: "editing",
          location: modelSel.location,
          target: modelSel.target,
        },
        dir,
      );
      ctx.suppressMutationSync.suppressForTurn(true);
      outlineCmd.removeAndPruneAncestors(ctx.core, ctx.rootId, pos.itemId);
      if (!nextStop) return;
      applyStopMove(ctx.core, ctx.applyEditingResult, nextStop);
      return;
    }
    const adjacentStop = moveStop(
      ctx.stops.value,
      {
        type: "editing",
        location: modelSel.location,
        target: modelSel.target,
      },
      dir,
    );
    if (
      !adjacentStop ||
      adjacentStop.stop.type !== "editing" ||
      adjacentStop.stop.target !== CONTENT_TEXT_TARGET
    ) {
      return;
    }
    const joined = outlineCmd.joinValues(
      ctx.core,
      ctx.rootId,
      dir === "backward"
        ? adjacentStop.stop.location.item
        : modelSel.location.item,
      dir === "backward"
        ? modelSel.location.item
        : adjacentStop.stop.location.item,
    );
    if (!joined) return;
    ctx.applyEditingResult({
      location: { item: joined.id, portals: ctx.portals },
      target: CONTENT_TEXT_TARGET,
      caret: joined.caret,
      scrollIntoView: { offset: joined.caret },
    });
    return;
  }

  const rangePos = getMappedRange(range, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return;
  if (
    !deleteMultiItemRange(
      ctx.core,
      ctx.portals,
      rangePos.start,
      rangePos.end,
      ctx.setCursorAndScrollIntoView,
    )
  ) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
}

function handleInsertReplacementTextBeforeInput(
  ctx: InputCtx,
  e: InputEvent,
): void {
  e.preventDefault();
  const replacementText = e.data ?? "";
  const fallback = () => insertText(ctx, replacementText);
  const targetRange = e.getTargetRanges()[0];
  if (!targetRange) return fallback();

  const rangePos = getMappedRange(targetRange, (point) =>
    domPositionToModel(ctx.root, point.node, point.offset),
  );
  if (!rangePos) return fallback();
  const startPos = rangePos.start;
  const endPos = rangePos.end;
  if (startPos.itemId !== endPos.itemId) return fallback();

  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return fallback();

  const currentText = valueToText(snap.content.value);
  const nextCaret = startPos.offset + replacementText.length;
  const nextText =
    currentText.slice(0, startPos.offset) +
    replacementText +
    currentText.slice(endPos.offset);
  ctx.core.commit((t) => t.setValue(startPos.itemId, nextText));

  const valueEl = ctx.root
    .querySelector<HTMLElement>(itemSelectorById(startPos.itemId))
    ?.querySelector<HTMLElement>(VALUE_SELECTOR);
  if (valueEl) {
    ctx.discardPendingMutationRecords();
    renderPlainTextToContentEditable(valueEl, nextText);
  }
  ctx.applyEditingResult({
    location: { item: startPos.itemId, portals: ctx.portals },
    target: CONTENT_TEXT_TARGET,
    caret: nextCaret,
    scrollIntoView: { offset: nextCaret, defer: false },
  });
}

export function insertText(
  ctx: InputCtx,
  text: string,
  range: AbstractRange | null = null,
): void {
  if (!text) return;
  const modelSel = ctx.core.selection();
  if (modelSel.type !== "editing") return;
  const editRange = range ?? getDomRangeInRoot(ctx.root);
  if (!editRange) return;
  const startValueEl = getSurfaceFromNodeInRoot(
    ctx.root,
    editRange.startContainer,
    VALUE_SELECTOR,
  );
  const startPos = domPositionToModel(
    ctx.root,
    editRange.startContainer,
    editRange.startOffset,
  );
  if (!startPos) return;
  if (!editRange.collapsed) {
    const endPos = domPositionToModel(
      ctx.root,
      editRange.endContainer,
      editRange.endOffset,
    );
    if (!endPos) return;
    deleteSelection(ctx, startPos, endPos);
  }
  const snap = ctx.core.item(startPos.itemId);
  if (!isPlainValueItem(snap)) return;
  const current = valueToText(snap.content.value);
  const caretStart = startPos.offset;
  const before = current.slice(0, caretStart);
  const after = current.slice(caretStart);
  const syncStartValueSurface = (): void => {
    if (!startValueEl) return;
    const startSnap = ctx.core.item(startPos.itemId);
    if (!isPlainValueItem(startSnap)) return;
    ctx.discardPendingMutationRecords();
    renderPlainTextToContentEditable(
      startValueEl,
      valueToText(startSnap.content.value),
    );
  };
  const applyValueEditingResult = (itemId: ItemId, caret: number): void => {
    ctx.applyEditingResult({
      location: { item: itemId, portals: ctx.portals },
      target: CONTENT_TEXT_TARGET,
      caret,
      scrollIntoView: { offset: caret, defer: false },
    });
  };

  const lines = text.split("\n");
  const loc = ctx.core.locate(startPos.itemId);
  if (!loc) {
    const nextText = before + text + after;
    const nextCaret = before.length + text.length;
    ctx.core.commit((t) => t.setValue(startPos.itemId, nextText));
    syncStartValueSurface();
    applyValueEditingResult(startPos.itemId, nextCaret);
    return;
  }
  const insertedIds: ItemId[] = [];
  ctx.core.commit((t) => {
    t.setValue(
      startPos.itemId,
      before + (lines[0] ?? "") + (lines.length === 1 ? after : ""),
    );
    for (let i = 1; i < lines.length; i += 1) {
      const newId = t.insertChild(loc.parentId, { at: loc.index + i });
      t.setValue(
        newId,
        (lines[i] ?? "") + (i === lines.length - 1 ? after : ""),
      );
      insertedIds.push(newId);
    }
  });
  syncStartValueSurface();
  const lastId = insertedIds[insertedIds.length - 1] ?? startPos.itemId;
  const lastOffset =
    lastId === startPos.itemId
      ? before.length + (lines[0]?.length ?? 0)
      : (lines[lines.length - 1]?.length ?? 0);
  applyValueEditingResult(lastId, lastOffset);
}

function resolveBeforeInputRange(
  root: HTMLElement,
  e: InputEvent,
): AbstractRange | null {
  const targetRange = e.getTargetRanges()[0];
  if (
    targetRange &&
    root.contains(targetRange.startContainer) &&
    root.contains(targetRange.endContainer)
  ) {
    return targetRange;
  }
  return getDomRangeInRoot(root);
}

export function bindOutlineBeforeInputEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  core: Core;
  inputCtx: InputCtx;
}): void {
  const { on, root, gated, core, inputCtx } = args;

  on(
    root,
    "beforeinput",
    gated((e: InputEvent): void => {
      if (e.isComposing) return;
      switch (e.inputType) {
        case "historyUndo": {
          handleHistoryBeforeInput(inputCtx, e, "undo");
          break;
        }
        case "historyRedo": {
          handleHistoryBeforeInput(inputCtx, e, "redo");
          break;
        }
        case "insertText": {
          if (!e.data) break;
          const range = resolveBeforeInputRange(root, e);
          if (!range) break;
          const pos = domPositionToModel(
            root,
            range.startContainer,
            range.startOffset,
          );
          if (!pos) break;
          const snap = core.item(pos.itemId);
          if (
            snap.content.type === "group" &&
            snap.content.children.length > 0
          ) {
            e.preventDefault();
            break;
          }
          e.preventDefault();
          insertText(inputCtx, e.data, range);
          break;
        }
        case "insertParagraph": {
          const range = resolveBeforeInputRange(root, e);
          if (!range) break;
          handleInsertParagraphBeforeInput(inputCtx, e, range);
          break;
        }
        case "insertLineBreak": {
          const range = resolveBeforeInputRange(root, e);
          if (!range) break;
          handleInsertLineBreakBeforeInput(inputCtx, e, range);
          break;
        }
        case "deleteContentBackward":
        case "deleteContentForward":
        case "deleteWordBackward":
        case "deleteWordForward":
        case "deleteHardLineBackward":
        case "deleteHardLineForward":
        case "deleteSoftLineBackward":
        case "deleteSoftLineForward": {
          const dir = e.inputType.includes("Backward") ? "backward" : "forward";
          const targetRange = e.getTargetRanges()[0];
          if (
            targetRange &&
            handleDeleteBeforeInput(inputCtx, e, targetRange)
          ) {
            break;
          }
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleBoundaryDeleteBeforeInput(inputCtx, e, dir, range);
          break;
        }
        case "insertFromPaste":
          e.preventDefault();
          break;
        case "insertFromDrop":
          e.preventDefault();
          break;
        case "deleteByDrag":
          e.preventDefault();
          break;
        case "insertReplacementText":
          handleInsertReplacementTextBeforeInput(inputCtx, e);
          break;
        default:
          e.preventDefault();
          return;
      }
    }),
  );
}
