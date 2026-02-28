import { computed, signal, type Signal } from "@preact/signals-core";

import type { Intent, ItemId, Location, Selection } from "../../core";
import {
  applyTypeToPrimaryTarget,
  isNumericLikeValue,
  LABEL_TARGET,
  patchConn,
  VALUE_TARGET,
} from "../../core";
import type { Component, UiCore } from "../../dom";
import {
  buildItemHeader,
  createComponent,
  defineView,
  el,
  getDomRangeInRoot,
  getMappedSelectionRangeInRoot,
  getMappedSelectionSnapshotInRoot,
  getPlainTextFromDataTransfer,
  getSurfaceFromNodeInRoot,
  getTextNodeFromMutationRecord,
  handleItemIntent,
  readPlainTextFromContentEditable,
  renderPlainTextToContentEditable,
  setBodyClasses,
  setDomCaret,
  setDomSelectionRange,
  writePlainTextClipboard,
} from "../../dom";
import {
  blockSelectionFocuses,
  blockSelectionItems,
  childrenOf,
  collectEditPoints,
  deleteBlockSelection,
  deleteMultiItemValueRange,
  extendBlockSelectionByArrow,
  firstChild,
  focusFor,
  focusKey,
  isPlainValueItem,
  nextSibling,
  outlineCmd as cmd,
  parentOf,
  prevSibling,
  readOutlineSelectionPlainText,
  sameFocus,
  valueToText,
} from "./logic";
import {
  createTurnSuppressionFlag,
  currentValueCaretOffset,
  deleteOutlineValueSelection,
  domPositionToModel,
  handleArrowHorizontal,
  handleArrowVertical,
  handleBoundaryDeleteBeforeInput,
  handleHistoryBeforeInput,
  handleInsertLineBreakBeforeInput,
  insertTextFromExternal,
  ITEM_SELECTOR,
  modelPositionToDom,
  OUTLINE_VALUE_SELECTOR,
  type EditCtx,
  type InputState,
  type SavedOutlineSelection,
  VALUE_SURFACE_SELECTOR,
} from "./input";
const OUTLINE_ROW_POINTERDOWN_IGNORE_SELECTOR =
  ".ui-outline-value, .ui-outline-gutter, .ui-header, .ui-body:not(.ui-outline)";

function itemSelectorById(itemId: ItemId): string {
  return `[data-id="${CSS.escape(itemId)}"]`;
}

