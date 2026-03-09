import { effect, signal } from "@preact/signals-core";
import { describe, expect, test } from "bun:test";

import type { ItemId, Selection } from "../src/core";
import { CONTENT_TEXT_TARGET, contentTarget } from "../src/core";
import {
  createDragController,
  createSuppressionFlag,
  type Ctx,
  type UiCore,
} from "../src/dom";
import { createOutlineInputRuntime } from "../src/views/outline/runtime-input";
import { bindOutlineSelectionCleanupEffect } from "../src/views/outline/runtime-selection";
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
  mountLocalView,
  mountView,
  pointerDown,
  requireEl,
  requireFrameEl,
  requireTargetInput,
  setFormula,
  setQuery,
  setView,
  snapshotEl,
  valueOfId,
} from "./dom-test-utils";

function requireOutlineRoot(root: ParentNode): HTMLElement {
  const el = root.querySelector(
    ".ui-body.ui-outline[contenteditable='true']",
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
  const itemEl = root.querySelector(
    `.ui-frame.ui-outline-child[data-id="${id}"]`,
  ) as HTMLElement | null;
  if (itemEl) {
    const valueEl = itemEl.querySelector(
      `.ui-outline-value[data-target="content:text"]`,
    ) as HTMLElement | null;
    if (!valueEl)
      throw new Error(`Missing outline value element for id=${String(id)}`);
    return valueEl;
  }

  const outlineRoot = requireOutlineRoot(root);
  if (outlineRoot.dataset.id !== id)
    throw new Error(`Missing outline value element for id=${String(id)}`);

  const rootValueEl = outlineRoot.querySelector(
    ":scope > .ui-outline-value[data-target='content:text']",
  ) as HTMLElement | null;
  if (rootValueEl) return rootValueEl;

  throw new Error(`Missing outline value element for id=${String(id)}`);
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

function readContentEditableCaret(valueEl: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!valueEl.contains(range.startContainer)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(valueEl);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

function dispatchBeforeInput(
  target: Element,
  inputType: string,
  init: Partial<InputEventInit> & { isComposing?: boolean } = {},
): { defaultPrevented: boolean } {
  const { isComposing, ...eventInit } = init;
  const ev = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType,
    ...eventInit,
  });
  if (typeof isComposing === "boolean") {
    Object.defineProperty(ev, "isComposing", {
      configurable: true,
      value: isComposing,
    });
  }
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
  dropEffect: string;
  effectAllowed: string;
  types: string[];
  setData(type: string, value: string): void;
  getData(type: string): string;
};

function makeMockTransfer(seed?: Record<string, string>): MockTransfer {
  const data = { ...(seed ?? {}) };
  return {
    _data: data,
    dropEffect: "none",
    effectAllowed: "all",
    get types() {
      return Object.keys(data);
    },
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

function dispatchDragStart(target: Element): {
  defaultPrevented: boolean;
  textPlain: string;
  effectAllowed: string;
} {
  const ev = new Event("dragstart", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  const transfer = makeMockTransfer();
  Object.defineProperty(ev, "dataTransfer", {
    value: transfer,
    configurable: true,
  });
  target.dispatchEvent(ev);
  return {
    defaultPrevented: ev.defaultPrevented,
    textPlain: transfer.getData("text/plain"),
    effectAllowed: transfer.effectAllowed,
  };
}

function dispatchDragOver(
  target: Element,
  init: { textPlain?: string } = {},
): { defaultPrevented: boolean; dropEffect: string } {
  const ev = new Event("dragover", {
    bubbles: true,
    cancelable: true,
  }) as DragEvent;
  const transfer = makeMockTransfer(
    init.textPlain != null ? { "text/plain": init.textPlain } : undefined,
  );
  Object.defineProperty(ev, "dataTransfer", {
    value: transfer,
    configurable: true,
  });
  target.dispatchEvent(ev);
  return {
    defaultPrevented: ev.defaultPrevented,
    dropEffect: transfer.dropEffect,
  };
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
  location: { item: ItemId; portals: readonly ItemId[] } = {
    item: rootId,
    portals: [],
  },
): Promise<{
  unmount: Awaited<ReturnType<typeof mountView>>["unmount"];
  root: HTMLElement;
}> {
  const mounted = await mountView({
    view: "outline",
    core,
    id: rootId,
    location,
  });
  return { ...mounted, root: requireOutlineRoot(document.body) };
}

async function mountLocalOutline(
  core: UiCore,
  rootId: ItemId,
  location: { item: ItemId; portals: readonly ItemId[] } = {
    item: rootId,
    portals: [],
  },
): Promise<{
  domView: Awaited<ReturnType<typeof mountLocalView>>["domView"];
  unmount: Awaited<ReturnType<typeof mountLocalView>>["unmount"];
  root: HTMLElement;
}> {
  const mounted = await mountLocalView({
    view: "outline",
    core,
    id: rootId,
    location,
  });
  return { ...mounted, root: requireOutlineRoot(document.body) };
}

function expectItemRangeSel(
  core: { selection(): ReturnType<UiCore["selection"]> },
  want: {
    anchor: { item: ItemId; portals: readonly ItemId[] };
    head: { item: ItemId; portals: readonly ItemId[] };
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
      anchor: { item: rootId, portals: [] },
      head: { item: rootId, portals: [] },
    });

    const { unmount, root } = await mountOutline(core, rootId);

    expect(root.isContentEditable).toBe(true);
    expect(root.classList.contains("ui-body")).toBe(true);
    expect(root.classList.contains("ui-outline")).toBe(true);
    expect(root.dataset.id).toBe(rootId);
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
    expect(gEl.firstElementChild).toBe(gutterEl);
    expect(
      gEl.lastElementChild instanceof HTMLElement &&
        gEl.lastElementChild.matches(".ui-body.ui-outline"),
    ).toBe(true);
    expect(gutterEl).toBeTruthy();
    expect(gutterEl?.getAttribute("contenteditable")).toBe("false");
    expect(valueEl.dataset.target).toBe("content:text");
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
      `.ui-outline-value[data-target="content:text"]`,
    ) as HTMLElement | null;
    const sliderInput = itemEl.querySelector(
      "input[type='range']",
    ) as HTMLInputElement | null;

    expect(sliderInput).toBeTruthy();
    expect(valueEl).toBeNull();

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

  test("scalar root renders direct outline value without row frame", async () => {
    const { core, rootId } = makeCoreRuntime();
    core.commit((t) => t.setValue(rootId, "root"));

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);

    const directValue = Array.from(root.children).find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.matches(".ui-outline-value[data-target='content:text']"),
    );
    expect(directValue).toBeTruthy();
    expect(root.children.length).toBe(1);
    expect(root.querySelector(".ui-frame.ui-outline-child")).toBeNull();

    unmount();
  });
});

