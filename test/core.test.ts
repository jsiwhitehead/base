import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import {
  createModel,
  createEvaluator,
  createEditor,
  interpretExpr,
  V,
  type ItemId,
  type SnapshotContent,
  type Value,
  type Selection,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
  repairSelection,
} from "../src/core";
import { installDomRuntime } from "../src/ui/dom";
import { createSliderView } from "../src/views/slider";
import { createTableView } from "../src/views/table";
import { createOutlineView } from "../src/views/outline";

GlobalRegistrator.register();

function installRafShim() {
  if (typeof globalThis.requestAnimationFrame !== "function") {
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(Date.now()), 0) as unknown as number;
  }
  if (typeof globalThis.cancelAnimationFrame !== "function") {
    globalThis.cancelAnimationFrame = (id: number) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
  }
}

installRafShim();

const runtimeCleanups = new Set<() => void>();

afterEach(() => {
  document.body.innerHTML = "";
  for (const cleanup of runtimeCleanups) cleanup();
  runtimeCleanups.clear();
});

async function tick() {
  await new Promise<void>((r) => setTimeout(() => r(), 0));
}

function makeRuntime() {
  const model = createModel();

  const rootId = model.createId();
  model.setRoot(rootId);
  model.apply(
    model.op.transaction([
      model.op.create(model.createItem.group(rootId)),
      model.op.patchView(rootId, "outline"),
    ]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });
  const editor = createEditor(model);
  runtimeCleanups.add(installDomRuntime(editor.runtime));

  return { model, evaluator, editor, rootId };
}

