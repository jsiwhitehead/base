import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type EntryId,
  type ItemRef,
  type Selection,
  createCore,
} from "../src/core";
import {
  createModel,
  type SnapshotContent,
  type Model,
} from "../src/core/model";
import {
  V,
  createEvaluator,
  type Value,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isEntryGroupValue,
  isValueGroupValue,
} from "../src/core/eval";
import { interpretExpr } from "../src/core/lang";
import { viewFactories } from "../src/views";

GlobalRegistrator.register();

const runtimeCleanups = new Set<() => void>();

afterEach(() => {
  document.body.innerHTML = "";
  for (const cleanup of runtimeCleanups) cleanup();
  runtimeCleanups.clear();
});

async function tick() {
  await new Promise<void>((r) => setTimeout(() => r(), 0));
}

function refOf(entryId: EntryId, path: readonly number[] = []): ItemRef {
  return { entryId, path };
}

function sameRef(a: ItemRef, b: ItemRef): boolean {
  return (
    a.entryId === b.entryId &&
    a.path.length === b.path.length &&
    a.path.every((x, i) => x === b.path[i])
  );
}

function makeCoreRuntime() {
  const { core, rootId } = createCore({ views: viewFactories as any });

  runtimeCleanups.add(() => {
    core.dispose();
  });

  return { core, rootId };
}

function contentToScalar(
  content: ReturnType<ReturnType<typeof createCore>["core"]["item"]>["content"],
): true | number | string | null {
  if (content.kind === "issue") throw new Error(`Issue: ${content.message}`);
  if (content.kind === "group") throw new Error(`Expected scalar, got group`);
  return content.value;
}

function expectBlankContent(content: { kind: string } | any) {
  expect(content.kind).toBe("scalar");
  if (content.kind === "scalar") expect(content.value).toBeNull();
}

function expectIssueValue(v: Value, includes?: string) {
  expect(isIssueValue(v)).toBe(true);
  if (includes && isIssueValue(v)) expect(v.message).toContain(includes);
}

type SnapshotGroupContent = Extract<SnapshotContent, { kind: "group" }>;
type FocusedSelection = Extract<Selection, { kind: "focused" }>;
type EntryGroupValue = Extract<Value, { kind: "entry-group" }>;
type ValueGroupValue = Extract<Value, { kind: "value-group" }>;

function expectSnapshotGroup(content: SnapshotContent): SnapshotGroupContent {
  if (
    typeof content !== "object" ||
    content === null ||
    !("kind" in content) ||
    content.kind !== "group"
  ) {
    throw new Error("expected group snapshot content");
  }
  return content;
}

function expectFocusedSelection(
  sel: Selection,
): asserts sel is FocusedSelection {
  expect(sel.kind).toBe("focused");
  if (sel.kind !== "focused") throw new Error("expected focused selection");
}

function expectEntryGroup(val: Value): EntryGroupValue {
  expect(isEntryGroupValue(val)).toBe(true);
  if (!isEntryGroupValue(val)) throw new Error("expected entry-group value");
  return val;
}

function expectValueGroup(val: Value): ValueGroupValue {
  expect(isValueGroupValue(val)).toBe(true);
  if (!isValueGroupValue(val)) throw new Error("expected value-group value");
  return val;
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
      const nm = model.normalizeLabel(model.readEntry(cid).label);
      if (!nm) continue;
      const prev = labelToId.get(nm);
      expect(prev).toBeUndefined();
      labelToId.set(nm, cid);
    }
  }
}

async function mountView(
  _core: ReturnType<typeof createCore>["core"],
  view: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
    dispose(): void;
  },
) {
  document.body.replaceChildren(view.root);
  await tick();
  return () => {
    view.dispose();
    document.body.replaceChildren();
  };
}