describe("outline/item-intents", () => {
  test("Enter on empty group creates first child and enters content:text", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    core.focus({
      type: "item",
      anchor: { item: g, portals: [] },
      head: { item: g, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Enter");
    await flushDomEffects();

    const kids = childrenOf(core, g);
    expect(kids.length).toBe(1);
    expectSel(core, {
      item: kids[0]!,
      target: CONTENT_TEXT_TARGET,
      portals: [],
    });
    expect(valueOfId(core, kids[0]!)).toBe(null);

    unmount();
  });

  test("Enter on non-empty group focuses first child item", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "x" });
    mkBlank(core, g, { label: "b", value: "y" });
    core.focus({
      type: "item",
      anchor: { item: g, portals: [] },
      head: { item: g, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Enter");
    await flushDomEffects();

    expectSel(core, { item: a, portals: [] });

    unmount();
  });

  test("Cmd+Enter on item selection inserts sibling in same parent", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "x" });
    const z = mkBlank(core, rootId, { label: "z", value: "tail" });
    core.focus({
      type: "item",
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Enter", { metaKey: true });
    await flushDomEffects();

    const gKids = childrenOf(core, g);
    expect(gKids).toEqual([a, gKids[1]!]);
    expect(childrenOf(core, rootId)).toEqual([g, z]);
    expect(valueOfId(core, gKids[1]!)).toBe(null);
    expectSel(core, {
      item: gKids[1]!,
      target: CONTENT_TEXT_TARGET,
      portals: [],
    });

    unmount();
  });

  test("Cmd+Shift+Enter on last child inserts after parent", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: "x" });
    const b = mkBlank(core, g, { label: "b", value: "y" });
    const z = mkBlank(core, rootId, { label: "z", value: "tail" });
    core.focus({
      type: "item",
      anchor: { item: b, portals: [] },
      head: { item: b, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Enter", { metaKey: true, shiftKey: true });
    await flushDomEffects();

    const rootKids = childrenOf(core, rootId);
    expect(rootKids[0]).toBe(g);
    expect(rootKids[2]).toBe(z);
    const inserted = rootKids[1]!;
    expect(valueOfId(core, inserted)).toBe(null);
    expectSel(core, {
      item: inserted,
      target: CONTENT_TEXT_TARGET,
      portals: [],
    });

    unmount();
  });

  test("Cmd+Shift+Enter on non-last child is a no-op", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "x" });
    const b = mkBlank(core, g, { label: "b", value: "y" });
    core.focus({
      type: "item",
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Enter", { metaKey: true, shiftKey: true });
    await flushDomEffects();

    expect(childrenOf(core, g)).toEqual([a, b]);
    expectSel(core, { item: a, portals: [] });

    unmount();
  });

  test("Enter on embedded leaf item selection enters primary control target", async () => {
    const CONTENT_SLIDER_TARGET = contentTarget("slider");
    const { core, rootId } = makeCoreRuntime();
    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");
    core.focus({
      type: "item",
      anchor: { item: s, portals: [] },
      head: { item: s, portals: [] },
    });

    const { unmount } = await mountOutline(core, rootId);

    core.dispatch({ type: "CONFIRM" });
    await flushDomEffects();

    expectSel(core, { item: s, target: CONTENT_SLIDER_TARGET, portals: [] });

    unmount();
  });

  test("TYPE from block inserts first char into value", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus({
      type: "item",
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    const { unmount } = await mountOutline(core, rootId);

    core.dispatch({ type: "TYPE", char: "x" });
    await flushDomEffects();

    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(valueOfId(core, a)).toBe("x");

    unmount();
  });

  test("NAV from item focus uses sibling geometry with right fallthrough", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "aa" });
    const b = mkBlank(core, g, { label: "b", value: "bb" });
    mkBlank(core, rootId, { label: "c", value: "cc" });
    core.focus({
      type: "item",
      anchor: { item: g, portals: [] },
      head: { item: g, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: a, portals: [] });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: b, portals: [] });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: b, portals: [] });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { item: g, portals: [] });

    unmount();
  });

  test("NAV boundaries from top/root no-op", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    core.focus({
      type: "item",
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { item: a, portals: [] });

    core.focus({
      type: "item",
      anchor: { item: rootId, portals: [] },
      head: { item: rootId, portals: [] },
    });
    await flushDomEffects();
    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { item: rootId, portals: [] });

    unmount();
  });

  test("DELETE on a non-last item lands on the next sibling", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const b = mkBlank(core, rootId, { label: "b", value: "b" });
    const c = mkBlank(core, rootId, { label: "c", value: "c" });
    core.focus({
      type: "item",
      anchor: { item: b, portals: [] },
      head: { item: b, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(childrenOf(core, rootId)).toEqual([a, c]);
    expectSel(core, { item: c, portals: [] });

    unmount();
  });

  test("DELETE on the last item lands on the previous sibling", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const b = mkBlank(core, rootId, { label: "b", value: "b" });
    core.focus({
      type: "item",
      anchor: { item: b, portals: [] },
      head: { item: b, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(childrenOf(core, rootId)).toEqual([a]);
    expectSel(core, { item: a, portals: [] });

    unmount();
  });

  test("DELETE on sole child of non-root group lands on sibling of pruned group", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "x" });
    const z = mkBlank(core, rootId, { label: "z", value: "z" });
    core.focus({
      type: "item",
      anchor: { item: x, portals: [] },
      head: { item: x, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(childrenOf(core, rootId)).toEqual([a, z]);
    expectSel(core, { item: z, portals: [] });

    unmount();
  });

  test("DELETE on sole child of nested sole-child groups lands on sibling of outer pruned group", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const outer = mkGroup(core, rootId, { label: "outer" });
    const inner = mkGroup(core, outer, { label: "inner" });
    const x = mkBlank(core, inner, { label: "x", value: "x" });
    const z = mkBlank(core, rootId, { label: "z", value: "z" });
    core.focus({
      type: "item",
      anchor: { item: x, portals: [] },
      head: { item: x, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(childrenOf(core, rootId)).toEqual([a, z]);
    expectSel(core, { item: z, portals: [] });

    unmount();
  });

  test("DELETE on final remaining item keeps selection valid", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    core.focus({
      type: "item",
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(valueOfId(core, rootId)).toBeNull();
    expectSel(core, { item: rootId, portals: [] });

    unmount();
  });

  test("DELETE in a multi-child group still lands on next sibling", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "x" });
    const y = mkBlank(core, g, { label: "y", value: "y" });
    const z = mkBlank(core, g, { label: "z", value: "z" });
    core.focus({
      type: "item",
      anchor: { item: y, portals: [] },
      head: { item: y, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(childrenOf(core, g)).toEqual([x, z]);
    expectSel(core, { item: z, portals: [] });

    unmount();
  });

  test("DELETE on a block selection lands on the item after the block", async () => {
    const { core, rootId } = makeCoreRuntime();
    mkBlank(core, rootId, { label: "a", value: "a" });
    const b = mkBlank(core, rootId, { label: "b", value: "b" });
    const c = mkBlank(core, rootId, { label: "c", value: "c" });
    const d = mkBlank(core, rootId, { label: "d", value: "d" });
    core.focus({
      type: "item",
      anchor: { item: b, portals: [] },
      head: { item: c, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expectSel(core, { item: d, portals: [] });

    unmount();
  });

  test("DELETE on a trailing block selection lands on previous surviving sibling", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const b = mkBlank(core, rootId, { label: "b", value: "b" });
    const c = mkBlank(core, rootId, { label: "c", value: "c" });
    core.focus({
      type: "item",
      anchor: { item: b, portals: [] },
      head: { item: c, portals: [] },
    });

    const { domView, unmount } = await mountLocalOutline(core, rootId);

    fireViewKey(domView, "Delete");
    await flushDomEffects();

    expect(childrenOf(core, rootId)).toEqual([a]);
    expectSel(core, { item: a, portals: [] });

    unmount();
  });

  test("ArrowRight from outline content:text enters embedded view as item selection, ArrowLeft returns to content:text", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    const slider = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, slider, "slider");
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 2);

    dispatchKey(outlineRoot, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: slider, portals: [] });

    dispatchKey(outlineRoot, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("ArrowRight/ArrowLeft boundary traversal uses item stop for embedded table rows", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    const tableId = mkGroup(core, rootId, { label: "t" });
    setView(core, tableId, "table");
    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkBlank(core, r1, { label: "c1", value: 1 });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 2);

    dispatchKey(outlineRoot, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: tableId, portals: [] });

    dispatchKey(outlineRoot, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("ArrowRight from outline content:text lands on connected item stop, not conn field", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    const formula = mkBlank(core, rootId, { label: "f", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "cd" });
    setFormula(core, formula, "1+2");
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 2);

    dispatchKey(outlineRoot, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: formula, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, formula), "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: b, portals: [] });

    core.dispatch({ type: "CONFIRM" });
    await flushDomEffects();
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("query parent is an item stop even when it exposes child leaves", async () => {
    const { core, rootId } = makeCoreRuntime();
    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: "one" });
    mkBlank(core, rows, { label: "r2", value: "two" });
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    const query = mkBlank(core, rootId, { label: "q", value: "x" });
    setQuery(core, query, { from: "rows" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 2);

    dispatchKey(outlineRoot, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { item: query, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, query), "ArrowRight");
    await flushDomEffects();
    const sel = core.selection();
    expect(sel.type).toBe("item");
    if (sel.type !== "item") throw new Error("Expected item selection");
    const firstChild = childrenOf(core, query)[0];
    if (!firstChild) throw new Error("Expected query child");
    expect(sel.head.item).toBe(firstChild);

    unmount();
  });

  test("Tab/Shift+Tab keydown uses in-place body transforms", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "v" });
    core.focus(
      {
        type: "editing",
        location: { item: x, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
    expectSel(core, { item: child, target: CONTENT_TEXT_TARGET, portals: [] });

    const secondTab = dispatchKey(outlineRoot, "Tab", { shiftKey: true });
    await flushDomEffects();
    expect(secondTab.defaultPrevented).toBe(true);
    expect(core.item(x).content.type).toBe("value");
    expect(valueOfId(core, x)).toBe("v");
    expectSel(core, { item: x, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("Tab structural transform stays isolated from surrounding text undo", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "a" });
    core.focus(
      {
        type: "editing",
        location: { item: x, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const outlineRoot = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, x);

    setContentEditableSelection(valueEl, 1);
    valueEl.textContent = "ab";
    await flushDomEffects();
    expect(valueOfId(core, x)).toBe("ab");

    const tab = dispatchKey(outlineRoot, "Tab");
    await flushDomEffects();
    expect(tab.defaultPrevented).toBe(true);
    expect(core.item(x).content.type).toBe("group");

    core.undo();
    expect(core.item(x).content.type).toBe("value");
    expect(valueOfId(core, x)).toBe("ab");

    core.undo();
    expect(valueOfId(core, x)).toBe("a");

    unmount();
  });

  test("Escape from CONTENT_TEXT_TARGET exits to same-item block", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aValue = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValue, 2);
    const ev = dispatchKey(requireOutlineRoot(document.body), "Escape");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expectSel(core, { item: a, portals: [] });
    expect(document.activeElement).toBe(requireOutlineItemEl(document.body, a));
    const domSel = window.getSelection();
    expect(domSel?.rangeCount ?? 0).toBe(0);

    unmount();
  });

  test("Tab keydown resets sticky caret before applying the body transform", () => {
    const { core, rootId } = makeCoreRuntime();
    const item = mkBlank(core, rootId, { label: "x", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const root = document.createElement("div");
    root.className = "ui-body ui-outline";
    root.setAttribute("contenteditable", "true");
    const itemEl = document.createElement("div");
    itemEl.className = "ui-frame ui-outline-child";
    itemEl.dataset.id = item;
    const valueEl = document.createElement("span");
    valueEl.className = "ui-outline-value";
    valueEl.dataset.target = CONTENT_TEXT_TARGET;
    valueEl.textContent = "hello";
    itemEl.append(valueEl);
    root.append(itemEl);
    document.body.replaceChildren(root);
    setContentEditableSelection(valueEl, 0);

    let stickyResets = 0;
    const onValueTabCalls: Array<
      [{ item: ItemId; portals: readonly ItemId[] }, boolean, number]
    > = [];
    const runtime = createOutlineInputRuntime({
      core,
      rootId,
      portals: [],
      root,
      stops: signal([]),
      resetStickyCaretX: () => {
        stickyResets += 1;
      },
      discardPendingMutationRecords: () => {},
      suppressMutationSync: createSuppressionFlag(false),
      suppressHistoryKeydown: createSuppressionFlag<"undo" | "redo" | null>(
        null,
      ),
      selection: {
        suppressSelectionSync: createSuppressionFlag(false),
        clearValueRangeSelectedItems: () => {},
        setValueSelectionRangeState: () => {},
      },
    });
    const disposers: Array<() => void> = [];
    const on: Ctx["on"] = (
      target: EventTarget,
      type: string,
      handler: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler as EventListener, options);
      disposers.push(() => {
        target.removeEventListener(type, handler as EventListener, options);
      });
    };
    runtime.bind({
      on,
      getCompositionEndedAt: () => 0,
      setCompositionEndedAt: () => {},
      getStickyCaretX: () => 45,
      setStickyCaretX: () => {},
      resetStickyCaretX: () => {
        stickyResets += 1;
      },
      onValueTab: (location, shift, caret) => {
        onValueTabCalls.push([location, shift, caret]);
      },
      setIsComposing: () => {},
    });

    const ev = dispatchKey(valueEl, "Tab");

    expect(ev.defaultPrevented).toBe(true);
    expect(stickyResets).toBe(1);
    expect(onValueTabCalls).toEqual([[{ item, portals: [] }, false, 0]]);

    for (const dispose of disposers) dispose();
  });
});

describe("outline/embedded-routing", () => {
  test("Cmd+Enter from embedded control editing inserts sibling in same parent", async () => {
    const CONTENT_SLIDER_TARGET = contentTarget("slider");
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const s = mkBlank(core, g, { label: "s", value: 5 });
    mkBlank(core, rootId, { label: "z", value: "tail" });
    setView(core, s, "slider");
    core.focus(
      {
        type: "editing",
        location: { item: s, portals: [] },
        target: CONTENT_SLIDER_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const sliderInput = requireOutlineItemEl(document.body, s).querySelector(
      "input[type='range']",
    ) as HTMLInputElement | null;
    expect(sliderInput).toBeTruthy();

    dispatchKey(sliderInput!, "Enter", { metaKey: true });
    await flushDomEffects();

    const gKids = childrenOf(core, g);
    const inserted = gKids[1]!;
    expect(valueOfId(core, inserted)).toBe(null);
    expectSel(core, {
      item: inserted,
      target: CONTENT_TEXT_TARGET,
      portals: [],
    });

    unmount();
  });

  test("Cmd+Shift+Enter from embedded control editing inserts after parent at valid edge", async () => {
    const CONTENT_SLIDER_TARGET = contentTarget("slider");
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: "x" });
    const s = mkBlank(core, g, { label: "s", value: 5 });
    const z = mkBlank(core, rootId, { label: "z", value: "tail" });
    setView(core, s, "slider");
    core.focus(
      {
        type: "editing",
        location: { item: s, portals: [] },
        target: CONTENT_SLIDER_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const sliderInput = requireOutlineItemEl(document.body, s).querySelector(
      "input[type='range']",
    ) as HTMLInputElement | null;
    expect(sliderInput).toBeTruthy();

    dispatchKey(sliderInput!, "Enter", { metaKey: true, shiftKey: true });
    await flushDomEffects();

    const rootKids = childrenOf(core, rootId);
    expect(rootKids[0]).toBe(g);
    expect(rootKids[2]).toBe(z);
    const inserted = rootKids[1]!;
    expect(valueOfId(core, inserted)).toBe(null);
    expectSel(core, {
      item: inserted,
      target: CONTENT_TEXT_TARGET,
      portals: [],
    });

    unmount();
  });
});

describe("outline/contenteditable-beforeinput", () => {
  test("beforeinput insertParagraph splits item at selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });

    core.undo();
    await flushDomEffects();
    expect(childrenOf(core, rootId)).toEqual([a]);
    expect(valueOfId(core, a)).toBe("hello");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, a)),
    ).toBe(2);

    core.redo();
    await flushDomEffects();
    expect(childrenOf(core, rootId)).toEqual([a, b]);
    expect(valueOfId(core, a)).toBe("he");
    expect(valueOfId(core, b)).toBe("llo");
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("Cmd+Enter inserts a blank sibling item from text editing", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "hello" });
    const z = mkBlank(core, rootId, { label: "z", value: "tail" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchKey(aValueEl, "Enter", { metaKey: true });
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("hello");

    const gKids = childrenOf(core, g);
    expect(gKids[0]).toBe(a);
    expect(gKids[2]).toBeUndefined();
    expect(childrenOf(core, rootId)).toEqual([g, z]);
    const b = gKids[1]!;
    expect(valueOfId(core, b)).toBe(null);
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("Cmd+Shift+Enter inserts after parent from text editing at valid edge", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "hello" });
    const z = mkBlank(core, rootId, { label: "z", value: "tail" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchKey(aValueEl, "Enter", {
      metaKey: true,
      shiftKey: true,
    });
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("hello");

    const rootKids = childrenOf(core, rootId);
    expect(rootKids[0]).toBe(g);
    expect(rootKids[2]).toBe(z);
    const b = rootKids[1]!;
    expect(valueOfId(core, b)).toBe(null);
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("Cmd+Shift+Enter from text editing is a no-op when not at last child", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "hello" });
    const b = mkBlank(core, g, { label: "b", value: "tail" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchKey(aValueEl, "Enter", {
      metaKey: true,
      shiftKey: true,
    });
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(childrenOf(core, g)).toEqual([a, b]);
    expect(valueOfId(core, a)).toBe("hello");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("beforeinput insertParagraph with non-collapsed single-item selection splits using range end", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 1, 4);
    const ev = dispatchBeforeInput(outlineRoot, "insertParagraph");
    await flushDomEffects();
    expect(ev.defaultPrevented).toBe(true);

    const kids = childrenOf(core, rootId);
    const aIdx = kids.indexOf(a);
    const b = kids[aIdx + 1]!;
    expect(valueOfId(core, a)).toBe("h");
    expect(valueOfId(core, b)).toBe("o");
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, b)),
    ).toBe(0);

    unmount();
  });

  test("beforeinput insertParagraph with non-collapsed multi-item selection deletes range then splits", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    const b = mkBlank(core, rootId, { label: "b", value: "world" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const aValueEl = requireOutlineValueEl(document.body, a);
    const bValueEl = requireOutlineValueEl(document.body, b);
    const bText = bValueEl.firstChild as Text | null;
    const sel = window.getSelection();
    expect(sel).toBeTruthy();
    expect(bText).toBeTruthy();
    const range = document.createRange();
    range.setStart(aValueEl.firstChild ?? aValueEl, 2);
    range.setEnd(bText ?? bValueEl, 3);
    sel!.removeAllRanges();
    sel!.addRange(range);

    const outlineRoot = requireOutlineRoot(document.body);
    const ev = dispatchBeforeInput(outlineRoot, "insertParagraph");
    await flushDomEffects();
    expect(ev.defaultPrevented).toBe(true);

    const kids = childrenOf(core, rootId);
    expect(kids.length).toBe(2);
    expect(kids[0]).toBe(a);
    const c = kids[1]!;
    expect(c).not.toBe(b);
    expect(valueOfId(core, a)).toBe("he");
    expect(valueOfId(core, c)).toBe("ld");
    expectSel(core, { item: c, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("beforeinput insertLineBreak inserts newline in-place", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("deleteContentForward at boundary joins with next sibling", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "aa" });
    mkBlank(core, rootId, { label: "b", value: "bb" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchBeforeInput(outlineRoot, "deleteContentForward");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(childrenOf(core, rootId)).toEqual([a]);
    expect(valueOfId(core, a)).toBe("aabb");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, a)),
    ).toBe(2);

    unmount();
  });

  test("deleteContentBackward on final empty leaf clears outline root to blank and repairs selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
    expectSel(core, { item: rootId, portals: [] });

    dispatchKey(outlineRoot, "Tab");
    await flushDomEffects();
    expectSel(core, { item: rootId, portals: [] });

    unmount();
  });

  test("deleteContentBackward on empty sole-child prunes ancestor and lands on previous edit stop", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "aa" });
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "" });
    const z = mkBlank(core, rootId, { label: "z", value: "zz" });
    core.focus(
      {
        type: "editing",
        location: { item: x, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, x), 0);
    const ev = dispatchBeforeInput(outlineRoot, "deleteContentBackward");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(childrenOf(core, rootId)).toEqual([a, z]);
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("deleteContentBackward at boundary joins siblings and keeps focus on survivor", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "aa" });
    const b = mkBlank(core, g, { label: "b", value: "bb" });
    core.focus(
      {
        type: "editing",
        location: { item: b, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, b), 0);
    const ev = dispatchBeforeInput(outlineRoot, "deleteContentBackward");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(childrenOf(core, g)).toEqual([a]);
    expect(valueOfId(core, a)).toBe("aabb");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    core.undo();
    await flushDomEffects();
    expect(childrenOf(core, g)).toEqual([a, b]);
    expect(valueOfId(core, a)).toBe("aa");
    expect(valueOfId(core, b)).toBe("bb");
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("nested outline root: final leaf delete clears nested root and repairs to parent item selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const nestedRoot = mkGroup(core, rootId, { label: "nested" });
    const a = mkBlank(core, nestedRoot, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, nestedRoot, {
      item: nestedRoot,
      portals: [],
    });

    const outlineRoot = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 0);
    const ev = dispatchBeforeInput(outlineRoot, "deleteContentBackward");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(valueOfId(core, nestedRoot)).toBeNull();
    expectSel(core, { item: nestedRoot, portals: [] });

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
          child.matches(`.ui-outline-value[data-target="content:text"]`),
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

  test("beforeinput insertCompositionText is not prevented while composing", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const outlineRoot = requireOutlineRoot(document.body);
    const aValueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(aValueEl, 2);
    const ev = dispatchBeforeInput(outlineRoot, "insertCompositionText", {
      isComposing: true,
    });
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(false);

    unmount();
  });

  test("beforeinput insertFromDrop is prevented when external drop text handled", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
  test("copy and cut single-item contenteditable selection use model text/plain semantics", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

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

  test("dragstart and dragover use plain-text copy semantics", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1, 4);

    const dragStart = dispatchDragStart(valueEl);
    expect(dragStart.textPlain).toBe("ell");
    expect(dragStart.effectAllowed).toBe("copy");

    const dragOver = dispatchDragOver(root, { textPlain: "X" });
    expect(dragOver.defaultPrevented).toBe(true);
    expect(dragOver.dropEffect).toBe("copy");

    unmount();
  });

  test("paste and drop insert external text into current selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "ab" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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

  test("internal drag/drop copies text without deleting the source selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1, 4);

    const dragStart = dispatchDragStart(valueEl);
    expect(dragStart.textPlain).toBe("ell");

    setContentEditableSelection(valueEl, 5);
    const drop = dispatchDropText(root, dragStart.textPlain);
    await flushDomEffects();

    expect(drop.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("helloell");

    unmount();
  });

  test("multi-line paste creates sibling items", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 2);

    const paste = dispatchClipboardEvent(root, "paste", {
      textPlain: "foo\nbar",
    });
    await flushDomEffects();
    expect(paste.defaultPrevented).toBe(true);

    const kids = childrenOf(core, rootId);
    const aIdx = kids.indexOf(a);
    const b = kids[aIdx + 1]!;

    expect(valueOfId(core, a)).toBe("hefoo");
    expect(valueOfId(core, b)).toBe("barllo");
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, b)),
    ).toBe(3);

    unmount();
  });

  test("multi-line drop creates sibling items", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 2);

    const drop = dispatchDropText(root, "foo\nbar");
    await flushDomEffects();
    expect(drop.defaultPrevented).toBe(true);

    const kids = childrenOf(core, rootId);
    const aIdx = kids.indexOf(a);
    const b = kids[aIdx + 1]!;

    expect(valueOfId(core, a)).toBe("hefoo");
    expect(valueOfId(core, b)).toBe("barllo");
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, b)),
    ).toBe(3);

    unmount();
  });

  test("multi-line paste undo/redo is atomic", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 2);

    const paste = dispatchClipboardEvent(root, "paste", {
      textPlain: "foo\nbar",
    });
    await flushDomEffects();
    expect(paste.defaultPrevented).toBe(true);

    const kids = childrenOf(core, rootId);
    const aIdx = kids.indexOf(a);
    const b = kids[aIdx + 1]!;

    expect(valueOfId(core, a)).toBe("hefoo");
    expect(valueOfId(core, b)).toBe("barllo");

    core.undo();
    await flushDomEffects();
    expect(childrenOf(core, rootId)).toEqual([a]);
    expect(valueOfId(core, a)).toBe("hello");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, a)),
    ).toBe(2);

    core.redo();
    await flushDomEffects();
    const redoneKids = childrenOf(core, rootId);
    const redoneAIdx = redoneKids.indexOf(a);
    const redoneB = redoneKids[redoneAIdx + 1]!;
    expect(valueOfId(core, a)).toBe("hefoo");
    expect(valueOfId(core, redoneB)).toBe("barllo");
    expectSel(core, {
      item: redoneB,
      target: CONTENT_TEXT_TARGET,
      portals: [],
    });
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, redoneB)),
    ).toBe(3);

    unmount();
  });

  test("paste into non-collapsed single-item selection replaces range", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1, 4);

    const paste = dispatchClipboardEvent(root, "paste", { textPlain: "X" });
    await flushDomEffects();
    expect(paste.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("hXo");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("drop into non-collapsed single-item selection replaces range", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 1, 4);

    const drop = dispatchDropText(root, "X");
    await flushDomEffects();
    expect(drop.defaultPrevented).toBe(true);
    expect(valueOfId(core, a)).toBe("hXo");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("paste/drop are isolated undo steps from surrounding typing", async () => {
    const runCase = async (kind: "paste" | "drop"): Promise<void> => {
      const { core, rootId } = makeCoreRuntime();
      const a = mkBlank(core, rootId, { label: "a", value: "ab" });
      core.focus(
        {
          type: "editing",
          location: { item: a, portals: [] },
          target: CONTENT_TEXT_TARGET,
        },
        { caret: 1 },
      );

      const { unmount } = await mountOutline(core, rootId);
      const root = requireOutlineRoot(document.body);
      const valueEl = requireOutlineValueEl(document.body, a);

      setContentEditableSelection(valueEl, 1);
      valueEl.textContent = "a0b";
      await flushDomEffects();
      expect(valueOfId(core, a)).toBe("a0b");

      setContentEditableSelection(valueEl, 2);
      if (kind === "paste")
        expect(
          dispatchClipboardEvent(root, "paste", { textPlain: "X" })
            .defaultPrevented,
        ).toBe(true);
      else expect(dispatchDropText(root, "X").defaultPrevented).toBe(true);
      await flushDomEffects();
      expect(valueOfId(core, a)).toBe("a0Xb");

      setContentEditableSelection(valueEl, 3);
      valueEl.textContent = "a0X1b";
      await flushDomEffects();
      expect(valueOfId(core, a)).toBe("a0X1b");

      core.undo();
      expect(valueOfId(core, a)).toBe("a0Xb");

      core.undo();
      expect(valueOfId(core, a)).toBe("a0b");

      core.undo();
      expect(valueOfId(core, a)).toBe("ab");

      unmount();
    };

    await runCase("paste");
    await runCase("drop");
  });
});

