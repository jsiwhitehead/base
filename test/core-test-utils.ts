import { expect } from "bun:test";

import type {
  Content,
  Core,
  NodeId,
  Selection,
  SnapshotData,
  Transaction,
  ViewName,
} from "../src/core";
import { createCore } from "../src/core";
import { splitViewRegistrations, viewRegistrations } from "../src/views";

export function expectEditing(
  selection: Selection,
): asserts selection is Extract<Selection, { type: "editing" }> {
  expect(selection.type).toBe("editing");
  if (selection.type !== "editing")
    throw new Error("Expected editing selection");
}

export function makePureCore(): { core: Core; rootId: NodeId } {
  const { shapes } = splitViewRegistrations(viewRegistrations);
  return createCore({ shapes });
}

export function valueOf(content: Content): true | number | string | null {
  if (content.type === "issue") throw new Error(content.message);
  if (content.type === "item") throw new Error("Expected value content");
  return content.value;
}

export function valueOfId(
  core: { node(id: NodeId): { content: Content } },
  id: NodeId,
): true | number | string | null {
  return valueOf(core.node(id).content);
}

export function childrenOf(
  core: { node(id: NodeId): { content: Content } },
  id: NodeId,
): readonly NodeId[] {
  const content = core.node(id).content;
  return content.type === "item" ? content.children : [];
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

export function exportSnapshot(
  core: Pick<Core, "exportSnapshot">,
): SnapshotData {
  return core.exportSnapshot();
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function expectSel(
  core: { selection(): Selection },
  want: { node: NodeId; portals?: readonly NodeId[]; target?: string },
): void {
  const portals = want.portals ?? [];
  const selection = core.selection();
  if (want.target !== undefined) {
    expect(selection.type).toBe("editing");
    if (selection.type !== "editing")
      throw new Error("Expected editing selection");
    expect(selection.location.node).toBe(want.node);
    expect(selection.location.portals).toEqual(portals);
    expect(selection.target).toBe(want.target);
  } else {
    expect(selection.type).toBe("node");
    if (selection.type !== "node") throw new Error("Expected node selection");
    expect(selection.head.node).toBe(want.node);
    expect(selection.head.portals).toEqual(portals);
  }
}

export function expectThrowsWithCode<Code extends string>(
  ErrorClass: new (...args: never[]) => { readonly code: Code },
  expectedCode: Code,
  fn: () => unknown,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ErrorClass);
  expect((thrown as { code: unknown }).code).toBe(expectedCode);
}

export function mkBlank(
  core: { commit: Core["commit"] },
  parentId: NodeId,
  args?: { at?: number; label?: string; value?: true | number | string | null },
): NodeId {
  let id: NodeId = "";
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

export function mkItem(
  core: { commit: Core["commit"] },
  parentId: NodeId,
  args?: { at?: number; label?: string; view?: ViewName | null },
): NodeId {
  let id: NodeId = "";
  core.commit((t) => {
    id = t.insertChild(
      parentId,
      args?.at != null ? { at: args.at } : undefined,
    );
    t.setItem(id);
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.view != null) t.setView(id, args.view);
  });
  return id;
}

export function setFormula(
  core: { commit: Core["commit"] },
  id: NodeId,
  expr: string,
): void {
  core.commit((t) => {
    t.setConnected(id, { type: "formula", expr });
  });
}

export function setQuery(
  core: { commit: Core["commit"] },
  id: NodeId,
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
  id: NodeId,
  view: ViewName | null,
): void {
  core.commit((t) => t.setView(id, view));
}

export function assertCoreInvariants(core: Core, rootId: NodeId): void {
  const seen = new Set<NodeId>();
  const stack: NodeId[] = [rootId];
  const assertAcyclicParentChain = (start: NodeId): void => {
    const parentChain = new Set<NodeId>();
    let cur: NodeId | null = start;
    while (cur != null) {
      expect(parentChain.has(cur)).toBe(false);
      parentChain.add(cur);
      const loc = core.locate(cur);
      cur = loc ? loc.parentId : null;
    }
  };

  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const node = core.node(id);
    const isQuery =
      node.mode.type === "connected" && node.mode.conn.type === "query";

    const loc = core.locate(id);
    if (id === rootId) {
      expect(loc).toBeNull();
    } else if (loc) {
      const parent = core.node(loc.parentId);
      expect(parent.content.type).toBe("item");
      assertAcyclicParentChain(id);
    }

    if (node.content.type !== "item") continue;

    const seenLabels = new Set<string>();
    for (const childId of node.content.children) {
      const childLoc = core.locate(childId);
      if (!childLoc) {
        expect(core.node(childId).mode.type).toBe("readonly");
        stack.push(childId);
        continue;
      }

      if (!isQuery) expect(childLoc.parentId).toBe(id);
      expect(childLoc.index).toBeGreaterThanOrEqual(0);
      expect(childLoc.index).toBeLessThan(childLoc.siblings.length);
      expect(childLoc.siblings[childLoc.index]).toBe(childId);
      expect(childLoc.siblings.filter((x) => x === childId).length).toBe(1);
      if (!isQuery) {
        const label = (core.node(childId).label ?? "").trim();
        if (label) {
          expect(seenLabels.has(label)).toBe(false);
          seenLabels.add(label);
        }
      }

      stack.push(childId);
    }
  }
}
