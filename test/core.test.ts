import { describe, expect, test } from "bun:test";

import type { Transaction } from "../src/core";
import { DEFAULT_TARGET, createCore } from "../src/core";
import {
  makeCoreRuntime,
  scalarOf,
  childrenOf,
  mkBlank,
  mkGroup,
  setFormula,
  setQuery,
  setView,
  expectFocused,
  expectSel,
  groupLabels,
  tree,
} from "./test-utils";

describe("core/model", () => {
  test("insert/move/remove/locate preserves sibling order and indices", () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });
    const c = mkBlank(core, g, { label: "c", value: 3 });

    const locB = core.locate(b);
    expect(locB).not.toBeNull();
    expect(locB!.ownerId).toBe(g);
    expect(locB!.index).toBe(1);
    expect(locB!.siblings).toEqual([a, b, c]);

    core.commit((t) => t.move(c, g, { at: 0 }));
    expect(childrenOf(core, g)).toEqual([c, a, b]);

    const locA = core.locate(a)!;
    expect(locA.index).toBe(1);
    expect(locA.siblings).toEqual([c, a, b]);

    core.commit((t) => t.remove(a));
    expect(childrenOf(core, g)).toEqual([c, b]);

    const locB2 = core.locate(b)!;
    expect(locB2.index).toBe(1);
    expect(locB2.siblings).toEqual([c, b]);
  });

  test("label uniqueness is enforced within a group (setLabel + move)", () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });

    expect(() => {
      core.commit((t) => t.setLabel(b, "a"));
    }).toThrow();

    const outside = mkBlank(core, rootId, { label: "a", value: 9 });

    expect(() => {
      core.commit((t) => t.move(outside, g));
    }).toThrow();

    expect(childrenOf(core, g)).toEqual([a, b]);
  });
});

describe("core/eval", () => {
  test("formula reactivity updates content synchronously on commit", () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x", value: 10 });
    const y = mkBlank(core, rootId, { label: "y" });
    setFormula(core, y, "x + 2");

    expect(scalarOf(core.item(y).content)).toBe(12);

    core.commit((t) => t.setValue(x, 40));
    expect(scalarOf(core.item(y).content)).toBe(42);
  });

  test("cycles become issues", () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a" });
    const b = mkBlank(core, rootId, { label: "b" });

    setFormula(core, a, "b");
    setFormula(core, b, "a");

    expect(core.item(a).content.kind).toBe("issue");
    expect(core.item(b).content.kind).toBe("issue");
  });

  test("formula entry-group materializes into readonly value-group children (paths) and cannot be located", () => {
    const { core, rootId } = makeCoreRuntime();

    const rows = mkGroup(core, rootId, { label: "rows" });
    mkBlank(core, rows, { label: "r1", value: 1 });
    mkBlank(core, rows, { label: "r2", value: 2 });

    const d = mkBlank(core, rootId, { label: "d" });
    setFormula(core, d, "rows");

    const snap = core.item(d);
    expect(snap.content.kind).toBe("group");
    if (snap.content.kind !== "group")
      throw new Error("Expected group content");

    expect(snap.content.children.length).toBe(2);

    const c0 = snap.content.children[0]!;
    const c1 = snap.content.children[1]!;

    expect(core.item(c0).mode.kind).toBe("readonly");
    expect(core.item(c1).mode.kind).toBe("readonly");

    expect(scalarOf(core.item(c0).content)).toBe(1);
    expect(scalarOf(core.item(c1).content)).toBe(2);

    expect(core.locate(c0)).toBe(null);
    expect(core.locate(c1)).toBe(null);
  });

  test("query filters and sorts entry rows; supports label/position vars; returns entry items (not readonly paths)", () => {
    const { core, rootId } = makeCoreRuntime();

    const rows = mkGroup(core, rootId, { label: "rows" });

    const mkRow = (label: string, score: number | null) => {
      const row = mkGroup(core, rows, { label });
      mkBlank(core, row, { label: "score", value: score });
      return row;
    };

    const ra = mkRow("a", 2);
    const rb = mkRow("b", 1);
    const rc = mkRow("c", 3);

    const L = mkBlank(core, rootId, { label: "L" });
    setQuery(core, L, { from: "rows", where: "score > 1", orderBy: "score" });

    const s1 = core.item(L);
    expect(s1.content.kind).toBe("group");
    if (s1.content.kind !== "group") throw new Error("Expected group content");

    const labels1 = s1.content.children.map((id) => core.item(id).label ?? "");
    expect(labels1).toEqual(["a", "c"]);

    for (const cid of s1.content.children) {
      expect(core.item(cid).mode.kind).not.toBe("readonly");
      expect(core.locate(cid)).not.toBe(null);
    }

    setQuery(core, L, {
      from: "rows",
      where: "position = 1 or label = 'c'",
      orderBy: "label",
    });

    const s2 = core.item(L);
    expect(s2.content.kind).toBe("group");
    if (s2.content.kind !== "group") throw new Error("Expected group content");

    const labels2 = s2.content.children.map((id) => core.item(id).label ?? "");
    expect(labels2).toEqual(["a", "c"]);

    expect(core.item(ra).label).toBe("a");
    expect(core.item(rb).label).toBe("b");
    expect(core.item(rc).label).toBe("c");
  });

  test("query orderBy ranks numbers before text before true; blanks/issues sort last; stable tie-break by original order", () => {
    const { core, rootId } = makeCoreRuntime();

    const rows = mkGroup(core, rootId, { label: "rows" });

    const mkRow = (
      label: string,
      keyKind: "num" | "text" | "true" | "blank" | "issue",
      v?: any,
    ) => {
      const row = mkGroup(core, rows, { label });
      const key = mkBlank(core, row, { label: "key" });
      if (keyKind === "num") core.commit((t) => t.setValue(key, v));
      else if (keyKind === "text") core.commit((t) => t.setValue(key, v));
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

    const L = mkBlank(core, rootId, { label: "L" });
    setQuery(core, L, { from: "rows", orderBy: "key" });

    const labels = groupLabels(core, L);
    expect(labels).toEqual(["n1", "n2", "t2", "t1", "u1", "b1", "e1"]);
  });
});

