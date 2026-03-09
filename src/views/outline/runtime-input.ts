import type { Signal } from "@preact/signals-core";

import {
  CONTENT_TEXT_TARGET,
  parseKeyIntent,
  type Core,
  type ItemId,
  type Location,
} from "../../core";
import {
  getMappedSelectionRangeInRoot,
  getPlainTextFromDataTransfer,
  getSurfaceFromNodeInRoot,
  getTextNodeFromMutationRecord,
  readPlainTextFromContentEditable,
  setDomCaret,
  setDomSelectionRange,
  writePlainTextClipboard,
} from "../../dom";
import type { Ctx, SuppressionFlag, UiCore } from "../../dom";

import {
  deleteMultiItemRange,
  deleteSingleItemRange,
  removeBlockSelection,
  outlineCmd,
  readSelectionText,
} from "./commands";
import {
  extendBlockSelectionByArrow,
  isPlainValueItem,
  textLengthForTarget,
  valueToText,
  type OutlineStop,
} from "./navigation";
import {
  domPositionToModel,
  ITEM_SELECTOR,
  itemSelectorById,
  modelPositionToDom,
  valueCaretOffset,
  VALUE_SELECTOR,
} from "./dom-mapping";
import {
  handleArrowHorizontal,
  handleArrowVertical,
  type ApplyEditingResult,
} from "./runtime-navigation";
import {
  bindOutlineBeforeInputEvents,
  insertText,
} from "./runtime-beforeinput";
import type { OutlineSelectionEditingControls } from "./runtime-selection";
import { isOutlineValueEditEvent } from "./runtime-selection";

export type InputCtx = {
  core: Core;
  rootId: ItemId;
  portals: readonly ItemId[];
  root: HTMLElement;
  stops: Signal<readonly OutlineStop[]>;
  applyEditingResult: ApplyEditingResult;
  setCursorAndScrollIntoView: (itemId: ItemId, offset: number) => void;
  discardPendingMutationRecords: () => void;
  suppressMutationSync: SuppressionFlag<boolean>;
  suppressHistoryKeydown: SuppressionFlag<"undo" | "redo" | null>;
};

