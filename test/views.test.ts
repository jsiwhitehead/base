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
  requirePresenterSurface,
  requireTargetInput,
  requireEl,
} from "./test-utils";

describe("views", () => {
  test("outline: initial focus; arrow nav keeps focused; click focuses presenter surface", async () => {
    const { core, rootId } = makeCoreRuntime();

    core.commit((t) => {
      const a = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(a, "a");
      t.setScalar(a, 1);

      const g = t.insertChild(rootId, { kind: "group" });
      t.setLabel(g, "g");

      const b = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(b, "b");
      t.setScalar(b, 3);
    });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);

    expect(core.selection().kind).toBe("focused");

    fireViewKey(view, "ArrowDown");
    expect(core.selection().kind).toBe("focused");

    fireViewKey(view, "ArrowRight");
    expect(core.selection().kind).toBe("focused");

    const sel = core.selection();
    expect(sel.kind).toBe("focused");
    if (sel.kind !== "focused") throw new Error("Expected focused selection");

    const itemEl = requireItemEl(view.root, sel.focus.item);
    const surface = requirePresenterSurface(itemEl);

    pointerDown(surface);
    await flushDomEffects();
    expect(document.activeElement === surface).toBe(true);

    expectSel(core, {
      container: sel.focus.container,
      item: sel.focus.item,
      target: DEFAULT_TARGET,
    });
  });

  test("outline: printable key at DEFAULT_TARGET enters value editor and inserts", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x" });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);

    expectSel(core, { container: rootId, item: x, target: DEFAULT_TARGET });

    fireViewKey(view, "A");
    await flushDomEffects();

    expectSel(core, { container: rootId, item: x, target: "value" });

    const itemEl = requireItemEl(view.root, x);
    const valueEl = requireTargetInput(itemEl, "value");
    const text = (valueEl as HTMLInputElement | HTMLTextAreaElement).value;
    expect(text.includes("A")).toBe(true);
  });

  test("outline: '=' on empty value editor switches to derived and focuses expr", () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x" });

    const view = viewFactories.outline({ core, id: rootId });
    mountDomView(view);

    const itemEl = requireItemEl(view.root, x);
    const valueEl = requireTargetInput(itemEl, "value");

    pointerDown(valueEl);

    valueEl.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "=",
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(core.item(x).mode.kind).toBe("source");
    expectSel(core, { container: rootId, item: x, target: "source:expr" });
  });

  test("table: arrow navigation row -> right -> cell; left -> row; down -> next row", () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScoreId = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowB = mkGroup(core, tableId, { label: "rowB" });
    const bScoreId = mkBlank(core, rowB, { label: "score", value: 6 });

    const view = viewFactories.table({ core, id: tableId });
    mountDomView(view);

    expectSel(core, { container: tableId, item: rowA, target: DEFAULT_TARGET });

    fireViewKey(view, "ArrowRight");
    expectSel(core, {
      container: rowA,
      item: aScoreId,
      target: DEFAULT_TARGET,
    });

    fireViewKey(view, "ArrowLeft");
    expectSel(core, { container: tableId, item: rowA, target: DEFAULT_TARGET });

    fireViewKey(view, "ArrowRight");
    fireViewKey(view, "ArrowDown");
    expectSel(core, {
      container: rowB,
      item: bScoreId,
      target: DEFAULT_TARGET,
    });
  });

  test("table: printable key from row selection focuses first cell value and inserts", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScoreId = mkBlank(core, rowA, { label: "score" });

    const view = viewFactories.table({ core, id: tableId });
    mountDomView(view);

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

    const nestedCellHost = requireEl(
      outline.root.querySelector(
        `.ui-item[data-view="table"] .ui-table-cell[data-col="score"]`,
      ) as HTMLElement | null,
      "Missing nested cell host",
    );

    pointerDown(nestedCellHost);
    await flushDomEffects();

    expectSel(core, { container: rowA, item: aScore, target: DEFAULT_TARGET });

    fireWindowKey("ArrowDown");
    expectSel(core, { container: rowB, item: bScore, target: DEFAULT_TARGET });
  });

  test("slider: input updates scalar; arrow nudge clamps; Home sets min; End sets max; modifiers scale nudge", () => {
    const { core, rootId } = makeCoreRuntime();

    const sliderId = mkBlank(core, rootId, { label: "slider", value: 10 });
    setView(core, sliderId, "slider");

    const view = viewFactories.slider({ core, id: sliderId });
    mountDomView(view);

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

    fireViewKey(view, "Home");
    expect(scalarOfId(core, sliderId)).toBe(0);

    fireViewKey(view, "End");
    expect(scalarOfId(core, sliderId)).toBe(100);

    core.commit((t) => t.setScalar(sliderId, 50));
    fireViewKey(view, "ArrowRight", { shiftKey: true });
    expect(scalarOfId(core, sliderId)).toBe(60);

    core.commit((t) => t.setScalar(sliderId, 0));
    fireViewKey(view, "ArrowRight", { altKey: true });
    expect(scalarOfId(core, sliderId)).toBe(0.1);
  });
});
