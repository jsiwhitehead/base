import { describe, expect, test } from "bun:test";

import type { ItemId } from "../src/core";
import { VALUE_TARGET } from "../src/core";
import { createDragController, type UiCore } from "../src/dom";
import {
  childrenOf,
  dispatchKey,
  dispatchPointerEvent,
  expectSel,
  expectSnapshotSame,
  fireViewKey,
  flushDomEffects,
  installCapturedWindowHandlers,
  makeCoreRuntime,
  mkBlank,
  mkGroup,
  mountView,
  pointerDown,
  requireEl,
  requireFrameEl,
  requireTargetInput,
  setFormula,
  setView,
  snapshotEl,
  valueOfId,
} from "./dom-test-utils";

function requireOutlineRoot(root: ParentNode): HTMLElement {
  const el = root.querySelector(
    "[contenteditable='true']",
  ) as HTMLElement | null;
  if (!el) throw new Error("Missing outline root");
  return el;
}

function requireOutlineItemEl(root: ParentNode, id: ItemId): HTMLElement {
  const itemEl = root.querySelector(
    `.ui-frame.ui-outline-child[data-id="${id}"]`,
  ) as HTMLElement | null;
  if (!itemEl)
    throw new Error(`Missing outline item element for id=${String(id)}`);
  return itemEl;
}

function requireOutlineValueEl(root: ParentNode, id: ItemId): HTMLElement {
  const itemEl = requireOutlineItemEl(root, id);
  const valueEl = itemEl.querySelector(
    `.ui-outline-value[data-target="value"]`,
  ) as HTMLElement | null;
  if (!valueEl)
    throw new Error(`Missing outline value element for id=${String(id)}`);
  return valueEl;
}

function requireOutlineGutterEl(root: ParentNode, id: ItemId): HTMLElement {
  const itemEl = requireOutlineItemEl(root, id);
  const gutterEl = itemEl.querySelector(
    ".ui-outline-gutter",
  ) as HTMLElement | null;
  if (!gutterEl)
    throw new Error(`Missing outline gutter element for id=${String(id)}`);
  return gutterEl;
}

function setContentEditableSelection(
  valueEl: HTMLElement,
  start: number,
  end = start,
): void {
  const sel = window.getSelection();
  if (!sel) throw new Error("Missing window selection");

  const textNode = [...valueEl.childNodes].find(
    (n): n is Text => n.nodeType === Node.TEXT_NODE,
  );

  const range = document.createRange();
  if (textNode) {
    range.setStart(textNode, Math.min(start, textNode.data.length));
    range.setEnd(textNode, Math.min(end, textNode.data.length));
  } else {
    range.setStart(valueEl, 0);
    range.setEnd(valueEl, 0);
  }

  sel.removeAllRanges();
  sel.addRange(range);
}

function dispatchBeforeInput(
  target: Element,
  inputType: string,
  init: Partial<InputEventInit> = {},
): { defaultPrevented: boolean } {
  const ev = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    ...init,
  });
  Object.defineProperty(ev, "getTargetRanges", {
    configurable: true,
    value: () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return [];
      const range = sel.getRangeAt(0);
      return [
        {
          startContainer: range.startContainer,
          startOffset: range.startOffset,
          endContainer: range.endContainer,
          endOffset: range.endOffset,
        } as StaticRange,
      ];
    },
  });
  target.dispatchEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };
}

type MockTransfer = {
  _data: Record<string, string>;
  setData(type: string, value: string): void;
  getData(type: string): string;
};

function makeMockTransfer(seed?: Record<string, string>): MockTransfer {
  const data = { ...(seed ?? {}) };
  return {
    _data: data,
    setData(type, value) {
      data[type] = value;
    },
    getData(type) {
      return data[type] ?? "";
    },
  };
}

