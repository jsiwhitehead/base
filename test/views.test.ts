import { describe, expect, test } from "bun:test";

import { VALUE_TARGET } from "../src/core";

import {
  childrenOf,
  dispatchKey,
  expectSel,
  fireViewKey,
  flushDomEffects,
  makeCoreRuntime,
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
      anchor: { container: tableId, item: tableId },
      head: { container: tableId, item: tableId },
    });

    const { unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    const header = document.body.querySelector(
      ".ui-table-header",
    ) as HTMLElement | null;
    expect(header).toBeTruthy();

    const headerCols = [
      ...(header?.querySelectorAll(":scope > .ui-table-cell") ?? []),
    ] as HTMLElement[];
    expect(headerCols.length).toBe(3);

    unmount();
  });

  test("NAV in row container moves rows; right enters first cell", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    core.focus({
      type: "item",
      anchor: { container: tableId, item: r1 },
      head: { container: tableId, item: r1 },
    });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    fireViewKey(domView, "ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: r2 });

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: r1 });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: r1, item: c11 });

    unmount();
  });

  test("NAV in cells moves in grid; left from first cell exits to row container", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    const c12 = mkBlank(core, r1, { label: "c2", value: 2 });

    const c21 = childrenOf(core, r2)[0]!;
    const c22 = childrenOf(core, r2)[1]!;

    core.focus({
      type: "item",
      anchor: { container: r1, item: c11 },
      head: { container: r1, item: c11 },
    });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: r1, item: c12 });

    fireViewKey(domView, "ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: r2, item: c22 });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: r2, item: c21 });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: r2 });

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

    const c21 = childrenOf(core, r2)[0]!;

    core.focus({
      type: "item",
      anchor: { container: r1, item: c11 },
      head: { container: r1, item: c11 },
    });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    fireViewKey(domView, "Tab");
    await flushDomEffects();
    expectSel(core, { container: r1, item: c12 });

    fireViewKey(domView, "Tab");
    await flushDomEffects();
    expectSel(core, { container: r2, item: c21 });

    unmount();
  });

  test("Enter from cell VALUE moves to same column next row container", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: "a" });
    mkBlank(core, r1, { label: "c2", value: "b" });

    const c21 = childrenOf(core, r2)[0]!;

    core.focus(
      {
        type: "editing",
        location: { container: r1, item: c11 },
        target: VALUE_TARGET,
      },
      { caret: 1 },
    );

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    fireViewKey(domView, "Enter");
    await flushDomEffects();

    expectSel(core, { container: r2, item: c21 });

    unmount();
  });

  test("DELETE: row container removes row; cell container clears value", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    core.focus({
      type: "item",
      anchor: { container: r1, item: c11 },
      head: { container: r1, item: c11 },
    });
    await flushDomEffects();

    fireViewKey(domView, "Backspace");
    await flushDomEffects();
    expect(valueOfId(core, c11)).toBe(null);

    core.focus({
      type: "item",
      anchor: { container: tableId, item: r2 },
      head: { container: tableId, item: r2 },
    });
    await flushDomEffects();

    fireViewKey(domView, "Backspace");
    await flushDomEffects();

    expect(childrenOf(core, tableId).includes(r2)).toBe(false);

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
      anchor: { container: tableId, item: firstRow },
      head: { container: tableId, item: firstRow },
    });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
      focus: { container: tableId, item: tableId },
    });

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: firstRow });

    const firstCell = childrenOf(core, firstRow)[0]!;
    core.focus({
      type: "item",
      anchor: { container: firstRow, item: firstCell },
      head: { container: firstRow, item: firstCell },
    });
    await flushDomEffects();

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { container: firstRow, item: firstCell });

    unmount();
  });
});

describe("views/slider", () => {
  test("renders range input and value readout", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({
      type: "item",
      anchor: { container: rootId, item: s },
      head: { container: rootId, item: s },
    });

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      focus: { container: rootId, item: s },
    });

    requireFrameEl(document.body, s);

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    const valueEl = document.body.querySelector(
      ".ui-slider-value",
    ) as HTMLElement | null;
    expect(valueEl).toBeTruthy();

    unmount();
  });

  test("pointerdown on input focuses VALUE_TARGET", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({
      type: "item",
      anchor: { container: rootId, item: s },
      head: { container: rootId, item: s },
    });

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      focus: { container: rootId, item: s },
    });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    pointerDown(input);
    await flushDomEffects();

    expectSel(core, { container: rootId, item: s, target: VALUE_TARGET });

    unmount();
  });

  test("native range keys do not bubble", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({
      type: "item",
      anchor: { container: rootId, item: s },
      head: { container: rootId, item: s },
    });

    const { unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      focus: { container: rootId, item: s },
    });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    expect(dispatchKey(input, "ArrowLeft").bubbled).toBe(0);
    expect(dispatchKey(input, "ArrowRight").bubbled).toBe(0);
    expect(dispatchKey(input, "ArrowUp").bubbled).toBe(0);
    expect(dispatchKey(input, "ArrowDown").bubbled).toBe(0);

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
      focus: { container: rootId, item: s },
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

  test("CONFIRM toggles VALUE_TARGET to ITEM_TARGET only when focused item is slider id", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    const other = mkBlank(core, rootId, { label: "o", value: 1 });

    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: s },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );

    const { domView, unmount } = await mountView({
      view: "slider",
      core,
      id: s,
      focus: { container: rootId, item: s },
    });

    fireViewKey(domView, "Enter");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: s });

    core.focus(
      {
        type: "editing",
        location: { container: rootId, item: other },
        target: VALUE_TARGET,
      },
      { caret: 0 },
    );
    await flushDomEffects();

    fireViewKey(domView, "Enter");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: other, target: VALUE_TARGET });

    unmount();
  });
});
