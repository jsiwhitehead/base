import { describe, expect, test } from "bun:test";

import type { Core, ItemId } from "../src/core";
import { DEFAULT_TARGET } from "../src/core";
import {
  assertCoreInvariants,
  childrenOf,
  makePureCore,
  mkBlank,
  mkGroup,
  valueOfId,
} from "./core-test-utils";

function assertSelectionValid(core: Core): void {
  const selection = core.selection();
  if (selection.type === "idle") return;

  expect(core.item(selection.focus.item).content.type).not.toBe("issue");
  expect(core.item(selection.focus.container).content.type).not.toBe("issue");

  if (selection.focus.item === selection.focus.container) return;
  const loc = core.locate(selection.focus.item);
  expect(loc).not.toBeNull();
  expect(loc!.parentId).toBe(selection.focus.container);
}

function countReachable(core: Core, rootId: ItemId): number {
  const seen = new Set<ItemId>();
  const stack: ItemId[] = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const item = core.item(id);
    if (item.content.type === "group") {
      for (const childId of item.content.children) stack.push(childId);
    }
  }
  return seen.size;
}

describe("core stress/large", () => {
  test("handles 1000+ items with deterministic edits and preserves valid structure", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "bulk" });

    const ids: ItemId[] = [];
    core.commit((t) => {
      for (let i = 0; i < 1200; i += 1) {
        const id = t.insertChild(g);
        t.setLabel(id, `r${i}`);
        t.setValue(id, i);
        ids.push(id);
      }
    });

    expect(childrenOf(core, g).length).toBe(1200);

    for (let i = 0; i < 150; i += 1) {
      const srcIdx = (i * 37) % ids.length;
      const dstIdx = (i * 53) % ids.length;
      const id = ids[srcIdx]!;
      core.commit((t) => t.move(id, g, { at: dstIdx }));
      if (i % 25 === 0) {
        assertCoreInvariants(core, rootId);
        assertSelectionValid(core);
      }
    }

    expect(countReachable(core, rootId)).toBeGreaterThan(1200);
    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core stress/deep nesting", () => {
  test("supports deep nesting edits and undo while remaining valid", () => {
    const { core, rootId } = makePureCore();

    let parent = rootId;
    const chain: ItemId[] = [];
    for (let i = 0; i < 220; i += 1) {
      const next = mkGroup(core, parent, { label: `g${i}` });
      chain.push(next);
      parent = next;
    }

    const leaf = mkBlank(core, parent, { label: "leaf", value: 1 });
    core.focus({ container: parent, item: leaf }, DEFAULT_TARGET);

    for (let i = 0; i < 30; i += 1) {
      core.commit((t) => t.setValue(leaf, i));
    }
    for (let i = 0; i < 15; i += 1) core.undo();
    for (let i = 0; i < 10; i += 1) core.redo();

    expect(typeof valueOfId(core, leaf)).toBe("number");
    assertCoreInvariants(core, rootId);
    assertSelectionValid(core);
    core.dispose();
  });
});

describe("core stress/history", () => {
  test("supports 100+ undo operations with valid state throughout", () => {
    const { core, rootId } = makePureCore();
    const x = mkBlank(core, rootId, { label: "x", value: 0 });

    for (let i = 1; i <= 140; i += 1) {
      core.commit((t) => t.setValue(x, i));
    }
    expect(valueOfId(core, x)).toBe(140);

    for (let i = 0; i < 120; i += 1) {
      core.undo();
      if (i % 20 === 0) {
        assertCoreInvariants(core, rootId);
        assertSelectionValid(core);
      }
    }

    for (let i = 0; i < 100; i += 1) {
      core.redo();
      if (i % 20 === 0) {
        assertCoreInvariants(core, rootId);
        assertSelectionValid(core);
      }
    }

    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core stress/rapid structural edits", () => {
  test("rapid structural edits preserve valid structure and selection", () => {
    const { core, rootId } = makePureCore();
    const g1 = mkGroup(core, rootId, { label: "g1" });
    const g2 = mkGroup(core, rootId, { label: "g2" });
    const pool: ItemId[] = [];

    for (let i = 0; i < 40; i += 1) {
      pool.push(mkBlank(core, g1, { label: `x${i}`, value: i }));
    }
    core.focus({ container: g1, item: pool[0] ?? g1 }, DEFAULT_TARGET);

    for (let i = 0; i < 240; i += 1) {
      const id = pool[i % pool.length]!;
      const targetParent = i % 2 === 0 ? g2 : g1;
      core.commit((t) => {
        t.move(id, targetParent, { at: i % 10 });
        if (i % 5 === 0) t.setValue(id, i);
      });

      if (i % 30 === 0) {
        assertCoreInvariants(core, rootId);
        assertSelectionValid(core);
      }
    }

    assertCoreInvariants(core, rootId);
    assertSelectionValid(core);
    core.dispose();
  });
});

describe("core stress/view switching", () => {
  test("repeated view switching with shapes keeps valid structure", () => {
    const { core, rootId } = makePureCore();
    const table = mkGroup(core, rootId, { label: "table" });
    const row = mkGroup(core, table, { label: "row" });
    mkBlank(core, row, { label: "a", value: 1 });
    mkBlank(core, row, { label: "b", value: 2 });

    const scalar = mkBlank(core, rootId, { label: "scalar", value: 1 });

    for (let i = 0; i < 180; i += 1) {
      core.commit((t) => {
        t.setView(
          table,
          i % 3 === 0 ? "table" : i % 3 === 1 ? "outline" : null,
        );
        t.setView(scalar, i % 2 === 0 ? "slider" : "outline");
      });
      if (i % 30 === 0) assertCoreInvariants(core, rootId);
    }

    expect(core.view(table)).toMatch(/outline|table/);
    expect(core.view(scalar)).toMatch(/outline|slider/);
    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});
