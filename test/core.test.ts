import { describe, expect, test } from "bun:test";

import type { Core, ItemId, Transaction, ViewName } from "../src/core";
import { DEFAULT_TARGET, VALUE_TARGET, createCore } from "../src/core";
import { viewRegistrations } from "../src/views";
import {
  childrenOf,
  expectSel,
  flushDomEffects,
  makeCoreRuntime,
  mkBlank,
  mkGroup,
  requireCreatedEntryId,
  valueOfId,
  setFormula,
  setQuery,
  setView,
} from "./test-utils";

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
  const sel = core.selection();
  if (sel.type === "idle") return { type: "idle" };

  if (!opts.includeCaret || !sel.caret)
    return { type: "focused", focus: sel.focus, target: sel.target };

  return {
    type: "focused",
    focus: sel.focus,
    target: sel.target,
    caret: { start: sel.caret.start, end: sel.caret.end },
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

function assertCoreInvariants(core: Core, rootId: ItemId): void {
  const seen = new Set<ItemId>();
  const stack: ItemId[] = [rootId];

  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const it = core.item(id);
    const isQuery =
      it.mode.type === "connected" && it.mode.conn.type === "query";

    if (it.content.type !== "group") continue;
    for (const childId of it.content.children) {
      const loc = core.locate(childId);
      if (!loc) {
        expect(core.item(childId).mode.type).toBe("readonly");
        stack.push(childId);
        continue;
      }

      if (!isQuery) expect(loc.parentId).toBe(id);
      expect(loc.index).toBeGreaterThanOrEqual(0);
      expect(loc.index).toBeLessThan(loc.siblings.length);
      expect(loc.siblings[loc.index]).toBe(childId);
      expect(loc.siblings.filter((x) => x === childId).length).toBe(1);

      stack.push(childId);
    }
  }
}

describe("core/basics", () => {
  test("boot: root exists, is group; selection is focused on root", () => {
    const { core, rootId } = makeCoreRuntime();

    expect(core.item(rootId).content.type).toBe("group");
    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });
  });

  test("item(invalid format) returns issue (does not throw)", () => {
    const { core } = makeCoreRuntime();

    expect(core.item("not-an-id").content.type).toBe("issue");
  });

  test("item(valid format, missing item) returns issue (does not throw)", () => {
    const { core } = makeCoreRuntime();

    expect(core.item("999999:").content.type).toBe("issue");
  });
});

describe("core/commit (transactionality)", () => {
  test("empty commit is a no-op", () => {
    const { core, rootId } = makeCoreRuntime();

    const before = snapshotState(core, rootId);
    core.commit(() => {});
    const after = snapshotState(core, rootId);

    expect(after).toEqual(before);
  });

  test("commit is atomic: if an op fails, nothing changes", () => {
    const { core, rootId } = makeCoreRuntime();

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
  test("insertChild appends by default", () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });

    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });

    expect(childrenOf(core, g)).toEqual([a, b]);

    assertCoreInvariants(core, rootId);
  });

  test("insertChild(at) inserts at index", () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });

    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });

    const c = mkBlank(core, g, { at: 0, label: "c" });
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    assertCoreInvariants(core, rootId);
  });

  test("move within parent reorders", () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });

    const a = mkBlank(core, g, { label: "a" });
    const b = mkBlank(core, g, { label: "b" });
    const c = mkBlank(core, g, { label: "c" });

    core.commit((t) => t.move(c, g, { at: 0 }));
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    assertCoreInvariants(core, rootId);
  });

  test("move across parents reparents", () => {
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: 1 });
    mkBlank(core, g, { label: "b", value: 2 });

    core.commit((t) => t.remove(g));

    expect(
      childrenOf(core, rootId).some((id) => core.item(id).label === "g"),
    ).toBe(false);
    expect(core.item(g).content.type).toBe("issue");
    expect(core.locate(g)).toBe(null);

    assertCoreInvariants(core, rootId);
  });
});

