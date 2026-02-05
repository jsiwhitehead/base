import { beforeAll, afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type Core,
  type ItemId,
  type Focus,
  type Selection,
  type DomView,
  type Content,
  createCore,
  DEFAULT_TARGET,
} from "../src/core";
import { viewFactories } from "../src/views";

const cleanups = new Set<() => void>();

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  document.body.replaceChildren();
  for (const fn of cleanups) fn();
  cleanups.clear();
});

export async function tick(): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, 0));
}

export function makeCoreRuntime(): { core: Core; rootId: ItemId } {
  const { core, rootId } = createCore({ views: viewFactories as any });
  cleanups.add(() => core.dispose());
  return { core, rootId };
}

export function scalarOf(content: Content): true | number | string | null {
  if (content.kind === "issue") throw new Error(content.message);
  if (content.kind === "group") throw new Error("Expected scalar content");
  return content.value;
}

export function childrenOf(core: Core, id: ItemId): readonly ItemId[] {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
}

export function expectFocused(
  sel: Selection,
): asserts sel is Extract<Selection, { kind: "focused" }> {
  expect(sel.kind).toBe("focused");
  if (sel.kind !== "focused") throw new Error("Expected focused selection");
}

export function mkBlank(
  core: Core,
  ownerId: ItemId,
  args?: { at?: number; label?: string; value?: true | number | string | null },
): ItemId {
  let id: ItemId = "";
  core.commit((t) => {
    id = t.insertChild(ownerId, {
      kind: "blank",
      ...(args?.at != null ? { at: args.at } : {}),
    } as any);
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.value !== undefined && args.value !== null)
      t.setScalar(id, args.value);
  });
  return id;
}

export function mkGroup(
  core: Core,
  ownerId: ItemId,
  args?: { at?: number; label?: string; view?: string },
): ItemId {
  let id: ItemId = "";
  core.commit((t) => {
    id = t.insertChild(ownerId, {
      kind: "group",
      ...(args?.at != null ? { at: args.at } : {}),
    } as any);
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.view != null) t.setView(id, args.view as any);
  });
  return id;
}

export function setDerived(core: Core, id: ItemId, expr: string): void {
  core.commit((t) => {
    t.setSource(id, { type: "derived", expr } as any);
  });
}

export function setLens(
  core: Core,
  id: ItemId,
  args: { from: string; where?: string; orderBy?: string },
): void {
  core.commit((t) => {
    t.setSource(id, { type: "lens", ...args } as any);
  });
}

export function setView(core: Core, id: ItemId, view: string): void {
  core.commit((t) => t.setView(id, view as any));
}

export async function mountDomView(view: DomView): Promise<() => void> {
  document.body.replaceChildren(view.root);
  await tick();
  const unmount = () => {
    view.dispose();
    document.body.replaceChildren();
  };
  cleanups.add(unmount);
  return unmount;
}

export function queryTargetInput(
  root: ParentNode,
  target: string,
): HTMLTextAreaElement | HTMLInputElement | null {
  const sel = `textarea[data-target="${target}"], input[data-target="${target}"]`;
  return root.querySelector(sel) as
    | HTMLTextAreaElement
    | HTMLInputElement
    | null;
}

export function findItemEl(root: ParentNode, id: ItemId): HTMLElement | null {
  return root.querySelector(`.ui-item[data-id="${id}"]`) as HTMLElement | null;
}

export function pointerDown(el: HTMLElement): void {
  el.dispatchEvent(
    new Event("pointerdown", { bubbles: true, cancelable: true }),
  );
}

export function findPresenterSurface(
  fromItemEl: HTMLElement | null,
): HTMLElement | null {
  if (!fromItemEl) return null;

  const directHost = fromItemEl.parentElement;
  if (directHost instanceof HTMLElement && directHost !== fromItemEl)
    return directHost;

  let cur: HTMLElement | null = fromItemEl;

  while (cur) {
    const parent: HTMLElement | null = cur.parentElement;
    if (!parent) return cur;

    if (parent.classList.contains("ui-item")) {
      cur = parent;
      continue;
    }

    return parent;
  }

  return fromItemEl;
}

export const targets = {
  DEFAULT: DEFAULT_TARGET,
};

export function focusOf(core: Core): Focus {
  const sel = core.selection();
  expectFocused(sel);
  return sel.focus;
}
