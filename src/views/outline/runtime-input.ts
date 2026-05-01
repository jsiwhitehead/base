import type { Signal } from "@preact/signals-core";

import {
  CONTENT_TEXT_TARGET,
  parseGlobalKeyIntent,
  type Core,
  type NodeId,
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
  deleteMultiNodeRange,
  deleteSingleNodeRange,
  readSelectionText,
} from "./commands";
import { isHorizontalEditingBoundary } from "./editing-structural";
import {
  extendBlockSelectionByArrow,
  isPlainValueNode,
  textLengthForTarget,
  valueToText,
  type OutlineStop,
} from "./navigation";
import {
  domPositionToModel,
  NODE_SELECTOR,
  nodeSelectorById,
  modelPositionToDom,
  valueCaretOffset,
  VALUE_SELECTOR,
} from "./dom-mapping";
import {
  handleArrowHorizontal,
  handleVerticalArrowIntent,
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
  rootId: NodeId;
  portals: readonly NodeId[];
  root: HTMLElement;
  stops: Signal<readonly OutlineStop[]>;
  applyEditingResult: ApplyEditingResult;
  setCursorAndScrollIntoView: (nodeId: NodeId, offset: number) => void;
  discardPendingMutationRecords: () => void;
  suppressMutationSync: SuppressionFlag<boolean>;
  suppressHistoryKeydown: SuppressionFlag<"undo" | "redo" | null>;
};

function deleteSelection(
  ctx: InputCtx,
  start: { nodeId: NodeId; offset: number },
  end: { nodeId: NodeId; offset: number },
): void {
  if (
    deleteSingleNodeRange(
      ctx.core,
      ctx.portals,
      start,
      end,
      ctx.setCursorAndScrollIntoView,
    )
  ) {
    return;
  }
  deleteMultiNodeRange(
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

      const nodeEl = valueEl.closest<HTMLElement>(NODE_SELECTOR);
      const nodeId = nodeEl?.dataset.id as NodeId | undefined;
      if (!nodeId) continue;

      const snap = core.node(nodeId);
      if (!isPlainValueNode(snap)) continue;

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
      core.commit((t) => t.setValue(nodeId, newText));
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
  setCursorAndScrollIntoView: (nodeId: NodeId, offset: number) => void;
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
  rootId: NodeId;
  portals: readonly NodeId[];
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
    clearValueRangeSelectedNodes,
    setValueSelectionRangeState,
  } = selection;

  const setCursorAndScrollIntoView = (nodeId: NodeId, offset: number): void => {
    discardPendingMutationRecords();
    const pos = modelPositionToDom(root, nodeId, offset);
    if (pos) {
      suppressSelectionSync.suppressForTurn(true);
      setDomCaret(pos);
      setValueSelectionRangeState({ collapsed: true });
    }
    const nodeEl = root.querySelector<HTMLElement>(nodeSelectorById(nodeId));
    const valueEl = nodeEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
    valueEl?.scrollIntoView({ block: "nearest" });
  };

  const applyEditingResultInner = (
    args: Parameters<ApplyEditingResult>[0],
  ): void => {
    const { location, target, caret, scrollIntoView } = args;
    if (target !== CONTENT_TEXT_TARGET || caret !== undefined) {
      clearValueRangeSelectedNodes();
    }
    core.focus(
      { type: "editing", location, target },
      caret !== undefined ? { caret } : undefined,
    );
    if (target !== CONTENT_TEXT_TARGET || !scrollIntoView) return;
    const run = (): void => {
      setCursorAndScrollIntoView(location.node, scrollIntoView.offset);
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
    startNodeId?: NodeId;
    endNodeId?: NodeId;
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
  rootId: NodeId;
  portals: readonly NodeId[];
  inputCtx: InputCtx;
  applyNavigationEditingResult: ApplyEditingResult;
  getCompositionEndedAt: () => number;
  getStickyCaretX: () => number | null;
  setStickyCaretX: (next: number) => void;
  resetStickyCaretX: () => void;
  setValueSelectionRangeState: (args: {
    collapsed: boolean;
    startNodeId?: NodeId;
    endNodeId?: NodeId;
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
      if (sel.type === "node") {
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
          core.focus({ type: "node", anchor: sel.anchor, head: next });
          return;
        }
      }
      const globalIntent = parseGlobalKeyIntent({
        key: e.key,
        ctrlKey: !!e.ctrlKey,
        metaKey: !!e.metaKey,
        altKey: !!e.altKey,
        shiftKey: !!e.shiftKey,
      });
      if (globalIntent?.type === "LABEL") {
        e.preventDefault();
        core.dispatch(globalIntent);
        return;
      }
      if (globalIntent?.type === "INSERT") {
        e.preventDefault();
        e.stopPropagation();
        core.dispatch(globalIntent);
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

        const seen = new Set<NodeId>();
        let firstNodeId: NodeId | undefined;
        let lastNodeId: NodeId | undefined;
        for (const stop of inputCtx.stops.value) {
          if (stop.type !== "editing" || stop.target !== CONTENT_TEXT_TARGET) {
            continue;
          }
          const nodeId = stop.location.node;
          if (seen.has(nodeId)) continue;
          seen.add(nodeId);
          if (!firstNodeId) firstNodeId = nodeId;
          lastNodeId = nodeId;
        }
        if (!firstNodeId || !lastNodeId) return;

        e.preventDefault();
        setValueSelectionRangeState({
          collapsed: false,
          startNodeId: firstNodeId,
          endNodeId: lastNodeId,
        });
        core.focus({
          type: "editing",
          location: { node: lastNodeId, portals },
          target: CONTENT_TEXT_TARGET,
        });

        const anchorDom = modelPositionToDom(root, firstNodeId, 0);
        const focusDom = modelPositionToDom(
          root,
          lastNodeId,
          textLengthForTarget(core, lastNodeId, CONTENT_TEXT_TARGET),
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
        const dir = e.key === "ArrowLeft" ? "left" : "right";
        if (isHorizontalEditingBoundary(core, root, dir)) {
          e.preventDefault();
          resetStickyCaretX();
          core.dispatch({ type: "NAV", dir });
          return;
        }
        const moveDir =
          e.key === "ArrowLeft" ? "backward" : ("forward" as const);
        if (
          handleArrowHorizontal(
            core,
            root,
            inputCtx.stops.value,
            resetStickyCaretX,
            applyNavigationEditingResult,
            e,
            moveDir,
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
          handleVerticalArrowIntent(
            core,
            root,
            inputCtx.stops.value,
            getStickyCaretX,
            setStickyCaretX,
            resetStickyCaretX,
            applyNavigationEditingResult,
            e,
            dir,
          )
        ) {
          return;
        }
      }
      if (e.key === "Tab") {
        const modelSel = core.selection();
        if (modelSel.type !== "editing") return;
        const caretOffset = valueCaretOffset(root, modelSel.location.node) ?? 0;
        resetStickyCaretX();
        inputCtx.suppressMutationSync.suppressForTurn(true);
        e.preventDefault();
        e.stopPropagation();
        onValueTab(modelSel.location, e.shiftKey, caretOffset);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        core.dispatch({ type: "NAV", dir: "out" });
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