describe("core/locate", () => {
  test("locate returns parent/index/siblings for item children", () => {
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x", value: 10 });
    const y = mkBlank(core, rootId, { label: "y" });
    setFormula(core, y, "x + 2");

    expect(valueOfId(core, y)).toBe(12);

    core.commit((t) => t.setValue(x, 40));
    expect(valueOfId(core, y)).toBe(42);
  });

  test("cycles become issues (no crashes)", () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a" });
    const b = mkBlank(core, rootId, { label: "b" });

    setFormula(core, a, "b");
    setFormula(core, b, "a");

    expect(core.item(a).content.type).toBe("issue");
    expect(core.item(b).content.type).toBe("issue");
  });

  test("formula group materialises derived children which are readonly and not locatable", () => {
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

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

describe("core/view constraints & rules", () => {
  test("table constraint coerces table item to group; rows become group", () => {
    const { core, rootId } = makeCoreRuntime();

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
    const { core, rootId } = makeCoreRuntime();

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
  test("undo/redo restores structure and values; redo cleared after new commit", () => {
    const { core, rootId } = makeCoreRuntime();

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
});

describe("core/target binding", () => {
  test("focus prefers exact target binding and falls back to DEFAULT_TARGET", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });
    const focus = { container: rootId, item: x };

    const defaultEl = document.createElement("button");
    const valueEl = document.createElement("input");
    document.body.append(defaultEl, valueEl);

    const cleanDefault = core.attachTarget({
      focus,
      target: DEFAULT_TARGET,
      getEl: () => defaultEl,
    });

    core.focus(focus, VALUE_TARGET);
    await flushDomEffects();
    expect(document.activeElement).toBe(defaultEl);

    const cleanValue = core.attachTarget({
      focus,
      target: VALUE_TARGET,
      getEl: () => valueEl,
    });

    core.focus(focus, VALUE_TARGET);
    await flushDomEffects();
    expect(document.activeElement).toBe(valueEl);

    cleanValue();
    cleanDefault();
  });

  test("new binding for same (focus, target) replaces previous binding", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });
    const focus = { container: rootId, item: x };

    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);

    const c1 = core.attachTarget({
      focus,
      target: DEFAULT_TARGET,
      getEl: () => first,
    });
    core.focus(focus, DEFAULT_TARGET);
    await flushDomEffects();
    expect(document.activeElement).toBe(first);

    const c2 = core.attachTarget({
      focus,
      target: DEFAULT_TARGET,
      getEl: () => second,
    });
    core.focus(focus, DEFAULT_TARGET);
    await flushDomEffects();
    expect(document.activeElement).toBe(second);

    c2();
    c1();
  });
});

describe("core/view mounting", () => {
  test("mountView treats item ids as opaque and can render fallback issue snapshots", () => {
    const { core } = makeCoreRuntime();

    const bad1 = core.mountView({ id: "not-an-id" as ItemId, view: "outline" });
    const bad2 = core.mountView({ id: "999999:" as ItemId, view: "outline" });

    expect(bad1.el.classList.contains("ui-body")).toBe(true);
    expect(bad1.el.classList.contains("ui-outline")).toBe(true);
    expect(bad2.el.classList.contains("ui-body")).toBe(true);
    expect(bad2.el.classList.contains("ui-outline")).toBe(true);

    bad1.dispose();
    bad2.dispose();
  });

  test("mountView falls back to outline when requested view factory is missing", () => {
    const { core, rootId } = makeCoreRuntime({ views: viewRegistrations });

    const mounted = core.mountView({
      id: rootId,
      view: "nonexistent" as ViewName,
    });

    expect(mounted.el.classList.contains("ui-body")).toBe(true);
    expect(mounted.el.classList.contains("ui-outline")).toBe(true);

    mounted.dispose();
  });

  test("mountView throws when requested view and outline fallback are both missing", () => {
    const { core, rootId } = makeCoreRuntime({ views: {} });

    expect(() =>
      core.mountView({ id: rootId, view: "nonexistent" as ViewName }),
    ).toThrow();
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

    const { core, rootId } = createCore({ constraints: {}, collab });

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
