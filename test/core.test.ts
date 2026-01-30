import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { createCore } from "../src/core";
import {
  createModel,
  type ItemId,
  type SnapshotContent,
  type Model,
} from "../src/core/model";
import {
  V,
  type Value,
  createEvaluator,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
} from "../src/core/compute";
import { interpretExpr } from "../src/core/lang";
import type { Selection } from "../src/core/runtime";
import { createSliderView } from "../src/views/slider";
import { createTableView } from "../src/views/table";
import { createOutlineView } from "../src/views/outline";

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

function makeCoreRuntime() {
  const { core, rootId } = createCore();

  runtimeCleanups.add(() => {
    core.dispose();
  });

  return { core, rootId };
}

function asScalar(v: Value): true | number | string | null {
  if (isBlankValue(v)) return null;
  if (!isScalarValue(v)) throw new Error(`Expected scalar, got ${v.kind}`);
  return v.value;
}

function expectBlank(v: Value) {
  expect(isBlankValue(v)).toBe(true);
}

function expectIssue(v: Value, includes?: string) {
  expect(isIssueValue(v)).toBe(true);
  if (includes && isIssueValue(v)) expect(v.message).toContain(includes);
}

type SnapshotGroupContent = Extract<SnapshotContent, { kind: "group" }>;
type FocusedSelection = Extract<Selection, { kind: "focused" }>;
type ItemGroupValue = Extract<Value, { kind: "item-group" }>;
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

function expectItemGroup(val: Value): ItemGroupValue {
  expect(isItemGroupValue(val)).toBe(true);
  if (!isItemGroupValue(val)) throw new Error("expected item-group value");
  return val;
}

function expectValueGroup(val: Value): ValueGroupValue {
  expect(isValueGroupValue(val)).toBe(true);
  if (!isValueGroupValue(val)) throw new Error("expected value-group value");
  return val;
}

function assertPublicModelContracts(model: Model) {
  const root = model.rootId();
  expect(model.hasItem(root)).toBe(true);

  const seen = new Set<ItemId>();
  const stack: ItemId[] = [root];

  while (stack.length) {
    const gid = stack.pop()!;
    if (seen.has(gid)) continue;
    seen.add(gid);

    const kids = model.childIdsOf(gid);

    for (const cid of kids) {
      expect(model.hasItem(cid)).toBe(true);
      const child = model.readItem(cid);
      expect(child.ownerId).toBe(gid);

      const loc = model.locateInOwner(cid);
      expect(loc).not.toBeNull();
      if (loc) {
        expect(loc.ownerId).toBe(gid);
        expect(loc.childIds[loc.index]).toBe(cid);
      }

      stack.push(cid);
    }

    const labelToId = new Map<string, ItemId>();
    for (const cid of kids) {
      const nm = model.normalizeLabel(model.readItem(cid).label);
      if (!nm) continue;
      const prev = labelToId.get(nm);
      expect(prev).toBeUndefined();
      labelToId.set(nm, cid);
    }
  }
}