function deleteSelection(
  ctx: InputCtx,
  start: { itemId: ItemId; offset: number },
  end: { itemId: ItemId; offset: number },
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

export function createOutlineMutationSync(args: {
  core: UiCore;
  root: HTMLElement;
  suppressMutationSync: SuppressionFlag<boolean>;
  isComposing: () => boolean;
}): {
  discardPendingMutationRecords: () => void;
  bind: (effect: Ctx["effect"]) => void;
} {
  const { core, root, suppressMutationSync, isComposing } = args;
  const observer = new MutationObserver((mutations) => {
    if (suppressMutationSync.get() || isComposing()) return;
    for (const mutation of mutations) {
      const textNode = getTextNodeFromMutationRecord(mutation);
      const valueEl =
        (textNode
          ? getSurfaceFromNodeInRoot(root, textNode, VALUE_SELECTOR)
          : null) ??
        getSurfaceFromNodeInRoot(root, mutation.target, VALUE_SELECTOR);
      if (!valueEl) continue;
      if (textNode && !valueEl.contains(textNode)) continue;

      const itemEl = valueEl.closest<HTMLElement>(ITEM_SELECTOR);
      const itemId = itemEl?.dataset.id as ItemId | undefined;
      if (!itemId) continue;

      const snap = core.item(itemId);
      if (!isPlainValueItem(snap)) continue;

      if (
        mutation.type === "childList" &&
        valueEl.childNodes.length === 1 &&
        valueEl.firstChild instanceof HTMLBRElement
      ) {
        continue;
      }
      if (
        mutation.type === "characterData" &&
        mutation.oldValue != null &&
        mutation.target instanceof Text &&
        mutation.target.data === mutation.oldValue
      ) {
        continue;
      }
      const newText = readPlainTextFromContentEditable(valueEl);
      if (valueToText(snap.content.value) === newText) continue;
      core.commit((t) => t.setValue(itemId, newText));
    }
  });

  return {
    discardPendingMutationRecords: (): void => {
      observer.takeRecords();
    },
    bind: (effect): void => {
      effect(() => {
        observer.observe(root, {
          characterData: true,
          characterDataOldValue: true,
          childList: true,
          subtree: true,
        });
        return () => {
          observer.disconnect();
        };
      });
    },
  };
}

export type OutlineInputRuntime = {
  setCursorAndScrollIntoView: (itemId: ItemId, offset: number) => void;
  applyEditingResult: ApplyEditingResult;
  applyNavigationEditingResult: ApplyEditingResult;
  bind: (args: {
    on: Ctx["on"];
    getCompositionEndedAt: () => number;
    setCompositionEndedAt: (next: number) => void;
    getStickyCaretX: () => number | null;
    setStickyCaretX: (next: number) => void;
    resetStickyCaretX: () => void;
    onValueTab: (location: Location, shift: boolean, caret: number) => void;
    setIsComposing: (next: boolean) => void;
  }) => void;
};

export function createOutlineInputRuntime(args: {
  core: UiCore;
  rootId: ItemId;
  portals: readonly ItemId[];
  root: HTMLElement;
  stops: Signal<readonly OutlineStop[]>;
  resetStickyCaretX: () => void;
  discardPendingMutationRecords: () => void;
  suppressMutationSync: SuppressionFlag<boolean>;
  suppressHistoryKeydown: SuppressionFlag<"undo" | "redo" | null>;
  selection: OutlineSelectionEditingControls;
}): OutlineInputRuntime {
  const {
    core,
    rootId,
    portals,
    root,
    stops,
    resetStickyCaretX,
    discardPendingMutationRecords,
    suppressMutationSync,
    suppressHistoryKeydown,
    selection,
  } = args;
  const {
    suppressSelectionSync,
    clearValueRangeSelectedItems,
    setValueSelectionRangeState,
  } = selection;

  const setCursorAndScrollIntoView = (itemId: ItemId, offset: number): void => {
    discardPendingMutationRecords();
    const pos = modelPositionToDom(root, itemId, offset);
    if (pos) {
      suppressSelectionSync.suppressForTurn(true);
      setDomCaret(pos);
      setValueSelectionRangeState({ collapsed: true });
    }
    const itemEl = root.querySelector<HTMLElement>(itemSelectorById(itemId));
    const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
    valueEl?.scrollIntoView({ block: "nearest" });
  };

  const applyEditingResultInner = (
    args: Parameters<ApplyEditingResult>[0],
  ): void => {
    const { location, target, caret, scrollIntoView } = args;
    if (target !== CONTENT_TEXT_TARGET || caret !== undefined) {
      clearValueRangeSelectedItems();
    }
    core.focus(
      { type: "editing", location, target },
      caret !== undefined ? { caret } : undefined,
    );
    if (target !== CONTENT_TEXT_TARGET || !scrollIntoView) return;
    const run = (): void => {
      setCursorAndScrollIntoView(location.item, scrollIntoView.offset);
    };
    if (scrollIntoView.defer === false) run();
    else queueMicrotask(run);
  };

  const applyEditingResult: ApplyEditingResult = (args): void => {
    resetStickyCaretX();
    applyEditingResultInner(args);
  };

  const applyNavigationEditingResult: ApplyEditingResult = (args): void => {
    applyEditingResultInner(args);
  };

  const inputCtx: InputCtx = {
    core,
    rootId,
    portals,
    root,
    stops,
    applyEditingResult,
    setCursorAndScrollIntoView,
    discardPendingMutationRecords,
    suppressMutationSync,
    suppressHistoryKeydown,
  };

  return {
    setCursorAndScrollIntoView,
    applyEditingResult,
    applyNavigationEditingResult,
    bind: ({
      on,
      getCompositionEndedAt,
      setCompositionEndedAt,
      getStickyCaretX,
      setStickyCaretX,
      resetStickyCaretX,
      onValueTab,
      setIsComposing,
    }): void => {
      bindOutlineBodyInputEvents({
        on,
        inputCtx,
        applyNavigationEditingResult,
        getCompositionEndedAt,
        setCompositionEndedAt,
        getStickyCaretX,
        setStickyCaretX,
        resetStickyCaretX,
        onValueTab,
        setIsComposing,
        setValueSelectionRangeState,
        suppressSelectionSync,
      });
    },
  };
}

export function bindOutlineBodyInputEvents(args: {
  on: Ctx["on"];
  inputCtx: InputCtx;
  applyNavigationEditingResult: ApplyEditingResult;
  getCompositionEndedAt: () => number;
  setCompositionEndedAt: (next: number) => void;
  getStickyCaretX: () => number | null;
  setStickyCaretX: (next: number) => void;
  resetStickyCaretX: () => void;
  onValueTab: (location: Location, shift: boolean, caret: number) => void;
  setIsComposing: (next: boolean) => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startItemId?: ItemId;
    endItemId?: ItemId;
  }) => void;
  suppressSelectionSync: SuppressionFlag<boolean>;
}): void {
  const {
    on,
    applyNavigationEditingResult,
    getCompositionEndedAt,
    setCompositionEndedAt,
    getStickyCaretX,
    setStickyCaretX,
    resetStickyCaretX,
    inputCtx,
    onValueTab,
    setIsComposing,
    setValueSelectionRangeState,
    suppressSelectionSync,
  } = args;
  const { core, rootId, portals, root, discardPendingMutationRecords } =
    inputCtx;

  const gated =
    <E extends Event>(handler: (e: E) => void): ((e: E) => void) =>
    (e: E) => {
      if (!isOutlineValueEditEvent(e.target, root)) return;
      handler(e);
    };

  bindOutlineCompositionEvents({
    on,
    root,
    gated,
    setCompositionEndedAt,
    core,
    setIsComposing,
  });
  bindOutlineBeforeInputEvents({
    on,
    root,
    gated,
    core,
    inputCtx,
  });
  bindOutlineKeydownEvents({
    on,
    root,
    gated,
    core,
    rootId,
    portals,
    inputCtx,
    applyNavigationEditingResult,
    getCompositionEndedAt,
    getStickyCaretX,
    setStickyCaretX,
    resetStickyCaretX,
    setValueSelectionRangeState,
    suppressSelectionSync,
    discardPendingMutationRecords,
    onValueTab,
  });
  bindOutlineClipboardEvents({
    on,
    root,
    gated,
    core,
    inputCtx,
  });
}

function bindOutlineCompositionEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  setCompositionEndedAt: (next: number) => void;
  core: Core;
  setIsComposing: (next: boolean) => void;
}): void {
  const { on, root, gated, setCompositionEndedAt, core, setIsComposing } = args;

  on(
    root,
    "compositionstart",
    gated((_e: CompositionEvent): void => {
      setIsComposing(true);
      core.undoBoundary();
    }),
  );
  on(
    root,
    "compositionupdate",
    gated((_e: CompositionEvent): void => {
      setIsComposing(true);
    }),
  );
  on(
    root,
    "compositionend",
    gated((_e: CompositionEvent): void => {
      setIsComposing(false);
      setCompositionEndedAt(Date.now());
      core.undoBoundary();
    }),
  );
}

function bindOutlineKeydownEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  core: Core;
  rootId: ItemId;
  portals: readonly ItemId[];
  inputCtx: InputCtx;
  applyNavigationEditingResult: ApplyEditingResult;
  getCompositionEndedAt: () => number;
  getStickyCaretX: () => number | null;
  setStickyCaretX: (next: number) => void;
  resetStickyCaretX: () => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startItemId?: ItemId;
    endItemId?: ItemId;
  }) => void;
  suppressSelectionSync: SuppressionFlag<boolean>;
  discardPendingMutationRecords: () => void;
  onValueTab: (location: Location, shift: boolean, caret: number) => void;
}): void {
  const {
    on,
    root,
    gated,
    core,
    rootId,
    portals,
    inputCtx,
    applyNavigationEditingResult,
    getCompositionEndedAt,
    getStickyCaretX,
    setStickyCaretX,
    resetStickyCaretX,
    setValueSelectionRangeState,
    suppressSelectionSync,
    discardPendingMutationRecords,
    onValueTab,
  } = args;

  on(
    root,
    "keydown",
    gated((e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (e.key === "Enter" && Date.now() - getCompositionEndedAt() < 100) {
        e.preventDefault();
        return;
      }
      const sel = core.selection();
      if (sel.type === "item") {
        if (
          e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          (e.key === "ArrowUp" || e.key === "ArrowDown")
        ) {
          const next = extendBlockSelectionByArrow(
            core,
            rootId,
            sel,
            e.key === "ArrowUp" ? "up" : "down",
            portals,
          );
          if (!next) return;
          e.preventDefault();
          core.focus({ type: "item", anchor: sel.anchor, head: next });
          return;
        }
        if (
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          (e.key === "Backspace" || e.key === "Delete")
        ) {
          e.preventDefault();
          removeBlockSelection(core, rootId, sel, portals);
          return;
        }
      }
      const globalIntent = parseKeyIntent({
        key: e.key,
        ctrlKey: !!e.ctrlKey,
        metaKey: !!e.metaKey,
        altKey: !!e.altKey,
        shiftKey: !!e.shiftKey,
      });
      if (globalIntent?.type === "EDIT_LABEL") {
        e.preventDefault();
        core.dispatch(globalIntent);
        return;
      }
      if (globalIntent?.type === "INSERT") {
        e.preventDefault();
        e.stopPropagation();
        const modelSel = core.selection();
        if (modelSel.type !== "editing") return;
        const nextId = outlineCmd.insertForScope(
          core,
          rootId,
          modelSel.location,
          globalIntent.scope,
        );
        if (!nextId) return;
        inputCtx.suppressMutationSync.suppressForTurn(true);
        inputCtx.applyEditingResult({
          location: { item: nextId, portals },
          target: CONTENT_TEXT_TARGET,
          caret: 0,
          scrollIntoView: { offset: 0, defer: false },
        });
        return;
      }
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "a" && !e.altKey) {
        const modelSel = core.selection();
        if (
          modelSel.type !== "editing" ||
          modelSel.target !== CONTENT_TEXT_TARGET
        ) {
          return;
        }

        const seen = new Set<ItemId>();
        let firstItemId: ItemId | undefined;
        let lastItemId: ItemId | undefined;
        for (const stop of inputCtx.stops.value) {
          if (stop.type !== "editing" || stop.target !== CONTENT_TEXT_TARGET) {
            continue;
          }
          const itemId = stop.location.item;
          if (seen.has(itemId)) continue;
          seen.add(itemId);
          if (!firstItemId) firstItemId = itemId;
          lastItemId = itemId;
        }
        if (!firstItemId || !lastItemId) return;

        e.preventDefault();
        setValueSelectionRangeState({
          collapsed: false,
          startItemId: firstItemId,
          endItemId: lastItemId,
        });
        core.focus({
          type: "editing",
          location: { item: lastItemId, portals },
          target: CONTENT_TEXT_TARGET,
        });

        const anchorDom = modelPositionToDom(root, firstItemId, 0);
        const focusDom = modelPositionToDom(
          root,
          lastItemId,
          textLengthForTarget(core, lastItemId, CONTENT_TEXT_TARGET),
        );
        if (anchorDom && focusDom) {
          suppressSelectionSync.suppressForTurn(true);
          discardPendingMutationRecords();
          setDomSelectionRange(anchorDom, focusDom);
        }
        return;
      }
      if (isMod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (inputCtx.suppressHistoryKeydown.get() === "undo") {
          e.preventDefault();
          inputCtx.suppressHistoryKeydown.set(null);
          return;
        }
        e.preventDefault();
        core.undo();
        return;
      }
      if (
        isMod &&
        (e.key.toLowerCase() === "y" ||
          (e.key.toLowerCase() === "z" && e.shiftKey))
      ) {
        if (inputCtx.suppressHistoryKeydown.get() === "redo") {
          e.preventDefault();
          inputCtx.suppressHistoryKeydown.set(null);
          return;
        }
        e.preventDefault();
        core.redo();
        return;
      }
      if (
        (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
        !e.altKey &&
        !isMod
      ) {
        const dir = e.key === "ArrowLeft" ? "backward" : ("forward" as const);
        if (
          handleArrowHorizontal(
            core,
            root,
            inputCtx.stops.value,
            resetStickyCaretX,
            applyNavigationEditingResult,
            e,
            dir,
          )
        ) {
          return;
        }
      }
      if (
        (e.key === "ArrowUp" || e.key === "ArrowDown") &&
        !e.shiftKey &&
        !e.altKey &&
        !isMod
      ) {
        const dir = e.key === "ArrowUp" ? "up" : "down";
        if (
          handleArrowVertical(
            core,
            root,
            inputCtx.stops.value,
            getStickyCaretX,
            setStickyCaretX,
            applyNavigationEditingResult,
            e,
            dir,
          )
        ) {
          return;
        }
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        const modelSel = core.selection();
        if (modelSel.type !== "editing") return;
        const caretOffset = valueCaretOffset(root, modelSel.location.item) ?? 0;
        resetStickyCaretX();
        inputCtx.suppressMutationSync.suppressForTurn(true);
        onValueTab(modelSel.location, e.shiftKey, caretOffset);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        core.dispatch({ type: "NAV", dir: "out", mode: "step" });
      }
    }),
  );
}