describe("outline/ime-mutation", () => {
  test("structural keydown is ignored while key event is composing", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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

  test("Enter immediately after compositionend is suppressed", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 2);
    dispatchComposition(root, "compositionend");

    const ev = dispatchKey(root, "Enter");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expect(childrenOf(core, rootId)).toEqual([a]);
    expect(valueOfId(core, a)).toBe("hello");

    unmount();
  });

  test("mutation sync ignores transient br-only contenteditable noise", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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

  test("mutation sync preserves blank lines and trailing newline from contenteditable DOM", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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

  test("composition boundaries isolate prior typing from composition edits", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);

    setContentEditableSelection(valueEl, 1);
    valueEl.textContent = "ab";
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("ab");

    dispatchComposition(root, "compositionstart");
    valueEl.textContent = "abx";
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("ab");

    dispatchComposition(root, "compositionend");
    valueEl.textContent = "abx";
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("abx");

    core.undo();
    expect(valueOfId(core, a)).toBe("ab");

    core.undo();
    expect(valueOfId(core, a)).toBe("a");

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
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
        location: { item: b, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );
    await flushDomEffects();

    expectSnapshotSame(snapA, requireFrameEl(document.body, a));
    expectSnapshotSame(snapB, requireFrameEl(document.body, b));

    unmount();
  });

  test("selectionchange maps contenteditable caret to focused CONTENT_TEXT_TARGET", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });

    const { unmount } = await mountOutline(core, rootId);

    setContentEditableSelection(requireOutlineValueEl(document.body, a), 3);
    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("scalar root value selectionchange maps to root editing selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    core.commit((t) => t.setValue(rootId, "hello"));

    const { unmount } = await mountOutline(core, rootId);
    const rootValueEl = requireOutlineValueEl(document.body, rootId);

    setContentEditableSelection(rootValueEl, 2);
    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    expectSel(core, { item: rootId, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("selection cleanup clears sticky caret when selection leaves content:text", () => {
    const item = "a" as ItemId;
    const selection = signal<Selection>({
      type: "editing",
      location: { item, portals: [] },
      target: CONTENT_TEXT_TARGET,
    });
    const valueSelectionCollapsed = signal(true);
    let stickyClears = 0;
    let rangeClears = 0;
    const disposers: Array<() => void> = [];

    bindOutlineSelectionCleanupEffect({
      effect: (fn) => {
        disposers.push(effect(fn));
      },
      core: { selection: () => selection.value } as UiCore,
      valueSelectionCollapsed,
      resetStickyCaretX: () => {
        stickyClears += 1;
      },
      clearValueRangeSelectedItems: () => {
        rangeClears += 1;
      },
    });

    stickyClears = 0;
    rangeClears = 0;
    selection.value = {
      type: "item",
      anchor: { item, portals: [] },
      head: { item, portals: [] },
    };

    expect(stickyClears).toBe(1);
    expect(rangeClears).toBe(1);

    for (const dispose of disposers) dispose();
  });

  test("selection cleanup clears sticky caret for non-collapsed content:text selection", () => {
    const item = "a" as ItemId;
    const selection = signal<Selection>({
      type: "editing",
      location: { item, portals: [] },
      target: CONTENT_TEXT_TARGET,
    });
    const valueSelectionCollapsed = signal(true);
    let stickyClears = 0;
    let rangeClears = 0;
    const disposers: Array<() => void> = [];

    bindOutlineSelectionCleanupEffect({
      effect: (fn) => {
        disposers.push(effect(fn));
      },
      core: { selection: () => selection.value } as UiCore,
      valueSelectionCollapsed,
      resetStickyCaretX: () => {
        stickyClears += 1;
      },
      clearValueRangeSelectedItems: () => {
        rangeClears += 1;
      },
    });

    stickyClears = 0;
    rangeClears = 0;
    valueSelectionCollapsed.value = false;

    expect(stickyClears).toBe(1);
    expect(rangeClears).toBe(0);

    valueSelectionCollapsed.value = true;

    expect(stickyClears).toBe(1);
    expect(rangeClears).toBe(1);

    for (const dispose of disposers) dispose();
  });

  test("ArrowLeft at start of first value stays editing with caret preserved", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    const valueEl = requireOutlineValueEl(document.body, a);

    setContentEditableSelection(valueEl, 0);
    const ev = dispatchKey(root, "ArrowLeft");
    await flushDomEffects();

    expect(ev.defaultPrevented).toBe(true);
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(readContentEditableCaret(valueEl)).toBe(0);

    unmount();
  });

  test("pointerup fallback syncs to editing when no selectionchange fires in pointer cycle", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });

    const { unmount } = await mountOutline(core, rootId);

    core.focus({
      type: "item",
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });
    await flushDomEffects();

    const valueEl = requireOutlineValueEl(document.body, a);
    setContentEditableSelection(valueEl, 2);

    dispatchPointerEvent(valueEl, "pointerdown", { pointerId: 7 });
    dispatchPointerEvent(document, "pointerup", { pointerId: 7 });
    await flushDomEffects();

    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("pointerup fallback is skipped for item-intent pointer cycle", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });

    const { unmount } = await mountOutline(core, rootId);
    const gutterEl = requireOutlineGutterEl(document.body, a);
    const valueEl = requireOutlineValueEl(document.body, a);

    dispatchPointerEvent(gutterEl, "pointerdown", { pointerId: 41 });
    setContentEditableSelection(valueEl, 2);
    dispatchPointerEvent(document, "pointerup", { pointerId: 41 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushDomEffects();

    expectItemRangeSel(core, {
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    unmount();
  });

  test("new pointer cycle invalidates pending pointer finalize fallback", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "alpha" });
    const b = mkBlank(core, rootId, { label: "b", value: "beta" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const aValueEl = requireOutlineValueEl(document.body, a);
    const bValueEl = requireOutlineValueEl(document.body, b);

    dispatchPointerEvent(aValueEl, "pointerdown", { pointerId: 42 });
    setContentEditableSelection(bValueEl, 2);
    dispatchPointerEvent(document, "pointerup", { pointerId: 42 });

    dispatchPointerEvent(aValueEl, "pointerdown", { pointerId: 43 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushDomEffects();

    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("pointerup fallback clears stale multi-item range when collapse has no trailing selectionchange", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "alpha" });
    const b = mkBlank(core, rootId, { label: "b", value: "beta" });

    const { unmount } = await mountOutline(core, rootId);

    const aValueEl = requireOutlineValueEl(document.body, a);
    const bValueEl = requireOutlineValueEl(document.body, b);
    const aText = aValueEl.firstChild as Text;
    const bText = bValueEl.firstChild as Text;
    const domSel = window.getSelection();
    if (!domSel) throw new Error("Missing window selection");

    const crossRange = document.createRange();
    crossRange.setStart(aText, 1);
    crossRange.setEnd(bText, 1);
    domSel.removeAllRanges();
    domSel.addRange(crossRange);
    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    expect(
      requireOutlineItemEl(document.body, a).classList.contains("is-selected"),
    ).toBe(true);
    expect(
      requireOutlineItemEl(document.body, b).classList.contains("is-selected"),
    ).toBe(true);

    dispatchPointerEvent(bValueEl, "pointerdown", { pointerId: 9 });
    document.dispatchEvent(new Event("selectionchange"));

    const collapse = document.createRange();
    collapse.setStart(bText, 2);
    collapse.collapse(true);
    domSel.removeAllRanges();
    domSel.addRange(collapse);

    dispatchPointerEvent(document, "pointerup", { pointerId: 9 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushDomEffects();

    expect(readContentEditableCaret(bValueEl)).toBe(2);
    expectSel(core, { item: b, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(
      requireOutlineItemEl(document.body, a).classList.contains("is-selected"),
    ).toBe(false);
    expect(
      requireOutlineItemEl(document.body, b).classList.contains("is-selected"),
    ).toBe(true);

    unmount();
  });

  test("intra-outline blur/focus does not restore stale non-collapsed value selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "alphabet" });

    const { unmount } = await mountOutline(core, rootId);

    const root = requireOutlineRoot(document.body);
    const itemEl = requireOutlineItemEl(document.body, a);
    const valueEl = requireOutlineValueEl(document.body, a);

    setContentEditableSelection(valueEl, 2, 6);
    document.dispatchEvent(new Event("selectionchange"));
    await flushDomEffects();

    root.dispatchEvent(new FocusEvent("blur", { relatedTarget: itemEl }));
    setContentEditableSelection(valueEl, 4);
    root.dispatchEvent(new FocusEvent("focus"));
    await flushDomEffects();

    expect(readContentEditableCaret(valueEl)).toBe(4);

    unmount();
  });

  test("core.focus updates contenteditable caret even when target is already focused", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountOutline(core, rootId);
    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, a)),
    ).toBe(1);

    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 4 },
    );
    await flushDomEffects();

    expect(
      readContentEditableCaret(requireOutlineValueEl(document.body, a)),
    ).toBe(4);

    unmount();
  });

  test("undo/redo text edit restores contenteditable caret to pre-apply position", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 2 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const valueEl = requireOutlineValueEl(document.body, a);

    setContentEditableSelection(valueEl, 3);
    valueEl.textContent = "helXlo";
    setContentEditableSelection(valueEl, 4);
    await flushDomEffects();

    core.undo();
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("hello");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(readContentEditableCaret(valueEl)).toBe(4);

    core.redo();
    await flushDomEffects();
    expect(valueOfId(core, a)).toBe("helXlo");
    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
    expect(readContentEditableCaret(valueEl)).toBe(4);

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
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
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

    expectSel(core, { item: a, target: CONTENT_TEXT_TARGET, portals: [] });
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
      anchor: { item: a, portals: [] },
      head: { item: a, portals: [] },
    });

    unmount();
  });

  test("shift+click gutter extends contiguous same-parent block range", async () => {
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
      anchor: { item: a, portals: [] },
      head: { item: c, portals: [] },
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
      anchor: { item: b, portals: [] },
      head: { item: c, portals: [] },
    });

    dispatchKey(root, "ArrowUp", { shiftKey: true });
    await flushDomEffects();
    expectItemRangeSel(core, {
      anchor: { item: b, portals: [] },
      head: { item: b, portals: [] },
    });

    dispatchKey(root, "ArrowUp", { shiftKey: true });
    await flushDomEffects();
    expectItemRangeSel(core, {
      anchor: { item: b, portals: [] },
      head: { item: a, portals: [] },
    });

    unmount();
  });

  test("item-selected class toggles across selected range", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });

    const { unmount } = await mountOutline(core, rootId);

    const aItem = requireOutlineItemEl(document.body, a);
    const bItem = requireOutlineItemEl(document.body, b);
    expect(aItem.classList.contains("is-item-selected")).toBe(false);
    expect(bItem.classList.contains("is-item-selected")).toBe(false);
    expect(aItem.classList.contains("is-selected")).toBe(false);
    expect(bItem.classList.contains("is-selected")).toBe(false);

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

    expect(aItem.classList.contains("is-item-selected")).toBe(true);
    expect(bItem.classList.contains("is-item-selected")).toBe(true);
    expect(aItem.classList.contains("is-selected")).toBe(true);
    expect(bItem.classList.contains("is-selected")).toBe(true);

    unmount();
  });

  test("DELETE removes selected block range", async () => {
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

  test("DELETE on block selection prunes newly empty ancestor groups", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "a" });
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "x" });
    const y = mkBlank(core, g, { label: "y", value: "y" });
    const z = mkBlank(core, rootId, { label: "z", value: "z" });

    const { unmount } = await mountOutline(core, rootId);

    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, x),
      "pointerdown",
    );
    dispatchPointerEvent(
      requireOutlineGutterEl(document.body, y),
      "pointerdown",
      { shiftKey: true },
    );
    await flushDomEffects();

    const ev = dispatchKey(requireOutlineRoot(document.body), "Delete");
    await flushDomEffects();
    expect(ev.defaultPrevented).toBe(true);

    expect(childrenOf(core, rootId)).toEqual([a, z]);

    unmount();
  });
});