describe("model contract", () => {
  function makeModelRuntime() {
    const model = createModel();

    const rootId = model.createId();
    model.setRoot(rootId);
    model.apply(
      model.ops.transaction([
        model.ops.create(model.createEntry.group(rootId)),
        model.ops.patchView(rootId, "outline"),
      ]),
    );

    runtimeCleanups.add(() => {
      void 0;
    });

    return { model, rootId };
  }

  function addBlankChild(model: Model, ownerId: EntryId, label = "") {
    const id = model.createId();
    model.apply(
      model.ops.transaction([
        model.ops.create(model.createEntry.blank(id)),
        ...(label ? [model.ops.patchLabel(id, label)] : []),
        model.ops.reparent({ childId: id, toOwnerId: ownerId }),
      ]),
    );
    return id;
  }

  function addGroupChild(model: Model, ownerId: EntryId, label = "") {
    const id = model.createId();
    model.apply(
      model.ops.transaction([
        model.ops.create(model.createEntry.group(id)),
        ...(label ? [model.ops.patchLabel(id, label)] : []),
        model.ops.reparent({ childId: id, toOwnerId: ownerId }),
      ]),
    );
    return id;
  }

  function patchScalar(
    model: Model,
    id: EntryId,
    value: true | number | string,
  ) {
    model.apply(
      model.ops.transaction([
        model.ops.patchContent(id, { kind: "scalar", value }),
      ]),
    );
  }

  function patchDerived(model: Model, id: EntryId, expr: string) {
    model.apply(
      model.ops.transaction([
        model.ops.patchContent(id, { kind: "derived", expr }),
      ]),
    );
  }

  function patchLens(
    model: Model,
    id: EntryId,
    spec: { from: string; where: string; orderBy: string },
  ) {
    model.apply(
      model.ops.transaction([
        model.ops.patchContent(id, {
          kind: "lens",
          from: spec.from,
          where: spec.where,
          orderBy: spec.orderBy,
        }),
      ]),
    );
  }

  test("root exists and is readable", () => {
    const { model, rootId } = makeModelRuntime();
    expect(model.rootId()).toBe(rootId);
    expect(model.readEntry(rootId).id).toBe(rootId);
    expect(model.childIdsOf(rootId)).toEqual([]);
    assertPublicModelContracts(model);
  });

  test("reparent adds/removes membership and updates ownerId", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, "a");
    const b = addBlankChild(model, rootId, "b");

    expect(model.readEntry(a).ownerId).toBe(rootId);
    expect(model.readEntry(b).ownerId).toBe(rootId);
    expect(model.childIdsOf(rootId)).toEqual([a, b]);

    model.apply(model.ops.transaction([model.ops.detach(b)]));
    expect(model.readEntry(b).ownerId).toBe(null);
    expect(model.childIdsOf(rootId)).toEqual([a]);

    assertPublicModelContracts(model);
  });

  test("reparent within same group preserves expected ordering rules", () => {
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

  test("label uniqueness enforced per-group (normalized) on create/patch/reparent", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, "Name");
    expect(() => addBlankChild(model, rootId, " Name ")).toThrow();

    addBlankChild(model, rootId, "b");
    expect(() => {
      model.apply(model.ops.transaction([model.ops.patchLabel(a, "b")]));
    }).toThrow();

    const g1 = addGroupChild(model, rootId, "g1");
    const g2 = addGroupChild(model, rootId, "g2");

    addBlankChild(model, g1, "dup");
    const y = addBlankChild(model, g2, " dup ");

    expect(() => {
      model.apply(
        model.ops.transaction([
          model.ops.reparent({ childId: y, toOwnerId: g1 }),
        ]),
      );
    }).toThrow();

    assertPublicModelContracts(model);
  });

  test("locateInOwner returns correct index and null when detached", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, "a");
    const b = addBlankChild(model, rootId, "b");

    const locB = model.locateInOwner(b)!;
    expect(locB.ownerId).toBe(rootId);
    expect(locB.index).toBe(1);
    expect(locB.childIds).toEqual([a, b]);

    model.apply(model.ops.transaction([model.ops.detach(b)]));
    expect(model.locateInOwner(b)).toBe(null);

    assertPublicModelContracts(model);
  });

  test("snapshot is stable and omits empty label/view", () => {
    const { model, rootId } = makeModelRuntime();

    const g = addGroupChild(model, rootId, "g");
    const x = addBlankChild(model, g, "x");
    patchScalar(model, x, 1);

    const d = addBlankChild(model, rootId, "d");
    patchDerived(model, d, "g");

    const l = addBlankChild(model, rootId, "lens");
    patchLens(model, l, { from: "g", where: "", orderBy: "" });

    const snap = model.snapshot(rootId);
    const groupContent = expectSnapshotGroup(snap.content);
    expect(groupContent.kind).toBe("group");
    expect(snap.view).toBe("outline");

    const labels = groupContent.childIds.map((it) => it.label ?? "");
    expect(labels).toContain("g");
    expect(labels).toContain("d");
    expect(labels).toContain("lens");

    const blankLabelId = addBlankChild(model, rootId, "");
    const snap2 = model.snapshot(blankLabelId);
    expect(snap2.label).toBeUndefined();

    assertPublicModelContracts(model);
  });

  test("pruneUnreachable removes detached subtrees", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addGroupChild(model, rootId, "A");
    const x = addBlankChild(model, a, "x");
    patchScalar(model, x, 123);

    model.apply(model.ops.transaction([model.ops.detach(a)]));
    const res = model.pruneUnreachable();

    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(res.removedIds).toContain(a);
    expect(model.hasEntry(a)).toBe(false);

    assertPublicModelContracts(model);
  });
});