function buildOutlineItem(
  core: UiCore,
  rootId: ItemId,
  itemId: ItemId,
  onGutterPointerDown: (itemId: ItemId, shiftKey: boolean) => void,
  selectedRowKeys: Signal<Set<string>>,
  valueSelectionCollapsed: Signal<boolean>,
  beforeProgrammaticDomWrite: () => void,
): Component {
  return createComponent(core, (ctx) => {
    const itemEl = el("div", "ui-frame ui-outline-child");
    const rowFocus = focusFor(core, rootId, itemId);
    itemEl.dataset.id = itemId;
    if (!itemEl.hasAttribute("tabindex")) itemEl.tabIndex = -1;

    ctx.on(itemEl, "pointerdown", (e: PointerEvent) => {
      if (e.defaultPrevented) return;
      const targetEl = e.target instanceof HTMLElement ? e.target : null;
      if (targetEl?.closest(OUTLINE_ROW_POINTERDOWN_IGNORE_SELECTOR)) {
        return;
      }
      core.focus({ type: "item", location: rowFocus });
      e.stopPropagation();
    });

    const gutterEl = el("span", "ui-outline-gutter");
    gutterEl.dataset.dragStart = "block";
    gutterEl.contentEditable = "false";
    gutterEl.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onGutterPointerDown(itemId, e.shiftKey);
    });
    itemEl.append(gutterEl);

    const valueEl = el("span", "ui-outline-value");
    valueEl.dataset.dragStart = "block";
    valueEl.dataset.target = "value";
    const valueAnchor = document.createComment("outline:value");
    itemEl.append(valueAnchor);

    ctx.effect(() => {
      const snap = core.item(itemId);
      const newText =
        snap.content.type === "value"
          ? valueToText(snap.content.value)
          : snap.content.type === "issue"
            ? (snap.content.message ?? "")
            : "";
      const modelSel = core.selection();
      const isEditingThisValue =
        modelSel.type === "editing" &&
        modelSel.target === VALUE_TARGET &&
        modelSel.location.item === rowFocus.item &&
        modelSel.location.container === rowFocus.container;
      const sel = window.getSelection();
      if (
        isEditingThisValue &&
        sel?.rangeCount &&
        valueEl.contains(sel.getRangeAt(0).startContainer)
      )
        return;
      beforeProgrammaticDomWrite();
      renderPlainTextToContentEditable(valueEl, newText);
    });

    ctx.effect(() => {
      const snap = core.item(itemId);
      const isEmbedded = core.view(itemId) !== "outline";
      const showValue = !isEmbedded && snap.content.type !== "group";
      const canEditValue =
        showValue &&
        snap.mode.type === "plain" &&
        snap.content.type === "value";
      if (canEditValue) valueEl.removeAttribute("contenteditable");
      else valueEl.contentEditable = "false";
      if (showValue) {
        if (valueEl.parentNode !== itemEl)
          itemEl.insertBefore(valueEl, valueAnchor);
      } else {
        valueEl.remove();
      }
    });

    ctx.effect(() => {
      const isSelected = selectedRowKeys.value.has(focusKey(rowFocus));
      itemEl.classList.toggle("is-block-selected", isSelected);
    });

    ctx.effect(() => {
      const sel = core.selection();
      const isRowFocusedTarget =
        sel.type === "editing" &&
        sel.location.item === rowFocus.item &&
        sel.location.container === rowFocus.container;
      const isFocusedTextCaret =
        isRowFocusedTarget &&
        sel.target === VALUE_TARGET &&
        valueSelectionCollapsed.value;
      const isFocusedNonText =
        isRowFocusedTarget && sel.target !== VALUE_TARGET;
      const isFocusedBlock =
        sel.type === "item" && sameFocus(sel.head, rowFocus);
      const isFocused =
        isFocusedTextCaret || isFocusedNonText || isFocusedBlock;
      const snap = core.item(itemId);
      const isIssue = snap.content.type === "issue";
      const isNumeric =
        snap.content.type === "value" && isNumericLikeValue(snap.content.value);

      itemEl.classList.toggle("is-focused", isFocused);
      itemEl.classList.toggle("is-issue", isIssue);
      itemEl.classList.toggle("is-numeric", isNumeric);
    });

    ctx.slot(itemEl, () => {
      const snap = core.item(itemId);
      const labelText = (snap.label ?? "").trim();
      const sel = core.selection();
      const focusedHeaderTarget =
        sel.type === "editing" &&
        sel.location.item === itemId &&
        sel.location.container === focusFor(core, rootId, itemId).container &&
        (sel.target === LABEL_TARGET || sel.target.startsWith("conn:"));

      const shouldShowHeader =
        labelText.length > 0 ||
        snap.mode.type === "connected" ||
        focusedHeaderTarget;
      if (!shouldShowHeader) return null;

      const focus = focusFor(core, rootId, itemId);
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
      if (core.view(itemId) === "outline") return null;
      const focus = focusFor(core, rootId, itemId);
      const mounted = core.mountView({
        id: itemId,
        containerId: focus.container,
      });
      mounted.el.contentEditable = "false";
      return mounted;
    });

    ctx.slot(itemEl, () => {
      const snap = core.item(itemId);
      if (core.view(itemId) !== "outline") return null;
      if (snap.content.type !== "group") return null;
      if (snap.content.children.length !== 0) return null;
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
    });

    const kids = computed(() => {
      const snap = core.item(itemId);
      if (snap.content.type !== "group") return [] as ItemId[];
      if (core.view(itemId) !== "outline") return [] as ItemId[];
      return [...snap.content.children];
    });
    ctx.list(
      itemEl,
      () => kids.value,
      (childId) =>
        buildOutlineItem(
          core,
          rootId,
          childId,
          onGutterPointerDown,
          selectedRowKeys,
          valueSelectionCollapsed,
          beforeProgrammaticDomWrite,
        ),
    );

    return itemEl;
  });
}

