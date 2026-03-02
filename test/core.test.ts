import { afterEach, describe, expect, test } from "bun:test";

import type { Core, ItemId, Transaction, ViewName } from "../src/core";
import {
  CoreApiError,
  CoreOpError,
  CoreReadError,
  createCore,
  VALUE_TARGET,
} from "../src/core";
import { splitViewRegistrations, viewRegistrations } from "../src/views";
import {
  assertCoreInvariants,
  childrenOf,
  cloneJson,
  expectSel,
  expectThrowsWithCode,
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

function entryIdOf(id: ItemId): number {
  return Number(id.slice(0, id.indexOf(":")));
}

function nextEntryId(core: Pick<Core, "exportSnapshot">): number {
  return core.exportSnapshot().nextId;
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
      type: "item";
      anchor: { container: ItemId; item: ItemId };
      head: { container: ItemId; item: ItemId };
    }
  | {
      type: "editing";
      location: { container: ItemId; item: ItemId };
      target: string;
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

function snapshotSelection(core: Core): SelectionSnapshot {
  const selection = core.selection();
  if (selection.type === "idle") return { type: "idle" };
  if (selection.type === "item")
    return { type: "item", anchor: selection.anchor, head: selection.head };
  return {
    type: "editing",
    location: selection.location,
    target: selection.target,
  };
}

function snapshotState(
  core: Core,
  rootId: ItemId,
  opts: { viewIds?: readonly ItemId[] } = {},
): {
  tree: TreeShape;
  selection: SelectionSnapshot;
  views?: Record<ItemId, ViewName>;
} {
  const views =
    opts.viewIds && opts.viewIds.length
      ? Object.fromEntries(opts.viewIds.map((id) => [id, core.view(id)]))
      : undefined;

  return {
    tree: tree(core, rootId),
    selection: snapshotSelection(core),
    ...(views ? { views } : {}),
  };
}

function expectCommitThrowsNoChange(
  core: Core,
  rootId: ItemId,
  run: Parameters<Core["commit"]>[0],
  opts: {
    viewIds?: readonly ItemId[];
    expected?:
      | { cls: typeof CoreApiError; code: "INVALID_ITEM_ID" }
      | { cls: typeof CoreApiError; code: "DERIVED_ITEM_ID" }
      | { cls: typeof CoreApiError; code: "UNKNOWN_ITEM_ID" }
      | { cls: typeof CoreOpError; code: "DUPLICATE_CHILD_LABEL" }
      | { cls: typeof CoreOpError; code: "CANNOT_MOVE_INTO_SELF" }
      | { cls: typeof CoreOpError; code: "CANNOT_MOVE_INTO_DESCENDANT" };
  } = {},
): void {
  const before = snapshotState(core, rootId, opts);
  if (opts.expected) {
    expectThrowsWithCode(opts.expected.cls, opts.expected.code, () =>
      core.commit(run),
    );
  } else {
    expect(() => core.commit(run)).toThrow();
  }
  expect(snapshotState(core, rootId, opts)).toEqual(before);
}

function assertFocusedSelectionStructurallyValid(
  core: Core,
  rootId: ItemId,
): void {
  const selection = core.selection();
  if (selection.type === "editing") {
    const item = core.item(selection.location.item);
    const container = core.item(selection.location.container);
    expect(item.content.type).not.toBe("issue");
    expect(container.content.type).not.toBe("issue");
    if (selection.location.item === selection.location.container) return;
    const loc = core.locate(selection.location.item);
    expect(loc).not.toBeNull();
    expect(loc!.parentId).toBe(selection.location.container);
    assertCoreInvariants(core, rootId);
  } else if (selection.type === "item") {
    const anchor = core.item(selection.anchor.item);
    expect(anchor.content.type).not.toBe("issue");
    assertCoreInvariants(core, rootId);
  }
}

type ItemContent = ReturnType<Core["item"]>["content"];

function expectGroupContent(
  content: ItemContent,
): Extract<ItemContent, { type: "group" }> {
  expect(content.type).toBe("group");
  if (content.type !== "group") throw new Error("Expected group content");
  return content;
}

function makeCollabHarness(): {
  core: Core;
  rootId: ItemId;
  deliver: (txn: Transaction) => void;
} {
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
  const deliver = (txn: Transaction) => {
    if (!onRemote) throw new Error("No collab subscriber");
    onRemote(txn);
  };
  return { core, rootId, deliver };
}

function expectRemoteRejectedNoMutation(
  core: Pick<Core, "exportSnapshot">,
  run: () => void,
  opts?: { expectThrow?: true },
): void {
  const before = core.exportSnapshot();
  let threw = false;
  try {
    run();
  } catch {
    threw = true;
  }
  if (opts?.expectThrow) expect(threw).toBe(true);
  expect(core.exportSnapshot()).toEqual(before);
}

describe("core/basics", () => {
  test("boot: root exists, is group; selection is focused on root", () => {
    const { core, rootId } = makeCoreForTest();

    expect(core.item(rootId).content.type).toBe("group");
    expectSel(core, { container: rootId, item: rootId });
  });

  test("item(invalid format) throws", () => {
    const { core } = makeCoreForTest();

    expectThrowsWithCode(CoreReadError, "INVALID_ITEM_ID", () =>
      core.item("not-an-id"),
    );
  });

  test("item(valid format, missing item) throws", () => {
    const { core } = makeCoreForTest();

    expectThrowsWithCode(CoreReadError, "UNKNOWN_ITEM_ID", () =>
      core.item("999999:"),
    );
  });

  test("view(invalid format) and view(missing item) throw", () => {
    const { core } = makeCoreForTest();

    expectThrowsWithCode(CoreReadError, "INVALID_ITEM_ID", () =>
      core.view("not-an-id"),
    );
    expectThrowsWithCode(CoreReadError, "UNKNOWN_ITEM_ID", () =>
      core.view("999999:"),
    );
  });

  test("view supports valid derived ids and returns outline", () => {
    const { core, rootId } = makeCoreForTest();
    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    const d = mkBlank(core, rootId, { label: "d" });
    setFormula(core, d, "rows");

    const snapGroup = expectGroupContent(core.item(d).content);

    const derived = snapGroup.children[0];
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

    expectCommitThrowsNoChange(
      core,
      rootId,
      (t) => {
        t.setLabel(b, "a");
      },
      {
        expected: { cls: CoreOpError, code: "DUPLICATE_CHILD_LABEL" },
      },
    );

    assertCoreInvariants(core, rootId);
  });

  test("commit throws INVALID_ITEM_ID for malformed item ids", () => {
    const { core, rootId } = makeCoreForTest();
    mkBlank(core, rootId, { label: "x", value: 1 });

    expectCommitThrowsNoChange(
      core,
      rootId,
      (t) => t.setLabel("not-an-id", "x2"),
      { expected: { cls: CoreApiError, code: "INVALID_ITEM_ID" } },
    );
  });

  test("commit throws DERIVED_ITEM_ID for readonly derived item ids", () => {
    const { core, rootId } = makeCoreForTest();
    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    const d = mkBlank(core, rootId, { label: "d" });
    setFormula(core, d, "rows");
    const derived = expectGroupContent(core.item(d).content).children[0];
    if (!derived) throw new Error("Expected derived child");

    expectCommitThrowsNoChange(core, rootId, (t) => t.setLabel(derived, "x"), {
      expected: { cls: CoreApiError, code: "DERIVED_ITEM_ID" },
    });
  });

  test("commit throws UNKNOWN_ITEM_ID for missing item ids", () => {
    const { core, rootId } = makeCoreForTest();
    mkBlank(core, rootId, { label: "x", value: 1 });

    expectCommitThrowsNoChange(
      core,
      rootId,
      (t) => t.setLabel("999999:", "x"),
      {
        expected: { cls: CoreApiError, code: "UNKNOWN_ITEM_ID" },
      },
    );
  });
});

describe("core/tree editing", () => {
  test("move into self throws and leaves state unchanged", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });

    expectCommitThrowsNoChange(core, rootId, (t) => t.move(g, g), {
      expected: { cls: CoreOpError, code: "CANNOT_MOVE_INTO_SELF" },
    });
    assertCoreInvariants(core, rootId);
  });

  test("move into descendant throws and leaves state unchanged", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    const c = mkGroup(core, g, { label: "c" });

    expectCommitThrowsNoChange(core, rootId, (t) => t.move(g, c), {
      expected: { cls: CoreOpError, code: "CANNOT_MOVE_INTO_DESCENDANT" },
    });
    assertCoreInvariants(core, rootId);
  });

  test("move root throws and leaves state unchanged", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });

    expectCommitThrowsNoChange(core, rootId, (t) => t.move(rootId, g));
    assertCoreInvariants(core, rootId);
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

    const snapGroup = expectGroupContent(core.item(d).content);

    const child0 = snapGroup.children[0]!;
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

    const snapGroup = expectGroupContent(core.item(d).content);

    expect(snapGroup.children.length).toBe(2);

    for (const cid of snapGroup.children) {
      expect(core.item(cid).mode.type).toBe("readonly");
      expect(core.locate(cid)).toBe(null);
    }
  });

  test("formula referencing a removed sibling yields an issue", () => {
    const { core, rootId } = makeCoreForTest();

    const a = mkBlank(core, rootId, { label: "a", value: 10 });
    const b = mkBlank(core, rootId, { label: "b" });
    setFormula(core, b, "a");

    expect(valueOfId(core, b)).toBe(10);

    core.commit((t) => t.remove(a));
    expect(core.item(b).content.type).toBe("issue");
  });

  test("formula dependency chain recovers when a removed name is restored", () => {
    const { core, rootId } = makeCoreForTest();

    const a = mkBlank(core, rootId, { label: "a", value: 10 });
    const b = mkBlank(core, rootId, { label: "b" });
    const c = mkBlank(core, rootId, { label: "c" });
    setFormula(core, b, "a + 1");
    setFormula(core, c, "b + 1");

    expect(valueOfId(core, b)).toBe(11);
    expect(valueOfId(core, c)).toBe(12);

    core.commit((t) => t.remove(a));
    expect(core.item(b).content.type).toBe("issue");
    expect(core.item(c).content.type).toBe("issue");

    mkBlank(core, rootId, { label: "a", value: 10 });
    expect(valueOfId(core, b)).toBe(11);
    expect(valueOfId(core, c)).toBe(12);

    assertCoreInvariants(core, rootId);
  });

  test("formula dependency chain toggles between issue and value across undo/redo", () => {
    const { core, rootId } = makeCoreForTest();

    const a = mkBlank(core, rootId, { label: "a", value: 10 });
    const b = mkBlank(core, rootId, { label: "b" });
    const c = mkBlank(core, rootId, { label: "c" });
    setFormula(core, b, "a + 1");
    setFormula(core, c, "b + 1");

    core.commit((t) => t.remove(a));
    expect(core.item(b).content.type).toBe("issue");
    expect(core.item(c).content.type).toBe("issue");

    core.undo();
    expect(valueOfId(core, b)).toBe(11);
    expect(valueOfId(core, c)).toBe(12);

    core.redo();
    expect(core.item(b).content.type).toBe("issue");
    expect(core.item(c).content.type).toBe("issue");

    assertCoreInvariants(core, rootId);
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
      const group = expectGroupContent(core.item(listId).content);
      for (const cid of group.children) {
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

  test("query result shrinks when a source item is removed", () => {
    const { core, rootId } = makeCoreForTest();

    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    const r2 = mkBlank(core, rows, { label: "r2", value: 2 });
    mkBlank(core, rows, { label: "r3", value: 3 });

    const listId = mkBlank(core, rootId, { label: "L" });
    setQuery(core, listId, { from: "rows" });

    const beforeGroup = expectGroupContent(core.item(listId).content);
    expect(beforeGroup.children.length).toBe(3);

    core.commit((t) => t.remove(r2));

    const afterGroup = expectGroupContent(core.item(listId).content);
    expect(afterGroup.children.length).toBe(2);

    assertCoreInvariants(core, rootId);
  });

  test("query result remove/undo/redo stays consistent", () => {
    const { core, rootId } = makeCoreForTest();

    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    const r2 = mkBlank(core, rows, { label: "r2", value: 2 });
    mkBlank(core, rows, { label: "r3", value: 3 });

    const listId = mkBlank(core, rootId, { label: "L" });
    setQuery(core, listId, { from: "rows" });

    const beforeGroup = expectGroupContent(core.item(listId).content);
    expect(beforeGroup.children.length).toBe(3);

    core.commit((t) => t.remove(r2));

    const afterRemoveGroup = expectGroupContent(core.item(listId).content);
    expect(afterRemoveGroup.children.length).toBe(2);

    core.undo();
    const afterUndoGroup = expectGroupContent(core.item(listId).content);
    expect(afterUndoGroup.children.length).toBe(3);

    core.redo();
    const afterRedoGroup = expectGroupContent(core.item(listId).content);
    expect(afterRedoGroup.children.length).toBe(2);

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
    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });

    core.commit((t) => t.setValue(x, 1));
    core.commit((t) => t.setValue(x, 2));
    core.commit((t) => t.setValue(x, 3));
    expect(valueOfId(core, x)).toBe(3);

    core.undo();
    expect(valueOfId(core, x)).toBe(0);

    core.redo();
    expect(valueOfId(core, x)).toBe(3);
  });

  test("text coalescing is inclusive at 500ms and splits after 500ms", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 0 });
    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });

    const realNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      core.commit((t) => t.setValue(x, 1));
      now = 10_500;
      core.commit((t) => t.setValue(x, 2));
      now = 11_001;
      core.commit((t) => t.setValue(x, 3));
    } finally {
      Date.now = realNow;
    }

    expect(valueOfId(core, x)).toBe(3);

    core.undo();
    expect(valueOfId(core, x)).toBe(2);

    core.undo();
    expect(valueOfId(core, x)).toBe(0);
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

    core.focus({
      type: "item",
      anchor: { container: g, item: a },
      head: { container: g, item: a },
    });

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
    core.focus({
      type: "editing",
      location: { container: row, item: a },
      target: VALUE_TARGET,
    });

    const beforeTree = snapshotState(core, rootId, {
      viewIds: [rootId, table, row, a, q],
    });
    const snap = core.exportSnapshot();

    core.importSnapshot(snap);

    expect(core.exportSnapshot()).toEqual(snap);
    expect(
      snapshotState(core, rootId, { viewIds: [rootId, table, row, a, q] }).tree,
    ).toEqual(beforeTree.tree);
    expectSel(core, { container: rootId, item: rootId });
  });

  test("importSnapshot invalid input throws and leaves state unchanged", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "x", value: 1 });

    const beforeState = snapshotState(core, rootId, { viewIds: [rootId, g] });
    const beforeSnap = core.exportSnapshot();
    const invalid = cloneJson(beforeSnap);
    invalid.nextId = invalid.rootId;

    expectThrowsWithCode(CoreApiError, "SNAPSHOT_PARSE_ERROR", () =>
      core.importSnapshot(invalid),
    );
    expect(core.exportSnapshot()).toEqual(beforeSnap);
    expect(snapshotState(core, rootId, { viewIds: [rootId, g] })).toEqual(
      beforeState,
    );
  });

  test("importSnapshot clears history and resets selection", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 1 });
    core.commit((t) => t.setValue(x, 2));
    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });

    const snap = core.exportSnapshot();
    core.importSnapshot(snap);

    expectSel(core, { container: rootId, item: rootId });

    core.undo();
    expect(valueOfId(core, x)).toBe(2);
  });

  test("importSnapshot rejects rootId mismatch", () => {
    const { core } = makeCoreForTest();
    const snap = core.exportSnapshot();
    const invalid = cloneJson(snap);
    invalid.rootId += 1;

    expectThrowsWithCode(CoreApiError, "SNAPSHOT_ROOT_MISMATCH", () =>
      core.importSnapshot(invalid),
    );
  });
});

