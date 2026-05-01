import { describe, expect, test } from "bun:test";

import { CONTENT_TEXT_TARGET, contentTarget } from "../src/core";
import { createDragController } from "../src/dom";

import {
  childrenOf,
  dispatchViewIntentKey,
  dispatchPointerEvent,
  dispatchKey,
  expectSel,
  flushDomEffects,
  installCapturedWindowHandlers,
  makeCoreRuntime,
  mountLocalView,
  mountView,
  mkBlank,
  mkGroup,
  pointerDown,
  requireFrameEl,
  setView,
  valueOfId,
} from "./dom-test-utils";

describe("views/table", () => {
  test("renders header columns based on schema row", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    core.focus({
      type: "item",
      anchor: { item: tableId, portals: [] },
      head: { item: tableId, portals: [] },
    });

    const { unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    const header = document.body.querySelector(
      ".ui-table-header",
    ) as HTMLElement | null;
    expect(header).toBeTruthy();

    const headerCols = [
      ...(header?.querySelectorAll(":scope > .ui-table-cell") ?? []),
    ] as HTMLElement[];
    expect(headerCols.length).toBe(childrenOf(core, r1).length + 1);

    unmount();
  });

  test("NAV in row item moves rows; right enters first cell", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });
    const [shapeCell] = childrenOf(core, r1);

    core.focus({
      type: "item",
      anchor: { item: r1, portals: [] },
      head: { item: r1, portals: [] },
    });

    const { domView, unmount } = await mountLocalView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    let key = dispatchKey(domView.root, "ArrowDown");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: r2, portals: [] });

    key = dispatchKey(domView.root, "ArrowUp");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: r1, portals: [] });

    key = dispatchKey(domView.root, "ArrowRight");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: shapeCell!, portals: [] });

    unmount();
  });

  test("NAV in cells moves in grid; left from first cell exits to row item", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    const c12 = mkBlank(core, r1, { label: "c2", value: 2 });

    const [r2ShapeCell, r2C1, r2C2] = childrenOf(core, r2);

    core.focus({
      type: "item",
      anchor: { item: c11, portals: [] },
      head: { item: c11, portals: [] },
    });

    const { domView, unmount } = await mountLocalView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    let key = dispatchKey(domView.root, "ArrowRight");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: c12, portals: [] });

    key = dispatchKey(domView.root, "ArrowDown");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: r2C2!, portals: [] });

    key = dispatchKey(domView.root, "ArrowLeft");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: r2C1!, portals: [] });

    key = dispatchKey(domView.root, "ArrowLeft");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: r2ShapeCell!, portals: [] });

    key = dispatchKey(domView.root, "ArrowLeft");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: r2, portals: [] });

    unmount();
  });

  test("TAB moves across cells and wraps rows", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    const c12 = mkBlank(core, r1, { label: "c2", value: 2 });

    const [r2ShapeCell] = childrenOf(core, r2);

    core.focus({
      type: "item",
      anchor: { item: c11, portals: [] },
      head: { item: c11, portals: [] },
    });

    const { domView, unmount } = await mountLocalView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    const tab1 = dispatchKey(domView.root, "Tab");
    await flushDomEffects();
    expect(tab1).toBe(true);
    expectSel(core, { item: c12, portals: [] });

    const tab2 = dispatchKey(domView.root, "Tab");
    await flushDomEffects();
    expect(tab2).toBe(true);
    expectSel(core, { item: r2ShapeCell!, portals: [] });

    unmount();
  });

  test("Enter from cell content:text keeps the current editing target", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: "a" });
    mkBlank(core, r1, { label: "c2", value: "b" });

    core.focus(
      {
        type: "editing",
        location: { item: c11, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );

    const { unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    const c11Frame = requireFrameEl(document.body, c11);
    const valueEl = c11Frame.querySelector(
      ".ui-outline-value[data-target='content:text']",
    ) as HTMLElement | null;
    if (!valueEl) throw new Error("Missing embedded outline value element");

    const sel = window.getSelection();
    const textNode = [...valueEl.childNodes].find(
      (n): n is Text => n.nodeType === Node.TEXT_NODE,
    );
    if (!sel || !textNode) throw new Error("Missing text selection target");
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 1);
    sel.removeAllRanges();
    sel.addRange(range);

    dispatchKey(valueEl, "Enter");
    await flushDomEffects();

    expectSel(core, { item: c11, target: CONTENT_TEXT_TARGET, portals: [] });

    unmount();
  });

  test("DELETE: row item removes row; cell item clears value", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    const { domView, unmount } = await mountLocalView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    core.focus({
      type: "item",
      anchor: { item: c11, portals: [] },
      head: { item: c11, portals: [] },
    });
    await flushDomEffects();

    let key = dispatchKey(domView.root, "Backspace");
    await flushDomEffects();
    expect(key).toBe(true);
    expect(valueOfId(core, c11)).toBe(null);

    core.focus({
      type: "item",
      anchor: { item: r2, portals: [] },
      head: { item: r2, portals: [] },
    });
    await flushDomEffects();

    key = dispatchKey(domView.root, "Backspace");
    await flushDomEffects();
    expect(key).toBe(true);

    expect(childrenOf(core, tableId).includes(r2)).toBe(false);

    unmount();
  });

  test("INSERT from row item preserves table columns", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    core.focus({
      type: "item",
      anchor: { item: r1, portals: [] },
      head: { item: r1, portals: [] },
    });

    const { domView, unmount } = await mountLocalView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });
    const rowCountBefore = childrenOf(core, tableId).length;

    dispatchViewIntentKey(domView, "Enter", { metaKey: true });
    await flushDomEffects();

    const rows = childrenOf(core, tableId);
    expect(rows.length).toBe(rowCountBefore + 1);
    expect(childrenOf(core, rows.at(-1)!).length).toBe(
      childrenOf(core, r1).length,
    );

    unmount();
  });

  test("NAV beyond grid edges does nothing", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    const firstRow = childrenOf(core, tableId)[0]!;
    core.focus({
      type: "item",
      anchor: { item: firstRow, portals: [] },
      head: { item: firstRow, portals: [] },
    });

    const { domView, unmount } = await mountLocalView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    let key = dispatchKey(domView.root, "ArrowUp");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: firstRow, portals: [] });

    const firstCell = childrenOf(core, firstRow)[0]!;
    core.focus({
      type: "item",
      anchor: { item: firstCell, portals: [] },
      head: { item: firstCell, portals: [] },
    });
    await flushDomEffects();

    key = dispatchKey(domView.root, "ArrowUp");
    await flushDomEffects();
    expect(key).toBe(true);
    expectSel(core, { item: firstCell, portals: [] });

    unmount();
  });

  test("pointerdown on a cell shell from embedded outline editing lands on the cell item", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const c11 = mkBlank(core, r1, { label: "c1", value: "alpha" });
    const c12 = mkBlank(core, r1, { label: "c2", value: "beta" });

    const { unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    core.focus(
      {
        type: "editing",
        location: { item: c11, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: 1 },
    );
    await flushDomEffects();

    const c12Frame = requireFrameEl(document.body, c12);
    pointerDown(c12Frame);
    await flushDomEffects();

    expectSel(core, { item: c12, portals: [] });

    unmount();
  });

  test("slot replace moves the cell and clears the source slot", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: "a" });
    mkBlank(core, r1, { label: "c2", value: "b" });
    const [, r2C1] = childrenOf(core, r2);

    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);
    const { unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    try {
      const c11Frame = requireFrameEl(document.body, c11);
      const r2C1Frame = requireFrameEl(document.body, r2C1!);
      dispatchPointerEvent(c11Frame, "pointerdown", {
        pointerId: 31,
        clientX: 0,
        clientY: 0,
      });
      expect(drag.state.value.type).toBe("pending");
      cap.emitPointer("pointermove", {
        pointerId: 31,
        clientX: 10,
        clientY: 0,
      });
      await flushDomEffects();

      if (drag.state.value.type !== "active")
        throw new Error("Drag not active");
      drag.state.value = {
        ...drag.state.value,
        drop: { type: "replace", itemId: r2C1!, anchorEl: r2C1Frame },
      };

      cap.emitPointer("pointerup", { pointerId: 31, clientX: 0, clientY: 0 });
      await flushDomEffects();

      const nextR1 = childrenOf(core, r1);
      const nextR2 = childrenOf(core, r2);
      const [, nextR2C1] = nextR2;
      const [, sourceReplacement] = nextR1;
      expect(nextR2C1).toBe(c11);
      expect(valueOfId(core, c11)).toBe("a");
      expect(sourceReplacement).not.toBe(c11);
      expect(valueOfId(core, sourceReplacement!)).toBe(null);
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });

  test("slot edge drop inserts the dragged item as a new row and clears the source slot", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: "a" });
    mkBlank(core, r1, { label: "c2", value: "b" });
    const cap = installCapturedWindowHandlers();
    const drag = createDragController(core);
    const { unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      location: { item: tableId, portals: [] },
    });

    try {
      const c11Frame = requireFrameEl(document.body, c11);
      const r2Frame = requireFrameEl(document.body, r2);
      const rowsBefore = childrenOf(core, tableId);
      const insertAt = rowsBefore.indexOf(r2);
      dispatchPointerEvent(c11Frame, "pointerdown", {
        pointerId: 32,
        clientX: 0,
        clientY: 0,
      });
      expect(drag.state.value.type).toBe("pending");
      cap.emitPointer("pointermove", {
        pointerId: 32,
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
          parentId: tableId,
          at: insertAt,
          side: "before",
          anchorEl: r2Frame,
        },
      };

      cap.emitPointer("pointerup", { pointerId: 32, clientX: 0, clientY: 0 });
      await flushDomEffects();

      const rows = childrenOf(core, tableId);
      const insertedRow = rows[insertAt]!;
      const nextR1 = childrenOf(core, r1);
      const [, sourceReplacement] = nextR1;

      expect(rows).toHaveLength(rowsBefore.length + 1);
      expect(insertedRow).toBe(c11);
      expect(insertedRow).not.toBe(r2);
      expect(sourceReplacement).not.toBe(c11);
      expect(valueOfId(core, sourceReplacement!)).toBe(null);
    } finally {
      drag.dispose();
      cap.dispose();
      unmount();
    }
  });
});