function buildOutlineBody(core: UiCore, rootId: ItemId): Component {
  return createComponent(core, (ctx) => {
    const root = el("div");
    setBodyClasses(root, "outline");
    root.contentEditable = "true";
    root.spellcheck = false;
    root.setAttribute("autocorrect", "off");
    root.setAttribute("autocapitalize", "off");

    const topKids = computed(() => {
      const snap = core.item(rootId);
      return snap.content.type === "group" ? snap.content.children : [];
    });
    const editStops = computed(() => collectEditPoints(core, rootId));

    const selectedRowKeys = computed(() => {
      const sel = core.selection();
      if (sel.type !== "item") return new Set<string>();
      return new Set(
        blockSelectionFocuses(core, rootId, sel).map((focus) =>
          focusKey(focus),
        ),
      );
    });

    const suppressSelectionChangeFromGutter = createTurnSuppressionFlag(false);
    const suppressMutationSync = createTurnSuppressionFlag(false);
    const suppressHistoryKeydown = createTurnSuppressionFlag<
      "undo" | "redo" | null
    >(null);
    const suppressBeforeInputDrop = createTurnSuppressionFlag(false);
    const state: InputState = {
      isComposing: false,
      compositionEndedAt: 0,
      stickyCaretX: null,
      savedSelectionOnEmbeddedBlur: null,
      shouldRestoreSelectionOnFocus: false,
      lastValueSelectionKey: null,
    };
    const valueSelectionCollapsed = signal(true);

    const onGutterPointerDown = (itemId: ItemId, shiftKey: boolean): void => {
      suppressSelectionChangeFromGutter.suppressForTurn(true);

      const loc = core.locate(itemId);
      if (!loc) return;
      const nextFocus: Location = { container: loc.parentId, item: itemId };
      if (shiftKey) {
        const sel = core.selection();
        if (sel.type === "item") {
          core.focus({ type: "item", anchor: sel.anchor, head: nextFocus });
          return;
        }
      }
      core.focus({ type: "item", location: nextFocus });
    };
    const mutObs = new MutationObserver((mutations) => {
      if (suppressMutationSync.get() || state.isComposing) return;
      for (const mutation of mutations) {
        const textNode = getTextNodeFromMutationRecord(mutation);
        const valueEl =
          (textNode
            ? getSurfaceFromNodeInRoot(root, textNode, VALUE_SURFACE_SELECTOR)
            : null) ??
          getSurfaceFromNodeInRoot(
            root,
            mutation.target,
            VALUE_SURFACE_SELECTOR,
          );
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
        const newText = readPlainTextFromContentEditable(valueEl);
        if (valueToText(snap.content.value) === newText) continue;
        core.commit((t) => t.setValue(itemId, newText));
      }
    });
    const drainObserver = (): void => {
      mutObs.takeRecords();
    };
    const setCursorAndReveal = (itemId: ItemId, charOffset: number): void => {
      drainObserver();
      const pos = modelPositionToDom(root, itemId, charOffset);
      if (pos) setDomCaret(pos);
      const itemEl = root.querySelector<HTMLElement>(itemSelectorById(itemId));
      const valueEl = itemEl?.querySelector<HTMLElement>(
        VALUE_SURFACE_SELECTOR,
      );
      valueEl?.scrollIntoView({ block: "nearest" });
    };
    const applyEditingResult = (args: {
      location: Location;
      target: string;
      caret?: number;
      reveal?: { offset: number; defer?: boolean };
    }): void => {
      const { location, target, caret, reveal } = args;
      core.focus(
        { type: "editing", location, target },
        caret !== undefined ? { caret } : undefined,
      );
      if (target !== VALUE_TARGET || !reveal) return;
      const run = (): void => {
        setCursorAndReveal(location.item, reveal.offset);
      };
      if (reveal.defer === false) run();
      else queueMicrotask(run);
    };
    const resetStickyCaretX = (): void => {
      state.stickyCaretX = null;
    };

    const snapshotCurrentOutlineSelection =
      (): SavedOutlineSelection | null => {
        return getMappedSelectionSnapshotInRoot(root, (point) =>
          domPositionToModel(root, point.node, point.offset),
        );
      };
    const restoreSavedOutlineSelection = (): void => {
      if (!state.shouldRestoreSelectionOnFocus) return;
      state.shouldRestoreSelectionOnFocus = false;
      const snap = state.savedSelectionOnEmbeddedBlur;
      if (!snap) return;
      const anchorDom = modelPositionToDom(
        root,
        snap.anchor.itemId,
        snap.anchor.charOffset,
      );
      const focusDom = modelPositionToDom(
        root,
        snap.focus.itemId,
        snap.focus.charOffset,
      );
      if (!anchorDom || !focusDom) {
        state.savedSelectionOnEmbeddedBlur = null;
        return;
      }
      drainObserver();
      setDomSelectionRange(anchorDom, focusDom);
    };
    const isOutlineValueEditEvent = (target: EventTarget | null): boolean => {
      const targetEl = target instanceof HTMLElement ? target : null;
      return (
        !targetEl ||
        targetEl === root ||
        !!targetEl.closest(OUTLINE_VALUE_SELECTOR)
      );
    };
    const gated =
      <E extends Event>(handler: (e: E) => void): ((e: E) => void) =>
      (e: E) => {
        if (!isOutlineValueEditEvent(e.target)) return;
        handler(e);
      };

    const editCtx: EditCtx = {
      core,
      rootId,
      root,
      editStops,
      applyEditingResult,
      setCursorAndReveal,
      drainObserver,
      suppressMutationSync,
      suppressHistoryKeydown,
    };

    ctx.list(
      root,
      () => [...topKids.value],
      (childId) =>
        buildOutlineItem(
          core,
          rootId,
          childId,
          onGutterPointerDown,
          selectedRowKeys,
          valueSelectionCollapsed,
          drainObserver,
        ),
    );

    const onSelectionChange = (): void => {
      if (state.isComposing) return;
      if (suppressSelectionChangeFromGutter.get()) return;
      const winSel = window.getSelection();
      if (!winSel?.rangeCount) return;
      const anchorNode = winSel.anchorNode;
      if (!anchorNode || !root.contains(anchorNode)) return;
      const pos = domPositionToModel(root, anchorNode, winSel.anchorOffset);
      if (!pos) return;
      valueSelectionCollapsed.value = winSel.isCollapsed;

      const focusNode = winSel.focusNode;
      const focusPos =
        focusNode && root.contains(focusNode)
          ? domPositionToModel(root, focusNode, winSel.focusOffset)
          : null;
      const selectionKey = `${pos.itemId}:${pos.charOffset}|${
        focusPos ? `${focusPos.itemId}:${focusPos.charOffset}` : "?"
      }|${winSel.isCollapsed ? "1" : "0"}`;
      if (selectionKey === state.lastValueSelectionKey) return;
      state.lastValueSelectionKey = selectionKey;

      const loc = core.locate(pos.itemId);
      if (!loc) return;
      const itemFocus: Location = { container: loc.parentId, item: pos.itemId };
      const caret: number | undefined =
        focusPos && focusPos.itemId === pos.itemId
          ? focusPos.charOffset
          : undefined;
      core.focus(
        { type: "editing", location: itemFocus, target: VALUE_TARGET },
        caret !== undefined ? { caret } : undefined,
      );
    };
    const onBeforeInput = gated((e: InputEvent): void => {
      switch (e.inputType) {
        case "historyUndo": {
          handleHistoryBeforeInput(editCtx, e, "undo");
          break;
        }

        case "historyRedo": {
          handleHistoryBeforeInput(editCtx, e, "redo");
          break;
        }

        case "insertText": {
          const range = getDomRangeInRoot(root);
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
          }
          break;
        }

        case "insertParagraph": {
          e.preventDefault();
          const range = getDomRangeInRoot(root);
          if (!range) break;
          const rStart = domPositionToModel(
            root,
            range.startContainer,
            range.startOffset,
          );
          const rEnd = domPositionToModel(
            root,
            range.endContainer,
            range.endOffset,
          );
          const rangePos = rStart && rEnd ? { start: rStart, end: rEnd } : null;
          if (!rangePos) break;
          if (core.selection().type !== "editing") break;
          const caretStart = rangePos.start.charOffset;
          let caretEnd = caretStart;
          if (
            !range.collapsed &&
            rangePos.start.itemId !== rangePos.end.itemId
          ) {
            if (
              !deleteMultiItemValueRange(
                core,
                rootId,
                rangePos.start,
                rangePos.end,
                setCursorAndReveal,
              )
            )
              break;
          } else if (!range.collapsed) {
            caretEnd = rangePos.end.charOffset;
          }
          const splitLoc = focusFor(core, rootId, rangePos.start.itemId);
          const newId = cmd.splitAt(
            core,
            { location: splitLoc },
            caretStart,
            caretEnd,
          );
          if (!newId) break;
          applyEditingResult({
            location: focusFor(core, rootId, newId),
            target: VALUE_TARGET,
            caret: 0,
            reveal: { offset: 0, defer: false },
          });
          break;
        }
        case "insertLineBreak": {
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleInsertLineBreakBeforeInput(editCtx, e, range);
          break;
        }

        case "deleteContentBackward":
        case "deleteContentForward": {
          const dir =
            e.inputType === "deleteContentBackward" ? "backward" : "forward";
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleBoundaryDeleteBeforeInput(editCtx, e, dir, range);
          break;
        }

        case "deleteWordBackward":
        case "deleteWordForward": {
          const dir =
            e.inputType === "deleteWordBackward" ? "backward" : "forward";
          const range = getDomRangeInRoot(root);
          if (!range?.collapsed) break;
          handleBoundaryDeleteBeforeInput(editCtx, e, dir, range);
          break;
        }

        case "insertFromPaste":
          e.preventDefault();
          break;

        case "insertFromDrop": {
          e.preventDefault();
          if (!suppressBeforeInputDrop.get()) {
            const text = getPlainTextFromDataTransfer(e.dataTransfer);
            insertTextFromExternal(editCtx, text);
          }
          break;
        }
      }
    });

    const onCopy = (e: ClipboardEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel) return;
      const text = readOutlineSelectionPlainText(core, rangeSel);
      if (text == null) return;
      if (!writePlainTextClipboard(e, text)) return;
      e.preventDefault();
    };

    const onPaste = gated((e: ClipboardEvent): void => {
      const text = getPlainTextFromDataTransfer(e.clipboardData);
      if (!text) return;
      e.preventDefault();
      insertTextFromExternal(editCtx, text);
    });
    const onDrop = gated((e: DragEvent): void => {
      const text = getPlainTextFromDataTransfer(e.dataTransfer);
      if (!text) return;
      e.preventDefault();
      suppressBeforeInputDrop.suppressForTurn(true);
      insertTextFromExternal(editCtx, text);
    });

    const onCut = (e: ClipboardEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel) return;
      const text = readOutlineSelectionPlainText(core, rangeSel);
      if (text == null) return;
      writePlainTextClipboard(e, text);
      e.preventDefault();

      if (rangeSel.range.collapsed) return;
      void deleteOutlineValueSelection(editCtx, rangeSel.start, rangeSel.end);
    };

    const onKeyDown = gated((e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if (e.key === "Enter" && Date.now() - state.compositionEndedAt < 500) {
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
          deleteBlockSelection(core, rootId, sel);
          return;
        }
      }
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown" && e.key !== "Shift") {
        resetStickyCaretX();
      }
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (suppressHistoryKeydown.get() === "undo") {
          e.preventDefault();
          suppressHistoryKeydown.set(null);
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
        if (suppressHistoryKeydown.get() === "redo") {
          e.preventDefault();
          suppressHistoryKeydown.set(null);
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
            editStops.value,
            state,
            applyEditingResult,
            e,
            dir,
          )
        )
          return;
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
            rootId,
            editStops.value,
            state,
            applyEditingResult,
            e,
            dir,
          )
        )
          return;
      }
      if (e.key === "Tab") {
        resetStickyCaretX();
        e.preventDefault();
        e.stopPropagation();
        const modelSel = core.selection();
        if (modelSel.type !== "editing") return;
        const caretOffset =
          currentValueCaretOffset(root, modelSel.location.item) ?? 0;
        suppressMutationSync.suppressForTurn(true);
        const nextFocus = e.shiftKey
          ? cmd.outdentInPlace(core, rootId, modelSel)
          : cmd.indentInPlace(core, modelSel);
        if (nextFocus) {
          applyEditingResult({
            location: nextFocus,
            target: VALUE_TARGET,
            caret: caretOffset,
            reveal: { offset: caretOffset },
          });
        }
        return;
      }
      if (e.key === "Escape") {
        resetStickyCaretX();
        e.preventDefault();
        core.dispatch({ type: "NAV", dir: "out", mode: "step" });
      }
    });

    const onCompositionStart = gated((_e: CompositionEvent): void => {
      state.isComposing = true;
      core.undoBoundary();
    });

    const onCompositionEnd = gated((_e: CompositionEvent): void => {
      state.isComposing = false;
      state.compositionEndedAt = Date.now();
    });

    const onFocusOut = (e: FocusEvent): void => {
      resetStickyCaretX();
      const next = e.relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      core.undoBoundary();
    };
    const onBlur = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (!(next instanceof Node) || !root.contains(next)) {
        state.shouldRestoreSelectionOnFocus = false;
        return;
      }
      state.savedSelectionOnEmbeddedBlur = snapshotCurrentOutlineSelection();
      state.shouldRestoreSelectionOnFocus =
        state.savedSelectionOnEmbeddedBlur != null;
    };
    const onFocus = (): void => {
      resetStickyCaretX();
      restoreSavedOutlineSelection();
    };
    const onPointerDown = (): void => {
      resetStickyCaretX();
    };

    ctx.effect(() => {
      mutObs.observe(root, {
        characterData: true,
        childList: true,
        subtree: true,
      });
      document.addEventListener("selectionchange", onSelectionChange);
      root.addEventListener("beforeinput", onBeforeInput);
      root.addEventListener("copy", onCopy);
      root.addEventListener("cut", onCut);
      root.addEventListener("paste", onPaste);
      root.addEventListener("drop", onDrop);
      root.addEventListener("blur", onBlur);
      root.addEventListener("focus", onFocus);
      root.addEventListener("compositionstart", onCompositionStart);
      root.addEventListener("compositionend", onCompositionEnd);
      root.addEventListener("focusout", onFocusOut);
      root.addEventListener("keydown", onKeyDown);
      root.addEventListener("pointerdown", onPointerDown);
      return () => {
        mutObs.disconnect();
        document.removeEventListener("selectionchange", onSelectionChange);
        root.removeEventListener("beforeinput", onBeforeInput);
        root.removeEventListener("copy", onCopy);
        root.removeEventListener("cut", onCut);
        root.removeEventListener("paste", onPaste);
        root.removeEventListener("drop", onDrop);
        root.removeEventListener("blur", onBlur);
        root.removeEventListener("focus", onFocus);
        root.removeEventListener("compositionstart", onCompositionStart);
        root.removeEventListener("compositionend", onCompositionEnd);
        root.removeEventListener("focusout", onFocusOut);
        root.removeEventListener("keydown", onKeyDown);
        root.removeEventListener("pointerdown", onPointerDown);
      };
    });

    return root;
  });
}

