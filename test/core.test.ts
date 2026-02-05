import { describe, test, expect } from "bun:test";
import {
  makeCoreRuntime,
  tick,
  scalarOf,
  childrenOf,
  mkBlank,
  mkGroup,
  setDerived,
  setLens,
  setView,
  expectFocused,
} from "./test-utils";

describe("core", () => {
  test("insert/remove basics + locate siblings/index", async () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });

    const locB = core.locate(b);
    expect(locB).not.toBeNull();
    if (locB) {
      expect(locB.ownerId).toBe(g);
      expect(locB.index).toBe(1);
      expect(locB.siblings).toEqual([a, b]);
    }

    core.commit((t) => t.remove(a));
    await tick();

    const locB2 = core.locate(b);
    expect(locB2).not.toBeNull();
    if (locB2) {
      expect(locB2.ownerId).toBe(g);
      expect(locB2.index).toBe(0);
      expect(locB2.siblings).toEqual([b]);
    }
  });

  test("derived reactivity updates content", async () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x", value: 10 });
    const y = mkBlank(core, rootId, { label: "y" });
    setDerived(core, y, "x + 2");

    expect(scalarOf(core.item(y).content)).toBe(12);

    core.commit((t) => t.setScalar(x, 40));
    await tick();
    expect(scalarOf(core.item(y).content)).toBe(42);
  });

  test("cycles become issues", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a" });
    const b = mkBlank(core, rootId, { label: "b" });

    setDerived(core, a, "b");
    setDerived(core, b, "a");

    await tick();
    expect(core.item(a).content.kind).toBe("issue");
    expect(core.item(b).content.kind).toBe("issue");
  });

  test("value-group projection creates readonly path children and locate returns null for them", async () => {
    const { core, rootId } = makeCoreRuntime();

    const d = mkBlank(core, rootId, { label: "d" });
    setDerived(core, d, "split('a,b', ',')");

    await tick();

    const snap = core.item(d);
    expect(snap.content.kind).toBe("group");
    if (snap.content.kind !== "group")
      throw new Error("Expected group content");

    expect(snap.content.children.length).toBe(2);

    const c0 = snap.content.children[0]!;
    const c1 = snap.content.children[1]!;

    const it0 = core.item(c0);
    const it1 = core.item(c1);

    expect(it0.mode.kind).toBe("readonly");
    expect(it1.mode.kind).toBe("readonly");

    expect(scalarOf(it0.content)).toBe("a");
    expect(scalarOf(it1.content)).toBe("b");

    expect(core.locate(c0)).toBe(null);
    expect(core.locate(c1)).toBe(null);
  });

  test("lens produces group of matching rows; supports label/position vars", async () => {
    const { core, rootId } = makeCoreRuntime();

    const rows = mkGroup(core, rootId, { label: "rows" });

    const mkRow = (label: string, score: number) => {
      const row = mkGroup(core, rows, { label });
      mkBlank(core, row, { label: "score", value: score });
      return row;
    };

    mkRow("a", 2);
    mkRow("b", 1);
    mkRow("c", 3);

    const L = mkBlank(core, rootId, { label: "L" });
    setLens(core, L, { from: "rows", where: "score > 1", orderBy: "score" });

    await tick();

    const snap = core.item(L);
    expect(snap.content.kind).toBe("group");
    if (snap.content.kind !== "group")
      throw new Error("Expected group content");
    const labels = snap.content.children.map((id) => core.item(id).label ?? "");
    expect(labels).toEqual(["a", "c"]);

    setLens(core, L, {
      from: "rows",
      where: "position = 1 or label = 'c'",
      orderBy: "label",
    });

    await tick();

    const snap2 = core.item(L);
    expect(snap2.content.kind).toBe("group");
    if (snap2.content.kind !== "group")
      throw new Error("Expected group content");
    const labels2 = snap2.content.children.map(
      (id) => core.item(id).label ?? "",
    );
    expect(labels2).toEqual(["a", "c"]);
  });

  test("selection repair when focused item disappears", async () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: 1 });

    core.focus({ container: g, item: x }, "value");
    core.commit((t) => t.remove(g));
    await tick();

    const sel = core.selection();
    if (sel.kind === "focused") {
      expect(typeof sel.focus.container).toBe("string");
      expect(sel.focus.container.length).toBeGreaterThan(0);
      expect(typeof sel.focus.item).toBe("string");
      expect(sel.focus.item.length).toBeGreaterThan(0);
    } else {
      expect(sel.kind).toBe("idle");
    }
  });

  test("view routing: global keydown reaches active nested view", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const aScore = mkBlank(core, rowA, { label: "score", value: 5 });

    const rowB = mkGroup(core, tableId, { label: "rowB" });
    const bScore = mkBlank(core, rowB, { label: "score", value: 6 });

    const outline = (await import("../src/views")).viewFactories.outline({
      core,
      id: rootId,
    });
    const { mountDomView } = await import("./test-utils");
    const unmount = await mountDomView(outline);

    await tick();

    const nestedCellHost = outline.root.querySelector(
      `.ui-item[data-view="table"] .ui-table-cell[data-col="score"]`,
    ) as HTMLElement | null;

    expect(nestedCellHost).not.toBeNull();
    if (!nestedCellHost) throw new Error("Missing nested cell host");

    nestedCellHost.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    await tick();

    let sel = core.selection();
    expectFocused(sel);
    expect(sel.focus.container).toBe(rowA);
    expect(sel.focus.item).toBe(aScore);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();

    sel = core.selection();
    expectFocused(sel);
    expect(sel.focus.container).toBe(rowB);
    expect(sel.focus.item).toBe(bScore);

    unmount();
  });

  test("setting a group's view does not change its children", async () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });

    setView(core, g, "table");
    await tick();

    expect(childrenOf(core, g)).toEqual([a, b]);
  });
});
