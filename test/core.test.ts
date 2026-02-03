import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type ItemId,
  type Selection,
  type Content,
  createCore,
  DEFAULT_TARGET,
} from "../src/core";
import {
  createModel,
  type Model,
  type EntryId,
  type SnapshotContent,
  makeBlankEntry,
  makeGroupEntry,
  normalizeLabel,
} from "../src/core/model";
import {
  V,
  createEvaluator,
  type Value,
  isBlankValue,
  isIssueValue,
  isScalarValue,
} from "../src/core/eval";
import { interpretExpr } from "../src/core/lang";
import { viewFactories } from "../src/views";

beforeAll(() => {
  GlobalRegistrator.register();
});

const cleanups = new Set<() => void>();

afterEach(() => {
  document.body.replaceChildren();
  for (const fn of cleanups) fn();
  cleanups.clear();
});

async function tick() {
  await new Promise<void>((r) => setTimeout(r, 0));
}

function makeCoreRuntime() {
  const { core, rootId } = createCore({ views: viewFactories as any });
  cleanups.add(() => core.dispose());
  return { core, rootId };
}

function makeModelRuntime() {
  const model = createModel();
  const rootId = model.createId();
  model.setRoot(rootId);
  model.apply(
    model.ops.transaction([
      model.ops.create(makeGroupEntry(rootId)),
      model.ops.patch(rootId, { view: "outline" }),
    ]),
  );
  return { model, rootId };
}

async function mountView(view: {
  root: HTMLElement;
  onKeyDown?: (e: KeyboardEvent) => void;
  dispose(): void;
}) {
  document.body.replaceChildren(view.root);
  await tick();
  return () => {
    view.dispose();
    document.body.replaceChildren();
  };
}

function contentToScalar(content: Content): true | number | string | null {
  if (content.kind === "issue") throw new Error(`Issue: ${content.message}`);
  if (content.kind === "group") throw new Error("Expected scalar, got group");
  return content.value;
}

type FocusedSelection = Extract<Selection, { kind: "focused" }>;

function expectFocused(sel: Selection): asserts sel is FocusedSelection {
  expect(sel.kind).toBe("focused");
  if (sel.kind !== "focused") throw new Error("Expected focused selection");
}

type SnapshotGroupContent = Extract<SnapshotContent, { kind: "group" }>;

function expectSnapshotGroup(c: SnapshotContent): SnapshotGroupContent {
  expect(c.kind).toBe("group");
  if (c.kind !== "group") throw new Error("Expected group snapshot content");
  return c;
}

function assertPublicModelContracts(model: Model) {
  const root = model.rootId();
  expect(model.hasEntry(root)).toBe(true);

  const seen = new Set<EntryId>();
  const stack: EntryId[] = [root];

  while (stack.length) {
    const gid = stack.pop()!;
    if (seen.has(gid)) continue;
    seen.add(gid);

    const kids = model.childIdsOf(gid);

    for (const cid of kids) {
      expect(model.hasEntry(cid)).toBe(true);
      const child = model.readEntry(cid);
      expect(child.ownerId).toBe(gid);

      const loc = model.locateInOwner(cid);
      expect(loc).not.toBeNull();
      if (loc) {
        expect(loc.ownerId).toBe(gid);
        expect(loc.childIds[loc.index]).toBe(cid);
      }

      stack.push(cid);
    }

    const labelToId = new Map<string, EntryId>();
    for (const cid of kids) {
      const nm = normalizeLabel(model.readEntry(cid).label);
      if (!nm) continue;
      const prev = labelToId.get(nm);
      expect(prev).toBeUndefined();
      labelToId.set(nm, cid);
    }
  }
}

function asScalarValue(v: Value): true | number | string | null {
  if (isBlankValue(v)) return null;
  expect(v.kind).toBe("scalar");
  if (!isScalarValue(v)) throw new Error(`Expected scalar, got ${v.kind}`);
  return v.value;
}

