import { expect } from "bun:test";

import type {
  Content,
  Core,
  ItemId,
  Selection,
  Transaction,
  ViewName,
} from "../src/core";
import { createCore, DEFAULT_TARGET } from "../src/core";
import { splitViewRegistrations, viewRegistrations } from "../src/views";

export function expectFocused(
  selection: Selection,
): asserts selection is Extract<Selection, { type: "focused" }> {
  expect(selection.type).toBe("focused");
  if (selection.type !== "focused")
    throw new Error("Expected focused selection");
}

export function makePureCore(): { core: Core; rootId: ItemId } {
  const { constraints } = splitViewRegistrations(viewRegistrations);
  return createCore({ constraints });
}

export function valueOf(content: Content): true | number | string | null {
  if (content.type === "issue") throw new Error(content.message);
  if (content.type === "group") throw new Error("Expected value content");
  return content.value;
}

export function valueOfId(
  core: { item(id: ItemId): { content: Content } },
  id: ItemId,
): true | number | string | null {
  return valueOf(core.item(id).content);
}

export function childrenOf(
  core: { item(id: ItemId): { content: Content } },
  id: ItemId,
): readonly ItemId[] {
  const content = core.item(id).content;
  return content.type === "group" ? content.children : [];
}

export function requireCreatedEntryId(txn: Transaction): number {
  const created = txn.ops.filter(
    (op): op is Extract<Transaction["ops"][number], { type: "create" }> =>
      op.type === "create",
  );
  if (created.length !== 1) {
    throw new Error(`Expected exactly one create op, got ${created.length}`);
  }
  return created[0]!.entry.id;
}

export function expectSel(
  core: { selection(): Selection },
  want: { container: ItemId; item: ItemId; target?: string },
): void {
  const selection = core.selection();
  expectFocused(selection);
  expect(selection.focus.container).toBe(want.container);
  expect(selection.focus.item).toBe(want.item);
  expect(selection.target).toBe(want.target ?? DEFAULT_TARGET);
}

export function mkBlank(
  core: { commit: Core["commit"] },
  parentId: ItemId,
  args?: { at?: number; label?: string; value?: true | number | string | null },
): ItemId {
  let id: ItemId = "";
  core.commit((t) => {
    id = t.insertChild(
      parentId,
      args?.at != null ? { at: args.at } : undefined,
    );
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.value !== undefined) t.setValue(id, args.value);
  });
  return id;
}

export function mkGroup(
  core: { commit: Core["commit"] },
  parentId: ItemId,
  args?: { at?: number; label?: string; view?: ViewName | null },
): ItemId {
  let id: ItemId = "";
  core.commit((t) => {
    id = t.insertChild(
      parentId,
      args?.at != null ? { at: args.at } : undefined,
    );
    t.setGroup(id);
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.view != null) t.setView(id, args.view);
  });
  return id;
}

export function setFormula(
  core: { commit: Core["commit"] },
  id: ItemId,
  expr: string,
): void {
  core.commit((t) => {
    t.setConnected(id, { type: "formula", expr });
  });
}

export function setQuery(
  core: { commit: Core["commit"] },
  id: ItemId,
  args: { from: string; where?: string; orderBy?: string },
): void {
  core.commit((t) => {
    t.setConnected(id, {
      type: "query",
      from: args.from,
      where: args.where ?? "",
      orderBy: args.orderBy ?? "",
    });
  });
}

export function setView(
  core: { commit: Core["commit"] },
  id: ItemId,
  view: ViewName | null,
): void {
  core.commit((t) => t.setView(id, view));
}

export function assertCoreInvariants(core: Core, rootId: ItemId): void {
  const seen = new Set<ItemId>();
  const stack: ItemId[] = [rootId];

  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const item = core.item(id);
    const isQuery =
      item.mode.type === "connected" && item.mode.conn.type === "query";

    if (item.content.type !== "group") continue;
    for (const childId of item.content.children) {
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
