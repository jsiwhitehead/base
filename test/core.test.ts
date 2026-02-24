import { afterEach, describe, expect, test } from "bun:test";

import type { Core, ItemId, Transaction, ViewName } from "../src/core";
import { createCore, DEFAULT_TARGET, VALUE_TARGET } from "../src/core";
import { splitViewRegistrations, viewRegistrations } from "../src/views";
import {
  assertCoreInvariants,
  childrenOf,
  cloneJson,
  expectSel,
  exportSnapshot,
  makePureCore,
  mkBlank,
  mkGroup,
  requireCreatedEntryId,
  setFormula,
  setQuery,
  setView,
  valueOfId,
} from "./core-test-utils";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.toReversed()) fn();
  cleanups.length = 0;
});

function makeCoreForTest(): { core: Core; rootId: ItemId } {
  const ctx = makePureCore();
  cleanups.push(() => ctx.core.dispose());
  return ctx;
}

type TreeShape =
  | {
      label: string;
      mode: string;
      type: "value";
      value: true | number | string | null;
    }
  | { label: string; mode: string; type: "issue"; message: string }
  | { label: string; mode: string; type: "group"; children: TreeShape[] };

type SelectionSnapshot =
  | { type: "idle" }
  | {
      type: "focused";
      focus: { container: ItemId; item: ItemId };
      target: string;
      caret?: { start: number; end: number };
    };

function groupLabels(core: Core, id: ItemId): string[] {
  const item = core.item(id);
  if (item.content.type !== "group") return [];
  return item.content.children.map((childId) => core.item(childId).label ?? "");
}

function tree(core: Core, id: ItemId): TreeShape {
  const item = core.item(id);
  const label = item.label ?? "";
  const mode = item.mode.type;
  const content = item.content;

  if (content.type === "value")
    return { label, mode, type: "value", value: content.value };
  if (content.type === "issue")
    return { label, mode, type: "issue", message: content.message };

  return {
    label,
    mode,
    type: "group",
    children: content.children.map((childId) => tree(core, childId)),
  };
}

function snapshotSelection(
  core: Core,
  opts: { includeCaret?: boolean } = {},
): SelectionSnapshot {
  const selection = core.selection();
  if (selection.type === "idle") return { type: "idle" };

  if (!opts.includeCaret || !selection.caret)
    return {
      type: "focused",
      focus: selection.focus,
      target: selection.target,
    };

  return {
    type: "focused",
    focus: selection.focus,
    target: selection.target,
    caret: { start: selection.caret.start, end: selection.caret.end },
  };
}

function snapshotState(
  core: Core,
  rootId: ItemId,
  opts: { viewIds?: readonly ItemId[]; includeCaret?: boolean } = {},
): {
  tree: TreeShape;
  selection: SelectionSnapshot;
  views?: Record<ItemId, ViewName>;
} {
  const caretOpts =
    opts.includeCaret === undefined ? {} : { includeCaret: opts.includeCaret };

  const views =
    opts.viewIds && opts.viewIds.length
      ? Object.fromEntries(opts.viewIds.map((id) => [id, core.view(id)]))
      : undefined;

  return {
    tree: tree(core, rootId),
    selection: snapshotSelection(core, caretOpts),
    ...(views ? { views } : {}),
  };
}

function expectCommitThrowsNoChange(
  core: Core,
  rootId: ItemId,
  run: Parameters<Core["commit"]>[0],
  opts: { viewIds?: readonly ItemId[]; includeCaret?: boolean } = {},
): void {
  const before = snapshotState(core, rootId, opts);
  expect(() => core.commit(run)).toThrow();
  expect(snapshotState(core, rootId, opts)).toEqual(before);
}

function assertFocusedSelectionStructurallyValid(
  core: Core,
  rootId: ItemId,
): void {
  const selection = core.selection();
  if (selection.type === "idle") return;

  const item = core.item(selection.focus.item);
  const container = core.item(selection.focus.container);
  expect(item.content.type).not.toBe("issue");
  expect(container.content.type).not.toBe("issue");

  if (selection.focus.item === selection.focus.container) return;

  const loc = core.locate(selection.focus.item);
  expect(loc).not.toBeNull();
  expect(loc!.parentId).toBe(selection.focus.container);

  assertCoreInvariants(core, rootId);
}