function queryTargetInput(root: HTMLElement, target: string) {
  return (
    (root.querySelector(
      `[data-target="${target}"] textarea, [data-target="${target}"] input`,
    ) as HTMLTextAreaElement | HTMLInputElement | null) ??
    (root.querySelector(
      `textarea[data-target="${target}"], input[data-target="${target}"]`,
    ) as HTMLTextAreaElement | HTMLInputElement | null)
  );
}

describe("model", () => {
  function addBlankChild(model: Model, ownerId: EntryId, label = "") {
    const id = model.createId();
    model.apply(
      model.ops.transaction([
        model.ops.create(makeBlankEntry(id)),
        ...(label ? [model.ops.patch(id, { label })] : []),
        model.ops.reparent({ childId: id, toOwnerId: ownerId }),
      ]),
    );
    return id;
  }

  function addGroupChild(model: Model, ownerId: EntryId, label = "") {
    const id = model.createId();
    model.apply(
      model.ops.transaction([
        model.ops.create(makeGroupEntry(id)),
        ...(label ? [model.ops.patch(id, { label })] : []),
        model.ops.reparent({ childId: id, toOwnerId: ownerId }),
      ]),
    );
    return id;
  }

  test("root exists, snapshot omits empty label, label uniqueness enforced, prune removes detached subtrees", () => {
    const { model, rootId } = makeModelRuntime();

    const g = addGroupChild(model, rootId, "g");
    const x = addBlankChild(model, g, "x");
    model.apply(
      model.ops.transaction([
        model.ops.patch(x, { content: { kind: "scalar", value: 1 } }),
      ]),
    );

    expect(() => addBlankChild(model, rootId, " Name ")).not.toThrow();
    expect(() => addBlankChild(model, rootId, "Name")).toThrow();

    const blankLabelId = addBlankChild(model, rootId, "");
    const snap0 = model.snapshot(blankLabelId);
    expect(snap0.label).toBeUndefined();

    model.apply(
      model.ops.transaction([
        model.ops.reparent({ childId: g, toOwnerId: null }),
      ]),
    );
    const pruned = model.pruneUnreachable();
    expect(pruned.removed).toBeGreaterThanOrEqual(1);
    expect(pruned.removedIds).toContain(g);
    expect(model.hasEntry(g)).toBe(false);

    const rootSnap = model.snapshot(rootId);
    expect(rootSnap.view).toBe("outline");
    const grp = expectSnapshotGroup(rootSnap.content);
    expect(Array.isArray(grp.childIds)).toBe(true);

    assertPublicModelContracts(model);
  });

  test("reparent within same group ordering rules", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, "a");
    const b = addBlankChild(model, rootId, "b");
    const c = addBlankChild(model, rootId, "c");

    model.apply(
      model.ops.transaction([
        model.ops.reparent({ childId: a, toOwnerId: rootId, toIndex: 3 }),
      ]),
    );
    expect(model.childIdsOf(rootId)).toEqual([b, c, a]);

    model.apply(
      model.ops.transaction([
        model.ops.reparent({ childId: c, toOwnerId: rootId, toIndex: 0 }),
      ]),
    );
    expect(model.childIdsOf(rootId)).toEqual([c, b, a]);

    assertPublicModelContracts(model);
  });

  test("reparent across owners enforces label uniqueness; detach and no-op move behavior", () => {
    const { model, rootId } = makeModelRuntime();

    const ga = addGroupChild(model, rootId, "ga");
    const gb = addGroupChild(model, rootId, "gb");

    const xa = addBlankChild(model, ga, "x");
    const xb = addBlankChild(model, gb, "x");

    expect(() =>
      model.apply(
        model.ops.transaction([
          model.ops.reparent({ childId: xa, toOwnerId: gb }),
        ]),
      ),
    ).toThrow();

    model.apply(model.ops.transaction([model.ops.patch(xa, { label: "" })]));

    expect(() =>
      model.apply(
        model.ops.transaction([
          model.ops.reparent({ childId: xa, toOwnerId: gb }),
        ]),
      ),
    ).not.toThrow();

    expect(model.readEntry(xa).ownerId).toBe(gb);
    expect(model.childIdsOf(ga)).toEqual([]);
    expect(model.childIdsOf(gb)).toEqual([xb, xa]);

    const before = model.childIdsOf(gb);
    const res = model.apply(
      model.ops.transaction([
        model.ops.reparent({
          childId: xa,
          toOwnerId: gb,
          toIndex: before.indexOf(xa),
        }),
      ]),
    );
    expect(model.childIdsOf(gb)).toEqual(before);
    expect(res.reparented.length).toBe(1);

    model.apply(
      model.ops.transaction([
        model.ops.reparent({ childId: xb, toOwnerId: null }),
      ]),
    );
    expect(model.readEntry(xb).ownerId).toBe(null);

    assertPublicModelContracts(model);
  });

  test("patch rejects group content updates; label patch checks uniqueness; findChildIdByLabel normalizes", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, " A ");
    const b = addBlankChild(model, rootId, "b");

    expect(model.findChildIdByLabel(rootId, "A")).toBe(a);
    expect(model.findChildIdByLabel(rootId, "  ")).toBe(null);

    expect(() =>
      model.apply(model.ops.transaction([model.ops.patch(a, { label: "b" })])),
    ).toThrow();

    expect(() =>
      model.apply(
        model.ops.transaction([
          model.ops.patch(rootId, {
            content: { kind: "group", childIds: [] } as any,
          }),
        ]),
      ),
    ).toThrow();

    assertPublicModelContracts(model);
  });
});