describe("outline/vertical-navigation", () => {
  test("ArrowUp from content:text lands on connected item stop and then continues structurally", async () => {
    const { core, rootId } = makeCoreRuntime();
    const top = mkBlank(core, rootId, { label: "top", value: "zz" });
    const formula = mkBlank(core, rootId, { label: "f", value: "x" });
    const a = mkBlank(core, rootId, { label: "a", value: "a\nb" });
    setFormula(core, formula, "1+2");
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 0);

    dispatchKey(root, "ArrowUp");
    await flushDomEffects();

    expectSel(core, { item: formula, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, formula), "ArrowDown");
    await flushDomEffects();

    expectSel(core, { item: a, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, a), "ArrowUp");
    await flushDomEffects();

    expectSel(core, { item: formula, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, formula), "ArrowUp");
    await flushDomEffects();

    expectSel(core, { item: top, portals: [] });

    unmount();
  });

  test("ArrowUp from content:text lands on embedded item stop and then continues structurally", async () => {
    const { core, rootId } = makeCoreRuntime();
    const slider = mkBlank(core, rootId, { label: "s", value: 5 });
    const a = mkBlank(core, rootId, { label: "a", value: "a\nb" });
    const top = mkBlank(core, rootId, { label: "top", value: "zz" });
    setView(core, slider, "slider");
    core.commit((tx) => {
      tx.move(top, rootId, { at: 0 });
      tx.move(slider, rootId, { at: 1 });
      tx.move(a, rootId, { at: 2 });
    });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 0);

    dispatchKey(root, "ArrowUp");
    await flushDomEffects();

    expectSel(core, { item: slider, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, slider), "ArrowDown");
    await flushDomEffects();

    expectSel(core, { item: a, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, a), "ArrowUp");
    await flushDomEffects();

    expectSel(core, { item: slider, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, slider), "ArrowUp");
    await flushDomEffects();

    expectSel(core, { item: top, portals: [] });

    unmount();
  });

  test("ArrowDown from connected item stop lands on the following plain value row", async () => {
    const { core, rootId } = makeCoreRuntime();
    const formula = mkBlank(core, rootId, { label: "f", value: "x" });
    const a = mkBlank(core, rootId, { label: "a", value: "a\nb" });
    setFormula(core, formula, "1+2");
    core.focus({ type: "item", location: { item: formula, portals: [] } });

    const { unmount } = await mountOutline(core, rootId);

    dispatchKey(requireOutlineItemEl(document.body, formula), "ArrowDown");
    await flushDomEffects();

    expectSel(core, { item: a, portals: [] });

    unmount();
  });

  test("ArrowDown from embedded item stop lands on the following plain value row", async () => {
    const { core, rootId } = makeCoreRuntime();
    const top = mkBlank(core, rootId, { label: "top", value: "zz" });
    const slider = mkBlank(core, rootId, { label: "s", value: 5 });
    const a = mkBlank(core, rootId, { label: "a", value: "a\nb" });
    setView(core, slider, "slider");
    core.commit((tx) => {
      tx.move(top, rootId, { at: 0 });
      tx.move(slider, rootId, { at: 1 });
      tx.move(a, rootId, { at: 2 });
    });
    core.focus({ type: "item", location: { item: slider, portals: [] } });

    const { unmount } = await mountOutline(core, rootId);

    dispatchKey(requireOutlineItemEl(document.body, slider), "ArrowDown");
    await flushDomEffects();

    expectSel(core, { item: a, portals: [] });

    unmount();
  });

  test("ArrowUp/ArrowDown with non-collapsed contenteditable selection are left to native behavior", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
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
    expect(sel.target).toBe(CONTENT_TEXT_TARGET);

    unmount();
  });

  test("vertical mixed-stop traversal works the same inside nested groups", async () => {
    const { core, rootId } = makeCoreRuntime();
    const group = mkGroup(core, rootId, { label: "g" });
    const top = mkBlank(core, group, { label: "top", value: "zz" });
    const formula = mkBlank(core, group, { label: "f", value: "x" });
    const a = mkBlank(core, group, { label: "a", value: "a\nb" });
    setFormula(core, formula, "1+2");
    core.focus(
      {
        type: "editing",
        location: { item: a, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountOutline(core, rootId);
    const root = requireOutlineRoot(document.body);
    setContentEditableSelection(requireOutlineValueEl(document.body, a), 0);

    dispatchKey(root, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { item: formula, portals: [] });

    dispatchKey(requireOutlineItemEl(document.body, formula), "ArrowUp");
    await flushDomEffects();
    expectSel(core, { item: top, portals: [] });

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
      anchor: { item: a, portals: [] },
      head: { item: b, portals: [] },
    });

    unmount();
  });

  test("applyEditingResult resets sticky caret while navigation application preserves it", () => {
    const { core, rootId } = makeCoreRuntime();
    const item = mkBlank(core, rootId, { label: "x", value: "hello" });
    let stickyResets = 0;
    const runtime = createOutlineInputRuntime({
      core,
      rootId,
      portals: [],
      root: document.createElement("div"),
      stops: signal([]),
      resetStickyCaretX: () => {
        stickyResets += 1;
      },
      discardPendingMutationRecords: () => {},
      suppressMutationSync: createSuppressionFlag(false),
      suppressHistoryKeydown: createSuppressionFlag<"undo" | "redo" | null>(
        null,
      ),
      selection: {
        suppressSelectionSync: createSuppressionFlag(false),
        clearValueRangeSelectedItems: () => {},
        setValueSelectionRangeState: () => {},
      },
    });

    runtime.applyNavigationEditingResult({
      location: { item, portals: [] },
      target: CONTENT_TEXT_TARGET,
      caret: 1,
    });
    expect(stickyResets).toBe(0);

    runtime.applyEditingResult({
      location: { item, portals: [] },
      target: CONTENT_TEXT_TARGET,
      caret: 0,
    });
    expect(stickyResets).toBe(1);
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

  test("connected item header focuses conn:expr and header interactions do not force content:text", async () => {
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

  test("conn header Tab commits and cycles through connection fields", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "query", value: "x" });
    setQuery(core, a, { from: "rows", where: "ok", orderBy: "label" });

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const fromInput = requireTargetInput(itemEl, "conn:from");
    pointerDown(fromInput);
    fromInput.focus();
    await flushDomEffects();

    fromInput.value = "next-rows";
    fromInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    const tab = dispatchKey(fromInput, "Tab");
    await flushDomEffects();

    expect(tab.defaultPrevented).toBe(true);
    expect(core.selection().type).toBe("editing");
    const sel = core.selection();
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe("conn:where");
    const connected = core.item(a);
    expect(connected.mode.type).toBe("connected");
    if (connected.mode.type !== "connected")
      throw new Error("Expected connected mode");
    expect(connected.mode.conn.type).toBe("query");
    if (connected.mode.conn.type !== "query")
      throw new Error("Expected query conn");
    expect(connected.mode.conn.from).toBe("next-rows");

    unmount();
  });

  test("conn header Tab at the last field commits and no-ops", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "query", value: "x" });
    setQuery(core, a, { from: "rows", where: "", orderBy: "old" });

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const orderByInput = requireTargetInput(itemEl, "conn:orderBy");
    pointerDown(orderByInput);
    orderByInput.focus();
    await flushDomEffects();

    orderByInput.value = "new-order";
    orderByInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    const tab = dispatchKey(orderByInput, "Tab");
    await flushDomEffects();

    expect(tab.defaultPrevented).toBe(true);
    const sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe("conn:orderBy");
    const connected = core.item(a);
    expect(connected.mode.type).toBe("connected");
    if (connected.mode.type !== "connected")
      throw new Error("Expected connected mode");
    expect(connected.mode.conn.type).toBe("query");
    if (connected.mode.conn.type !== "query")
      throw new Error("Expected query conn");
    expect(connected.mode.conn.orderBy).toBe("new-order");

    unmount();
  });

  test("label Enter commits and exits to same-item item selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "name", value: "x" });

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const labelInput = requireTargetInput(itemEl, "label");
    pointerDown(labelInput);
    labelInput.focus();
    await flushDomEffects();

    labelInput.value = "renamed";
    labelInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    const enter = dispatchKey(labelInput, "Enter");
    await flushDomEffects();

    expect(enter.defaultPrevented).toBe(true);
    expectSel(core, { item: a, portals: [] });
    expect(core.item(a).label).toBe("renamed");

    unmount();
  });

  test("label Escape cancels and exits to same-item item selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "name", value: "x" });

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const labelInput = requireTargetInput(itemEl, "label");
    pointerDown(labelInput);
    labelInput.focus();
    await flushDomEffects();

    labelInput.value = "discarded";
    labelInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    const escape = dispatchKey(labelInput, "Escape");
    await flushDomEffects();

    expect(escape.defaultPrevented).toBe(true);
    expectSel(core, { item: a, portals: [] });
    expect(core.item(a).label).toBe("name");

    unmount();
  });

  test("label Tab commits and no-ops in place", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "name", value: "x" });

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, a);
    const labelInput = requireTargetInput(itemEl, "label");
    pointerDown(labelInput);
    labelInput.focus();
    await flushDomEffects();

    labelInput.value = "tabbed";
    labelInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    const tab = dispatchKey(labelInput, "Tab");
    await flushDomEffects();

    expect(tab.defaultPrevented).toBe(true);
    const sel = core.selection();
    expect(sel.type).toBe("editing");
    if (sel.type !== "editing") throw new Error("Expected editing selection");
    expect(sel.location.item).toBe(a);
    expect(sel.target).toBe("label");
    expect(core.item(a).label).toBe("tabbed");

    unmount();
  });

  test("non-control header click keeps item selection on the frame", async () => {
    const { core, rootId } = makeCoreRuntime();
    mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "calc", value: "y" });
    setFormula(core, b, "1+2");

    const { unmount } = await mountOutline(core, rootId);

    const itemEl = requireOutlineItemEl(document.body, b);
    const headerEl = itemEl.querySelector(".ui-header") as HTMLElement | null;
    expect(headerEl).toBeTruthy();

    pointerDown(headerEl!);
    await flushDomEffects();

    expectSel(core, { item: b, portals: [] });
    expect(document.activeElement).toBe(itemEl);

    unmount();
  });

  test("embedded slider mounts in row and pointerdown keeps slider focus behavior", async () => {
    const CONTENT_SLIDER_TARGET = contentTarget("slider");
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
    expect(sel.target).toBe(CONTENT_SLIDER_TARGET);
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
    expectSel(core, { item: c11, portals: [] });

    unmount();
  });
});

