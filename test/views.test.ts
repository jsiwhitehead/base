import { describe, test, expect } from "bun:test";
import { DEFAULT_TARGET } from "../src/core";
import { viewFactories } from "../src/views";
import {
  makeCoreRuntime,
  mountDomView,
  mkBlank,
  mkGroup,
  setView,
  scalarOfId,
  pointerDown,
  fireViewKey,
  fireWindowKey,
  flushDomEffects,
  expectSel,
  requireItemEl,
  requireTargetInput,
  requireEl,
  requireSameEl,
  snapshotEl,
  expectSnapshotSame,
  nodeOrderByDataId,
} from "./test-utils";

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

    const aEl0 = requireItemEl(view.root, a);
    const bEl0 = requireItemEl(view.root, b);

    fireViewKey(view, "ArrowDown");
    fireViewKey(view, "ArrowDown");
    fireViewKey(view, "ArrowUp");
    await flushDomEffects();

    const aEl1 = requireItemEl(view.root, a);
    const bEl1 = requireItemEl(view.root, b);

    requireSameEl(aEl0, aEl1);
    requireSameEl(bEl0, bEl1);

    const sel = core.selection();
    expect(sel.kind).toBe("focused");
    if (sel.kind === "focused") {
      expect([a, b, g, rootId]).toContain(sel.focus.item);
    }
  });

  test("outline: click focuses item shell; does not replace shell", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x", value: 1 });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    const itemEl0 = requireItemEl(view.root, x);

    pointerDown(itemEl0);
    await flushDomEffects();

    expect(document.activeElement === itemEl0).toBe(true);
    expectSel(core, { container: rootId, item: x, target: DEFAULT_TARGET });

    const itemEl1 = requireItemEl(view.root, x);
    requireSameEl(itemEl0, itemEl1);
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

    const itemEl = requireItemEl(view.root, x);
    const valueEl = requireTargetInput(itemEl, "value");
    const text = (valueEl as HTMLInputElement | HTMLTextAreaElement).value;
    expect(text.includes("A")).toBe(true);
  });

  test("outline: '=' in empty value editor switches to derived and focuses expr without replacing item root", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x" });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: rootId, item: x }, "value");
    await flushDomEffects();

    const itemEl0 = requireItemEl(view.root, x);
    const snap0 = snapshotEl(itemEl0);

    const valueEl = requireTargetInput(itemEl0, "value");
    pointerDown(valueEl);
    await flushDomEffects();

    fireViewKey(view, "=");
    await flushDomEffects();

    expect(core.item(x).mode.kind).toBe("source");
    expectSel(core, { container: rootId, item: x, target: "source:expr" });

    const itemEl1 = requireItemEl(view.root, x);
    expectSnapshotSame(snap0, itemEl1);

    const exprEl = requireTargetInput(itemEl1, "source:expr");
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

    const aEl0 = requireItemEl(view.root, a);
    const bEl0 = requireItemEl(view.root, b);
    const cEl0 = requireItemEl(view.root, c);

    core.commit((t) => t.move(c, g, { at: 0 }));
    await flushDomEffects();

    const aEl1 = requireItemEl(view.root, a);
    const bEl1 = requireItemEl(view.root, b);
    const cEl1 = requireItemEl(view.root, c);

    requireSameEl(aEl0, aEl1);
    requireSameEl(bEl0, bEl1);
    requireSameEl(cEl0, cEl1);

    const order = nodeOrderByDataId(view.root, `.ui-outline-node`);
    const filtered = order.filter((id) => id === a || id === b || id === c);
    expect(filtered).toEqual([c, a, b]);
  });

  test("table: navigation does not replace row item roots or cell shells", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScoreId = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowB = mkGroup(core, tableId, { label: "rowB" });
    const bScoreId = mkBlank(core, rowB, { label: "score", value: 6 });

    const view = viewFactories.table({ core, id: tableId });
    mountDomView(view);
    await flushDomEffects();

    core.focus({ container: tableId, item: rowA }, DEFAULT_TARGET);
    await flushDomEffects();

    expectSel(core, { container: tableId, item: rowA, target: DEFAULT_TARGET });

    const rowAEl0 = requireItemEl(view.root, rowA);
    const rowBEl0 = requireItemEl(view.root, rowB);

    const cellA0 = requireEl(
      rowAEl0.querySelector(
        `.ui-table-cell[data-col="score"]`,
      ) as HTMLElement | null,
      "Missing rowA score cell",
    );

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

    const rowAEl1 = requireItemEl(view.root, rowA);
    const rowBEl1 = requireItemEl(view.root, rowB);

    requireSameEl(rowAEl0, rowAEl1);
    requireSameEl(rowBEl0, rowBEl1);

    const cellA1 = requireEl(
      rowAEl1.querySelector(
        `.ui-table-cell[data-col="score"]`,
      ) as HTMLElement | null,
      "Missing rowA score cell",
    );

    requireSameEl(cellA0, cellA1);
  });

  test("table: printable key from row selection focuses first cell value and inserts", async () => {
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

    expectSel(core, { container: rowA, item: aScoreId, target: "value" });

    const cellItemEl = requireItemEl(view.root, aScoreId);
    const valueEl = requireTargetInput(cellItemEl, "value");
    const text = (valueEl as HTMLInputElement | HTMLTextAreaElement).value;
    expect(text.includes("7")).toBe(true);
  });

  test("table: global keydown routes to active nested view (outline hosting a table)", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScore = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowB = mkGroup(core, tableId, { label: "rowB" });
    const bScore = mkBlank(core, rowB, { label: "score", value: 6 });

    const outline = viewFactories.outline({ core, id: rootId });
    mountDomView(outline);
    await flushDomEffects();

    const nestedCell = requireEl(
      outline.root.querySelector(
        `.ui-item[data-view="table"] .ui-table-cell[data-col="score"]`,
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

    core.commit((t) => t.setScalar(sliderId, 100));
    fireViewKey(view, "ArrowRight");
    expect(scalarOfId(core, sliderId)).toBe(100);

    core.commit((t) => t.setScalar(sliderId, 50));
    fireViewKey(view, "ArrowRight", { ctrlKey: true });
    expect(scalarOfId(core, sliderId)).toBe(60);

    core.commit((t) => t.setScalar(sliderId, 50));
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

    const sliderItemEl0 = requireItemEl(outline.root, sliderId);
    const sliderInput0 = requireEl(
      sliderItemEl0.querySelector(
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

    const sliderItemEl1 = requireItemEl(outline.root, sliderId);
    const sliderInput1 = requireEl(
      sliderItemEl1.querySelector(
        `input[type="range"]`,
      ) as HTMLInputElement | null,
      "Missing slider input",
    );

    requireSameEl(sliderItemEl0, sliderItemEl1);
    requireSameEl(sliderInput0, sliderInput1);
  });
});