function dispatchClipboardEvent(
  target: Element,
  type: "copy" | "cut" | "paste",
  init: { textPlain?: string } = {},
): { defaultPrevented: boolean; textPlain: string } {
  const ev = new Event(type, {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  const transfer = makeMockTransfer(
    init.textPlain != null ? { "text/plain": init.textPlain } : undefined,
  );
  Object.defineProperty(ev, "clipboardData", {
    value: transfer,
    configurable: true,
  });
  target.dispatchEvent(ev);
  return {
    defaultPrevented: ev.defaultPrevented,
    textPlain: transfer.getData("text/plain"),
  };
}

function dispatchDropText(
  target: Element,
  textPlain: string,
  init: Partial<Pick<PointerEventInit, "clientX" | "clientY">> = {},
): { defaultPrevented: boolean } {
  const ev = new Event("drop", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  const transfer = makeMockTransfer({ "text/plain": textPlain });
  Object.defineProperty(ev, "dataTransfer", {
    value: transfer,
    configurable: true,
  });
  Object.defineProperty(ev, "clientX", {
    value: init.clientX ?? 0,
    configurable: true,
  });
  Object.defineProperty(ev, "clientY", {
    value: init.clientY ?? 0,
    configurable: true,
  });
  target.dispatchEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };
}

function dispatchComposition(
  target: Element,
  type: "compositionstart" | "compositionend",
): { defaultPrevented: boolean } {
  const ev = new CompositionEvent(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return { defaultPrevented: ev.defaultPrevented };
}

async function mountOutline(
  core: UiCore,
  rootId: ItemId,
  focus: { container: ItemId; item: ItemId } = {
    container: rootId,
    item: rootId,
  },
): Promise<{
  domView: Awaited<ReturnType<typeof mountView>>["domView"];
  unmount: Awaited<ReturnType<typeof mountView>>["unmount"];
  root: HTMLElement;
}> {
  const mounted = await mountView({
    view: "outline",
    core,
    id: rootId,
    focus,
  });
  return { ...mounted, root: requireOutlineRoot(document.body) };
}

function expectItemRangeSel(
  core: { selection(): ReturnType<UiCore["selection"]> },
  want: {
    anchor: { container: ItemId; item: ItemId };
    head: { container: ItemId; item: ItemId };
  },
): void {
  const sel = core.selection();
  expect(sel.type).toBe("item");
  if (sel.type !== "item") throw new Error("Expected item selection");
  expect(sel.anchor).toEqual(want.anchor);
  expect(sel.head).toEqual(want.head);
}

describe("outline/rendering", () => {
  test("renders outline root and item frame contracts", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "aa" });

    core.focus({
      type: "item",
      anchor: { container: rootId, item: rootId },
      head: { container: rootId, item: rootId },
    });

    const { unmount, root } = await mountOutline(core, rootId);

    expect(root.isContentEditable).toBe(true);
    expect(root.spellcheck).toBe(false);
    expect(root.getAttribute("autocorrect")).toBe("off");
    expect(root.getAttribute("autocapitalize")).toBe("off");

    const gEl = requireOutlineItemEl(document.body, g);
    const gFrameEl = requireFrameEl(document.body, g);
    const gutterEl = gEl.querySelector(
      ".ui-outline-gutter",
    ) as HTMLElement | null;
    const valueEl = requireOutlineValueEl(document.body, g);

    expect(gFrameEl).toBe(gEl);
    expect(gEl.classList.contains("ui-outline-child")).toBe(true);
    expect(gEl.dataset.id).toBe(g);
    expect(gutterEl).toBeTruthy();
    expect(gutterEl?.getAttribute("contenteditable")).toBe("false");
    expect(valueEl.dataset.target).toBe("value");
    expect(requireOutlineItemEl(document.body, a).isConnected).toBe(true);

    unmount();
  });

  test("empty outline group renders visual placeholder only", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });

    const { unmount } = await mountOutline(core, rootId);

    const gEl = requireOutlineItemEl(document.body, g);
    const placeholder = gEl.querySelector(
      ".ui-outline-placeholder",
    ) as HTMLElement | null;
    expect(placeholder).toBeTruthy();
    expect(placeholder?.textContent).toContain("Empty group");
    expect(placeholder?.getAttribute("contenteditable")).toBe("false");
    expect(placeholder?.getAttribute("aria-hidden")).toBe("true");
    expect(placeholder?.hasAttribute("tabindex")).toBe(false);

    mkBlank(core, g, { label: "a", value: "x" });
    await flushDomEffects();
    expect(
      requireOutlineItemEl(document.body, g).querySelector(
        ".ui-outline-placeholder",
      ),
    ).toBeNull();

    unmount();
  });

  test("embedded view mounts outside outline value surface", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "slider", value: 5 });
    setView(core, a, "slider");

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const valueEl = itemEl.querySelector(
      `.ui-outline-value[data-target="value"]`,
    ) as HTMLElement | null;
    const sliderValueEl = itemEl.querySelector(
      ".ui-slider-value",
    ) as HTMLElement | null;
    const sliderInput = itemEl.querySelector(
      "input[type='range']",
    ) as HTMLInputElement | null;

    expect(sliderValueEl).toBeTruthy();
    expect(sliderInput).toBeTruthy();
    expect(valueEl).toBeNull();
    expect(itemEl.contains(sliderValueEl!)).toBe(true);

    unmount();
  });

  test("value surfaces mount for multiline and empty values", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x\ny" });
    const b = mkBlank(core, rootId, { label: "b", value: "x\n\ny" });
    const c = mkBlank(core, rootId, { label: "c", value: "x\n" });
    const d = mkBlank(core, rootId, { label: "d", value: "" });

    const { unmount } = await mountOutline(core, rootId);

    expect(requireOutlineValueEl(document.body, a).isConnected).toBe(true);
    expect(requireOutlineValueEl(document.body, b).isConnected).toBe(true);
    expect(requireOutlineValueEl(document.body, c).isConnected).toBe(true);
    expect(requireOutlineValueEl(document.body, d).isConnected).toBe(true);

    unmount();
  });
});