describe("core/basics", () => {
  test("boot: root exists, is group; selection is focused on root", () => {
    const { core, rootId } = makeCoreForTest();

    expect(core.item(rootId).content.type).toBe("group");
    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });
  });

  test("item(invalid format) throws", () => {
    const { core } = makeCoreForTest();

    expect(() => core.item("not-an-id")).toThrow();
  });

  test("item(valid format, missing item) throws", () => {
    const { core } = makeCoreForTest();

    expect(() => core.item("999999:")).toThrow();
  });

  test("view(invalid format) and view(missing item) throw", () => {
    const { core } = makeCoreForTest();

    expect(() => core.view("not-an-id")).toThrow();
    expect(() => core.view("999999:")).toThrow();
  });

  test("view supports valid derived ids and returns outline", () => {
    const { core, rootId } = makeCoreForTest();
    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    const d = mkBlank(core, rootId, { label: "d" });
    setFormula(core, d, "rows");

    const snap = core.item(d);
    expect(snap.content.type).toBe("group");
    if (snap.content.type !== "group")
      throw new Error("Expected group content");

    const derived = snap.content.children[0];
    if (!derived) throw new Error("Expected derived child");
    expect(core.view(derived)).toBe("outline");
  });

  test("view falls back to outline for shape-incompatible preferred view and recovers", () => {
    const { core, rootId } = makeCoreForTest();
    const s = mkBlank(core, rootId, { label: "s", value: 5 });

    setView(core, s, "slider");
    expect(core.view(s)).toBe("slider");

    setFormula(core, s, "unknown_name");
    expect(core.view(s)).toBe("outline");

    core.commit((t) => t.setValue(s, 7));
    expect(core.view(s)).toBe("slider");
  });
});

describe("core/commit (transactionality)", () => {
  test("empty commit is a no-op", () => {
    const { core, rootId } = makeCoreForTest();

    const before = snapshotState(core, rootId);
    core.commit(() => {});
    const after = snapshotState(core, rootId);

    expect(after).toEqual(before);
  });

  test("commit is atomic: if an op fails, nothing changes", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });

    expectCommitThrowsNoChange(core, rootId, (t) => {
      t.setLabel(b, "a");
    });

    assertCoreInvariants(core, rootId);
  });
});

describe("core/tree editing", () => {
  test("move into self throws and leaves state unchanged", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });

    expectCommitThrowsNoChange(core, rootId, (t) => t.move(g, g));
    assertCoreInvariants(core, rootId);
    core.dispose();
  });

  test("move into descendant throws and leaves state unchanged", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });
    const c = mkGroup(core, g, { label: "c" });

    expectCommitThrowsNoChange(core, rootId, (t) => t.move(g, c));
    assertCoreInvariants(core, rootId);
    core.dispose();
  });

  test("move root throws and leaves state unchanged", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });

    expectCommitThrowsNoChange(core, rootId, (t) => t.move(rootId, g));
    assertCoreInvariants(core, rootId);
    core.dispose();
  });

  test("insertChild appends by default", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });

    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });

    expect(childrenOf(core, g)).toEqual([a, b]);

    assertCoreInvariants(core, rootId);
  });

  test("insertChild(at) inserts at index", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });

    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });

    const c = mkBlank(core, g, { at: 0, label: "c" });
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    assertCoreInvariants(core, rootId);
  });

  test("move within parent reorders", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });

    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });
    const c = mkBlank(core, g, { label: "c" });

    core.commit((t) => t.move(c, g, { at: 0 }));
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    assertCoreInvariants(core, rootId);
  });

  test("move across parents reparents", () => {
    const { core, rootId } = makeCoreForTest();

    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });

    const a = mkBlank(core, g1, { label: "a" });
    const b = mkBlank(core, g1, { label: "b" });

    core.commit((t) => t.move(b, g2));

    expect(childrenOf(core, g1)).toEqual([a]);
    expect(childrenOf(core, g2)).toEqual([b]);

    assertCoreInvariants(core, rootId);
  });

  test("remove removes subtree from parent", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: 1 });
    mkBlank(core, g, { label: "b", value: 2 });

    core.commit((t) => t.remove(g));

    expect(
      childrenOf(core, rootId).some((id) => core.item(id).label === "g"),
    ).toBe(false);
    expect(() => core.item(g)).toThrow();
    expect(core.locate(g)).toBe(null);

    assertCoreInvariants(core, rootId);
  });

  test("remove deletes descendants (cascade delete)", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });
    const row = mkGroup(core, g, { label: "row" });
    const cell = mkBlank(core, row, { label: "cell", value: 1 });

    core.commit((t) => t.remove(g));

    expect(() => core.item(g)).toThrow();
    expect(() => core.item(row)).toThrow();
    expect(() => core.item(cell)).toThrow();
    expect(core.locate(g)).toBe(null);
    expect(core.locate(row)).toBe(null);
    expect(core.locate(cell)).toBe(null);

    const snap = exportSnapshot(core);
    expect(JSON.stringify(snap)).not.toContain(
      `\"id\":${Number(g.slice(0, -1))}`,
    );
    assertCoreInvariants(core, rootId);
  });
});