function bindOutlineClipboardEvents(args: {
  on: Ctx["on"];
  root: HTMLElement;
  gated: <E extends Event>(handler: (e: E) => void) => (e: E) => void;
  core: Core;
  inputCtx: InputCtx;
}): void {
  const { on, root, gated, core, inputCtx } = args;

  const insertPlainTextFromTransfer = (
    e: ClipboardEvent | DragEvent,
    dt: DataTransfer | null | undefined,
  ): void => {
    const text = getPlainTextFromDataTransfer(dt);
    if (!text) return;
    e.preventDefault();
    core.undoBoundary();
    insertText(inputCtx, text);
    core.undoBoundary();
  };

  const canAcceptPlainTextDrop = (
    dt: DataTransfer | null | undefined,
  ): boolean => {
    if (!dt) return false;
    const types = Array.from(dt.types ?? []);
    return types.length === 0 || types.includes("text/plain");
  };

  on(root, "copy", (e: ClipboardEvent): void => {
    const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
      domPositionToModel(root, point.node, point.offset),
    );
    if (!rangeSel) return;
    const text = readSelectionText(core, rangeSel);
    if (text == null) {
      e.preventDefault();
      return;
    }
    if (!writePlainTextClipboard(e, text)) return;
    e.preventDefault();
  });

  on(root, "cut", (e: ClipboardEvent): void => {
    const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
      domPositionToModel(root, point.node, point.offset),
    );
    if (!rangeSel) return;
    const text = readSelectionText(core, rangeSel);
    if (text == null) {
      e.preventDefault();
      return;
    }
    if (!writePlainTextClipboard(e, text)) return;
    e.preventDefault();

    if (rangeSel.range.collapsed) return;
    core.undoBoundary();
    deleteSelection(inputCtx, rangeSel.start, rangeSel.end);
    core.undoBoundary();
  });

  on(
    root,
    "paste",
    gated((e: ClipboardEvent): void => {
      insertPlainTextFromTransfer(e, e.clipboardData);
    }),
  );

  on(
    root,
    "dragstart",
    gated((e: DragEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel || !e.dataTransfer) return;
      const text = readSelectionText(core, rangeSel);
      if (text == null) return;
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", text);
    }),
  );

  on(
    root,
    "dragover",
    gated((e: DragEvent): void => {
      if (!canAcceptPlainTextDrop(e.dataTransfer)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }),
  );

  on(
    root,
    "drop",
    gated((e: DragEvent): void => {
      insertPlainTextFromTransfer(e, e.dataTransfer);
    }),
  );
}