describe("lang", () => {
  test("precedence, unary, blank propagation, string escapes, parse error => issue", () => {
    const env = {
      lookup: (_name: string) => V.issue("unbound"),
      resolve: (_id: EntryId) => V.issue("unbound"),
      getLabel: (_id: EntryId) => "",
    };

    expect(asScalarValue(interpretExpr("1 + 2 * 3", env))).toBe(7);
    expect(asScalarValue(interpretExpr("(1 + 2) * 3", env))).toBe(9);
    expect(asScalarValue(interpretExpr("--1", env))).toBe(1);
    expect(isBlankValue(interpretExpr("blank + 1", env))).toBe(true);

    expect(asScalarValue(interpretExpr("'a\\nb'", env))).toBe("a\nb");
    expect(asScalarValue(interpretExpr('"a\\"b"', env))).toBe('a"b');
    expect(asScalarValue(interpretExpr("'\\u0041'", env))).toBe("A");

    expect(isIssueValue(interpretExpr("1 +", env))).toBe(true);
  });

  test("member + select-by-label + implicit dot member", () => {
    const model = createModel();
    const rootId = model.createId();
    model.setRoot(rootId);
    model.apply(
      model.ops.transaction([model.ops.create(makeGroupEntry(rootId))]),
    );

    const evaluator = createEvaluator({ model, interpret: interpretExpr });

    const g = model.createId();
    const a = model.createId();
    const b = model.createId();

    model.apply(
      model.ops.transaction([
        model.ops.create(makeGroupEntry(g)),
        model.ops.patch(g, { label: "g" }),
        model.ops.reparent({ childId: g, toOwnerId: rootId }),

        model.ops.create(makeBlankEntry(a)),
        model.ops.patch(a, {
          label: "a",
          content: { kind: "scalar", value: 10 },
        }),
        model.ops.reparent({ childId: a, toOwnerId: g }),

        model.ops.create(makeBlankEntry(b)),
        model.ops.patch(b, {
          label: "b",
          content: { kind: "scalar", value: 20 },
        }),
        model.ops.reparent({ childId: b, toOwnerId: g }),
      ]),
    );

    const env = {
      lookup: (name: string) => {
        if (name === "g") return V.entryGroup([a, b]);
        if (name === "_") return V.entryGroup([a, b]);
        return V.issue(`unbound: ${name}`);
      },
      resolve: (id: EntryId) => evaluator.value(id),
      getLabel: (id: EntryId) => normalizeLabel(model.readEntry(id).label),
    };

    expect(asScalarValue(interpretExpr("g.a", env))).toBe(10);
    expect(asScalarValue(interpretExpr("g['b']", env))).toBe(20);
    expect(asScalarValue(interpretExpr(".a", env))).toBe(10);

    evaluator.dispose();
    assertPublicModelContracts(model);
  });

  test("select-by-position, pipe syntax, and key builtins", () => {
    const model = createModel();
    const rootId = model.createId();
    model.setRoot(rootId);
    model.apply(
      model.ops.transaction([model.ops.create(makeGroupEntry(rootId))]),
    );

    const evaluator = createEvaluator({ model, interpret: interpretExpr });

    const a = model.createId();
    const b = model.createId();
    const c = model.createId();

    model.apply(
      model.ops.transaction([
        model.ops.create(makeBlankEntry(a)),
        model.ops.patch(a, {
          label: "a",
          content: { kind: "scalar", value: 1 },
        }),
        model.ops.reparent({ childId: a, toOwnerId: rootId }),

        model.ops.create(makeBlankEntry(b)),
        model.ops.patch(b, {
          label: "b",
          content: { kind: "scalar", value: 2 },
        }),
        model.ops.reparent({ childId: b, toOwnerId: rootId }),

        model.ops.create(makeBlankEntry(c)),
        model.ops.patch(c, {
          label: "c",
          content: { kind: "scalar", value: 3 },
        }),
        model.ops.reparent({ childId: c, toOwnerId: rootId }),
      ]),
    );

    const env = {
      lookup: (name: string) => {
        if (name === "g") return V.entryGroup([a, b, c]);
        if (name === "_") return V.entryGroup([a, b, c]);
        return V.issue(`unbound: ${name}`);
      },
      resolve: (id: EntryId) => evaluator.value(id),
      getLabel: (id: EntryId) => normalizeLabel(model.readEntry(id).label),
    };

    expect(asScalarValue(interpretExpr("g[2]", env))).toBe(2);
    expect(isIssueValue(interpretExpr("g[0]", env))).toBe(true);

    expect(asScalarValue(interpretExpr("sum(g)", env))).toBe(6);
    expect(asScalarValue(interpretExpr("g:count()", env))).toBe(3);

    expect(asScalarValue(interpretExpr("text_or(blank, 'x')", env))).toBe("x");
    expect(asScalarValue(interpretExpr("If(true, 1, 2)", env))).toBe(1);
    expect(isBlankValue(interpretExpr("and(true, blank)", env))).toBe(true);
    expect(asScalarValue(interpretExpr("or(blank, true)", env))).toBe(true);

    expect(
      asScalarValue(interpretExpr("join(split('a,b', ','), '-')", env)),
    ).toBe("a-b");

    evaluator.dispose();
    assertPublicModelContracts(model);
  });
});

