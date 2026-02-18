import { afterEach, beforeAll, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type {
  Content,
  Core,
  ItemId,
  Selection,
  Transaction,
  ViewName,
} from "../src/core";
import { DEFAULT_TARGET, createCore } from "../src/core";
import { viewRegistrations } from "../src/views";

const cleanups: Array<() => void> = [];

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  document.body.replaceChildren();
  for (const fn of cleanups.toReversed()) fn();
  cleanups.length = 0;
});

export function makeCoreRuntime(): { core: Core; rootId: ItemId } {
  const { core, rootId } = createCore({ views: viewRegistrations });
  cleanups.push(() => core.dispose());
  return { core, rootId };
}

export function valueOf(content: Content): true | number | string | null {
  if (content.type === "issue") throw new Error(content.message);
  if (content.type === "group") throw new Error("Expected value content");
  return content.value;
}

export function valueOfId(
  core: Core,
  id: ItemId,
): true | number | string | null {
  return valueOf(core.item(id).content);
}

export function childrenOf(core: Core, id: ItemId): readonly ItemId[] {
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

function expectFocused(
  sel: Selection,
): asserts sel is Extract<Selection, { type: "focused" }> {
  expect(sel.type).toBe("focused");
  if (sel.type !== "focused") throw new Error("Expected focused selection");
}

export function expectSel(
  core: Core,
  want: { container: ItemId; item: ItemId; target?: string },
): void {
  const sel = core.selection();
  expectFocused(sel);
  expect(sel.focus.container).toBe(want.container);
  expect(sel.focus.item).toBe(want.item);
  expect(sel.target).toBe(want.target ?? DEFAULT_TARGET);
}

export function mkBlank(
  core: Core,
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
  core: Core,
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

export function setFormula(core: Core, id: ItemId, expr: string): void {
  core.commit((t) => {
    t.setConnected(id, { type: "formula", expr });
  });
}

export function setQuery(
  core: Core,
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

export function setView(core: Core, id: ItemId, view: ViewName | null): void {
  core.commit((t) => t.setView(id, view));
}

export function dispatchKey(
  target: Element,
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): { defaultPrevented: boolean; bubbled: number } {
  let bubbled = 0;
  const onBubble = () => {
    bubbled += 1;
  };
  window.addEventListener("keydown", onBubble);

  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });

  target.dispatchEvent(ev);
  window.removeEventListener("keydown", onBubble);

  return { defaultPrevented: ev.defaultPrevented, bubbled };
}

export async function flushDomEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

function queryTargetInput(
  root: ParentNode,
  target: string,
): HTMLTextAreaElement | HTMLInputElement | null {
  const sel = `textarea[data-target="${target}"], input[data-target="${target}"]`;
  return root.querySelector(sel) as
    | HTMLTextAreaElement
    | HTMLInputElement
    | null;
}

export function requireTargetInput(
  root: ParentNode,
  target: string,
): HTMLTextAreaElement | HTMLInputElement {
  const targetInput = queryTargetInput(root, target);
  if (!targetInput) throw new Error(`Missing input for target=${target}`);
  return targetInput;
}

export function pointerDown(element: HTMLElement): void {
  element.dispatchEvent(
    new Event("pointerdown", { bubbles: true, cancelable: true }),
  );
}

export function requireEl<T extends Element>(
  element: T | null,
  msg = "Missing element",
): T {
  if (!element) throw new Error(msg);
  return element;
}