describe("core/locate", () => {
  test("locate returns parent/index/siblings for item children", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });
    const c = mkBlank(core, g, { label: "c" });

    const locB = core.locate(b);
    expect(locB).not.toBeNull();
    expect(locB!.parentId).toBe(g);
    expect(locB!.index).toBe(1);
    expect(locB!.siblings).toEqual([a, b, c]);
  });

  test("locate returns null for readonly derived children", () => {
    const { core, rootId } = makeCoreForTest();

    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    mkBlank(core, rows, { label: "r2", value: 2 });

    const d = mkBlank(core, rootId, { label: "d" });
    setFormula(core, d, "rows");

    const snap = core.item(d);
    expect(snap.content.type).toBe("group");
    if (snap.content.type !== "group")
      throw new Error("Expected group content");

    const child0 = snap.content.children[0]!;
    expect(core.item(child0).mode.type).toBe("readonly");
    expect(core.locate(child0)).toBe(null);
  });
});

describe("core/values", () => {
  test("setValue supports null/number/string/true", () => {
    const { core, rootId } = makeCoreForTest();

    const x = mkBlank(core, rootId, { label: "x" });

    core.commit((t) => t.setValue(x, null));
    expect(valueOfId(core, x)).toBe(null);

    core.commit((t) => t.setValue(x, 7));
    expect(valueOfId(core, x)).toBe(7);

    core.commit((t) => t.setValue(x, "hi"));
    expect(valueOfId(core, x)).toBe("hi");

    core.commit((t) => t.setValue(x, true));
    expect(valueOfId(core, x)).toBe(true);
  });
});

describe("core/formula", () => {
  test("formula evaluates and updates synchronously on commit", () => {
    const { core, rootId } = makeCoreForTest();

    const x = mkBlank(core, rootId, { label: "x", value: 10 });
    const y = mkBlank(core, rootId, { label: "y" });
    setFormula(core, y, "x + 2");

    expect(valueOfId(core, y)).toBe(12);

    core.commit((t) => t.setValue(x, 40));
    expect(valueOfId(core, y)).toBe(42);
  });

  test("cycles become issues (no crashes)", () => {
    const { core, rootId } = makeCoreForTest();

    const a = mkBlank(core, rootId, { label: "a" });
    const b = mkBlank(core, rootId, { label: "b" });

    setFormula(core, a, "b");
    setFormula(core, b, "a");

    expect(core.item(a).content.type).toBe("issue");
    expect(core.item(b).content.type).toBe("issue");
  });

  test("formula group materialises derived children which are readonly and not locatable", () => {
    const { core, rootId } = makeCoreForTest();

    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    mkBlank(core, rows, { label: "r2", value: 2 });

    const d = mkBlank(core, rootId, { label: "d" });
    setFormula(core, d, "rows");

    const snap = core.item(d);
    expect(snap.content.type).toBe("group");
    if (snap.content.type !== "group")
      throw new Error("Expected group content");

    expect(snap.content.children.length).toBe(2);

    for (const cid of snap.content.children) {
      expect(core.item(cid).mode.type).toBe("readonly");
      expect(core.locate(cid)).toBe(null);
    }
  });
});