describe("outline/container-intents", () => {
  test("Enter on empty group converts to value and enters VALUE", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    core.focus({
      type: "item",
      anchor: { container: rootId, item: g },
      head: { container: rootId, item: g },
    });

    const { domView, unmount } = await mountOutline(core, rootId);

    fireViewKey(domView, "Enter");
    await flushDomEffects();

    expect(childrenOf(core, g)).toEqual([]);
    expectSel(core, { container: rootId, item: g, target: VALUE_TARGET });
    expect(valueOfId(core, g)).toBe("");

    unmount();
  });

  test("TYPE from block inserts first char into value", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus({
      type: "item",
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: a },
    });

    const { domView, unmount } = await mountOutline(core, rootId);

    fireViewKey(domView, "x");
    await flushDomEffects();

    expectSel(core, { container: rootId, item: a, target: VALUE_TARGET });
    expect(valueOfId(core, a)).toBe("x");

    unmount();
  });

  test('TYPE "=" from block uses formula conversion path', async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus({
      type: "item",
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: a },
    });

    const { domView, unmount } = await mountOutline(core, rootId);

    fireViewKey(domView, "=");
    await flushDomEffects();

    const item = core.item(a);
    expect(item.mode.type).toBe("connected");
    const sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe("conn:expr");

    unmount();
  });

  test("NAV from container focus uses sibling geometry with right fallthrough", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "aa" });
    const b = mkBlank(core, g, { label: "b", value: "bb" });
    mkBlank(core, rootId, { label: "c", value: "cc" });
    core.focus({
      type: "item",
      anchor: { container: rootId, item: g },
      head: { container: rootId, item: g },
    });

    const { domView, unmount } = await mountOutline(core, rootId);

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: g, item: a });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: g, item: b });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: g, item: b });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: g });

    unmount();
  });

  test("NAV boundaries from top/root no-op", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    core.focus({
      type: "item",
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: a },
    });

    const { domView, unmount } = await mountOutline(core, rootId);

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: a });

    core.focus({
      type: "item",
      anchor: { container: rootId, item: rootId },
      head: { container: rootId, item: rootId },
    });
    await flushDomEffects();
    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: rootId });

    unmount();
  });

  test("keydown Tab/Shift+Tab use in-place body transforms", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "v" });
    core.focus(
      {
        type: "editing",
        location: { container: g, item: x },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    const firstTab = dispatchKey(outlineRoot, "Tab");
    await flushDomEffects();
    expect(firstTab.defaultPrevented).toBe(true);

    expect(core.item(x).content.type).toBe("group");
    const nestedKids = childrenOf(core, x);
    expect(nestedKids.length).toBe(1);
    const child = nestedKids[0]!;
    expect(valueOfId(core, child)).toBe("v");
    expectSel(core, { container: x, item: child, target: VALUE_TARGET });

    const secondTab = dispatchKey(outlineRoot, "Tab", { shiftKey: true });
    await flushDomEffects();
    expect(secondTab.defaultPrevented).toBe(true);
    expect(core.item(x).content.type).toBe("value");
    expect(valueOfId(core, x)).toBe("v");
    expectSel(core, { container: g, item: x, target: VALUE_TARGET });

    unmount();
  });

  test("Escape from VALUE_TARGET exits to same-item block", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { container: g, item: a },
        target: VALUE_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aValue = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValue, 2);
    const ev = dispatchKey(requireOutlineRoot(document.body), "Escape");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expectSel(core, { container: g, item: a });

    unmount();
  });
});

