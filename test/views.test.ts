import { describe, expect, test } from "bun:test";

import { DEFAULT_TARGET } from "../src/core";
import { viewRegistrations } from "../src/views";
import {
  expectSel,
  expectSnapshotSame,
  fireViewKey,
  fireWindowKey,
  flushDomEffects,
  makeCoreRuntime,
  mkBlank,
  mkGroup,
  mountDomView,
  nodeOrderByDataId,
  pointerDown,
  requireSameEl,
  requireEl,
  requireFrameEl,
  requireTargetInput,
  scalarOfId,
  setView,
  snapshotEl,
} from "./test-utils";

const viewFactories = Object.fromEntries(
  Object.entries(viewRegistrations).map(([k, v]) => [k, v.factory]),
) as {
  [K in keyof typeof viewRegistrations]: (typeof viewRegistrations)[K]["factory"];
};

describe("views", () => {
  test("outline: selection moves do not replace item roots", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: 1 });
    const g = mkGroup(core, rootId, { label: "g" });
    const b = mkBlank(core, rootId, { label: "b", value: 3 });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: rootId, item: a }, DEFAULT_TARGET);
    await flushDomEffects();

    const aElBefore = requireFrameEl(view.root, a);
    const bElBefore = requireFrameEl(view.root, b);

    fireViewKey(view, "ArrowDown");
    fireViewKey(view, "ArrowDown");
    fireViewKey(view, "ArrowUp");
    await flushDomEffects();

    const aElAfter = requireFrameEl(view.root, a);
    const bElAfter = requireFrameEl(view.root, b);

    requireSameEl(aElBefore, aElAfter);
    requireSameEl(bElBefore, bElAfter);

    const sel = core.selection();
    expect(sel.type).toBe("focused");
    if (sel.type === "focused") {
      expect([a, b, g, rootId]).toContain(sel.focus.item);
    }
  });

  test("outline: click focuses item frame; does not replace frame", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x", value: 1 });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    const itemElBefore = requireFrameEl(view.root, x);

    pointerDown(itemElBefore);
    await flushDomEffects();

    expect(document.activeElement === itemElBefore).toBe(true);
    expectSel(core, { container: rootId, item: x, target: DEFAULT_TARGET });

    const itemElAfter = requireFrameEl(view.root, x);
    requireSameEl(itemElBefore, itemElAfter);
  });

  test("outline: printable key at DEFAULT_TARGET enters value editor and inserts", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x" });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: rootId, item: x }, DEFAULT_TARGET);
    await flushDomEffects();

    fireViewKey(view, "A");
    await flushDomEffects();

    expectSel(core, { container: rootId, item: x, target: "value" });

    const itemEl = requireFrameEl(view.root, x);
    const valueEl = requireTargetInput(itemEl, "value");
    const text = (valueEl as HTMLInputElement | HTMLTextAreaElement).value;
    expect(text.includes("A")).toBe(true);
  });

  test("outline: '=' at container focus on empty value switches to formula and focuses expr without replacing item root", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x" });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: rootId, item: x }, DEFAULT_TARGET);
    await flushDomEffects();

    const itemElBefore = requireFrameEl(view.root, x);
    const snapBefore = snapshotEl(itemElBefore);

    fireViewKey(view, "=");
    await flushDomEffects();

    expect(core.item(x).mode.type).toBe("connected");
    expectSel(core, { container: rootId, item: x, target: "conn:expr" });

    const itemElAfter = requireFrameEl(view.root, x);
    expectSnapshotSame(snapBefore, itemElAfter);

    const exprEl = requireTargetInput(itemElAfter, "conn:expr");
    expect(exprEl).toBeTruthy();
  });

  test("outline: list reorder preserves child item element identity and updates DOM order", async () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });
    const c = mkBlank(core, g, { label: "c", value: 3 });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    const aElBefore = requireFrameEl(view.root, a);
    const bElBefore = requireFrameEl(view.root, b);
    const cElBefore = requireFrameEl(view.root, c);

    core.commit((t) => t.move(c, g, { at: 0 }));
    await flushDomEffects();

    const aElAfter = requireFrameEl(view.root, a);
    const bElAfter = requireFrameEl(view.root, b);
    const cElAfter = requireFrameEl(view.root, c);

    requireSameEl(aElBefore, aElAfter);
    requireSameEl(bElBefore, bElAfter);
    requireSameEl(cElBefore, cElAfter);

    const order = nodeOrderByDataId(view.root, `.ui-outline-child`);
    const filtered = order.filter((id) => id === a || id === b || id === c);
    expect(filtered).toEqual([c, a, b]);
  });

  test("table: navigation does not replace row item roots or cell frames", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const rowB = mkGroup(core, tableId, { label: "rowB" });

    const aScoreId = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowBContent = core.item(rowB).content;
    const bScoreId =
      rowBContent.type === "group" ? rowBContent.children[0]! : "";
    core.commit((t) => t.setValue(bScoreId, 6));

    const view = viewFactories.table({ core, id: tableId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: tableId, item: rowA }, DEFAULT_TARGET);
    await flushDomEffects();

    expectSel(core, { container: tableId, item: rowA, target: DEFAULT_TARGET });

    const rowAElBefore = requireFrameEl(view.root, rowA);
    const rowBElBefore = requireFrameEl(view.root, rowB);

    const cellA0 = requireEl(
      rowAElBefore.querySelector(
        `:scope > .ui-table-cell:not(.ui-table-header-col)`,
      ) as HTMLElement | null,
      "Missing rowA first data cell",
    );

    fireViewKey(view, "ArrowRight");
    await flushDomEffects();
    expectSel(core, {
      container: rowA,
      item: aScoreId,
      target: DEFAULT_TARGET,
    });

    fireViewKey(view, "ArrowRight");
    await flushDomEffects();
    expectSel(core, {
      container: rowA,
      item: aScoreId,
      target: DEFAULT_TARGET,
    });

    fireViewKey(view, "ArrowDown");
    await flushDomEffects();
    expectSel(core, {
      container: rowB,
      item: bScoreId,
      target: DEFAULT_TARGET,
    });

    fireViewKey(view, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: rowB, target: DEFAULT_TARGET });

    const beforeRows = core.item(tableId);
    const beforeCount =
      beforeRows.content.type === "group"
        ? beforeRows.content.children.length
        : 0;
    fireViewKey(view, "Enter");
    await flushDomEffects();
    const sel = core.selection();
    expect(sel.type).toBe("focused");
    if (sel.type === "focused") {
      expect(sel.focus.container).toBe(tableId);
      expect(sel.focus.item).not.toBe(rowB);
      expect(sel.target).toBe(DEFAULT_TARGET);
    }

    const afterRows = core.item(tableId);
    const afterCount =
      afterRows.content.type === "group"
        ? afterRows.content.children.length
        : 0;
    expect(afterCount).toBe(beforeCount + 1);

    const rowAElAfter = requireFrameEl(view.root, rowA);
    const rowBElAfter = requireFrameEl(view.root, rowB);

    requireSameEl(rowAElBefore, rowAElAfter);
    requireSameEl(rowBElBefore, rowBElAfter);

    const cellA1 = requireEl(
      rowAElAfter.querySelector(
        `:scope > .ui-table-cell:not(.ui-table-header-col)`,
      ) as HTMLElement | null,
      "Missing rowA first data cell",
    );

    requireSameEl(cellA0, cellA1);
  });

  test("table: printable key from row selection does not enter edit", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScoreId = mkBlank(core, rowA, { label: "score" });

    const view = viewFactories.table({ core, id: tableId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: tableId, item: rowA }, DEFAULT_TARGET);
    await flushDomEffects();

    expectSel(core, { container: tableId, item: rowA, target: DEFAULT_TARGET });

    fireViewKey(view, "7");
    await flushDomEffects();

    expectSel(core, { container: tableId, item: rowA, target: DEFAULT_TARGET });

    const cellItemEl = requireFrameEl(view.root, aScoreId);
    const valueEl = requireTargetInput(cellItemEl, "value");
    expect((valueEl as HTMLInputElement | HTMLTextAreaElement).value).toBe("");
  });

  test("table: global keydown routes to active nested view (outline hosting a table)", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const rowB = mkGroup(core, tableId, { label: "rowB" });

    const aScore = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowBContent = core.item(rowB).content;
    const bScore = rowBContent.type === "group" ? rowBContent.children[0]! : "";
    core.commit((t) => t.setValue(bScore, 6));

    const outline = viewFactories.outline({ core, id: rootId });
    mountDomView(outline);
    await flushDomEffects();

    const nestedCell = requireEl(
      outline.root.querySelector(
        `.ui-table .ui-table-row > .ui-table-cell:not(.ui-table-header-col)`,
      ) as HTMLElement | null,
      "Missing nested cell",
    );

    pointerDown(nestedCell);
    await flushDomEffects();

    expectSel(core, { container: rowA, item: aScore, target: DEFAULT_TARGET });

    fireWindowKey("ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: rowB, item: bScore, target: DEFAULT_TARGET });
  });

  test("slider: input updates scalar; arrow nudge clamps; ctrl/meta jump scales nudge", async () => {
    const { core, rootId } = makeCoreRuntime();

    const sliderId = mkBlank(core, rootId, { label: "slider", value: 10 });
    setView(core, sliderId, "slider");

    const view = viewFactories.slider({ core, id: sliderId });
    mountDomView(view);
    await flushDomEffects();

    const input = requireEl(
      view.root.querySelector(`input[type="range"]`) as HTMLInputElement | null,
      "Missing slider input",
    );

    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scalarOfId(core, sliderId)).toBe(42);

    core.focus({ container: rootId, item: sliderId }, DEFAULT_TARGET);

    core.commit((t) => t.setValue(sliderId, 100));
    fireViewKey(view, "ArrowRight");
    expect(scalarOfId(core, sliderId)).toBe(100);

    core.commit((t) => t.setValue(sliderId, 50));
    fireViewKey(view, "ArrowRight", { ctrlKey: true });
    expect(scalarOfId(core, sliderId)).toBe(60);

    core.commit((t) => t.setValue(sliderId, 50));
    fireViewKey(view, "ArrowLeft", { metaKey: true });
    expect(scalarOfId(core, sliderId)).toBe(40);
  });

  test("slider: does not replace input element on selection changes", async () => {
    const { core, rootId } = makeCoreRuntime();

    const sliderId = mkBlank(core, rootId, { label: "slider", value: 10 });
    setView(core, sliderId, "slider");

    const other = mkBlank(core, rootId, { label: "other", value: 1 });

    const outline = viewFactories.outline({ core, id: rootId });
    mountDomView(outline);
    await flushDomEffects();

    core.focus({ container: rootId, item: sliderId }, DEFAULT_TARGET);
    await flushDomEffects();

    const sliderItemElBefore = requireFrameEl(outline.root, sliderId);
    const sliderInputBefore = requireEl(
      sliderItemElBefore.querySelector(
        `input[type="range"]`,
      ) as HTMLInputElement | null,
      "Missing slider input",
    );

    core.focus({ container: rootId, item: other }, DEFAULT_TARGET);
    await flushDomEffects();
    core.focus({ container: rootId, item: sliderId }, DEFAULT_TARGET);
    await flushDomEffects();

    expectSel(core, {
      container: rootId,
      item: sliderId,
      target: DEFAULT_TARGET,
    });

    const sliderItemElAfter = requireFrameEl(outline.root, sliderId);
    const sliderInputAfter = requireEl(
      sliderItemElAfter.querySelector(
        `input[type="range"]`,
      ) as HTMLInputElement | null,
      "Missing slider input",
    );

    requireSameEl(sliderItemElBefore, sliderItemElAfter);
    requireSameEl(sliderInputBefore, sliderInputAfter);
  });
});