describe("core/query", () => {
  test("query filters and sorts rows; supports label/position vars; returns locatable item ids", () => {
    const { core, rootId } = makeCoreForTest();

    const rows = mkGroup(core, rootId, { label: "rows" });

    const mkRow = (label: string, score: number | null) => {
      const row = mkGroup(core, rows, { label });
      mkBlank(core, row, { label: "score", value: score });
      return row;
    };

    mkRow("a", 2);
    mkRow("b", 1);
    mkRow("c", 3);

    const listId = mkBlank(core, rootId, { label: "L" });

    setQuery(core, listId, {
      from: "rows",
      where: "score > 1",
      orderBy: "score",
    });

    expect(groupLabels(core, listId)).toEqual(["a", "c"]);

    {
      const snap = core.item(listId);
      expect(snap.content.type).toBe("group");
      if (snap.content.type !== "group")
        throw new Error("Expected group content");

      for (const cid of snap.content.children) {
        expect(core.item(cid).mode.type).not.toBe("readonly");
        expect(core.locate(cid)).not.toBeNull();
      }
    }

    setQuery(core, listId, {
      from: "rows",
      where: "position = 1 or label = 'c'",
      orderBy: "label",
    });

    expect(groupLabels(core, listId)).toEqual(["a", "c"]);

    assertCoreInvariants(core, rootId);
  });

  test("query orderBy ranks numbers before text before true; blanks/issues sort last; stable tie-break", () => {
    const { core, rootId } = makeCoreForTest();

    const rows = mkGroup(core, rootId, { label: "rows" });

    const mkRow = (
      label: string,
      keyKind: "num" | "text" | "true" | "blank" | "issue",
      value?: unknown,
    ) => {
      const row = mkGroup(core, rows, { label });
      const key = mkBlank(core, row, { label: "key" });
      if (keyKind === "num")
        core.commit((t) => t.setValue(key, value as number));
      else if (keyKind === "text")
        core.commit((t) => t.setValue(key, value as string));
      else if (keyKind === "true") core.commit((t) => t.setValue(key, true));
      else if (keyKind === "blank") core.commit((t) => t.setValue(key, null));
      else if (keyKind === "issue") setFormula(core, key, "unknown_name");
      return row;
    };

    mkRow("n1", "num", 2);
    mkRow("t1", "text", "b");
    mkRow("b1", "blank");
    mkRow("u1", "true");
    mkRow("e1", "issue");
    mkRow("n2", "num", 2);
    mkRow("t2", "text", "a");

    const listId = mkBlank(core, rootId, { label: "L" });
    setQuery(core, listId, { from: "rows", orderBy: "key" });

    expect(groupLabels(core, listId)).toEqual([
      "n1",
      "n2",
      "t2",
      "t1",
      "u1",
      "b1",
      "e1",
    ]);

    assertCoreInvariants(core, rootId);
  });
});

describe("core/view shapes & rules", () => {
  test("table shape coerces table item to group; rows become group", () => {
    const { core, rootId } = makeCoreForTest();

    const tableId = mkBlank(core, rootId, { label: "table", value: "x" });
    setView(core, tableId, "table");

    expect(core.item(tableId).content.type).toBe("group");

    const rowA = mkBlank(core, tableId, { label: "rowA", value: 1 });
    const rowB = mkGroup(core, tableId, { label: "rowB" });
    setView(core, rowB, "slider");

    expect(core.item(rowA).content.type).toBe("group");
    expect(core.item(rowB).content.type).toBe("group");

    assertCoreInvariants(core, rootId);
  });

  test("shape sync across table rows propagates by label (add/reorder/remove)", () => {
    const { core, rootId } = makeCoreForTest();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const rowA = mkGroup(core, tableId, { label: "rowA" });
    const rowB = mkGroup(core, tableId, { label: "rowB" });
    const rowC = mkGroup(core, tableId, { label: "rowC" });

    const aScore = mkBlank(core, rowA, { label: "score", value: 5 });
    const aName = mkBlank(core, rowA, { label: "name", value: "alice" });

    expect(groupLabels(core, rowB)).toEqual(["score", "name"]);
    expect(groupLabels(core, rowC)).toEqual(["score", "name"]);

    core.commit((t) => t.move(aName, rowA, { at: 0 }));
    expect(groupLabels(core, rowA)).toEqual(["name", "score"]);
    expect(groupLabels(core, rowB)).toEqual(["name", "score"]);
    expect(groupLabels(core, rowC)).toEqual(["name", "score"]);

    core.commit((t) => t.remove(aScore));
    expect(groupLabels(core, rowA)).toEqual(["name"]);
    expect(groupLabels(core, rowB)).toEqual(["name"]);
    expect(groupLabels(core, rowC)).toEqual(["name"]);

    assertCoreInvariants(core, rootId);
  });
});