describe("expr contract", () => {
  function asScalarValue(v: Value): true | number | string | null {
    if (isBlankValue(v)) return null;
    if (!isScalarValue(v)) throw new Error(`Expected scalar, got ${v.kind}`);
    return v.value;
  }

  test("parsing precedence, unary, blanks", () => {
    const env = {
      lookup: (_name: string) => V.issue("nope"),
      resolve: (_id: EntryId) => V.issue("nope"),
      getLabel: (_id: EntryId) => "",
    };

    expect(asScalarValue(interpretExpr("1 + 2 * 3", env))).toBe(7);
    expect(asScalarValue(interpretExpr("(1 + 2) * 3", env))).toBe(9);
    expect(asScalarValue(interpretExpr("--1", env))).toBe(1);
    expect(isBlankValue(interpretExpr("blank + 1", env))).toBe(true);
  });

  test("path forms: member, select-by-label, implicit dot member", () => {
    const model = createModel();
    const rootId = model.createId();
    model.setRoot(rootId);
    model.apply(
      model.ops.transaction([
        model.ops.create(model.createEntry.group(rootId)),
      ]),
    );
    const evaluator = createEvaluator({ model, interpret: interpretExpr });

    const g = model.createId();
    const a = model.createId();
    const b = model.createId();

    model.apply(
      model.ops.transaction([
        model.ops.create(model.createEntry.group(g)),
        model.ops.patchLabel(g, "g"),
        model.ops.reparent({ childId: g, toOwnerId: rootId }),

        model.ops.create(model.createEntry.blank(a)),
        model.ops.patchLabel(a, "a"),
        model.ops.patchContent(a, { kind: "scalar", value: 10 }),
        model.ops.reparent({ childId: a, toOwnerId: g }),

        model.ops.create(model.createEntry.blank(b)),
        model.ops.patchLabel(b, "b"),
        model.ops.patchContent(b, { kind: "scalar", value: 20 }),
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
      getLabel: (id: EntryId) =>
        model.normalizeLabel(model.readEntry(id).label),
    };

    expect(asScalarValue(interpretExpr("g.a", env))).toBe(10);
    expect(asScalarValue(interpretExpr("g['b']", env))).toBe(20);
    expect(asScalarValue(interpretExpr(".a", env))).toBe(10);

    evaluator.dispose();
    assertPublicModelContracts(model);
  });

  test("string escapes", () => {
    const env = {
      lookup: (_name: string) => V.issue("nope"),
      resolve: (_id: EntryId) => V.issue("nope"),
      getLabel: (_id: EntryId) => "",
    };

    expect(asScalarValue(interpretExpr("'a\\nb'", env))).toBe("a\nb");
    expect(asScalarValue(interpretExpr('"a\\"b"', env))).toBe('a"b');
    expect(asScalarValue(interpretExpr("'\\u0041'", env))).toBe("A");
  });

  test("builtins typing rules", () => {
    const env = {
      lookup: (_name: string) => V.blank(),
      resolve: (_id: EntryId) => V.blank(),
      getLabel: (_id: EntryId) => "",
    };

    expect(isBlankValue(interpretExpr("abs(blank)", env))).toBe(true);
    expect(asScalarValue(interpretExpr("round(2.34, 1)", env))).toBe(2.3);
    expect(asScalarValue(interpretExpr("to_number('3')", env))).toBe(3);
    expect(asScalarValue(interpretExpr("to_text(12)", env))).toBe("12");

    expect(asScalarValue(interpretExpr("if(1, 10, 20)", env))).toBe(20);
    expect(asScalarValue(interpretExpr("if(true, 10, 20)", env))).toBe(10);

    expect(isBlankValue(interpretExpr("and(true, blank)", env))).toBe(true);
    expect(isBlankValue(interpretExpr("or(blank, blank)", env))).toBe(true);
    expect(asScalarValue(interpretExpr("or(true, blank)", env))).toBe(true);
  });

  test("parse error returns issue", () => {
    const env = {
      lookup: (_name: string) => V.blank(),
      resolve: (_id: EntryId) => V.blank(),
      getLabel: (_id: EntryId) => "",
    };
    const out = interpretExpr("1 +", env);
    expect(isIssueValue(out)).toBe(true);
  });
});

describe("core evaluator contract", () => {
  test("derived computes expression in entry env + updates when dependency changes", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let x: EntryId = -1;
    let y: EntryId = -1;

    core.commit((t) => {
      x = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(x), "x");
      t.setScalar(refOf(x), 10);

      y = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(y), "y");
      t.setSource(refOf(y), { type: "derived", expr: "x + 2" });
    });

    expect(contentToScalar(core.item(refOf(y)).content)).toBe(12);

    core.commit((t) => t.setScalar(refOf(x), 40));
    await tick();
    expect(contentToScalar(core.item(refOf(y)).content)).toBe(42);
  });

  test("cycle returns issue", () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let a: EntryId = -1;
    let b: EntryId = -1;

    core.commit((t) => {
      a = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(a), "a");
      b = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(b), "b");
      t.setSource(refOf(a), { type: "derived", expr: "b" });
      t.setSource(refOf(b), { type: "derived", expr: "a" });
    });

    const ca = core.item(refOf(a)).content;
    const cb = core.item(refOf(b)).content;
    expect(ca.kind).toBe("issue");
    expect(cb.kind).toBe("issue");
    if (ca.kind === "issue") expect(ca.message).toContain("Cyclic");
    if (cb.kind === "issue") expect(cb.message).toContain("Cyclic");
  });

  test("derived materializes entry-groups into value-groups (recursive) and becomes a group of items", () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let g: EntryId = -1;
    let a: EntryId = -1;
    let h: EntryId = -1;
    let b: EntryId = -1;
    let d: EntryId = -1;

    core.commit((t) => {
      g = t.insertChild(root, { kind: "group" });
      t.setLabel(refOf(g), "g");

      a = t.insertChild(refOf(g), { kind: "blank" });
      t.setLabel(refOf(a), "a");
      t.setScalar(refOf(a), 1);

      h = t.insertChild(refOf(g), { kind: "group" });
      t.setLabel(refOf(h), "h");

      b = t.insertChild(refOf(h), { kind: "blank" });
      t.setLabel(refOf(b), "b");
      t.setScalar(refOf(b), 2);

      d = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(d), "d");
      t.setSource(refOf(d), { type: "derived", expr: "g" });
    });

    const snap = core.item(refOf(d));
    expect(snap.content.kind).toBe("group");
    if (snap.content.kind !== "group") return;

    const childLabels = snap.content.children.map(
      (r) => core.item(r).label ?? "",
    );
    expect(childLabels).toContain("a");
    expect(childLabels).toContain("h");
  });
});