describe("outline/ce-beforeinput", () => {
  test("beforeinput insertParagraph splits item at selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchBeforeInput(outlineRoot, "insertParagraph");
    await flushDomEffects();
    expect(ev.defaultPrevented).toBe(true);

    const kids = childrenOf(core, rootId);
    const aIdx = kids.indexOf(a);
    const b = kids[aIdx + 1]!;
    expect(valueOfId(core, a)).toBe("he");
    expect(valueOfId(core, b)).toBe("llo");
    expectSel(core, { container: rootId, item: b, target: VALUE_TARGET });

    unmount();
  });

  test("beforeinput insertLineBreak inserts newline in-place", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchBeforeInput(outlineRoot, "insertLineBreak");
    await flushDomEffects();
    expect(ev.defaultPrevented).toBe(true);

    expect(childrenOf(core, rootId)).toEqual([a]);
    expect(valueOfId(core, a)).toBe("he\nllo");
    expectSel(core, { container: rootId, item: a, target: VALUE_TARGET });

    unmount();
  });

  test("deleteContentBackward on final empty leaf blanks outline root and repairs selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 0);
    const ev = dispatchBeforeInput(outlineRoot, "deleteContentBackward");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(valueOfId(core, rootId)).toBeNull();
    expectSel(core, { container: rootId, item: rootId });

    dispatchKey(outlineRoot, "Tab");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: rootId });

    unmount();
  });

  test("nested outline root: final leaf delete blanks nested root and repairs to parent location", async () => {
    const { core, rootId } = makeCoreRuntime();
    const nestedRoot = mkGroup(core, rootId, { label: "nested" });
    const a = mkBlank(core, nestedRoot, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { container: nestedRoot, item: a },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, nestedRoot, {
      container: rootId,
      item: nestedRoot,
    });

    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 0);
    const ev = dispatchBeforeInput(outlineRoot, "deleteContentBackward");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(valueOfId(core, nestedRoot)).toBeNull();
    expectSel(core, { container: rootId, item: nestedRoot });

    dispatchKey(outlineRoot, "Tab");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: nestedRoot });

    unmount();
  });

  test("non-empty group items do not expose an outline value surface", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: "x" });

    const { unmount } = await mountOutline(core, rootId);

    const gEl = requireOutlineItemEl(document.body, g);
    const gValueEl =
      [...gEl.children].find(
        (child) =>
          child instanceof HTMLElement &&
          child.matches(`.ui-outline-value[data-target="value"]`),
      ) ?? null;
    expect(gValueEl).toBeNull();

    unmount();
  });

  test("beforeinput historyUndo/historyRedo call core undo/redo", async () => {
    const { core, rootId } = makeCoreRuntime();
    mkBlank(core, rootId, { label: "a", value: "x" });

    const undoCalls: number[] = [];
    const redoCalls: number[] = [];
    const origUndo = core.undo.bind(core);
    const origRedo = core.redo.bind(core);
    core.undo = (() => {
      undoCalls.push(1);
      return origUndo();
    }) as typeof core.undo;
    core.redo = (() => {
      redoCalls.push(1);
      return origRedo();
    }) as typeof core.redo;

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    expect(dispatchBeforeInput(root, "historyUndo").defaultPrevented).toBe(
      true,
    );
    expect(dispatchBeforeInput(root, "historyRedo").defaultPrevented).toBe(
      true,
    );
    expect(undoCalls.length).toBe(1);
    expect(redoCalls.length).toBe(1);

    unmount();
  });

  test("beforeinput insertFromDrop is prevented when external drop text handled", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1);

    const drop = dispatchDropText(root, "Z");
    expect(drop.defaultPrevented).toBe(true);
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("aZb");

    unmount();
  });
});

