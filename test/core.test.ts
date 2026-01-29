import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { createStore, type ItemId, type SnapshotContent } from "../src/store";
import {
  createEvaluator,
  V,
  type Value,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
} from "../src/eval";
import { interpretExpr } from "../src/expr";
import { createEditor, repairSelection, type Selection } from "../src/editor";
import { installDomRuntime } from "../src/dom";
import { createSliderView } from "../src/views/slider";
import { createTableView } from "../src/views/table";
import { createTreeView } from "../src/views/tree";

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
  const store = createStore();

  const rootId = store.createId();
  store.setRoot(rootId);
  store.apply(
    store.op.transaction([
      store.op.create(store.create.group(rootId)),
      store.op.patchView(rootId, "tree"),
    ]),
  );

  const evaluator = createEvaluator({ store, interpret: interpretExpr });
  const editor = createEditor(store);
  runtimeCleanups.add(installDomRuntime(editor.runtime));

  return { store, evaluator, editor, rootId };
}

function addBlankChild(
  store: ReturnType<typeof createStore>,
  ownerId: ItemId,
  label = "",
) {
  const id = store.createId();
  store.apply(
    store.op.transaction([
      store.op.create(store.create.blank(id)),
      ...(label ? [store.op.patchLabel(id, label)] : []),
      store.op.reparent({ childId: id, toOwnerId: ownerId }),
    ]),
  );
  return id;
}

function addGroupChild(
  store: ReturnType<typeof createStore>,
  ownerId: ItemId,
  label = "",
) {
  const id = store.createId();
  store.apply(
    store.op.transaction([
      store.op.create(store.create.group(id)),
      ...(label ? [store.op.patchLabel(id, label)] : []),
      store.op.reparent({ childId: id, toOwnerId: ownerId }),
    ]),
  );
  return id;
}

function patchScalar(
  store: ReturnType<typeof createStore>,
  id: ItemId,
  value: true | number | string,
) {
  store.apply(
    store.op.transaction([
      store.op.patchContent(id, { kind: "scalar", value }),
    ]),
  );
}

function patchDerived(
  store: ReturnType<typeof createStore>,
  id: ItemId,
  expr: string,
) {
  store.apply(
    store.op.transaction([
      store.op.patchContent(id, { kind: "derived", expr }),
    ]),
  );
}

function patchLens(
  store: ReturnType<typeof createStore>,
  id: ItemId,
  spec: { from: string; where: string; orderBy: string },
) {
  store.apply(
    store.op.transaction([
      store.op.patchContent(id, {
        kind: "lens",
        from: spec.from,
        where: spec.where,
        orderBy: spec.orderBy,
      }),
    ]),
  );
}