async function mountView(
  core: ReturnType<typeof createCore>["core"],
  view: {
    root: HTMLElement;
    onKeyDown?: (e: KeyboardEvent) => void;
    dispose(): void;
  },
) {
  document.body.replaceChildren(view.root);
  const unmountRoot = core.mountViewRoot({
    root: view.root,
    onKeyDown: view.onKeyDown,
  });
  await tick();
  return () => {
    unmountRoot();
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
      model.op.transaction([
        model.op.create(model.createItem.group(rootId)),
        model.op.patchView(rootId, "outline"),
      ]),
    );

    runtimeCleanups.add(() => {
      void 0;
    });

    return { model, rootId };
  }

  function addBlankChild(model: Model, ownerId: ItemId, label = "") {
    const id = model.createId();
    model.apply(
      model.op.transaction([
        model.op.create(model.createItem.blank(id)),
        ...(label ? [model.op.patchLabel(id, label)] : []),
        model.op.reparent({ childId: id, toOwnerId: ownerId }),
      ]),
    );
    return id;
  }

  function addGroupChild(model: Model, ownerId: ItemId, label = "") {
    const id = model.createId();
    model.apply(
      model.op.transaction([
        model.op.create(model.createItem.group(id)),
        ...(label ? [model.op.patchLabel(id, label)] : []),
        model.op.reparent({ childId: id, toOwnerId: ownerId }),
      ]),
    );
    return id;
  }

  function patchScalar(
    model: Model,
    id: ItemId,
    value: true | number | string,
  ) {
    model.apply(
      model.op.transaction([
        model.op.patchContent(id, { kind: "scalar", value }),
      ]),
    );
  }

  function patchDerived(model: Model, id: ItemId, expr: string) {
    model.apply(
      model.op.transaction([
        model.op.patchContent(id, { kind: "derived", expr }),
      ]),
    );
  }

  function patchLens(
    model: Model,
    id: ItemId,
    spec: { from: string; where: string; orderBy: string },
  ) {
    model.apply(
      model.op.transaction([
        model.op.patchContent(id, {
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
    expect(model.readItem(rootId).id).toBe(rootId);
    expect(model.childIdsOf(rootId)).toEqual([]);
    assertPublicModelContracts(model);
  });

  test("reparent adds/removes membership and updates ownerId", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, "a");
    const b = addBlankChild(model, rootId, "b");

    expect(model.readItem(a).ownerId).toBe(rootId);
    expect(model.readItem(b).ownerId).toBe(rootId);
    expect(model.childIdsOf(rootId)).toEqual([a, b]);

    model.apply(model.op.transaction([model.op.detach(b)]));
    expect(model.readItem(b).ownerId).toBe(null);
    expect(model.childIdsOf(rootId)).toEqual([a]);

    assertPublicModelContracts(model);
  });

  test("reparent within same group preserves expected ordering rules", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addBlankChild(model, rootId, "a");
    const b = addBlankChild(model, rootId, "b");
    const c = addBlankChild(model, rootId, "c");

    model.apply(
      model.op.transaction([
        model.op.reparent({ childId: a, toOwnerId: rootId, toIndex: 3 }),
      ]),
    );
    expect(model.childIdsOf(rootId)).toEqual([b, c, a]);

    model.apply(
      model.op.transaction([
        model.op.reparent({ childId: c, toOwnerId: rootId, toIndex: 0 }),
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
      model.apply(model.op.transaction([model.op.patchLabel(a, "b")]));
    }).toThrow();

    const g1 = addGroupChild(model, rootId, "g1");
    const g2 = addGroupChild(model, rootId, "g2");

    addBlankChild(model, g1, "dup");
    const y = addBlankChild(model, g2, " dup ");

    expect(() => {
      model.apply(
        model.op.transaction([
          model.op.reparent({ childId: y, toOwnerId: g1 }),
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

    model.apply(model.op.transaction([model.op.detach(b)]));
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

  test("compactUnreachable removes detached subtrees", () => {
    const { model, rootId } = makeModelRuntime();

    const a = addGroupChild(model, rootId, "A");
    const x = addBlankChild(model, a, "x");
    patchScalar(model, x, 123);

    model.apply(model.op.transaction([model.op.detach(a)]));
    const res = model.compactUnreachable();

    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(res.removedIds).toContain(a);
    expect(model.hasItem(a)).toBe(false);

    assertPublicModelContracts(model);
  });
});

describe("expr contract", () => {
  test("parsing precedence, unary, blanks", () => {
    const env = {
      lookup: (_name: string) => V.issue("nope"),
      resolve: (_id: ItemId) => V.issue("nope"),
      getLabel: (_id: ItemId) => "",
    };

    expect(asScalar(interpretExpr("1 + 2 * 3", env))).toBe(7);
    expect(asScalar(interpretExpr("(1 + 2) * 3", env))).toBe(9);
    expect(asScalar(interpretExpr("--1", env))).toBe(1);
    expectBlank(interpretExpr("blank + 1", env));
  });

  test("path forms: member, select-by-label, implicit dot member", () => {
    const model = createModel();
    const rootId = model.createId();
    model.setRoot(rootId);
    model.apply(
      model.op.transaction([model.op.create(model.createItem.group(rootId))]),
    );
    const evaluator = createEvaluator({ model, interpret: interpretExpr });

    const g = model.createId();
    const a = model.createId();
    const b = model.createId();

    model.apply(
      model.op.transaction([
        model.op.create(model.createItem.group(g)),
        model.op.patchLabel(g, "g"),
        model.op.reparent({ childId: g, toOwnerId: rootId }),

        model.op.create(model.createItem.blank(a)),
        model.op.patchLabel(a, "a"),
        model.op.patchContent(a, { kind: "scalar", value: 10 }),
        model.op.reparent({ childId: a, toOwnerId: g }),

        model.op.create(model.createItem.blank(b)),
        model.op.patchLabel(b, "b"),
        model.op.patchContent(b, { kind: "scalar", value: 20 }),
        model.op.reparent({ childId: b, toOwnerId: g }),
      ]),
    );

    const env = {
      lookup: (name: string) => {
        if (name === "g") return V.itemGroup([a, b]);
        if (name === "_") return V.itemGroup([a, b]);
        return V.issue(`unbound: ${name}`);
      },
      resolve: (id: ItemId) => evaluator.value(id),
      getLabel: (id: ItemId) => model.normalizeLabel(model.readItem(id).label),
    };

    expect(asScalar(interpretExpr("g.a", env))).toBe(10);
    expect(asScalar(interpretExpr("g['b']", env))).toBe(20);
    expect(asScalar(interpretExpr(".a", env))).toBe(10);

    evaluator.dispose();
    assertPublicModelContracts(model);
  });

  test("string escapes", () => {
    const env = {
      lookup: (_name: string) => V.issue("nope"),
      resolve: (_id: ItemId) => V.issue("nope"),
      getLabel: (_id: ItemId) => "",
    };

    expect(asScalar(interpretExpr("'a\\nb'", env))).toBe("a\nb");
    expect(asScalar(interpretExpr('"a\\"b"', env))).toBe('a"b');
    expect(asScalar(interpretExpr("'\\u0041'", env))).toBe("A");
  });

  test("builtins typing rules", () => {
    const env = {
      lookup: (_name: string) => V.blank(),
      resolve: (_id: ItemId) => V.blank(),
      getLabel: (_id: ItemId) => "",
    };

    expectBlank(interpretExpr("abs(blank)", env));
    expect(asScalar(interpretExpr("round(2.34, 1)", env))).toBe(2.3);
    expect(asScalar(interpretExpr("to_number('3')", env))).toBe(3);
    expect(asScalar(interpretExpr("to_text(12)", env))).toBe("12");

    expect(asScalar(interpretExpr("if(1, 10, 20)", env))).toBe(20);
    expect(asScalar(interpretExpr("if(true, 10, 20)", env))).toBe(10);

    expectBlank(interpretExpr("and(true, blank)", env));
    expectBlank(interpretExpr("or(blank, blank)", env));
    expect(asScalar(interpretExpr("or(true, blank)", env))).toBe(true);
  });

  test("parse error returns issue", () => {
    const env = {
      lookup: (_name: string) => V.blank(),
      resolve: (_id: ItemId) => V.blank(),
      getLabel: (_id: ItemId) => "",
    };
    const out = interpretExpr("1 +", env);
    expectIssue(out);
  });
});

describe("core evaluator contract", () => {
  test("derived computes expression in item env + updates when dependency changes", async () => {
    const { core, rootId } = makeCoreRuntime();

    let x: ItemId = -1;
    let y: ItemId = -1;

    core.commit((t) => {
      x = t.insert(rootId, { kind: "blank" });
      t.setLabel(x, "x");
      t.setScalar(x, 10);

      y = t.insert(rootId, { kind: "blank" });
      t.setLabel(y, "y");
      t.setSource(y, { kind: "derived", expr: "x + 2" });
    });

    expect(asScalar(core.value(y))).toBe(12);

    core.edit.setScalar(x, 40);
    await tick();
    expect(asScalar(core.value(y))).toBe(42);
  });

  test("cycle returns issue", () => {
    const { core, rootId } = makeCoreRuntime();

    let a: ItemId = -1;
    let b: ItemId = -1;

    core.commit((t) => {
      a = t.insert(rootId, { kind: "blank" });
      t.setLabel(a, "a");
      b = t.insert(rootId, { kind: "blank" });
      t.setLabel(b, "b");
      t.setSource(a, { kind: "derived", expr: "b" });
      t.setSource(b, { kind: "derived", expr: "a" });
    });

    expectIssue(core.value(a), "Cyclic");
    expectIssue(core.value(b), "Cyclic");
  });

  test("derived materializes item-groups into value-groups (recursive)", () => {
    const { core, rootId } = makeCoreRuntime();

    let g: ItemId = -1;
    let a: ItemId = -1;
    let h: ItemId = -1;
    let b: ItemId = -1;
    let d: ItemId = -1;

    core.commit((t) => {
      g = t.insert(rootId, { kind: "group" });
      t.setLabel(g, "g");

      a = t.insert(g, { kind: "blank" });
      t.setLabel(a, "a");
      t.setScalar(a, 1);

      h = t.insert(g, { kind: "group" });
      t.setLabel(h, "h");

      b = t.insert(h, { kind: "blank" });
      t.setLabel(b, "b");
      t.setScalar(b, 2);

      d = t.insert(rootId, { kind: "blank" });
      t.setLabel(d, "d");
      t.setSource(d, { kind: "derived", expr: "g" });
    });

    const v = expectValueGroup(core.value(d));
    const labels = v.items.map((it) => it.label ?? "");
    expect(labels).toContain("a");
    expect(labels).toContain("h");
  });
});

describe("selection contract", () => {
  test("setSelection repairs when focused item disappears", async () => {
    const { core, rootId } = makeCoreRuntime();

    let g: ItemId = -1;
    let x: ItemId = -1;

    core.commit((t) => {
      g = t.insert(rootId, { kind: "group" });
      t.setLabel(g, "g");
      x = t.insert(g, { kind: "blank" });
      t.setLabel(x, "x");
      t.setScalar(x, 1);
    });

    core.focus({ scopeId: g, id: x }, "content");

    core.commit((t) => {
      t.remove(g);
    });

    await tick();
    core.setSelection(core.selection());

    const sel = core.selection();
    if (sel.kind === "focused") {
      expect(core.has(sel.focus.id)).toBe(true);
      expect(core.has(sel.focus.scopeId)).toBe(true);
    } else {
      expect(sel.kind).toBe("idle");
    }
  });
});

describe("views contract (selection transitions via onKeyDown)", () => {
  test("table arrow navigation: row label -> right -> cell; left -> row label; down -> next row", async () => {
    const { core, rootId } = makeCoreRuntime();

    let tableId: ItemId = -1;
    let rowA: ItemId = -1;
    let aScore: ItemId = -1;
    let rowB: ItemId = -1;
    let bScore: ItemId = -1;

    core.commit((t) => {
      tableId = t.insert(rootId, { kind: "group" });
      t.setLabel(tableId, "table");
      t.setView(tableId, "table");

      rowA = t.insert(tableId, { kind: "group" });
      t.setLabel(rowA, "rowA");
      aScore = t.insert(rowA, { kind: "blank" });
      t.setLabel(aScore, "score");
      t.setScalar(aScore, 5);

      rowB = t.insert(tableId, { kind: "group" });
      t.setLabel(rowB, "rowB");
      bScore = t.insert(rowB, { kind: "blank" });
      t.setLabel(bScore, "score");
      t.setScalar(bScore, 6);
    });

    const view = createTableView({ core, id: tableId });
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
    expect(sel.focus.scopeId).toBe(rowB);

    unmount();
  });

  test("outline picks first nav stop; arrows keep focused selection", async () => {
    const { core, rootId } = makeCoreRuntime();

    core.commit((t) => {
      const a = t.insert(rootId, { kind: "blank" });
      t.setLabel(a, "a");
      t.setScalar(a, 1);

      const g = t.insert(rootId, { kind: "group" });
      t.setLabel(g, "g");
      const ga = t.insert(g, { kind: "blank" });
      t.setLabel(ga, "ga");
      t.setScalar(ga, 2);

      const b = t.insert(rootId, { kind: "blank" });
      t.setLabel(b, "b");
      t.setScalar(b, 3);
    });

    const view = createOutlineView({ core, id: rootId });
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

    let sliderId: ItemId = -1;

    core.commit((t) => {
      sliderId = t.insert(rootId, { kind: "blank" });
      t.setLabel(sliderId, "slider");
      t.setView(sliderId, "slider");
      t.setScalar(sliderId, 10);
    });

    const view = createSliderView({ core, id: sliderId });
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

    expect(asScalar(core.value(sliderId))).toBe(42);

    unmount();
  });

  test("reactivity updates derived display text", async () => {
    const { core, rootId } = makeCoreRuntime();

    let x: ItemId = -1;
    let d: ItemId = -1;

    core.commit((t) => {
      x = t.insert(rootId, { kind: "blank" });
      t.setLabel(x, "x");
      t.setScalar(x, 1);

      d = t.insert(rootId, { kind: "blank" });
      t.setLabel(d, "d");
      t.setSource(d, { kind: "derived", expr: "x + 1" });
    });

    const view = createOutlineView({ core, id: rootId });
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

    core.edit.setScalar(x, 5);
    await tick();
    expect(getDerivedText()).toBe("6");

    unmount();
  });

  test("dispose safety: disposing view does not crash on subsequent model updates", async () => {
    const { core, rootId } = makeCoreRuntime();

    let a: ItemId = -1;

    core.commit((t) => {
      a = t.insert(rootId, { kind: "blank" });
      t.setLabel(a, "a");
      t.setScalar(a, 1);
    });

    const view = createOutlineView({ core, id: rootId });
    const unmount = await mountView(core, view);

    expect(() => unmount()).not.toThrow();
    expect(() => core.edit.setScalar(a, 2)).not.toThrow();
  });
});

test("outline: clicking editable content focuses the text input element", async () => {
  const { core, rootId } = makeCoreRuntime();

  core.commit((t) => {
    const x = t.insert(rootId, { kind: "blank" });
    t.setLabel(x, "x");
    t.setScalar(x, 10);
  });

  const view = createOutlineView({ core, id: rootId });
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