describe("eval", () => {
  test("derived reactivity + cycles + entry-group materialization", async () => {
    const { core, rootId } = makeCoreRuntime();

    let x: ItemId = "";
    let y: ItemId = "";
    let a: ItemId = "";
    let b: ItemId = "";
    let g: ItemId = "";
    let d: ItemId = "";

    core.commit((t) => {
      x = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(x, "x");
      t.setScalar(x, 10);

      y = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(y, "y");
      t.setSource(y, { type: "derived", expr: "x + 2" });

      a = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(a, "a");
      b = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(b, "b");
      t.setSource(a, { type: "derived", expr: "b" });
      t.setSource(b, { type: "derived", expr: "a" });

      g = t.insertChild(rootId, { kind: "group" });
      t.setLabel(g, "g");
      const ga = t.insertChild(g, { kind: "blank" });
      t.setLabel(ga, "ga");
      t.setScalar(ga, 1);

      d = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(d, "d");
      t.setSource(d, { type: "derived", expr: "g" });
    });

    expect(contentToScalar(core.item(y).content)).toBe(12);
    core.commit((t) => t.setScalar(x, 40));
    await tick();
    expect(contentToScalar(core.item(y).content)).toBe(42);

    expect(core.item(a).content.kind).toBe("issue");
    expect(core.item(b).content.kind).toBe("issue");

    const dd = core.item(d);
    expect(dd.content.kind).toBe("group");
    if (dd.content.kind === "group") {
      const labels = dd.content.children.map(
        (cid) => core.item(cid).label ?? "",
      );
      expect(labels).toContain("ga");
    }
  });

  test("lens: from/where/orderBy with label and position vars", async () => {
    const { core, rootId } = makeCoreRuntime();

    let rows: ItemId = "";
    let lens: ItemId = "";

    const mkRow = (label: string, score: number) => {
      let row: ItemId = "";
      core.commit((t) => {
        row = t.insertChild(rows, { kind: "group" });
        t.setLabel(row, label);
        const sc = t.insertChild(row, { kind: "blank" });
        t.setLabel(sc, "score");
        t.setScalar(sc, score);
      });
      return row;
    };

    core.commit((t) => {
      rows = t.insertChild(rootId, { kind: "group" });
      t.setLabel(rows, "rows");
    });

    mkRow("a", 2);
    mkRow("b", 1);
    mkRow("c", 3);

    core.commit((t) => {
      lens = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(lens, "L");
      t.setSource(lens, {
        type: "lens",
        from: "rows",
        where: "score > 1",
        orderBy: "score",
      });
    });

    await tick();

    const snap = core.item(lens);
    expect(snap.content.kind).toBe("group");
    if (snap.content.kind === "group") {
      const labels = snap.content.children.map(
        (cid) => core.item(cid).label ?? "",
      );
      expect(labels).toEqual(["a", "c"]);
    }

    core.commit((t) => {
      t.setSource(lens, {
        type: "lens",
        from: "rows",
        where: "position = 1 or label = 'c'",
        orderBy: "label",
      });
    });

    await tick();

    const snap2 = core.item(lens);
    expect(snap2.content.kind).toBe("group");
    if (snap2.content.kind === "group") {
      const labels = snap2.content.children.map(
        (cid) => core.item(cid).label ?? "",
      );
      expect(labels).toEqual(["a", "c"]);
    }
  });
});