describe("core/history", () => {
  test("undo/redo restores structure and scalars (including group remove/restore)", () => {
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
    expect(scalarOf(core.item(b).content)).toBe(99);
    expect(
      childrenOf(core, rootId).some((id) => core.item(id).label === "g"),
    ).toBe(true);
  });

  test("redo stack is cleared after a new user commit", () => {
    const { core, rootId } = makeCoreRuntime();

    const x = mkBlank(core, rootId, { label: "x", value: 1 });
    core.commit((t) => t.setValue(x, 2));
    expect(scalarOf(core.item(x).content)).toBe(2);

    core.undo();
    expect(scalarOf(core.item(x).content)).toBe(1);

    core.commit((t) => t.setValue(x, 7));
    expect(scalarOf(core.item(x).content)).toBe(7);

    core.redo();
    expect(scalarOf(core.item(x).content)).toBe(7);
  });
});

describe("core/invariants & rules", () => {
  test("table invariant: table becomes group; rows become group", () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkBlank(core, rootId, {
      label: "table",
      value: "not a group",
    });
    setView(core, tableId, "table");

    expect(core.item(tableId).content.kind).toBe("group");

    const rowA = mkBlank(core, tableId, { label: "rowA", value: 1 });
    const rowB = mkGroup(core, tableId, { label: "rowB" });
    setView(core, rowB, "slider");

    expect(core.item(rowA).content.kind).toBe("group");
    expect(core.item(rowB).content.kind).toBe("group");
  });

  test("shape sync across table rows: adding/reordering/removing columns propagates by label", () => {
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

    const bKids = childrenOf(core, rowB);
    const bScore = bKids.find((id) => core.item(id).label === "score")!;
    const bName = bKids.find((id) => core.item(id).label === "name")!;
    expect(scalarOf(core.item(bScore).content)).toBe(null);
    expect(scalarOf(core.item(bName).content)).toBe(null);

    core.commit((t) => t.move(aName, rowA, { at: 0 }));
    expect(groupLabels(core, rowA)).toEqual(["name", "score"]);
    expect(groupLabels(core, rowB)).toEqual(["name", "score"]);
    expect(groupLabels(core, rowC)).toEqual(["name", "score"]);

    core.commit((t) => t.remove(aScore));
    expect(groupLabels(core, rowA)).toEqual(["name"]);
    expect(groupLabels(core, rowB)).toEqual(["name"]);
    expect(groupLabels(core, rowC)).toEqual(["name"]);
  });
});

describe("core/selection", () => {
  test("selection repair: when focused item/container disappear, selection snaps to root focus", () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: 1 });

    core.focus({ container: g, item: x }, "value");
    expectFocused(core.selection());

    core.commit((t) => t.remove(g));

    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });
  });
});

describe("core/collab", () => {
  test("remote transactions apply; local echo is ignored; undo still applies last local inverse", () => {
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

    const { core, rootId } = createCore({ views: {}, collab });

    let x = "";
    core.commit((t) => {
      x = t.insertChild(rootId);
      t.setLabel(x, "x");
      t.setValue(x, 1);
    });

    core.commit((t) => t.setValue(x, 2));
    expect(scalarOf(core.item(x).content)).toBe(2);

    core.undo();
    expect(scalarOf(core.item(x).content)).toBe(1);

    core.commit((t) => t.setValue(x, 3));
    expect(scalarOf(core.item(x).content)).toBe(3);

    const localLast = sent.at(-1);
    expect(localLast).toBeTruthy();
    deliver(localLast!);
    expect(scalarOf(core.item(x).content)).toBe(3);

    const entryId = Number(x.split(":")[0]);
    const remoteTxn: Transaction = {
      ops: [
        {
          kind: "patch",
          id: entryId,
          next: { content: { kind: "scalar", value: 99 } },
        },
      ],
      meta: { origin: "someone-else", seq: 1 },
    };

    deliver(remoteTxn);
    expect(scalarOf(core.item(x).content)).toBe(99);

    core.undo();
    expect(scalarOf(core.item(x).content)).toBe(1);

    core.dispose();
  });
});