function setView(
  store: ReturnType<typeof createStore>,
  id: ItemId,
  view: "tree" | "table" | "slider",
) {
  store.apply(store.op.transaction([store.op.patchView(id, view)]));
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

type SnapshotGroupContent = Extract<
  SnapshotContent,
  { kind: "group"; items: unknown }
>;

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

function assertPublicStoreContracts(store: ReturnType<typeof createStore>) {
  const root = store.getRoot();
  expect(store.hasItem(root)).toBe(true);

  const seen = new Set<ItemId>();
  const stack: ItemId[] = [root];

  while (stack.length) {
    const gid = stack.pop()!;
    if (seen.has(gid)) continue;
    seen.add(gid);

    const kids = store.getChildren(gid);

    for (const cid of kids) {
      expect(store.hasItem(cid)).toBe(true);
      const child = store.readItem(cid);
      expect(child.ownerId).toBe(gid);

      const loc = store.locateInOwner(cid);
      expect(loc).not.toBeNull();
      if (loc) {
        expect(loc.ownerId).toBe(gid);
        expect(loc.items[loc.index]).toBe(cid);
      }

      stack.push(cid);
    }

    const labelToId = new Map<string, ItemId>();
    for (const cid of kids) {
      const nm = store.normalizeLabel(store.readItem(cid).label);
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

describe("store contract", () => {
  test("root exists and is readable", () => {
    const { store, rootId } = makeRuntime();
    expect(store.getRoot()).toBe(rootId);
    expect(store.readItem(rootId).id).toBe(rootId);
    expect(store.getChildren(rootId)).toEqual([]);
    assertPublicStoreContracts(store);
  });

  test("reparent adds/removes membership and updates ownerId", () => {
    const { store, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    const b = addBlankChild(store, rootId, "b");

    expect(store.readItem(a).ownerId).toBe(rootId);
    expect(store.readItem(b).ownerId).toBe(rootId);
    expect(store.getChildren(rootId)).toEqual([a, b]);

    store.apply(store.op.transaction([store.op.detach(b)]));
    expect(store.readItem(b).ownerId).toBe(null);
    expect(store.getChildren(rootId)).toEqual([a]);

    assertPublicStoreContracts(store);
  });

  test("reparent within same group preserves expected ordering rules", () => {
    const { store, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    const b = addBlankChild(store, rootId, "b");
    const c = addBlankChild(store, rootId, "c");

    store.apply(
      store.op.transaction([
        store.op.reparent({ childId: a, toOwnerId: rootId, toIndex: 3 }),
      ]),
    );
    expect(store.getChildren(rootId)).toEqual([b, c, a]);

    store.apply(
      store.op.transaction([
        store.op.reparent({ childId: c, toOwnerId: rootId, toIndex: 0 }),
      ]),
    );
    expect(store.getChildren(rootId)).toEqual([c, b, a]);

    assertPublicStoreContracts(store);
  });

  test("label uniqueness enforced per-group (normalized) on create/patch/reparent", () => {
    const { store, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "Name");
    expect(() => addBlankChild(store, rootId, " Name ")).toThrow();

    addBlankChild(store, rootId, "b");
    expect(() => {
      store.apply(store.op.transaction([store.op.patchLabel(a, "b")]));
    }).toThrow();

    const g1 = addGroupChild(store, rootId, "g1");
    const g2 = addGroupChild(store, rootId, "g2");

    addBlankChild(store, g1, "dup");
    const y = addBlankChild(store, g2, " dup ");

    expect(() => {
      store.apply(
        store.op.transaction([
          store.op.reparent({ childId: y, toOwnerId: g1 }),
        ]),
      );
    }).toThrow();

    assertPublicStoreContracts(store);
  });

  test("locateInOwner returns correct index and null when detached", () => {
    const { store, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    const b = addBlankChild(store, rootId, "b");

    const locB = store.locateInOwner(b)!;
    expect(locB.ownerId).toBe(rootId);
    expect(locB.index).toBe(1);
    expect(locB.items).toEqual([a, b]);

    store.apply(store.op.transaction([store.op.detach(b)]));
    expect(store.locateInOwner(b)).toBe(null);

    assertPublicStoreContracts(store);
  });

  test("snapshot is stable and omits empty label/view", () => {
    const { store, rootId } = makeRuntime();

    const g = addGroupChild(store, rootId, "g");
    const x = addBlankChild(store, g, "x");
    patchScalar(store, x, 1);

    const d = addBlankChild(store, rootId, "d");
    patchDerived(store, d, "g");

    const l = addBlankChild(store, rootId, "lens");
    patchLens(store, l, { from: "g", where: "", orderBy: "" });

    const snap = store.snapshot(rootId);
    const groupContent = expectSnapshotGroup(snap.content);
    expect(groupContent.kind).toBe("group");
    expect(snap.view).toBe("tree");

    const labels = groupContent.items.map((it) => it.label ?? "");
    expect(labels).toContain("g");
    expect(labels).toContain("d");
    expect(labels).toContain("lens");

    const blankLabelId = addBlankChild(store, rootId, "");
    const snap2 = store.snapshot(blankLabelId);
    expect(snap2.label).toBeUndefined();

    assertPublicStoreContracts(store);
  });

  test("compactUnreachable removes detached subtrees", () => {
    const { store, rootId } = makeRuntime();

    const a = addGroupChild(store, rootId, "A");
    const x = addBlankChild(store, a, "x");
    patchScalar(store, x, 123);

    store.apply(store.op.transaction([store.op.detach(a)]));

    const res = store.compactUnreachable();
    expect(res.removed).toBeGreaterThanOrEqual(1);
    expect(res.removedIds).toContain(a);
    expect(store.hasItem(a)).toBe(false);

    assertPublicStoreContracts(store);
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
    const { store, evaluator, rootId } = makeRuntime();
    const g = addGroupChild(store, rootId, "g");
    const a = addBlankChild(store, g, "a");
    const b = addBlankChild(store, g, "b");
    patchScalar(store, a, 10);
    patchScalar(store, b, 20);

    const env = {
      lookup: (name: string) => {
        if (name === "g") return V.itemGroup([a, b]);
        if (name === "_") return V.itemGroup([a, b]);
        return V.issue(`unbound: ${name}`);
      },
      resolve: (id: ItemId) => evaluator.value(id),
      getLabel: (id: ItemId) => store.normalizeLabel(store.readItem(id).label),
    };

    expect(asScalar(interpretExpr("g.a", env))).toBe(10);
    expect(asScalar(interpretExpr("g['b']", env))).toBe(20);
    expect(asScalar(interpretExpr(".a", env))).toBe(10);

    assertPublicStoreContracts(store);
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
    const { store, evaluator, rootId } = makeRuntime();

    const x = addBlankChild(store, rootId, "x");
    patchScalar(store, x, 10);

    const y = addBlankChild(store, rootId, "y");
    patchDerived(store, y, "x + 2");

    expect(asScalar(evaluator.value(y))).toBe(12);

    patchScalar(store, x, 40);
    await tick();
    expect(asScalar(evaluator.value(y))).toBe(42);

    assertPublicStoreContracts(store);
  });

  test("ancestor lookup shadows outer values", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const xOuter = addBlankChild(store, rootId, "x");
    patchScalar(store, xOuter, 100);

    const g = addGroupChild(store, rootId, "g");
    const xInner = addBlankChild(store, g, "x");
    patchScalar(store, xInner, 1);

    const d = addBlankChild(store, g, "d");
    patchDerived(store, d, "x + 1");

    expect(asScalar(evaluator.value(d))).toBe(2);

    assertPublicStoreContracts(store);
  });

  test("cycle returns issue", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    const b = addBlankChild(store, rootId, "b");

    store.apply(
      store.op.transaction([
        store.op.patchContent(a, { kind: "derived", expr: "b" }),
        store.op.patchContent(b, { kind: "derived", expr: "a" }),
      ]),
    );

    expectIssue(evaluator.value(a), "Cyclic");
    expectIssue(evaluator.value(b), "Cyclic");

    assertPublicStoreContracts(store);
  });

  test("derived materializes item-groups into value-groups (recursive)", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const g = addGroupChild(store, rootId, "g");
    const a = addBlankChild(store, g, "a");
    patchScalar(store, a, 1);

    const h = addGroupChild(store, g, "h");
    const b = addBlankChild(store, h, "b");
    patchScalar(store, b, 2);

    const d = addBlankChild(store, rootId, "d");
    patchDerived(store, d, "g");

    const v = expectValueGroup(evaluator.value(d));
    const labels = v.items.map((it) => it.label ?? "");
    expect(labels).toContain("a");
    expect(labels).toContain("h");

    assertPublicStoreContracts(store);
  });

  test("lens contract: blank from => blank; non-item-group => issue", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const l1 = addBlankChild(store, rootId, "l1");
    patchLens(store, l1, { from: " ", where: "", orderBy: "" });
    expectBlank(evaluator.value(l1));

    const x = addBlankChild(store, rootId, "x");
    patchScalar(store, x, 123);

    const l2 = addBlankChild(store, rootId, "l2");
    patchLens(store, l2, { from: "x", where: "", orderBy: "" });
    expectIssue(evaluator.value(l2), "item-group");

    assertPublicStoreContracts(store);
  });

  test("lens where + orderBy works and ties are stable", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const rows = addGroupChild(store, rootId, "rows");

    function addRow(label: string, score: number) {
      const row = addGroupChild(store, rows, label);
      const scoreId = addBlankChild(store, row, "score");
      patchScalar(store, scoreId, score);
      return row;
    }

    const rA = addRow("a", 2);
    const rB = addRow("b", 2);
    addRow("c", 1);

    const lensId = addBlankChild(store, rootId, "lens");
    patchLens(store, lensId, {
      from: "rows",
      where: "_.score >= 2",
      orderBy: "_.score",
    });

    const out = expectItemGroup(evaluator.value(lensId));
    expect(out.items).toEqual([rA, rB]);

    assertPublicStoreContracts(store);
  });

  test("lens row env provides _, position, label", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const rows = addGroupChild(store, rootId, "rows");

    const r1 = addGroupChild(store, rows, "rowA");
    const s1 = addBlankChild(store, r1, "score");
    patchScalar(store, s1, 2);

    const r2 = addGroupChild(store, rows, "rowB");
    const s2 = addBlankChild(store, r2, "score");
    patchScalar(store, s2, 1);

    const lensId = addBlankChild(store, rootId, "lens");
    patchLens(store, lensId, {
      from: "rows",
      where: "position = 2",
      orderBy: "label",
    });

    const out = expectItemGroup(evaluator.value(lensId));
    const labels = out.items.map((id) => store.readItem(id).label);
    expect(labels).toEqual(["rowB"]);

    assertPublicStoreContracts(store);
  });
});

describe("editor contract (no DOM)", () => {
  test("commit applies transaction", () => {
    const { store, editor, rootId } = makeRuntime();
    const a = addBlankChild(store, rootId, "a");

    editor.commit(store.op.transaction([store.op.patchLabel(a, "aa")]));
    expect(store.readItem(a).label).toBe("aa");

    assertPublicStoreContracts(store);
  });

  test("repairSelection falls back when focused item disappears", () => {
    const { store, editor, rootId } = makeRuntime();

    const g = addGroupChild(store, rootId, "g");
    const x = addBlankChild(store, g, "x");

    editor.setSelection({
      kind: "focused",
      focus: { scopeId: g, id: x },
      target: { kind: "content" },
    });

    store.apply(store.op.transaction([store.op.detach(g)]));
    store.compactUnreachable();

    const sel = editor.getSelection();
    const repaired = repairSelection(editor, sel);

    if (repaired.kind === "focused") {
      expect(store.hasItem(repaired.focus.id)).toBe(true);
      expect(store.hasItem(repaired.focus.scopeId)).toBe(true);
    } else {
      expect(repaired.kind).toBe("idle");
    }

    assertPublicStoreContracts(store);
  });
});

describe("views contract (selection transitions via onKeyDown)", () => {
  test("table arrow navigation: row label -> right -> cell; left -> row label; down -> next row", async () => {
    const { store, evaluator, editor, rootId } = makeRuntime();

    const tableId = addGroupChild(store, rootId, "table");
    setView(store, tableId, "table");

    const rowA = addGroupChild(store, tableId, "rowA");
    const aScore = addBlankChild(store, rowA, "score");
    patchScalar(store, aScore, 5);

    const rowB = addGroupChild(store, tableId, "rowB");
    const bScore = addBlankChild(store, rowB, "score");
    patchScalar(store, bScore, 6);

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
    assertPublicStoreContracts(store);
  });

  test("tree onActivate picks first nav stop; arrows keep focused selection", async () => {
    const { store, evaluator, editor, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    patchScalar(store, a, 1);

    const g = addGroupChild(store, rootId, "g");
    const ga = addBlankChild(store, g, "ga");
    patchScalar(store, ga, 2);

    const b = addBlankChild(store, rootId, "b");
    patchScalar(store, b, 3);

    const view = createTreeView({ runtime: { editor, evaluator }, id: rootId });
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
    assertPublicStoreContracts(store);
  });
});

describe("DOM smoke", () => {
  test("slider range input updates scalar content", async () => {
    const { store, evaluator, editor, rootId } = makeRuntime();
    const sliderId = addBlankChild(store, rootId, "slider");

    setView(store, sliderId, "slider");
    patchScalar(store, sliderId, 10);

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

    expect(store.readItem(sliderId).content).toEqual({
      kind: "scalar",
      value: 42,
    });

    view.dispose();
    assertPublicStoreContracts(store);
  });

  test("reactivity updates derived display text", async () => {
    const { store, evaluator, editor, rootId } = makeRuntime();

    const x = addBlankChild(store, rootId, "x");
    patchScalar(store, x, 1);

    const d = addBlankChild(store, rootId, "d");
    patchDerived(store, d, "x + 1");

    const view = createTreeView({ runtime: { editor, evaluator }, id: rootId });
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

    patchScalar(store, x, 5);
    await tick();
    expect(getDerivedText()).toBe("6");

    unmount();
    assertPublicStoreContracts(store);
  });

  test("dispose safety: disposing view does not crash on subsequent store updates", async () => {
    const { store, evaluator, editor, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    patchScalar(store, a, 1);

    const view = createTreeView({ runtime: { editor, evaluator }, id: rootId });
    const unmount = await mountAndActivateView(editor, view);

    expect(() => unmount()).not.toThrow();
    expect(() => patchScalar(store, a, 2)).not.toThrow();

    assertPublicStoreContracts(store);
  });
});

test("tree: clicking editable content focuses the text input element", async () => {
  const { store, evaluator, editor, rootId } = makeRuntime();

  const x = addBlankChild(store, rootId, "x");
  patchScalar(store, x, 10);

  const view = createTreeView({ runtime: { editor, evaluator }, id: rootId });
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
  assertPublicStoreContracts(store);
});