describe("outline/clipboard-drop", () => {
  test("copy and cut single-item CE selection use model text/plain semantics", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1, 4);

    const copy = dispatchClipboardEvent(root, "copy");
    expect(copy.defaultPrevented).toBe(true);
    expect(copy.textPlain).toBe("ell");

    const cut = dispatchClipboardEvent(root, "cut");
    await flushDomEffects();
    expect(cut.defaultPrevented).toBe(true);
    expect(cut.textPlain).toBe("ell");
    expect(valueOfId(core, a)).toBe("ho");
    expectSel(core, { container: rootId, item: a, target: VALUE_TARGET });

    unmount();
  });

  test("copy and cut same-parent multi-item selection serializes newline-joined text", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    const b = mkBlank(core, rootId, { label: "b", value: "world" });

    const { unmount } = await mountOutline(core, rootId);

    setContentEditableSelection(requireOutlineValueEl(document.body, a), 2);
    const sel = window.getSelection();
    const bText = requireOutlineValueEl(document.body, b)
      .firstChild as Text | null;
    expect(sel).toBeTruthy();
    expect(bText).toBeTruthy();
    const range = document.createRange();
    range.setStart(
      requireOutlineValueEl(document.body, a).firstChild ??
        requireOutlineValueEl(document.body, a),
      2,
    );
    range.setEnd(bText ?? requireOutlineValueEl(document.body, b), 3);
    sel!.removeAllRanges();
    sel!.addRange(range);

    const root = requireOutlineRoot(document.body);
    const copy = dispatchClipboardEvent(root, "copy");
    expect(copy.defaultPrevented).toBe(true);
    expect(copy.textPlain).toBe("llo\nwor");

    const cut = dispatchClipboardEvent(root, "cut");
    await flushDomEffects();
    expect(cut.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("held");

    unmount();
  });

  test("paste and drop insert external text into current selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1);

    const paste = dispatchClipboardEvent(root, "paste", { textPlain: "X" });
    await flushDomEffects();
    expect(paste.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("aXb");
    expect(requireOutlineValueEl(document.body, a).textContent).toBe("aXb");

    setContentEditableSelection(valueEl, 2);
    const drop = dispatchDropText(root, "Y");
    await flushDomEffects();
    expect(drop.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("aXYb");

    unmount();
  });
});

describe("outline/ime-mutation", () => {
  test("structural keydown is ignored while key event is composing", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const ev = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(ev, "isComposing", {
      value: true,
      configurable: true,
    });
    root.dispatchEvent(ev);
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(false);
    expect(core.item(a).content.type).toBe("value");

    unmount();
  });

  test("mutation sync ignores transient br-only contenteditable noise", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const valueEl = requireOutlineValueEl(document.body, a);
    valueEl.replaceChildren(document.createElement("br"));
    await flushDomEffects();

    expect(valueOfId(core, a)).toBe("");

    unmount();
  });

  test("mutation sync preserves blank lines and trailing newline from CE DOM", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const valueEl = requireOutlineValueEl(document.body, a);
    valueEl.replaceChildren(
      document.createTextNode("a"),
      document.createElement("br"),
      document.createElement("br"),
      document.createTextNode("b"),
      document.createElement("br"),
    );
    await flushDomEffects();

    expect(valueOfId(core, a)).toBe("a\n\nb\n");

    unmount();
  });

  test("composition lifecycle does not break subsequent text sync", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    dispatchComposition(root, "compositionstart");
    valueEl.textContent = "ab";
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("a");

    dispatchComposition(root, "compositionend");
    valueEl.textContent = "abc";
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("abc");

    unmount();
  });
});