describe("core/selection validity & repair", () => {
  test("focus keeps existing editing selection even when container/item pair is mismatched", () => {
    const { core, rootId } = makeCoreForTest();
    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });
    const x = mkBlank(core, g2, { label: "x", value: 1 });

    core.focus({
      type: "editing",
      location: { container: g1, item: x },
      target: VALUE_TARGET,
    });

    expect(core.selection()).toEqual({
      type: "editing",
      location: { container: g1, item: x },
      target: VALUE_TARGET,
    });
  });

  test("removing selected item repairs selection to a valid position", () => {
    const { core, rootId } = makeCoreForTest();
    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });
    const c = mkBlank(core, g, { label: "c", value: 3 });
    void a;
    void c;

    core.focus({
      type: "item",
      anchor: { container: g, item: b },
      head: { container: g, item: b },
    });
    core.commit((t) => t.remove(b));

    assertFocusedSelectionStructurallyValid(core, rootId);
  });

  test("repair anchor falls back to last surviving sibling when multiple trailing siblings are removed", () => {
    const { core, rootId } = makeCoreForTest();
    const a = mkBlank(core, rootId, { label: "a", value: 1 });
    const b = mkBlank(core, rootId, { label: "b", value: 2 });
    const c = mkBlank(core, rootId, { label: "c", value: 3 });
    const d = mkBlank(core, rootId, { label: "d", value: 4 });
    const e = mkBlank(core, rootId, { label: "e", value: 5 });
    void a;
    void c;
    void e;

    core.focus({
      type: "item",
      anchor: { container: rootId, item: d },
      head: { container: rootId, item: d },
    });

    core.commit((t) => {
      t.remove(c);
      t.remove(d);
      t.remove(e);
    });

    expectSel(core, { container: rootId, item: b });
  });

  test("moving selected item to another parent repairs invalid container pairing", () => {
    const { core, rootId } = makeCoreForTest();
    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });
    const x = mkBlank(core, g1, { label: "x", value: 1 });

    core.focus({
      type: "item",
      anchor: { container: g1, item: x },
      head: { container: g1, item: x },
    });
    core.commit((t) => t.move(x, g2));

    assertFocusedSelectionStructurallyValid(core, rootId);
  });

  test("user setView on editing item snaps selection to item at same location", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 1 });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });

    setView(core, x, "slider");

    expect(core.selection()).toEqual({
      type: "item",
      anchor: { container: rootId, item: x },
      head: { container: rootId, item: x },
    });
  });

  test("undo view patch (including null view) snaps editing selection to item", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 1 });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });
    setView(core, x, "slider");
    expectSel(core, { container: rootId, item: x });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });
    setView(core, x, null);
    expectSel(core, { container: rootId, item: x });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });
    core.undo();

    expect(core.selection()).toEqual({
      type: "item",
      anchor: { container: rootId, item: x },
      head: { container: rootId, item: x },
    });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });
    core.undo();

    expect(core.selection()).toEqual({
      type: "item",
      anchor: { container: rootId, item: x },
      head: { container: rootId, item: x },
    });
  });

  test("remote apply that invalidates selected item sets selection to idle", () => {
    const { core, rootId, deliver } = makeCollabHarness();

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

    core.focus({
      type: "item",
      anchor: { container: g, item: x },
      head: { container: g, item: x },
    });

    deliver({
      ops: [
        { type: "remove" as const, id: Number(x.slice(0, x.indexOf(":"))) },
      ],
      meta: { origin: "remote-peer", seq: 1 },
    });

    expect(core.selection().type).toBe("idle");
    core.dispose();
  });

  test("remote setView on editing item snaps selection to item", () => {
    const { core, rootId, deliver } = makeCollabHarness();
    const x = mkBlank(core, rootId, { label: "x", value: 1 });
    const y = mkBlank(core, rootId, { label: "y", value: 2 });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });

    deliver({
      ops: [
        {
          type: "patch" as const,
          id: Number(y.slice(0, y.indexOf(":"))),
          next: { view: "slider" as const },
        },
      ],
      meta: { origin: "remote-peer", seq: 1 },
    });

    expect(core.selection()).toEqual({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });

    deliver({
      ops: [
        {
          type: "patch" as const,
          id: Number(x.slice(0, x.indexOf(":"))),
          next: { view: "slider" as const },
        },
      ],
      meta: { origin: "remote-peer", seq: 2 },
    });

    expect(core.selection()).toEqual({
      type: "item",
      anchor: { container: rootId, item: x },
      head: { container: rootId, item: x },
    });
    core.dispose();
  });

  test("setView on different item keeps editing selection unchanged", () => {
    const { core, rootId } = makeCoreForTest();
    const x = mkBlank(core, rootId, { label: "x", value: 1 });
    const y = mkBlank(core, rootId, { label: "y", value: 2 });

    core.focus({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });
    setView(core, y, "slider");

    expect(core.selection()).toEqual({
      type: "editing",
      location: { container: rootId, item: x },
      target: VALUE_TARGET,
    });
  });
});