describe("selection contract", () => {
  test("setSelection repairs when focused entry disappears", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let g: EntryId = -1;
    let x: EntryId = -1;

    core.commit((t) => {
      g = t.insertChild(root, { kind: "group" });
      t.setLabel(refOf(g), "g");
      x = t.insertChild(refOf(g), { kind: "blank" });
      t.setLabel(refOf(x), "x");
      t.setScalar(refOf(x), 1);
    });

    core.focus({ scope: refOf(g), ref: refOf(x) }, "content");

    core.commit((t) => {
      t.remove(g);
    });

    await tick();

    const sel = core.selection();
    if (sel.kind === "focused") {
      expect(sel.focus.ref.entryId).toBeGreaterThan(0);
      expect(sel.focus.scope.entryId).toBeGreaterThan(0);
    } else {
      expect(sel.kind).toBe("idle");
    }
  });
});

describe("views contract (selection transitions via onKeyDown)", () => {
  test("table arrow navigation: row label -> right -> cell; left -> row label; down -> next row", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let tableId: EntryId = -1;
    let rowA: EntryId = -1;
    let aScore: EntryId = -1;
    let rowB: EntryId = -1;
    let bScore: EntryId = -1;

    core.commit((t) => {
      tableId = t.insertChild(root, { kind: "group" });
      t.setLabel(refOf(tableId), "table");
      t.setView(tableId, "table");

      rowA = t.insertChild(refOf(tableId), { kind: "group" });
      t.setLabel(refOf(rowA), "rowA");
      aScore = t.insertChild(refOf(rowA), { kind: "blank" });
      t.setLabel(refOf(aScore), "score");
      t.setScalar(refOf(aScore), 5);

      rowB = t.insertChild(refOf(tableId), { kind: "group" });
      t.setLabel(refOf(rowB), "rowB");
      bScore = t.insertChild(refOf(rowB), { kind: "blank" });
      t.setLabel(refOf(bScore), "score");
      t.setScalar(refOf(bScore), 6);
    });

    const view = viewFactories.table({ core, id: tableId });
    const unmount = await mountView(core, view);

    await tick();
    let sel = core.selection();
    expectFocusedSelection(sel);
    expect(sel.target).toBe("label");

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    sel = core.selection();
    expectFocusedSelection(sel);
    expect(sel.target).toBe("content");

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await tick();
    sel = core.selection();
    expectFocusedSelection(sel);
    expect(sel.target).toBe("label");

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    sel = core.selection();
    expectFocusedSelection(sel);
    expect(sel.target).toBe("content");
    expect(sel.focus.scope.entryId).toBe(rowB);

    unmount();
  });

  test("outline picks first nav stop; arrows keep focused selection", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    core.commit((t) => {
      const a = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(a), "a");
      t.setScalar(refOf(a), 1);

      const g = t.insertChild(root, { kind: "group" });
      t.setLabel(refOf(g), "g");
      const ga = t.insertChild(refOf(g), { kind: "blank" });
      t.setLabel(refOf(ga), "ga");
      t.setScalar(refOf(ga), 2);

      const b = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(b), "b");
      t.setScalar(refOf(b), 3);
    });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(core, view);

    await tick();
    let sel = core.selection();
    expectFocusedSelection(sel);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    sel = core.selection();
    expectFocusedSelection(sel);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    sel = core.selection();
    expectFocusedSelection(sel);

    unmount();
  });
});