describe("core", () => {
  test("locate returns correct siblings/index and null for path items", () => {
    const { core, rootId } = makeCoreRuntime();

    let g: ItemId = "";
    let a: ItemId = "";
    let b: ItemId = "";

    core.commit((t) => {
      g = t.insertChild(rootId, { kind: "group" });
      t.setLabel(g, "g");
      a = t.insertChild(g, { kind: "blank" });
      t.setLabel(a, "a");
      b = t.insertChild(g, { kind: "blank" });
      t.setLabel(b, "b");
    });

    const locB = core.locate(b);
    expect(locB).not.toBeNull();
    if (locB) {
      expect(locB.ownerId).toBe(g);
      expect(locB.index).toBe(1);
      expect(locB.siblings).toEqual([a, b]);
    }

    const groupSnap = core.item(g);
    expect(groupSnap.content.kind).toBe("group");
    if (groupSnap.content.kind === "group") {
      const firstChild = groupSnap.content.children[0]!;
      const roId = `${String(firstChild)}0` as ItemId;
      expect(core.locate(roId)).toBe(null);
    }
  });

  test("value-group projection via split produces path children with readonly mode", async () => {
    const { core, rootId } = makeCoreRuntime();

    let d: ItemId = "";

    core.commit((t) => {
      d = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(d, "d");
      t.setSource(d, { type: "derived", expr: "split('a,b', ',')" });
    });

    await tick();

    const snap = core.item(d);
    expect(snap.content.kind).toBe("group");
    if (snap.content.kind === "group") {
      expect(snap.content.children.length).toBe(2);

      const c0 = snap.content.children[0]!;
      const c1 = snap.content.children[1]!;

      const it0 = core.item(c0);
      const it1 = core.item(c1);

      expect(it0.mode.kind).toBe("readonly");
      expect(it1.mode.kind).toBe("readonly");

      expect(contentToScalar(it0.content)).toBe("a");
      expect(contentToScalar(it1.content)).toBe("b");

      expect(core.locate(c0)).toBe(null);
    }
  });

  test("selection repair when focused entry disappears", async () => {
    const { core, rootId } = makeCoreRuntime();

    let g: ItemId = "";
    let x: ItemId = "";

    core.commit((t) => {
      g = t.insertChild(rootId, { kind: "group" });
      t.setLabel(g, "g");
      x = t.insertChild(g, { kind: "blank" });
      t.setLabel(x, "x");
      t.setScalar(x, 1);
    });

    core.focus({ container: g, item: x }, DEFAULT_TARGET);
    core.commit((t) => t.remove(g));
    await tick();

    const sel = core.selection();
    if (sel.kind === "focused") {
      expect(typeof sel.focus.item).toBe("string");
      expect(sel.focus.item.length).toBeGreaterThan(0);
      expect(typeof sel.focus.container).toBe("string");
      expect(sel.focus.container.length).toBeGreaterThan(0);
    } else {
      expect(sel.kind).toBe("idle");
    }
  });
});

