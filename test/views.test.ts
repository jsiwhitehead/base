import { describe, test, expect } from "bun:test";
import { DEFAULT_TARGET } from "../src/core";
import { viewFactories } from "../src/views";
import {
  makeCoreRuntime,
  tick,
  mountDomView,
  mkBlank,
  mkGroup,
  setView,
  scalarOf,
  expectFocused,
  findItemEl,
  findPresenterSurface,
  queryTargetInput,
  pointerDown,
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
    const unmount = await mountDomView(view);

    await tick();
    expectFocused(core.selection());

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    expectFocused(core.selection());

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    expectFocused(core.selection());

    const sel = core.selection();
    expectFocused(sel);

    const itemEl = findItemEl(view.root, sel.focus.item);
    expect(itemEl).not.toBeNull();

    const surface = findPresenterSurface(itemEl);
    expect(surface).not.toBeNull();

    pointerDown(surface!);
    await tick();

    expect(document.activeElement === surface).toBe(true);

    const sel2 = core.selection();
    expectFocused(sel2);
    expect(sel2.target).toBe(DEFAULT_TARGET);

    unmount();
  });

  test("outline: '=' on empty value editor switches to derived and focuses expr", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x" });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountDomView(view);

    await tick();

    const itemEl = findItemEl(view.root, x);
    expect(itemEl).not.toBeNull();
    if (!itemEl) throw new Error("Missing item element");

    const valueEl = queryTargetInput(itemEl, "value");
    expect(valueEl).not.toBeNull();
    if (!valueEl) throw new Error("Missing value input");

    pointerDown(valueEl);
    await tick();

    valueEl.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "=",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    expect(core.item(x).mode.kind).toBe("source");

    const sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe("source:expr");

    unmount();
  });

  test("table: arrow navigation row -> right -> cell; left -> row; down -> next row", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScoreId = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowB = mkGroup(core, tableId, { label: "rowB" });
    const bScoreId = mkBlank(core, rowB, { label: "score", value: 6 });

    const view = viewFactories.table({ core, id: tableId });
    const unmount = await mountDomView(view);

    await tick();

    let sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);
    expect(sel.focus.container).toBe(tableId);
    expect(sel.focus.item).toBe(rowA);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();

    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);
    expect(sel.focus.container).toBe(rowA);
    expect(sel.focus.item).toBe(aScoreId);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await tick();

    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);
    expect(sel.focus.container).toBe(tableId);
    expect(sel.focus.item).toBe(rowA);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();

    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);
    expect(sel.focus.container).toBe(rowB);
    expect(sel.focus.item).toBe(bScoreId);

    unmount();
  });

  test("slider: input updates scalar; arrow nudge clamps; Home sets min", async () => {
    const { core, rootId } = makeCoreRuntime();

    const sliderId = mkBlank(core, rootId, { label: "slider", value: 10 });
    setView(core, sliderId, "slider");

    const view = viewFactories.slider({ core, id: sliderId });
    const unmount = await mountDomView(view);

    const input = view.root.querySelector(
      `input[type="range"]`,
    ) as HTMLInputElement | null;

    expect(input).not.toBeNull();
    if (!input) throw new Error("Missing slider input");

    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(scalarOf(core.item(sliderId).content)).toBe(42);

    core.commit((t) => t.setScalar(sliderId, 100));
    await tick();

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    expect(scalarOf(core.item(sliderId).content)).toBe(100);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "Home" }));
    await tick();
    expect(scalarOf(core.item(sliderId).content)).toBe(0);

    unmount();
  });
});