describe("DOM smoke", () => {
  test("slider range input updates scalar content", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let sliderId: EntryId = -1;

    core.commit((t) => {
      sliderId = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(sliderId), "slider");
      t.setView(sliderId, "slider");
      t.setScalar(refOf(sliderId), 10);
    });

    const view = viewFactories.slider({ core, id: sliderId });
    const unmount = await mountView(core, view);
    await tick();

    const input = view.root.querySelector("input") as HTMLInputElement | null;
    expect(input).not.toBeNull();

    if (!input) {
      unmount();
      return;
    }

    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(contentToScalar(core.item(refOf(sliderId)).content)).toBe(42);

    unmount();
  });

  test("reactivity updates derived display text", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let x: EntryId = -1;
    let d: EntryId = -1;

    core.commit((t) => {
      x = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(x), "x");
      t.setScalar(refOf(x), 1);

      d = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(d), "d");
      t.setSource(refOf(d), { type: "derived", expr: "x + 1" });
    });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(core, view);

    const getDerivedText = () => {
      const nodes = Array.from(view.root.querySelectorAll(".item.readonly"));
      return (
        nodes
          .map((n) => n.textContent ?? "")
          .find((t) => t === "2" || t === "6") ?? ""
      );
    };

    await tick();
    expect(getDerivedText()).toBe("2");

    core.commit((t) => t.setScalar(refOf(x), 5));
    await tick();
    expect(getDerivedText()).toBe("6");

    unmount();
  });

  test("dispose safety: disposing view does not crash on subsequent model updates", async () => {
    const { core, rootId } = makeCoreRuntime();
    const root = refOf(rootId);

    let a: EntryId = -1;

    core.commit((t) => {
      a = t.insertChild(root, { kind: "blank" });
      t.setLabel(refOf(a), "a");
      t.setScalar(refOf(a), 1);
    });

    const view = viewFactories.outline({ core, id: rootId });
    const unmount = await mountView(core, view);

    expect(() => unmount()).not.toThrow();
    expect(() => core.commit((t) => t.setScalar(refOf(a), 2))).not.toThrow();
  });
});