function addBlankChild(
  model: ReturnType<typeof createModel>,
  ownerId: ItemId,
  label = "",
) {
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

function addGroupChild(
  model: ReturnType<typeof createModel>,
  ownerId: ItemId,
  label = "",
) {
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
  model: ReturnType<typeof createModel>,
  id: ItemId,
  value: true | number | string,
) {
  model.apply(
    model.op.transaction([
      model.op.patchContent(id, { kind: "scalar", value }),
    ]),
  );
}

function patchDerived(
  model: ReturnType<typeof createModel>,
  id: ItemId,
  expr: string,
) {
  model.apply(
    model.op.transaction([
      model.op.patchContent(id, { kind: "derived", expr }),
    ]),
  );
}

function patchLens(
  model: ReturnType<typeof createModel>,
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

function setView(
  model: ReturnType<typeof createModel>,
  id: ItemId,
  view: "outline" | "table" | "slider",
) {
  model.apply(model.op.transaction([model.op.patchView(id, view)]));
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

function assertPublicModelContracts(model: ReturnType<typeof createModel>) {
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

async function mountAndActivateView(
  editor: ReturnType<typeof createEditor>,
  view: {
    id: string;
    root: HTMLElement;
    onActivate?: () => void;
    dispose(): void;
  },
) {
  document.body.append(view.root);

  await tick();

  editor.runtime.registerView(view as any);
  editor.runtime.setActiveView(view.id);

  view.onActivate?.();

  await tick();

  return () => {
    editor.runtime.unregisterView(view.id);
    view.dispose();
    view.root.remove();
  };
}

describe("model contract", () => {
  test("root exists and is readable", () => {
    const { model, rootId } = makeRuntime();
    expect(model.rootId()).toBe(rootId);
    expect(model.readItem(rootId).id).toBe(rootId);
    expect(model.childIdsOf(rootId)).toEqual([]);
    assertPublicModelContracts(model);
  });

  test("reparent adds/removes membership and updates ownerId", () => {
    const { model, rootId } = makeRuntime();

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
    const { model, rootId } = makeRuntime();

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
    const { model, rootId } = makeRuntime();

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
    const { model, rootId } = makeRuntime();

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
    const { model, rootId } = makeRuntime();

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
    const { model, rootId } = makeRuntime();

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
    const { model, evaluator, rootId } = makeRuntime();
    const g = addGroupChild(model, rootId, "g");
    const a = addBlankChild(model, g, "a");
    const b = addBlankChild(model, g, "b");
    patchScalar(model, a, 10);
    patchScalar(model, b, 20);

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

describe("evaluator contract", () => {
  test("derived computes expression in item env + updates when dependency changes", async () => {
    const { model, evaluator, rootId } = makeRuntime();

    const x = addBlankChild(model, rootId, "x");
    patchScalar(model, x, 10);

    const y = addBlankChild(model, rootId, "y");
    patchDerived(model, y, "x + 2");

    expect(asScalar(evaluator.value(y))).toBe(12);

    patchScalar(model, x, 40);
    await tick();
    expect(asScalar(evaluator.value(y))).toBe(42);

    assertPublicModelContracts(model);
  });

  test("ancestor lookup shadows outer values", () => {
    const { model, evaluator, rootId } = makeRuntime();

    const xOuter = addBlankChild(model, rootId, "x");
    patchScalar(model, xOuter, 100);

    const g = addGroupChild(model, rootId, "g");
    const xInner = addBlankChild(model, g, "x");
    patchScalar(model, xInner, 1);

    const d = addBlankChild(model, g, "d");
    patchDerived(model, d, "x + 1");

    expect(asScalar(evaluator.value(d))).toBe(2);

    assertPublicModelContracts(model);
  });

  test("cycle returns issue", () => {
    const { model, evaluator, rootId } = makeRuntime();

    const a = addBlankChild(model, rootId, "a");
    const b = addBlankChild(model, rootId, "b");

    model.apply(
      model.op.transaction([
        model.op.patchContent(a, { kind: "derived", expr: "b" }),
        model.op.patchContent(b, { kind: "derived", expr: "a" }),
      ]),
    );

    expectIssue(evaluator.value(a), "Cyclic");
    expectIssue(evaluator.value(b), "Cyclic");

    assertPublicModelContracts(model);
  });

  test("derived materializes item-groups into value-groups (recursive)", () => {
    const { model, evaluator, rootId } = makeRuntime();

    const g = addGroupChild(model, rootId, "g");
    const a = addBlankChild(model, g, "a");
    patchScalar(model, a, 1);

    const h = addGroupChild(model, g, "h");
    const b = addBlankChild(model, h, "b");
    patchScalar(model, b, 2);

    const d = addBlankChild(model, rootId, "d");
    patchDerived(model, d, "g");

    const v = expectValueGroup(evaluator.value(d));
    const labels = v.items.map((it) => it.label ?? "");
    expect(labels).toContain("a");
    expect(labels).toContain("h");

    assertPublicModelContracts(model);
  });

  test("lens contract: blank from => blank; non-item-group => issue", () => {
    const { model, evaluator, rootId } = makeRuntime();

    const l1 = addBlankChild(model, rootId, "l1");
    patchLens(model, l1, { from: " ", where: "", orderBy: "" });
    expectBlank(evaluator.value(l1));

    const x = addBlankChild(model, rootId, "x");
    patchScalar(model, x, 123);

    const l2 = addBlankChild(model, rootId, "l2");
    patchLens(model, l2, { from: "x", where: "", orderBy: "" });
    expectIssue(evaluator.value(l2), "item-group");

    assertPublicModelContracts(model);
  });

  test("lens where + orderBy works and ties are stable", () => {
    const { model, evaluator, rootId } = makeRuntime();

    const rows = addGroupChild(model, rootId, "rows");

    function addRow(label: string, score: number) {
      const row = addGroupChild(model, rows, label);
      const scoreId = addBlankChild(model, row, "score");
      patchScalar(model, scoreId, score);
      return row;
    }

    const rA = addRow("a", 2);
    const rB = addRow("b", 2);
    addRow("c", 1);

    const lensId = addBlankChild(model, rootId, "lens");
    patchLens(model, lensId, {
      from: "rows",
      where: "_.score >= 2",
      orderBy: "_.score",
    });

    const out = expectItemGroup(evaluator.value(lensId));
    expect(out.itemIds).toEqual([rA, rB]);

    assertPublicModelContracts(model);
  });

  test("lens row env provides _, position, label", () => {
    const { model, evaluator, rootId } = makeRuntime();

    const rows = addGroupChild(model, rootId, "rows");

    const r1 = addGroupChild(model, rows, "rowA");
    const s1 = addBlankChild(model, r1, "score");
    patchScalar(model, s1, 2);

    const r2 = addGroupChild(model, rows, "rowB");
    const s2 = addBlankChild(model, r2, "score");
    patchScalar(model, s2, 1);

    const lensId = addBlankChild(model, rootId, "lens");
    patchLens(model, lensId, {
      from: "rows",
      where: "position = 2",
      orderBy: "label",
    });

    const out = expectItemGroup(evaluator.value(lensId));
    const labels = out.itemIds.map((id) => model.readItem(id).label);
    expect(labels).toEqual(["rowB"]);

    assertPublicModelContracts(model);
  });
});

describe("editor contract (no DOM)", () => {
  test("commit applies transaction", () => {
    const { model, editor, rootId } = makeRuntime();
    const a = addBlankChild(model, rootId, "a");

    editor.commit(model.op.transaction([model.op.patchLabel(a, "aa")]));
    expect(model.readItem(a).label).toBe("aa");

    assertPublicModelContracts(model);
  });

  test("repairSelection falls back when focused item disappears", () => {
    const { model, editor, rootId } = makeRuntime();

    const g = addGroupChild(model, rootId, "g");
    const x = addBlankChild(model, g, "x");

    editor.setSelection({
      kind: "focused",
      focus: { scopeId: g, id: x },
      target: { kind: "content" },
    });

    model.apply(model.op.transaction([model.op.detach(g)]));
    model.compactUnreachable();

    const sel = editor.getSelection();
    const repaired = repairSelection(editor, sel);

    if (repaired.kind === "focused") {
      expect(model.hasItem(repaired.focus.id)).toBe(true);
      expect(model.hasItem(repaired.focus.scopeId)).toBe(true);
    } else {
      expect(repaired.kind).toBe("idle");
    }

    assertPublicModelContracts(model);
  });
});

describe("views contract (selection transitions via onKeyDown)", () => {
  test("table arrow navigation: row label -> right -> cell; left -> row label; down -> next row", async () => {
    const { model, evaluator, editor, rootId } = makeRuntime();

    const tableId = addGroupChild(model, rootId, "table");
    setView(model, tableId, "table");

    const rowA = addGroupChild(model, tableId, "rowA");
    const aScore = addBlankChild(model, rowA, "score");
    patchScalar(model, aScore, 5);

    const rowB = addGroupChild(model, tableId, "rowB");
    const bScore = addBlankChild(model, rowB, "score");
    patchScalar(model, bScore, 6);

    const view = createTableView({
      runtime: { editor, evaluator },
      id: tableId,
    });
    const unmount = await mountAndActivateView(editor, view);

    let sel = editor.getSelection();
    expectFocusedSelection(sel);
    expect(sel.target.kind).toBe("header");
    if (sel.target.kind === "header") expect(sel.target.index).toBe(0);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    sel = editor.getSelection();
    expectFocusedSelection(sel);
    expect(sel.target.kind).toBe("content");

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowLeft" }));
    await tick();
    sel = editor.getSelection();
    expectFocusedSelection(sel);
    expect(sel.target.kind).toBe("header");
    if (sel.target.kind === "header") expect(sel.target.index).toBe(0);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    sel = editor.getSelection();
    expectFocusedSelection(sel);
    expect(sel.target.kind).toBe("content");
    expect(sel.focus.scopeId).toBe(rowB);

    unmount();
    assertPublicModelContracts(model);
  });

  test("outline onActivate picks first nav stop; arrows keep focused selection", async () => {
    const { model, evaluator, editor, rootId } = makeRuntime();

    const a = addBlankChild(model, rootId, "a");
    patchScalar(model, a, 1);

    const g = addGroupChild(model, rootId, "g");
    const ga = addBlankChild(model, g, "ga");
    patchScalar(model, ga, 2);

    const b = addBlankChild(model, rootId, "b");
    patchScalar(model, b, 3);

    const view = createOutlineView({
      runtime: { editor, evaluator },
      id: rootId,
    });
    const unmount = await mountAndActivateView(editor, view);

    let sel = editor.getSelection();
    expectFocusedSelection(sel);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    await tick();
    sel = editor.getSelection();
    expectFocusedSelection(sel);

    view.onKeyDown?.(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    await tick();
    sel = editor.getSelection();
    expectFocusedSelection(sel);

    unmount();
    assertPublicModelContracts(model);
  });
});

describe("DOM smoke", () => {
  test("slider range input updates scalar content", async () => {
    const { model, evaluator, editor, rootId } = makeRuntime();
    const sliderId = addBlankChild(model, rootId, "slider");

    setView(model, sliderId, "slider");
    patchScalar(model, sliderId, 10);

    const view = createSliderView({
      runtime: { editor, evaluator },
      id: sliderId,
    });

    document.body.append(view.root);
    await tick();

    const input = view.root.querySelector("input") as HTMLInputElement | null;
    expect(input).not.toBeNull();

    if (!input) {
      view.dispose();
      return;
    }

    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(model.readItem(sliderId).content).toEqual({
      kind: "scalar",
      value: 42,
    });

    view.dispose();
    assertPublicModelContracts(model);
  });

  test("reactivity updates derived display text", async () => {
    const { model, evaluator, editor, rootId } = makeRuntime();

    const x = addBlankChild(model, rootId, "x");
    patchScalar(model, x, 1);

    const d = addBlankChild(model, rootId, "d");
    patchDerived(model, d, "x + 1");

    const view = createOutlineView({
      runtime: { editor, evaluator },
      id: rootId,
    });
    const unmount = await mountAndActivateView(editor, view);

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

    patchScalar(model, x, 5);
    await tick();
    expect(getDerivedText()).toBe("6");

    unmount();
    assertPublicModelContracts(model);
  });

  test("dispose safety: disposing view does not crash on subsequent model updates", async () => {
    const { model, evaluator, editor, rootId } = makeRuntime();

    const a = addBlankChild(model, rootId, "a");
    patchScalar(model, a, 1);

    const view = createOutlineView({
      runtime: { editor, evaluator },
      id: rootId,
    });
    const unmount = await mountAndActivateView(editor, view);

    expect(() => unmount()).not.toThrow();
    expect(() => patchScalar(model, a, 2)).not.toThrow();

    assertPublicModelContracts(model);
  });
});

test("outline: clicking editable content focuses the text input element", async () => {
  const { model, evaluator, editor, rootId } = makeRuntime();

  const x = addBlankChild(model, rootId, "x");
  patchScalar(model, x, 10);

  const view = createOutlineView({
    runtime: { editor, evaluator },
    id: rootId,
  });
  const unmount = await mountAndActivateView(editor, view);

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

  const sel = editor.getSelection();
  expectFocusedSelection(sel);
  expect(sel.target.kind).toBe("content");

  unmount();
  assertPublicModelContracts(model);
});
