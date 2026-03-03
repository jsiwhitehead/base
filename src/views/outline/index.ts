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
  createSuppressionFlag,
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
  collectNavPoints,
  deleteBlockSelection,
  extendBlockSelectionByArrow,
  firstChild,
  focusKey,
  isPlainValueItem,
  nextSibling,
  outlineCmd as cmd,
  parentOf,
  prevSibling,
  readSelectionText,
  sameFocus,
  valueToText,
} from "./logic";
import {
  valueCaretOffset,
  deleteSelection,
  domPositionToModel,
  handleArrowHorizontal,
  handleArrowVertical,
  handleBoundaryDeleteBeforeInput,
  handleDeleteBeforeInput,
  handleHistoryBeforeInput,
  handleInsertParagraphBeforeInput,
  handleInsertLineBreakBeforeInput,
  insertText,
  ITEM_SELECTOR,
  itemSelectorById,
  modelPositionToDom,
  VALUE_SELECTOR,
  type EditCtx,
  type InputState,
  type SelectionSnapshot,
} from "./input";
const OUTLINE_ROW_POINTERDOWN_IGNORE_SELECTOR =
  ".ui-outline-value, .ui-outline-gutter, .ui-header, .ui-body:not(.ui-outline)";

function buildOutlineItem(
  core: UiCore,
  itemId: ItemId,
  portals: readonly ItemId[],
  onGutterPointerDown: (
    itemId: ItemId,
    portals: readonly ItemId[],
    shiftKey: boolean,
  ) => void,
  selectedRowKeys: Signal<Set<string>>,
  valueSelectionCollapsed: Signal<boolean>,
  beforeProgrammaticDomWrite: () => void,
): Component {
  return createComponent(core, (ctx) => {
    const itemEl = el("div", "ui-frame ui-outline-child");
    const rowFocus: Location = { item: itemId, portals };
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
      onGutterPointerDown(itemId, portals, e.shiftKey);
    });
    itemEl.append(gutterEl);

    const valueEl = el("span", "ui-outline-value");
    valueEl.dataset.dragStart = "block";
    valueEl.dataset.target = "value";
    const valueAnchor = document.createComment("outline:value");
    itemEl.append(valueAnchor);

    ctx.target(
      rowFocus,
      VALUE_TARGET,
      () => (valueEl.isConnected ? valueEl : null),
      {
        getCaret: () => {
          const outlineRoot = valueEl.closest("[contenteditable='true']");
          if (!(outlineRoot instanceof HTMLElement)) return undefined;
          return valueCaretOffset(outlineRoot, itemId) ?? undefined;
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
      const modelSel = core.selection();
      const isEditingThisValue =
        modelSel.type === "editing" &&
        modelSel.target === VALUE_TARGET &&
        sameFocus(modelSel.location, rowFocus);
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
        sel.type === "editing" && sameFocus(sel.location, rowFocus);
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
        sameFocus(sel.location, rowFocus) &&
        (sel.target === LABEL_TARGET || sel.target.startsWith("conn:"));

      const shouldShowHeader =
        labelText.length > 0 ||
        snap.mode.type === "connected" ||
        focusedHeaderTarget;
      if (!shouldShowHeader) return null;

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
      if (core.view(itemId) === "outline") return null;
      const snap = core.item(itemId);
      const childPortals =
        snap.mode.type === "connected" ? [...portals, itemId] : portals;
      const mounted = core.mountView({
        id: itemId,
        portals: childPortals,
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
          childId,
          portals,
          onGutterPointerDown,
          selectedRowKeys,
          valueSelectionCollapsed,
          beforeProgrammaticDomWrite,
        ),
    );

    return itemEl;
  });
}

function buildOutlineBody(
  core: UiCore,
  rootId: ItemId,
  portals: readonly ItemId[],
): Component {
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
    const navPoints = computed(() => collectNavPoints(core, rootId, portals));

    const selectedRowKeys = computed(() => {
      const sel = core.selection();
      if (sel.type !== "item") return new Set<string>();
      return new Set(
        blockSelectionFocuses(core, rootId, sel, portals).map((focus) =>
          focusKey(focus),
        ),
      );
    });

    const suppressSelectionChangeFromGutter = createSuppressionFlag(false);
    const suppressSelectionSync = createSuppressionFlag(false);
    const suppressMutationSync = createSuppressionFlag(false);
    const suppressHistoryKeydown = createSuppressionFlag<
      "undo" | "redo" | null
    >(null);
    const state: InputState = {
      isComposing: false,
      compositionEndedAt: 0,
      stickyCaretX: null,
      savedSelection: null,
      restoreSelectionOnFocus: false,
    };
    const valueSelectionCollapsed = signal(true);

    const onGutterPointerDown = (
      itemId: ItemId,
      portals: readonly ItemId[],
      shiftKey: boolean,
    ): void => {
      suppressSelectionChangeFromGutter.suppressForTurn(true);

      const nextFocus: Location = { item: itemId, portals };
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
        const newText = readPlainTextFromContentEditable(valueEl);
        if (valueToText(snap.content.value) === newText) continue;
        core.commit((t) => t.setValue(itemId, newText));
      }
    });
    const drainObserver = (): void => {
      mutObs.takeRecords();
    };
    const setCursorAndReveal = (itemId: ItemId, offset: number): void => {
      drainObserver();
      const pos = modelPositionToDom(root, itemId, offset);
      if (pos) {
        suppressSelectionSync.suppressForTurn(true);
        setDomCaret(pos);
        valueSelectionCollapsed.value = true;
      }
      const itemEl = root.querySelector<HTMLElement>(itemSelectorById(itemId));
      const valueEl = itemEl?.querySelector<HTMLElement>(VALUE_SELECTOR);
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

    const snapshotSelection = (): SelectionSnapshot | null => {
      return getMappedSelectionSnapshotInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
    };
    const restoreSelection = (): void => {
      if (!state.restoreSelectionOnFocus) return;
      state.restoreSelectionOnFocus = false;
      const snap = state.savedSelection;
      if (!snap) return;
      const anchorDom = modelPositionToDom(
        root,
        snap.anchor.itemId,
        snap.anchor.offset,
      );
      const focusDom = modelPositionToDom(
        root,
        snap.focus.itemId,
        snap.focus.offset,
      );
      if (!anchorDom || !focusDom) {
        state.savedSelection = null;
        return;
      }
      drainObserver();
      setDomSelectionRange(anchorDom, focusDom);
    };
    const isOutlineValueEditEvent = (target: EventTarget | null): boolean => {
      const targetEl = target instanceof HTMLElement ? target : null;
      return (
        !targetEl || targetEl === root || !!targetEl.closest(VALUE_SELECTOR)
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
      portals,
      root,
      navPoints,
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
          childId,
          portals,
          onGutterPointerDown,
          selectedRowKeys,
          valueSelectionCollapsed,
          drainObserver,
        ),
    );

    const onSelectionChange = (): void => {
      if (state.isComposing) return;
      if (suppressSelectionChangeFromGutter.get()) return;
      if (suppressSelectionSync.get()) return;
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

      const itemFocus: Location = { item: pos.itemId, portals };
      const caret: number | undefined =
        focusPos && focusPos.itemId === pos.itemId
          ? focusPos.offset
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
          if (e.isComposing) break;
          if (!e.data) break;
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
            break;
          }
          e.preventDefault();
          insertText(editCtx, e.data);
          break;
        }

        case "insertParagraph": {
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleInsertParagraphBeforeInput(editCtx, e, range);
          break;
        }
        case "insertLineBreak": {
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleInsertLineBreakBeforeInput(editCtx, e, range);
          break;
        }

        case "deleteContentBackward":
        case "deleteContentForward":
        case "deleteWordBackward":
        case "deleteWordForward": {
          if (e.isComposing) break;
          const dir = e.inputType.includes("Backward") ? "backward" : "forward";
          const targetRange = e.getTargetRanges()[0];
          if (targetRange && handleDeleteBeforeInput(editCtx, e, targetRange))
            break;
          const range = getDomRangeInRoot(root);
          if (!range) break;
          handleBoundaryDeleteBeforeInput(editCtx, e, dir, range);
          break;
        }

        case "insertFromPaste":
          e.preventDefault();
          break;

        case "insertFromDrop":
          e.preventDefault();
          break;
      }
    });

    const onCopy = (e: ClipboardEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel) return;
      const text = readSelectionText(core, rangeSel);
      if (text == null) return;
      if (!writePlainTextClipboard(e, text)) return;
      e.preventDefault();
    };
    const onDragStart = gated((e: DragEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel || !e.dataTransfer) return;
      const text = readSelectionText(core, rangeSel);
      if (text == null) return;
      e.dataTransfer.setData("text/plain", text);
    });

    const onPaste = gated((e: ClipboardEvent): void => {
      const text = getPlainTextFromDataTransfer(e.clipboardData);
      if (!text) return;
      e.preventDefault();
      core.undoBoundary();
      insertText(editCtx, text);
      core.undoBoundary();
    });
    const onDrop = gated((e: DragEvent): void => {
      const text = getPlainTextFromDataTransfer(e.dataTransfer);
      if (!text) return;
      e.preventDefault();
      core.undoBoundary();
      insertText(editCtx, text);
      core.undoBoundary();
    });

    const onCut = (e: ClipboardEvent): void => {
      const rangeSel = getMappedSelectionRangeInRoot(root, (point) =>
        domPositionToModel(root, point.node, point.offset),
      );
      if (!rangeSel) return;
      const text = readSelectionText(core, rangeSel);
      if (text == null) return;
      if (!writePlainTextClipboard(e, text)) return;
      e.preventDefault();

      if (rangeSel.range.collapsed) return;
      void deleteSelection(editCtx, rangeSel.start, rangeSel.end);
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
          deleteBlockSelection(core, rootId, sel, portals);
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
            navPoints.value,
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
            portals,
            navPoints.value,
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
        const caretOffset = valueCaretOffset(root, modelSel.location.item) ?? 0;
        suppressMutationSync.suppressForTurn(true);
        const nextFocus = e.shiftKey
          ? cmd.outdentInPlace(core, modelSel.location)
          : cmd.indentInPlace(core, modelSel.location);
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
      core.undoBoundary();
    });

    const onFocusOut = (): void => {
      resetStickyCaretX();
    };
    const onBlur = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (!(next instanceof Node) || !root.contains(next)) {
        state.restoreSelectionOnFocus = false;
        return;
      }
      state.savedSelection = snapshotSelection();
      state.restoreSelectionOnFocus = state.savedSelection != null;
    };
    const onFocus = (): void => {
      resetStickyCaretX();
      restoreSelection();
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
      root.addEventListener("dragstart", onDragStart);
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
        root.removeEventListener("dragstart", onDragStart);
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

function handleOutlineItemTypeIntent(args: {
  core: UiCore;
  portals: readonly ItemId[];
  sel: Extract<Selection, { type: "item" }>;
  intent: Extract<Intent, { type: "TYPE" }>;
}): boolean {
  const { core, portals, sel, intent } = args;

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
      location: { item: id, portals },
      target: applied.target,
    },
    { caret: applied.caret },
  );
  return true;
}