describe("core/history", () => {
  test("setValue edits on same item coalesce into one undo step", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 0 });
    core.focus({ container: rootId, item: x }, VALUE_TARGET);

    core.commit((t) => t.setValue(x, 1));
    core.commit((t) => t.setValue(x, 2));
    core.commit((t) => t.setValue(x, 3));
    expect(valueOfId(core, x)).toBe(3);

    core.undo();
    expect(valueOfId(core, x)).toBe(0);

    core.redo();
    expect(valueOfId(core, x)).toBe(3);
  });

  test("setValue edits on different items do not coalesce", () => {
    const { core, rootId } = makeCoreForTest();
    const a = mkBlank(core, rootId, { label: "a", value: 1 });
    const b = mkBlank(core, rootId, { label: "b", value: 2 });

    core.commit((t) => t.setValue(a, 10));
    core.commit((t) => t.setValue(b, 20));

    core.undo();
    expect(valueOfId(core, a)).toBe(10);
    expect(valueOfId(core, b)).toBe(2);

    core.undo();
    expect(valueOfId(core, a)).toBe(1);
    expect(valueOfId(core, b)).toBe(2);
  });

  test("structural edit does not coalesce with text edits", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: 1 });
    const y = mkBlank(core, g, { label: "y", value: 2 });

    core.commit((t) => t.setValue(x, 10));
    core.commit((t) => t.move(y, rootId, { at: 0 }));
    core.commit((t) => t.setValue(x, 11));

    core.undo();
    expect(valueOfId(core, x)).toBe(10);

    core.undo();
    expect(childrenOf(core, g)).toEqual([x, y]);

    core.undo();
    expect(valueOfId(core, x)).toBe(1);
  });

  test("undo/redo restores structure and values; redo cleared after new commit", () => {
    const { core, rootId } = makeCoreForTest();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });

    core.focus({ container: g, item: a }, DEFAULT_TARGET);

    const before = tree(core, rootId);

    core.commit((t) => {
      t.setValue(a, 10);
      t.remove(g);
    });

    const afterRemove = tree(core, rootId);
    expect(afterRemove).not.toEqual(before);

    core.undo();
    expect(tree(core, rootId)).toEqual(before);

    core.redo();
    expect(tree(core, rootId)).toEqual(afterRemove);

    core.undo();
    expect(tree(core, rootId)).toEqual(before);

    core.commit((t) => {
      t.setValue(b, 99);
    });

    core.redo();
    expect(valueOfId(core, b)).toBe(99);
    expect(
      childrenOf(core, rootId).some((id) => core.item(id).label === "g"),
    ).toBe(true);

    assertCoreInvariants(core, rootId);
  });

  test("remove subtree undo/redo preserves descendant ids", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    const row = mkGroup(core, g, { label: "row" });
    const cell = mkBlank(core, row, { label: "cell", value: 1 });

    core.commit((t) => t.remove(g));
    expect(() => core.item(row)).toThrow();
    expect(() => core.item(cell)).toThrow();

    core.undo();
    expect(childrenOf(core, rootId)).toContain(g);
    expect(childrenOf(core, g)).toContain(row);
    expect(childrenOf(core, row)).toContain(cell);
    expect(valueOfId(core, cell)).toBe(1);

    core.redo();
    expect(() => core.item(g)).toThrow();
    expect(() => core.item(row)).toThrow();
    expect(() => core.item(cell)).toThrow();
  });

  test("removing root clears root and undo restores previous root subtree", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: 1 });

    core.commit((t) => t.remove(rootId));

    const rootAfter = core.item(rootId);
    expect(rootAfter.content.type).toBe("value");
    expect(rootAfter.mode.type).toBe("plain");
    expect(rootAfter.label ?? "").toBe("");
    expect(() => core.item(g)).toThrow();
    expect(() => core.item(x)).toThrow();

    core.undo();
    expect(childrenOf(core, rootId)).toEqual([g]);
    expect(childrenOf(core, g)).toEqual([x]);
    expect(valueOfId(core, x)).toBe(1);
  });
});

