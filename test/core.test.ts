import { describe, test, expect, afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import { createStore, type ItemId } from "../src/store";
import {
  createEvaluator,
  V,
  type Value,
  isBlankValue,
  isScalarValue,
  isItemGroupValue,
} from "../src/eval";
import { interpretExpr } from "../src/expr";
import { createEditor } from "../src/editor";
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

afterEach(() => {
  document.body.innerHTML = "";
});

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

function asScalar(v: Value): true | number | string | null {
  if (isBlankValue(v)) return null;
  if (!isScalarValue(v)) throw new Error(`Expected scalar, got ${v.kind}`);
  return v.value;
}

function addTableRow(
  store: ReturnType<typeof createStore>,
  tableId: ItemId,
  label: string,
  cells: Record<string, true | number | string>,
) {
  const rowId = addGroupChild(store, tableId, label);
  for (const [cellLabel, value] of Object.entries(cells)) {
    const cellId = addBlankChild(store, rowId, cellLabel);
    patchScalar(store, cellId, value);
  }
  return rowId;
}

describe("store", () => {
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
  });

  test("label uniqueness enforced per-group (normalized)", () => {
    const { store, rootId } = makeRuntime();

    addBlankChild(store, rootId, "Name");
    expect(() => addBlankChild(store, rootId, " Name ")).toThrow();
  });

  test("patchLabel enforces uniqueness within group", () => {
    const { store, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    addBlankChild(store, rootId, "b");

    expect(() => {
      store.apply(store.op.transaction([store.op.patchLabel(a, "b")]));
    }).toThrow();
  });

  test("locateInOwner returns correct index", () => {
    const { store, rootId } = makeRuntime();

    const a = addBlankChild(store, rootId, "a");
    const b = addBlankChild(store, rootId, "b");

    const locB = store.locateInOwner(b)!;
    expect(locB.ownerId).toBe(rootId);
    expect(locB.index).toBe(1);
    expect(locB.items).toEqual([a, b]);
  });
});

describe("expr interpreter", () => {
  test("basic arithmetic and blanks", () => {
    const env = {
      lookup: (_name: string) => V.issue("nope"),
      resolve: (_id: ItemId) => V.issue("nope"),
      getLabel: (_id: ItemId) => "",
    };

    expect(asScalar(interpretExpr("1 + 2 * 3", env))).toBe(7);
    expect(interpretExpr("blank + 1", env).kind).toBe("blank");
    expect(asScalar(interpretExpr("to_number('3')", env))).toBe(3);
    expect(asScalar(interpretExpr("to_text(12)", env))).toBe("12");
  });

  test("parse error returns issue", () => {
    const env = {
      lookup: (_name: string) => V.blank(),
      resolve: (_id: ItemId) => V.blank(),
      getLabel: (_id: ItemId) => "",
    };
    const out = interpretExpr("1 +", env);
    expect(out.kind).toBe("issue");
  });
});