function resolveFocusAfterRemove(
  core: UiCore,
  rootId: ItemId,
  id: ItemId,
  prefer: "next" | "previous",
  portals: readonly ItemId[],
): Location | null {
  const primary =
    prefer === "next" ? nextSibling(core, id) : prevSibling(core, id);
  if (primary) return { item: primary, portals };

  const fallback =
    prefer === "next" ? prevSibling(core, id) : nextSibling(core, id);
  if (fallback) return { item: fallback, portals };

  const parentId = parentOf(core, rootId, id);
  return parentId ? { item: parentId, portals } : null;
}

export const outlineView = defineView(({ core, id: rootId, focus }) => {
  const rootPortals = focus.portals;
  const onIntent = (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type !== "item") return;
    const sel = selection;

    const focus: Location = sel.head;
    const selectedItems = blockSelectionItems(core, rootId, sel, rootPortals);

    if (intent.type === "DELETE") {
      if (selectedItems.length > 1) {
        const lastId = selectedItems[selectedItems.length - 1]!;
        const nextFocus = resolveFocusAfterRemove(
          core,
          rootId,
          lastId,
          "next",
          rootPortals,
        );
        deleteBlockSelection(core, rootId, sel, rootPortals);
        if (nextFocus) core.focus({ type: "item", location: nextFocus });
        return;
      }
      const id = sel.head.item;
      if (core.item(id).mode.type === "readonly") return;
      const nextFocus = resolveFocusAfterRemove(
        core,
        rootId,
        id,
        "next",
        rootPortals,
      );
      cmd.removeAndPruneAncestors(core, rootId, id);
      if (nextFocus) core.focus({ type: "item", location: nextFocus });
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
          ? cmd.outdentInPlace(core, focus)
          : cmd.indentInPlace(core, focus);
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
        const nextFocus = { item: nextId, portals: rootPortals };
        core.focus({ type: "item", location: nextFocus });
        return;
      }
      case "TYPE":
        if (
          handleOutlineItemTypeIntent({
            core,
            portals: rootPortals,
            sel,
            intent,
          })
        )
          return;
        handleItemIntent({ core, sel, intent });
        return;
      case "CONFIRM": {
        if (handleItemIntent({ core, sel, intent })) return;
        const nextId = cmd.insertSibling(core, focus, "after");
        if (!nextId) return;
        core.focus(
          {
            type: "editing",
            location: { item: nextId, portals: rootPortals },
            target: VALUE_TARGET,
          },
          { caret: 0 },
        );
        return;
      }
    }
  };

  const body = buildOutlineBody(core, rootId, rootPortals);

  return { onIntent, body };
});