describe("core/snapshot", () => {
  test("exportSnapshot returns full state including rootId/nextId/root", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g", view: "table" });
    mkBlank(core, g, { label: "x", value: 1 });

    const snap = core.exportSnapshot();

    expect(snap.rootId).toBe(Number(rootId.slice(0, rootId.indexOf(":"))));
    expect(typeof snap.nextId).toBe("number");
    expect(snap.nextId).toBeGreaterThan(snap.rootId);
    expect(snap.root.id).toBe(snap.rootId);
    expect(snap.root.content.type).toBe("group");
  });

  test("export/import snapshot roundtrip preserves state and ids", () => {
    const { core, rootId } = makeCoreForTest();
    const table = mkGroup(core, rootId, { label: "table", view: "table" });
    const row = mkGroup(core, table, { label: "row" });
    const a = mkBlank(core, row, { label: "a", value: 1 });
    const q = mkBlank(core, rootId, { label: "q" });
    setQuery(core, q, { from: "table", where: "", orderBy: "label" });
    core.focus({ container: row, item: a }, VALUE_TARGET);

    const beforeTree = snapshotState(core, rootId, {
      viewIds: [rootId, table, row, a, q],
      includeCaret: true,
    });
    const snap = core.exportSnapshot();

    core.importSnapshot(snap);

    expect(core.exportSnapshot()).toEqual(snap);
    expect(
      snapshotState(core, rootId, {
        viewIds: [rootId, table, row, a, q],
        includeCaret: true,
      }).tree,
    ).toEqual(beforeTree.tree);
    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });
  });

  test("importSnapshot invalid input throws and leaves state unchanged", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "x", value: 1 });

    const beforeState = snapshotState(core, rootId, { viewIds: [rootId, g] });
    const beforeSnap = core.exportSnapshot();
    const invalid = cloneJson(beforeSnap);
    invalid.nextId = invalid.rootId;

    expect(() => core.importSnapshot(invalid)).toThrow();
    expect(core.exportSnapshot()).toEqual(beforeSnap);
    expect(snapshotState(core, rootId, { viewIds: [rootId, g] })).toEqual(
      beforeState,
    );
  });

  test("importSnapshot clears history and resets selection", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 1 });
    core.commit((t) => t.setValue(x, 2));
    core.focus({ container: rootId, item: x }, VALUE_TARGET);

    const snap = core.exportSnapshot();
    core.importSnapshot(snap);

    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });

    core.undo();
    expect(valueOfId(core, x)).toBe(2);
  });

  test("importSnapshot rejects rootId mismatch", () => {
    const { core } = makeCoreForTest();
    const snap = core.exportSnapshot();
    const invalid = cloneJson(snap);
    invalid.rootId += 1;

    expect(() => core.importSnapshot(invalid)).toThrow();
  });
});

describe("core/selection validity & repair", () => {
  test("focus with invalid container/item pair repairs to valid selection", () => {
    const { core, rootId } = makePureCore();
    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });
    const x = mkBlank(core, g2, { label: "x", value: 1 });

    core.focus({ container: g1, item: x }, DEFAULT_TARGET);

    assertFocusedSelectionStructurallyValid(core, rootId);
    core.dispose();
  });

  test("removing selected item repairs selection to a valid position", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });
    const c = mkBlank(core, g, { label: "c", value: 3 });
    void a;
    void c;

    core.focus({ container: g, item: b }, DEFAULT_TARGET);
    core.commit((t) => t.remove(b));

    assertFocusedSelectionStructurallyValid(core, rootId);
    core.dispose();
  });

  test("moving selected item to another parent repairs invalid container pairing", () => {
    const { core, rootId } = makePureCore();
    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });
    const x = mkBlank(core, g1, { label: "x", value: 1 });

    core.focus({ container: g1, item: x }, DEFAULT_TARGET);
    core.commit((t) => t.move(x, g2));

    assertFocusedSelectionStructurallyValid(core, rootId);
    core.dispose();
  });

  test("remote apply that invalidates selected item sets selection to idle", () => {
    let onRemote: ((txn: Transaction) => void) | undefined;
    const collab = {
      origin: "local",
      send(_txn: Transaction) {},
      subscribe(fn: (txn: Transaction) => void) {
        onRemote = fn;
        return () => {
          onRemote = undefined;
        };
      },
    };

    const { shapes } = splitViewRegistrations(viewRegistrations);
    const { core, rootId } = createCore({ shapes, collab });

    let g = "";
    let x = "";
    core.commit((t) => {
      g = t.insertChild(rootId);
      t.setLabel(g, "g");
      t.setGroup(g);
      x = t.insertChild(g);
      t.setLabel(x, "x");
      t.setValue(x, 1);
    });

    core.focus({ container: g, item: x }, DEFAULT_TARGET);

    const createTxn = {
      ops: [
        { type: "remove" as const, id: Number(x.slice(0, x.indexOf(":"))) },
      ],
      meta: { origin: "remote-peer", seq: 1 },
    };
    if (!onRemote) throw new Error("No collab subscriber");
    onRemote(createTxn);

    expect(core.selection().type).toBe("idle");
    core.dispose();
  });
});