function handleOutlineContainerTypeIntent(args: {
  core: UiCore;
  rootId: ItemId;
  sel: Extract<Selection, { type: "item" }>;
  intent: Extract<Intent, { type: "TYPE" }>;
}): boolean {
  const { core, rootId, sel, intent } = args;

  const id = sel.head.item;
  if (core.view(id) !== "outline") return false;

  const item = core.item(id);
  if (item.mode.type !== "plain") return false;
  if (item.content.type !== "value") return false;

  const applied = applyTypeToPrimaryTarget(core, id, intent.char);
  if (!applied || applied.target !== VALUE_TARGET) return false;
  core.focus(
    {
      type: "editing",
      location: focusFor(core, rootId, id),
      target: applied.target,
    },
    { caret: applied.caret },
  );
  return true;
}

export const outlineView = defineView(({ core, id: rootId }) => {
  const onIntent = (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type !== "item") return;
    const sel = selection;

    const focus: Location = sel.head;
    const selectedItems = blockSelectionItems(core, rootId, sel);

    if (intent.type === "DELETE") {
      if (selectedItems.length > 1) {
        deleteBlockSelection(core, rootId, sel);
        return;
      }
      const id = sel.head.item;
      if (core.item(id).mode.type === "readonly") return;
      cmd.removeAndPruneAncestors(core, rootId, id);
      return;
    }

    if (
      intent.type === "TYPE" &&
      intent.char === "=" &&
      handleItemIntent({ core, sel, intent })
    )
      return;

    if (
      (intent.type === "TYPE" || intent.type === "CONFIRM") &&
      core.item(sel.head.item).content.type === "group" &&
      childrenOf(core, sel.head.item).length === 0
    ) {
      const groupId = sel.head.item;
      if (core.item(groupId).mode.type === "readonly") return;
      if (intent.type === "TYPE") {
        core.commit((t) => t.setValue(groupId, intent.char));
        core.focus(
          { type: "editing", location: focus, target: VALUE_TARGET },
          { caret: intent.char.length },
        );
        return;
      }
      core.commit((t) => t.setValue(groupId, ""));
      core.focus(
        { type: "editing", location: focus, target: VALUE_TARGET },
        { caret: 0 },
      );
      return;
    }

    switch (intent.type) {
      case "TAB": {
        const nextFocus = intent.shift
          ? cmd.outdentInPlace(core, rootId, { location: focus })
          : cmd.indentInPlace(core, { location: focus });
        if (!nextFocus) return;
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "NAV": {
        const dir = intent.dir === "out" ? "left" : intent.dir;
        const fromId = sel.head.item;
        let nextId: ItemId | null = null;
        if (dir === "left") nextId = parentOf(core, rootId, fromId);
        else if (dir === "right")
          nextId = firstChild(core, fromId) ?? nextSibling(core, fromId);
        else if (dir === "up") nextId = prevSibling(core, fromId);
        else if (dir === "down") nextId = nextSibling(core, fromId);
        if (!nextId) return;
        const nextFocus = focusFor(core, rootId, nextId);
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "TYPE":
        if (handleOutlineContainerTypeIntent({ core, rootId, sel, intent }))
          return;
        handleItemIntent({ core, sel, intent });
        return;
      case "CONFIRM": {
        if (handleItemIntent({ core, sel, intent })) return;
        const nextId = cmd.insertSibling(core, { location: focus }, "after");
        if (!nextId) return;
        core.focus(
          {
            type: "editing",
            location: focusFor(core, rootId, nextId),
            target: VALUE_TARGET,
          },
          { caret: 0 },
        );
        return;
      }
    }
  };

  const body = buildOutlineBody(core, rootId);

  return { onIntent, body };
});