describe("outline/selection-cursor", () => {
  test("selection changes do not recreate frame elements", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aFrame0 = requireFrameEl(document.body, a);
    const bFrame0 = requireFrameEl(document.body, b);
    const snapA = snapshotEl(aFrame0);
    const snapB = snapshotEl(bFrame0);

    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: b },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );
    await flushDomEffects();

    expectSnapshotSame(snapA, requireFrameEl(document.body, a));
    expectSnapshotSame(snapB, requireFrameEl(document.body, b));

    unmount();
  });

  test("selectionchange maps CE caret to focused VALUE_TARGET", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });

    const { unmount } = await mountOutline(core, rootId);

    setContentEditableSelection(requireOutlineValueEl(document.body, a), 3);
    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    expectSel(core, { container: rootId, item: a, target: VALUE_TARGET });

    unmount();
  });

  test("selectionchange after gutter click does not overwrite item selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });

    const { unmount } = await mountOutline(core, rootId);

    pointerDown(requireOutlineGutterEl(document.body, a));
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 2);
    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    expectItemRangeSel(core, {
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: a },
    });

    unmount();
  });

  test("cut restores caret to range start after model-owned deletion", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });

    const { unmount } = await mountOutline(core, rootId);

    setContentEditableSelection(requireOutlineValueEl(document.body, a), 1, 4);
    const cut = dispatchClipboardEvent(
      requireOutlineRoot(document.body),
      "cut",
    );
    await flushDomEffects();
    expect(cut.defaultPrevented).toBe(true);

    expectSel(core, { container: rootId, item: a, target: VALUE_TARGET });
    const sel = window.getSelection();
    expect(sel).toBeTruthy();
    expect(sel?.anchorNode).toBeTruthy();
    expect(
      requireOutlineValueEl(document.body, a).contains(sel!.anchorNode),
    ).toBe(true);

    unmount();
  });
});

describe("outline/block-selection", () => {
  test("gutter pointerdown creates single-item item selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    mkBlank(core, rootId, { label: "b", value: "y" });

    const { unmount } = await mountOutline(core, rootId);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, a),
      "pointerdown",
    );
    await flushDomEffects();

    expectItemRangeSel(core, {
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: a },
    });

    unmount();
  });

  test("shift+click gutter extends contiguous same-container block range", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    mkBlank(core, rootId, { label: "b", value: "y" });
    const c = mkBlank(core, rootId, { label: "c", value: "z" });

    const { unmount } = await mountOutline(core, rootId);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, a),
      "pointerdown",
    );
    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, c),
      "pointerdown",
      { shiftKey: true },
    );
    await flushDomEffects();

    expectItemRangeSel(core, {
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: c },
    });

    unmount();
  });

  test("shift+ArrowDown/up extends and shrinks item selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });
    const c = mkBlank(core, rootId, { label: "c", value: "z" });

    const { unmount } = await mountOutline(core, rootId);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, b),
      "pointerdown",
    );
    await flushDomEffects();

    const root = requireOutlineRoot(document.body);
    dispatchKey(root, "ArrowDown", { shiftKey: true });
    await flushDomEffects();
    expectItemRangeSel(core, {
      anchor: { container: rootId, item: b },
      head: { container: rootId, item: c },
    });

    dispatchKey(root, "ArrowUp", { shiftKey: true });
    await flushDomEffects();
    expectItemRangeSel(core, {
      anchor: { container: rootId, item: b },
      head: { container: rootId, item: b },
    });

    dispatchKey(root, "ArrowUp", { shiftKey: true });
    await flushDomEffects();
    expectItemRangeSel(core, {
      anchor: { container: rootId, item: b },
      head: { container: rootId, item: a },
    });

    unmount();
  });

  test("block selected class toggles across selected range", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });

    const { unmount } = await mountOutline(core, rootId);

    const aItem = requireOutlineItemEl(document.body, a);
    const bItem = requireOutlineItemEl(document.body, b);
    expect(aItem.classList.contains("is-block-selected")).toBe(false);
    expect(bItem.classList.contains("is-block-selected")).toBe(false);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, a),
      "pointerdown",
    );
    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, b),
      "pointerdown",
      { shiftKey: true },
    );
    await flushDomEffects();

    expect(aItem.classList.contains("is-block-selected")).toBe(true);
    expect(bItem.classList.contains("is-block-selected")).toBe(true);

    unmount();
  });

  test("Delete removes selected block range", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });
    const c = mkBlank(core, rootId, { label: "c", value: "z" });

    const { unmount } = await mountOutline(core, rootId);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, a),
      "pointerdown",
    );
    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, b),
      "pointerdown",
      { shiftKey: true },
    );
    await flushDomEffects();

    const ev = dispatchKey(requireOutlineRoot(document.body), "Delete");
    await flushDomEffects();
    expect(ev.defaultPrevented).toBe(true);

    expect(childrenOf(core, rootId)).toEqual([c]);

    unmount();
  });
});