describe("core/id stability", () => {
  test("move/reorder and undo/redo preserve item ids", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });
    const c = mkBlank(core, g, { label: "c", value: 3 });

    core.commit((t) => t.move(c, g, { at: 0 }));
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    core.commit((t) => t.remove(a));
    core.undo();
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    core.redo();
    expect(childrenOf(core, g)).toEqual([c, b]);

    core.undo();
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core/determinism", () => {
  test("same sequence of transactions produces the same final state", () => {
    const { shapes } = splitViewRegistrations(viewRegistrations);
    const runScenario = () => {
      const { core, rootId } = createCore({ shapes });
      let g = "";
      let a = "";
      let b = "";
      core.commit((t) => {
        g = t.insertChild(rootId);
        t.setLabel(g, "g");
        t.setGroup(g);
        a = t.insertChild(g);
        t.setLabel(a, "a");
        t.setValue(a, 1);
        b = t.insertChild(g);
        t.setLabel(b, "b");
        t.setValue(b, 2);
      });
      core.commit((t) => {
        t.move(b, g, { at: 0 });
        t.setValue(a, 10);
      });
      core.focus({ container: g, item: b }, VALUE_TARGET);
      core.undo();
      core.redo();

      const snap = snapshotState(core, rootId, { viewIds: [rootId, g] });
      core.dispose();
      return snap;
    };

    expect(runScenario()).toEqual(runScenario());
  });
});

describe("core/collab (wire contract)", () => {
  test("remote applies; local echo ignored; undo still uses last local inverse", () => {
    let onRemote: ((txn: Transaction) => void) | undefined;
    const sent: Transaction[] = [];
    const origin = "test-origin";

    const collab = {
      origin,
      send(txn: Transaction) {
        sent.push(txn);
      },
      subscribe(fn: (txn: Transaction) => void) {
        onRemote = fn;
        return () => {
          onRemote = undefined;
        };
      },
    };

    const deliver = (txn: Transaction) => {
      if (!onRemote) throw new Error("No collab subscriber");
      onRemote(txn);
    };

    const { core, rootId } = createCore({ shapes: {}, collab });

    let x = "";
    core.commit((t) => {
      x = t.insertChild(rootId);
      t.setLabel(x, "x");
      t.setValue(x, 1);
    });

    core.commit((t) => t.setValue(x, 2));
    expect(valueOfId(core, x)).toBe(2);

    core.undo();
    expect(valueOfId(core, x)).toBe(1);

    core.commit((t) => t.setValue(x, 3));
    expect(valueOfId(core, x)).toBe(3);

    const localLast = sent.at(-1);
    expect(localLast).toBeTruthy();
    deliver(localLast!);
    expect(valueOfId(core, x)).toBe(3);

    const createdTxn = sent.find((txn) =>
      txn.ops.some((op) => op.type === "create"),
    );
    if (!createdTxn) throw new Error("Expected a create transaction");
    const entryId = requireCreatedEntryId(createdTxn);

    const remoteTxn: Transaction = {
      ops: [
        {
          type: "patch",
          id: entryId,
          next: { content: { type: "scalar", value: 99 } },
        },
      ],
      meta: { origin: "someone-else", seq: 1 },
    };

    deliver(remoteTxn);
    expect(valueOfId(core, x)).toBe(99);

    core.undo();
    expect(valueOfId(core, x)).toBe(1);

    core.dispose();
  });
});