describe("core/id stability", () => {
  test("move/reorder and undo/redo preserve item ids", () => {
    const { core, rootId } = makeCoreForTest();
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
      core.focus({
        type: "editing",
        location: { container: g, item: b },
        target: VALUE_TARGET,
      });
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

  test("remote structural edits preserve invariants", () => {
    const { core, rootId, deliver } = makeCollabHarness();

    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });
    const x = mkBlank(core, g1, { label: "x", value: 1 });
    const y = mkBlank(core, g1, { label: "y", value: 2 });

    deliver({
      ops: [
        {
          type: "move",
          spec: {
            childId: entryIdOf(y),
            toParentId: entryIdOf(g2),
          },
        },
      ],
      meta: { origin: "remote-peer", seq: 1 },
    });
    expect(childrenOf(core, g2)).toContain(y);
    assertCoreInvariants(core, rootId);

    deliver({
      ops: [{ type: "remove", id: entryIdOf(x) }],
      meta: { origin: "remote-peer", seq: 2 },
    });
    expect(() => core.item(x)).toThrow();
    assertCoreInvariants(core, rootId);

    const zEntryId = nextEntryId(core);
    deliver({
      ops: [
        {
          type: "create",
          entry: {
            id: zEntryId,
            parentId: null,
            label: "",
            view: null,
            content: { type: "blank" },
          },
        },
        {
          type: "patch",
          id: zEntryId,
          next: { label: "z", content: { type: "scalar", value: 3 } },
        },
        {
          type: "move",
          spec: { childId: zEntryId, toParentId: entryIdOf(g1) },
        },
      ],
      meta: { origin: "remote-peer", seq: 3 },
    });
    expect(childrenOf(core, g1).some((id) => core.item(id).label === "z")).toBe(
      true,
    );
    assertCoreInvariants(core, rootId);

    core.dispose();
  });

  test("remote remove and restore recompute formula dependencies", () => {
    const { core, rootId, deliver } = makeCollabHarness();

    const a = mkBlank(core, rootId, { label: "a", value: 10 });
    const b = mkBlank(core, rootId, { label: "b" });
    const c = mkBlank(core, rootId, { label: "c" });
    setFormula(core, b, "a + 1");
    setFormula(core, c, "b + 1");
    expect(valueOfId(core, c)).toBe(12);

    deliver({
      ops: [{ type: "remove", id: entryIdOf(a) }],
      meta: { origin: "remote-peer", seq: 1 },
    });
    expect(core.item(b).content.type).toBe("issue");
    expect(core.item(c).content.type).toBe("issue");

    const restoredA = nextEntryId(core);
    deliver({
      ops: [
        {
          type: "create",
          entry: {
            id: restoredA,
            parentId: null,
            label: "",
            view: null,
            content: { type: "blank" },
          },
        },
        {
          type: "patch",
          id: restoredA,
          next: { label: "a", content: { type: "scalar", value: 10 } },
        },
        {
          type: "move",
          spec: { childId: restoredA, toParentId: entryIdOf(rootId) },
        },
      ],
      meta: { origin: "remote-peer", seq: 2 },
    });
    expect(valueOfId(core, b)).toBe(11);
    expect(valueOfId(core, c)).toBe(12);
    assertCoreInvariants(core, rootId);

    core.dispose();
  });

  test("malformed remote move is rejected atomically with no state change", () => {
    const { core, rootId, deliver } = makeCollabHarness();

    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: 1 });

    expectRemoteRejectedNoMutation(
      core,
      () =>
        deliver({
          ops: [
            {
              type: "move",
              spec: { childId: entryIdOf(x), toParentId: 999_999 },
            },
          ],
          meta: { origin: "remote-peer", seq: 1 },
        }),
      { expectThrow: true },
    );
    assertCoreInvariants(core, rootId);
    core.dispose();
  });

  test("malformed remote remove is rejected atomically with no state change", () => {
    const { core, rootId, deliver } = makeCollabHarness();

    mkBlank(core, rootId, { label: "x", value: 1 });
    expectRemoteRejectedNoMutation(core, () =>
      deliver({
        ops: [{ type: "remove", id: 999_999 }],
        meta: { origin: "remote-peer", seq: 1 },
      }),
    );
    assertCoreInvariants(core, rootId);
    core.dispose();
  });

  test("malformed remote multi-op transaction rolls back earlier ops", () => {
    const { core, rootId, deliver } = makeCollabHarness();

    const x = mkBlank(core, rootId, { label: "x", value: 1 });
    expectRemoteRejectedNoMutation(core, () =>
      deliver({
        ops: [
          {
            type: "patch",
            id: entryIdOf(x),
            next: { content: { type: "scalar", value: 42 } },
          },
          { type: "remove", id: 999_999 },
        ],
        meta: { origin: "remote-peer", seq: 1 },
      }),
    );
    expect(valueOfId(core, x)).toBe(1);
    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});