describe("evaluator", () => {
  test("derived computes expression in item env", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const x = addBlankChild(store, rootId, "x");
    patchScalar(store, x, 10);

    const y = addBlankChild(store, rootId, "y");
    store.apply(
      store.op.transaction([
        store.op.patchContent(y, { kind: "derived", expr: "x + 2" }),
      ]),
    );

    expect(asScalar(evaluator.value(y))).toBe(12);
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

    expect(evaluator.value(a).kind).toBe("issue");
  });

  test("derived materializes item-groups into value-groups", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const g = addGroupChild(store, rootId, "g");
    const a = addBlankChild(store, g, "a");
    patchScalar(store, a, 1);
    const b = addBlankChild(store, g, "b");
    patchScalar(store, b, 2);

    const d = addBlankChild(store, rootId, "d");
    store.apply(
      store.op.transaction([
        store.op.patchContent(d, { kind: "derived", expr: "g" }),
      ]),
    );

    expect(evaluator.value(d).kind).toBe("value-group");
  });

  test("lens where + orderBy works", () => {
    const { store, evaluator, rootId } = makeRuntime();

    const rows = addGroupChild(store, rootId, "rows");

    function addRow(label: string, score: number) {
      const row = addGroupChild(store, rows, label);
      const scoreId = addBlankChild(store, row, "score");
      patchScalar(store, scoreId, score);
      return row;
    }

    addRow("a", 2);
    addRow("b", 1);
    addRow("c", 3);

    const lensId = addBlankChild(store, rootId, "lens");
    store.apply(
      store.op.transaction([
        store.op.patchContent(lensId, {
          kind: "lens",
          from: "rows",
          where: "_.score > 1",
          orderBy: "_.score",
        }),
      ]),
    );

    const out = evaluator.value(lensId);
    expect(isItemGroupValue(out)).toBe(true);
    if (!isItemGroupValue(out)) return;

    const labels = out.items.map((id) => store.readItem(id).label);
    expect(labels).toEqual(["a", "c"]);
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
    store.apply(
      store.op.transaction([
        store.op.patchContent(lensId, {
          kind: "lens",
          from: "rows",
          where: "position = 2",
          orderBy: "label",
        }),
      ]),
    );

    const out = evaluator.value(lensId);
    expect(isItemGroupValue(out)).toBe(true);
    if (!isItemGroupValue(out)) return;

    const labels = out.items.map((id) => store.readItem(id).label);
    expect(labels).toEqual(["rowB"]);
  });
});

describe("editor/store integration (no DOM)", () => {
  test("commit applies transaction", () => {
    const { store, editor, rootId } = makeRuntime();
    const a = addBlankChild(store, rootId, "a");

    editor.commit(store.op.transaction([store.op.patchLabel(a, "aa")]));
    expect(store.readItem(a).label).toBe("aa");
  });
});

describe("slider DOM integration", () => {
  test("range input updates scalar content", () => {
    const { store, evaluator, editor, rootId } = makeRuntime();
    const sliderId = addBlankChild(store, rootId, "slider");

    store.apply(store.op.transaction([store.op.patchView(sliderId, "slider")]));
    patchScalar(store, sliderId, 10);

    const view = createSliderView({
      runtime: { editor, evaluator },
      id: sliderId,
    });

    document.body.append(view.root);

    const input = view.root.querySelector("input");
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
  });
});

describe("table DOM integration", () => {
  test("editing a cell textarea commits scalar text", () => {
    const { store, evaluator, editor, rootId } = makeRuntime();
    const tableId = addGroupChild(store, rootId, "table");
    store.apply(store.op.transaction([store.op.patchView(tableId, "table")]));

    const rowId = addTableRow(store, tableId, "rowA", { score: 5 });
    const scoreId = store.findChildByLabel(rowId, "score");
    if (!scoreId) throw new Error("score cell missing");

    const view = createTableView({
      runtime: { editor, evaluator },
      id: tableId,
    });

    document.body.append(view.root);

    const cellTextarea = view.root.querySelector(
      ".row-cells textarea",
    ) as HTMLTextAreaElement | null;
    expect(cellTextarea).not.toBeNull();
    if (!cellTextarea) {
      view.dispose();
      return;
    }

    cellTextarea.value = "25";
    cellTextarea.dispatchEvent(new Event("input", { bubbles: true }));

    expect(store.readItem(scoreId).content).toEqual({
      kind: "scalar",
      value: 25,
    });

    view.dispose();
  });
});

describe("tree DOM integration", () => {
  test("header label input updates item label", () => {
    const { store, evaluator, editor, rootId } = makeRuntime();
    const nodeId = addBlankChild(store, rootId, "node");

    const view = createTreeView({
      runtime: { editor, evaluator },
      id: rootId,
    });

    document.body.append(view.root);

    const labelInput = view.root.querySelector(
      ".header .label input",
    ) as HTMLInputElement | null;
    expect(labelInput).not.toBeNull();
    if (!labelInput) {
      view.dispose();
      return;
    }

    labelInput.value = "renamed";
    labelInput.dispatchEvent(new Event("input", { bubbles: true }));

    expect(store.readItem(nodeId).label).toBe("renamed");

    view.dispose();
  });
});