describe("outline/vertical-navigation", () => {
  test("ArrowUp/ArrowDown with non-collapsed CE selection are left to native behavior", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: a },
        target: VALUE_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 1, 3);

    const up = dispatchKey(root, "ArrowUp");
    const down = dispatchKey(root, "ArrowDown");
    await flushDomEffects();

    expect(up.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(false);

    const sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe(VALUE_TARGET);

    unmount();
  });

  test("vertical navigation does not interfere with block Shift+Arrow selection extension", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const b = mkBlank(core, rootId, { label: "b", value: "b" });

    const { unmount } = await mountOutline(core, rootId);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, a),
      "pointerdown",
    );
    await flushDomEffects();

    const root = requireOutlineRoot(document.body);
    const ev = dispatchKey(root, "ArrowDown", { shiftKey: true });
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expectItemRangeSel(core, {
      anchor: { container: rootId, item: a },
      head: { container: rootId, item: b },
    });

    unmount();
  });
});

describe("outline/header-embedded", () => {
  test("renders header for labeled item and exposes label target input", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "name", value: "x" });

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const headerEl = itemEl.querySelector(".ui-header") as HTMLElement | null;
    expect(headerEl).toBeTruthy();
    expect(headerEl?.getAttribute("contenteditable")).toBe("false");
    expect(requireTargetInput(itemEl, "label")).toBeTruthy();

    unmount();
  });

  test("connected item header focuses conn:expr and header interactions do not force VALUE", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "calc", value: "x" });
    setFormula(core, a, "1+2");

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const exprInput = requireTargetInput(itemEl, "conn:expr");
    pointerDown(exprInput);
    exprInput.focus();
    await flushDomEffects();

    let sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe("conn:expr");

    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.target).toBe("conn:expr");

    unmount();
  });

  test("conn header Tab does not trigger outline nesting", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "calc", value: "x" });
    setFormula(core, a, "1+2");

    const { unmount } = await mountOutline(core, rootId);

    const beforeKids = [...childrenOf(core, rootId)];
    const itemEl = requireOutlineItemEl(document.body, a);
    const exprInput = requireTargetInput(itemEl, "conn:expr");
    pointerDown(exprInput);
    exprInput.focus();
    await flushDomEffects();

    dispatchKey(exprInput, "Tab");
    await flushDomEffects();

    expect(childrenOf(core, rootId)).toEqual(beforeKids);
    const sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target.startsWith("conn:")).toBe(true);

    unmount();
  });

  test("embedded slider mounts in row and pointerdown keeps slider focus behavior", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "slider", value: 5 });
    setView(core, a, "slider");

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const embeddedBody = itemEl.querySelector(
      ".ui-body.ui-slider",
    ) as HTMLElement | null;
    expect(embeddedBody).toBeTruthy();
    expect(embeddedBody?.getAttribute("contenteditable")).toBe("false");
    const sliderInput = itemEl.querySelector(
      "input[type='range']",
    ) as HTMLInputElement | null;
    expect(sliderInput).toBeTruthy();

    pointerDown(sliderInput!);
    await flushDomEffects();

    const sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe(VALUE_TARGET);
    expect(document.activeElement).toBe(sliderInput);

    unmount();
  });

  test("embedded table mounts in outline row and table cell focus works", async () => {
    const { core, rootId } = makeCoreRuntime();
    const tableId = mkGroup(core, rootId, { label: "t" });
    setView(core, tableId, "table");
    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkGroup(core, tableId, { label: "r2" });
    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });

    const { unmount } = await mountOutline(core, rootId);

    const tableItemEl = requireOutlineItemEl(document.body, tableId);
    const embeddedBody = requireEl(
      tableItemEl.querySelector(".ui-body.ui-table"),
      "Missing embedded table body",
    ) as HTMLElement;
    expect(embeddedBody.getAttribute("contenteditable")).toBe("false");
    expect(embeddedBody.querySelector(".ui-table-body")).toBeTruthy();

    const c11Frame = requireFrameEl(tableItemEl, c11);
    pointerDown(c11Frame);
    await flushDomEffects();
    expectSel(core, { container: r1, item: c11 });

    unmount();
  });
});