describe("outline/drag-integration", () => {
  test("drag pointerdown on outline gutter handle enters pending state", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    mkBlank(core, rootId, { label: "b", value: "y" });
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);

    const { unmount } = await mountOutline(core, rootId);

    try {
      const aGutter = requireOutlineGutterEl(document.body, a);
      dispatchPointerEvent(aGutter, "pointerdown", {
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
      const aFrame = requireFrameEl(document.body, a);
      expect(aFrame.classList.contains("is-dragging")).toBe(false);
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });

  test("drag does not start from non-handle outline zones", async () => {
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
        requireFrameEl(document.body, withHeader),
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
      const aGutter = requireOutlineGutterEl(document.body, a);
      dispatchPointerEvent(aGutter, "pointerdown", {
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
      const aGutter = requireOutlineGutterEl(document.body, a);
      const cFrame = requireFrameEl(document.body, c);
      dispatchPointerEvent(aGutter, "pointerdown", {
        pointerId: 41,
        clientX: 0,
        clientY: 0,
      });
      expect(drag.state.value.type).toBe("pending");
      cap.emitPointer("pointermove", {
        pointerId: 41,
        clientX: 10,
        clientY: 0,
      });
      await flushDomEffects();

      if (drag.state.value.type !== "active")
        throw new Error("Drag not active");
      drag.state.value = {
        ...drag.state.value,
        drop: {
          type: "gap",
          parentId: rootId,
          at: 3,
          side: "after",
          anchorEl: cFrame,
        },
      };

      cap.emitPointer("pointerup", { pointerId: 41, clientX: 10, clientY: 30 });
      await flushDomEffects();

      expect(childrenOf(core, rootId)).toEqual([b, c, a]);
      expect(document.documentElement.dataset.dragState).toBeUndefined();
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });

  test("same-position reorder resolves to no drop and no commit", async () => {
    const { core, rootId } = makeCoreRuntime();
    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });
    const c = mkBlank(core, rootId, { label: "c", value: "z" });
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);

    const { unmount } = await mountOutline(core, rootId);
    const originalElementFromPoint = document.elementFromPoint.bind(document);
    try {
      const bGutter = requireOutlineGutterEl(document.body, b);
      const cFrame = requireFrameEl(document.body, c);
      cFrame.getBoundingClientRect = () =>
        ({
          top: 100,
          bottom: 140,
          left: 0,
          right: 200,
          width: 200,
          height: 40,
        }) as DOMRect;
      document.elementFromPoint = (() =>
        cFrame) as typeof document.elementFromPoint;

      dispatchPointerEvent(bGutter, "pointerdown", {
        pointerId: 51,
        clientX: 10,
        clientY: 110,
      });
      expect(drag.state.value.type).toBe("pending");

      cap.emitPointer("pointermove", {
        pointerId: 51,
        clientX: 10,
        clientY: 119,
      });
      await flushDomEffects();

      expect(drag.state.value.type).toBe("active");
      if (drag.state.value.type !== "active")
        throw new Error("Drag not active");
      expect(drag.state.value.drop).toBeNull();

      cap.emitPointer("pointerup", {
        pointerId: 51,
        clientX: 10,
        clientY: 119,
      });
      await flushDomEffects();

      expect(childrenOf(core, rootId)).toEqual([a, b, c]);
      expect(document.documentElement.dataset.dragState).toBeUndefined();
    } finally {
      document.elementFromPoint = originalElementFromPoint;
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });
});