describe("views/slider", () => {
  const CONTENT_SLIDER_TARGET = contentTarget("slider");

  test("renders range input", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({
      type: "item",
      anchor: { item: s, portals: [] },
      head: { item: s, portals: [] },
    });

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      location: { item: s, portals: [] },
    });

    const body = document.body.querySelector(".ui-body.ui-slider");
    expect(body).toBeTruthy();

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    unmount();
  });

  test("pointerdown on input focuses content:slider", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({
      type: "item",
      anchor: { item: s, portals: [] },
      head: { item: s, portals: [] },
    });

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      location: { item: s, portals: [] },
    });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    pointerDown(input);
    await flushDomEffects();

    expectSel(core, { item: s, target: CONTENT_SLIDER_TARGET, portals: [] });

    unmount();
  });

  test("native range keys remain local to the range input", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({
      type: "item",
      anchor: { item: s, portals: [] },
      head: { item: s, portals: [] },
    });

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      location: { item: s, portals: [] },
    });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    dispatchKey(input, "ArrowLeft");
    dispatchKey(input, "ArrowRight");
    dispatchKey(input, "ArrowUp");
    dispatchKey(input, "ArrowDown");
    await flushDomEffects();

    expectSel(core, { item: s, portals: [] });

    unmount();
  });

  test("input updates core value", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 0 });
    setView(core, s, "slider");

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      location: { item: s, portals: [] },
    });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    input.value = "42";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    expect(valueOfId(core, s)).toBe(42);

    unmount();
  });

  test("ENTER on content:slider is a local no-op", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus(
      {
        type: "editing",
        location: { item: s, portals: [] },
        target: CONTENT_SLIDER_TARGET,
      },
      { caret: 0 },
    );

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      location: { item: s, portals: [] },
    });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement | null;
    if (!input) throw new Error("Missing slider input");

    const enter = dispatchKey(input, "Enter");
    await flushDomEffects();
    expect(enter).toBe(false);
    expectSel(core, {
      item: s,
      target: CONTENT_SLIDER_TARGET,
      portals: [],
    });

    unmount();
  });
});