describe("outline/drag-integration", () => {
  test("drag pointerdown on outline row shell enters pending state", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    mkBlank(core, rootId, { label: "b", value: "y" });
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);

    const { unmount } = await mountOutline(core, rootId);

    try {
      const aFrame = requireFrameEl(document.body, a);
      dispatchPointerEvent(aFrame, "pointerdown", {
        pointerId: 11,
        clientX: 0,
        clientY: 0,
      });
      const pending = drag.state.value;
      expect(pending.type).toBe("pending");
      expect(document.documentElement.dataset.dragState).toBe("pending");
      const pointerId =
        pending.type === "pending" ? pending.pointerId : undefined;
      cap.emitPointer("pointercancel", pointerId == null ? {} : { pointerId });
      await flushDomEffects();
      expect(document.documentElement.dataset.dragState).toBeUndefined();
      expect(aFrame.classList.contains("is-dragging")).toBe(false);
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });

  test("drag is blocked from outline value, gutter, header, and embedded body zones", async () => {
    const { core, rootId } = makeCoreRuntime();
    const withHeader = mkBlank(core, rootId, { label: "name", value: "x" });
    const withEmbed = mkBlank(core, rootId, { label: "slider", value: 5 });
    setView(core, withEmbed, "slider");
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);

    const { unmount } = await mountOutline(core, rootId);

    try {
      const zones = [
        requireOutlineValueEl(document.body, withHeader),
        requireOutlineGutterEl(document.body, withHeader),
        requireEl(
          requireOutlineItemEl(document.body, withHeader).querySelector(
            ".ui-header",
          ),
          "Missing header",
        ) as HTMLElement,
        requireEl(
          requireOutlineItemEl(document.body, withEmbed).querySelector(
            ".ui-body.ui-slider",
          ),
          "Missing embedded body",
        ) as HTMLElement,
      ];

      let pointerId = 20;
      for (const zone of zones) {
        dispatchPointerEvent(zone, "pointerdown", {
          pointerId,
          clientX: 0,
          clientY: 0,
        });
        expect(drag.state.value.type).toBe("idle");
        cap.emitPointer("pointermove", { pointerId, clientX: 20, clientY: 0 });
        await flushDomEffects();
        expect(document.documentElement.dataset.dragState).toBeUndefined();
        pointerId += 1;
      }
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });

  test("pointercancel cancels pending outline drag without moving items", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);

    const { unmount } = await mountOutline(core, rootId);
    try {
      const aFrame = requireFrameEl(document.body, a);
      dispatchPointerEvent(aFrame, "pointerdown", {
        pointerId: 14,
        clientX: 0,
        clientY: 0,
      });
      const pending = drag.state.value;
      expect(pending.type).toBe("pending");
      const pointerId =
        pending.type === "pending" ? pending.pointerId : undefined;
      cap.emitPointer("pointercancel", pointerId == null ? {} : { pointerId });
      await flushDomEffects();
      expect(document.documentElement.dataset.dragState).toBeUndefined();
      expect(aFrame.classList.contains("is-dragging")).toBe(false);
      expect(childrenOf(core, rootId)).toEqual([a, b]);
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });

  test("pointerup commits seeded active gap drop reorder", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });
    const c = mkBlank(core, rootId, { label: "c", value: "z" });
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);

    const { unmount } = await mountOutline(core, rootId);
    try {
      const aFrame = requireFrameEl(document.body, a);
      const cFrame = requireFrameEl(document.body, c);
      aFrame.classList.add("is-dragging");
      document.documentElement.dataset.dragState = "active";
      drag.state.value = {
        type: "active",
        itemId: a,
        drop: {
          type: "gap",
          parentId: rootId,
          at: 3,
          side: "after",
          axis: "vertical",
          anchorEl: cFrame,
        },
      };

      cap.emitPointer("pointerup", { clientX: 10, clientY: 30 });
      await flushDomEffects();

      expect(childrenOf(core, rootId)).toEqual([b, c, a]);
      expect(document.documentElement.dataset.dragState).toBeUndefined();
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });
});