test("outline: clicking editable content focuses the text input element", async () => {
  const { core, rootId } = makeCoreRuntime();
  const root = refOf(rootId);

  core.commit((t) => {
    const x = t.insertChild(root, { kind: "blank" });
    t.setLabel(refOf(x), "x");
    t.setScalar(refOf(x), 10);
  });

  const view = viewFactories.outline({ core, id: rootId });
  const unmount = await mountView(core, view);

  const labelInputs = Array.from(
    view.root.querySelectorAll(".autosize.label input"),
  ) as HTMLInputElement[];

  const xLabelInput = labelInputs.find((n) => (n.value ?? "") === "x") ?? null;
  expect(xLabelInput).not.toBeNull();
  if (!xLabelInput) {
    unmount();
    return;
  }

  const itemRoot = xLabelInput.closest(".item") as HTMLElement | null;
  expect(itemRoot).not.toBeNull();
  if (!itemRoot) {
    unmount();
    return;
  }

  const contentTextarea = itemRoot.querySelector(
    "textarea.content",
  ) as HTMLTextAreaElement | null;

  expect(contentTextarea).not.toBeNull();
  if (!contentTextarea) {
    unmount();
    return;
  }

  contentTextarea.dispatchEvent(
    new Event("pointerdown", { bubbles: true, cancelable: true }),
  );

  await tick();
  await tick();

  expect(document.activeElement === contentTextarea).toBe(true);

  const sel = core.selection();
  expectFocusedSelection(sel);
  expect(sel.target).toBe("content");

  unmount();
});