describe("views", () => {
  test("outline: initial focus, arrow nav keeps focused, click focuses content input", async () => {
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
    const unmount = await mountView(view);

    await tick();
    expectFocused(core.selection());

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    expectFocused(core.selection());

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    expectFocused(core.selection());

    const el = queryTargetInput(view.root, DEFAULT_TARGET);
    expect(el).not.toBeNull();
    if (el) {
      el.dispatchEvent(
        new Event("pointerdown", { bubbles: true, cancelable: true }),
      );
      await tick();
      expect(document.activeElement === el).toBe(true);
      const sel = core.selection();
      expectFocused(sel);
      expect(sel.target).toBe(DEFAULT_TARGET);
    }

    unmount();
  });

  test("outline: '=' on empty direct content sets derived and focuses expr field", async () => {
    const { core, rootId } = makeCoreRuntime();

    let x: ItemId = "";
    core.commit((t) => {
      x = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(x, "x");
    });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(view);

    await tick();

    const el = queryTargetInput(view.root, DEFAULT_TARGET);
    expect(el).not.toBeNull();
    el!.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    await tick();

    el!.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "=",
        bubbles: true,
        cancelable: true,
      }),
    );
    await tick();

    const it = core.item(x);
    expect(it.mode.kind).toBe("source");

    const sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe("source:expr");

    unmount();
  });

  test("table: arrow navigation label -> right -> cell; left -> label; down -> next row", async () => {
    const { core, rootId } = makeCoreRuntime();

    let tableId: ItemId = "";
    let rowA: ItemId = "";
    let rowB: ItemId = "";

    core.commit((t) => {
      tableId = t.insertChild(rootId, { kind: "group" });
      t.setLabel(tableId, "table");
      t.setView(tableId, "table");

      rowA = t.insertChild(tableId, { kind: "group" });
      t.setLabel(rowA, "rowA");
      const aScore = t.insertChild(rowA, { kind: "blank" });
      t.setLabel(aScore, "score");
      t.setScalar(aScore, 5);

      rowB = t.insertChild(tableId, { kind: "group" });
      t.setLabel(rowB, "rowB");
      const bScore = t.insertChild(rowB, { kind: "blank" });
      t.setLabel(bScore, "score");
      t.setScalar(bScore, 6);
    });

    const view = viewFactories.table({ core, id: tableId });
    const unmount = await mountView(view);

    await tick();
    let sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe("label");

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await tick();
    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe("label");

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);
    expect(sel.focus.container).toBe(rowB);

    unmount();
  });

  test("outline mounts nested table and runtime routes global keydown to it", async () => {
    const { core, rootId } = makeCoreRuntime();

    let tableId: ItemId = "";
    let rowA: ItemId = "";
    let rowB: ItemId = "";

    core.commit((t) => {
      tableId = t.insertChild(rootId, { kind: "group" });
      t.setLabel(tableId, "table");
      t.setView(tableId, "table");

      rowA = t.insertChild(tableId, { kind: "group" });
      t.setLabel(rowA, "rowA");
      const aScore = t.insertChild(rowA, { kind: "blank" });
      t.setLabel(aScore, "score");
      t.setScalar(aScore, 5);

      rowB = t.insertChild(tableId, { kind: "group" });
      t.setLabel(rowB, "rowB");
      const bScore = t.insertChild(rowB, { kind: "blank" });
      t.setLabel(bScore, "score");
      t.setScalar(bScore, 6);
    });

    const outline = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(outline);

    await tick();

    const nestedTableRoot = outline.root.querySelector(
      `.ui-item[data-view="table"][data-part="table"]`,
    );
    expect(nestedTableRoot).not.toBeNull();

    const cellInput = nestedTableRoot
      ? queryTargetInput(nestedTableRoot as HTMLElement, DEFAULT_TARGET)
      : null;
    expect(cellInput).not.toBeNull();

    cellInput!.dispatchEvent(
      new Event("pointerdown", { bubbles: true, cancelable: true }),
    );
    await tick();

    let sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();

    sel = core.selection();
    expectFocused(sel);
    expect(sel.target).toBe(DEFAULT_TARGET);
    expect(sel.focus.container).toBe(rowB);

    unmount();
  });

  test("slider: input event updates scalar; key nudges clamp", async () => {
    const { core, rootId } = makeCoreRuntime();

    let sliderId: ItemId = "";

    core.commit((t) => {
      sliderId = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(sliderId, "slider");
      t.setView(sliderId, "slider");
      t.setScalar(sliderId, 10);
    });

    const view = viewFactories.slider({ core, id: sliderId });
    const unmount = await mountView(view);

    const input = view.root.querySelector(
      `input[type="range"]`,
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (input) {
      input.value = "42";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(contentToScalar(core.item(sliderId).content)).toBe(42);
    }

    core.commit((t) => t.setScalar(sliderId, 100));
    await tick();

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    expect(contentToScalar(core.item(sliderId).content)).toBe(100);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "Home" }));
    await tick();
    expect(contentToScalar(core.item(sliderId).content)).toBe(0);

    unmount();
  });
});

describe("smoke", () => {
  test("dispose safety: unmounting view then committing does not throw", async () => {
    const { core, rootId } = makeCoreRuntime();

    let a: ItemId = "";

    core.commit((t) => {
      a = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(a, "a");
      t.setScalar(a, 1);
    });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(view);

    expect(() => unmount()).not.toThrow();
    expect(() => core.commit((t) => t.setScalar(a, 2))).not.toThrow();
  });

  test("reactivity updates derived display text in outline", async () => {
    const { core, rootId } = makeCoreRuntime();

    let x: ItemId = "";
    let d: ItemId = "";

    core.commit((t) => {
      x = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(x, "x");
      t.setScalar(x, 1);

      d = t.insertChild(rootId, { kind: "blank" });
      t.setLabel(d, "d");
      t.setSource(d, { type: "derived", expr: "x + 1" });
    });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(view);

    const findText = () => {
      const nodes = Array.from(
        view.root.querySelectorAll(`.ui-item[data-mode="readonly"]`),
      );
      return nodes.map((n) => n.textContent ?? "");
    };

    await tick();
    expect(findText().join("\n")).toContain("2");

    core.commit((t) => t.setScalar(x, 5));
    await tick();
    expect(findText().join("\n")).toContain("6");

    unmount();
  });
});
