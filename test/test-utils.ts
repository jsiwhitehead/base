import { beforeAll, afterEach, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  type Core,
  type ItemId,
  type Focus,
  type Selection,
  type DomView,
  type Content,
  type ViewKind,
  createCore,
  DEFAULT_TARGET,
} from "../src/core";
import { viewFactories } from "../src/views";

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
  const { core, rootId } = createCore({ views: viewFactories });
  cleanups.push(() => core.dispose());
  return { core, rootId };
}

export function scalarOf(content: Content): true | number | string | null {
  if (content.kind === "issue") throw new Error(content.message);
  if (content.kind === "group") throw new Error("Expected scalar content");
  return content.value;
}

export function scalarOfId(
  core: Core,
  id: ItemId,
): true | number | string | null {
  return scalarOf(core.item(id).content);
}

export function childrenOf(core: Core, id: ItemId): readonly ItemId[] {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
}

export function groupLabels(core: Core, id: ItemId): string[] {
  const it = core.item(id);
  if (it.content.kind !== "group") return [];
  return it.content.children.map((cid) => core.item(cid).label ?? "");
}

type TreeShape =
  | {
      label: string;
      mode: string;
      kind: "scalar";
      value: true | number | string | null;
    }
  | { label: string; mode: string; kind: "issue"; message: string }
  | { label: string; mode: string; kind: "group"; children: TreeShape[] };

export function tree(core: Core, id: ItemId): TreeShape {
  const it = core.item(id);
  const label = it.label ?? "";
  const mode = it.mode.kind;
  const c = it.content;

  if (c.kind === "scalar")
    return { label, mode, kind: "scalar", value: c.value };
  if (c.kind === "issue")
    return { label, mode, kind: "issue", message: c.message };

  return {
    label,
    mode,
    kind: "group",
    children: c.children.map((x) => tree(core, x)),
  };
}

export function expectFocused(
  sel: Selection,
): asserts sel is Extract<Selection, { kind: "focused" }> {
  expect(sel.kind).toBe("focused");
  if (sel.kind !== "focused") throw new Error("Expected focused selection");
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

export function focusOf(core: Core): Focus {
  const sel = core.selection();
  expectFocused(sel);
  return sel.focus;
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
    });
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.value !== undefined) t.setScalar(id, args.value);
  });
  return id;
}

export function mkGroup(
  core: Core,
  ownerId: ItemId,
  args?: { at?: number; label?: string; view?: ViewKind },
): ItemId {
  let id: ItemId = "";
  core.commit((t) => {
    id = t.insertChild(ownerId, {
      kind: "group",
      ...(args?.at != null ? { at: args.at } : {}),
    });
    if (args?.label != null) t.setLabel(id, args.label);
    if (args?.view != null) t.setView(id, args.view);
  });
  return id;
}

export function setDerived(core: Core, id: ItemId, expr: string): void {
  core.commit((t) => {
    t.setSource(id, { type: "derived", expr });
  });
}

export function setLens(
  core: Core,
  id: ItemId,
  args: { from: string; where?: string; orderBy?: string },
): void {
  core.commit((t) => {
    t.setSource(id, {
      type: "lens",
      from: args.from,
      where: args.where ?? "",
      orderBy: args.orderBy ?? "",
    });
  });
}

export function setView(core: Core, id: ItemId, view: ViewKind): void {
  core.commit((t) => t.setView(id, view));
}

export function mountDomView(view: DomView): () => void {
  document.body.replaceChildren(view.root);

  const unmount = () => {
    view.dispose();
    document.body.replaceChildren();
  };

  cleanups.push(unmount);
  return unmount;
}

export function keyEvent(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
}

export function fireViewKey(
  view: DomView,
  key: string,
  opts?: Partial<KeyboardEventInit>,
): void {
  view.onKeyDown?.(keyEvent(key, opts));
}

export function fireWindowKey(
  key: string,
  opts?: Partial<KeyboardEventInit>,
): void {
  window.dispatchEvent(keyEvent(key, opts));
}

export async function flushDomEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
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

export function requireTargetInput(
  root: ParentNode,
  target: string,
): HTMLTextAreaElement | HTMLInputElement {
  const el0 = queryTargetInput(root, target);
  if (!el0) throw new Error(`Missing input for target=${target}`);
  return el0;
}

export function findItemEl(root: ParentNode, id: ItemId): HTMLElement | null {
  return root.querySelector(`.ui-item[data-id="${id}"]`) as HTMLElement | null;
}

export function requireItemEl(root: ParentNode, id: ItemId): HTMLElement {
  const el0 = findItemEl(root, id);
  if (!el0) throw new Error(`Missing item element for id=${String(id)}`);
  return el0;
}

export function pointerDown(el0: HTMLElement): void {
  el0.dispatchEvent(
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

export function requirePresenterSurface(
  fromItemEl: HTMLElement | null,
): HTMLElement {
  const s = findPresenterSurface(fromItemEl);
  if (!s) throw new Error("Missing presenter surface");
  return s;
}

export function requireEl<T extends Element>(
  el0: T | null,
  msg = "Missing element",
): T {
  if (!el0) throw new Error(msg);
  return el0;
}

export function nodeOrderByDataId(
  root: ParentNode,
  selector: string,
): string[] {
  const els = [...root.querySelectorAll(selector)] as HTMLElement[];
  return els.map((e) => e.dataset.id ?? "");
}

export function requireFocusedItemEl(root: ParentNode): HTMLElement {
  const el0 = root.querySelector(`.ui-item.is-focused`) as HTMLElement | null;
  if (!el0) throw new Error("Missing focused item element");
  return el0;
}

export function requireNotSameEl(a: Element | null, b: Element | null): void {
  if (!a || !b) throw new Error("Missing element");
  expect(a === b).toBe(false);
}

export function requireSameEl(a: Element | null, b: Element | null): void {
  if (!a || !b) throw new Error("Missing element");
  expect(a === b).toBe(true);
}

export type ElSnapshot = {
  el: Element;
  keyEls: Element[];
};

export function snapshotEl(
  el0: Element,
  keySelectors: string[] = [],
): ElSnapshot {
  const keyEls: Element[] = [];
  for (const sel of keySelectors) {
    const hit = (el0 as ParentNode).querySelector(sel);
    if (!hit) throw new Error(`Missing key element selector=${sel}`);
    keyEls.push(hit);
  }
  return { el: el0, keyEls };
}

export function expectSnapshotSame(
  snap: ElSnapshot,
  el0: Element,
  keySelectors: string[] = [],
): void {
  expect(snap.el === el0).toBe(true);

  if (keySelectors.length !== snap.keyEls.length)
    throw new Error("Key selector count mismatch");

  for (let i = 0; i < keySelectors.length; i++) {
    const sel = keySelectors[i]!;
    const hit = (el0 as ParentNode).querySelector(sel);
    if (!hit) throw new Error(`Missing key element selector=${sel}`);
    expect(snap.keyEls[i] === hit).toBe(true);
  }
}

export function expectSnapshotKeyChanged(
  snap: ElSnapshot,
  el0: Element,
  keySelector: string,
): void {
  expect(snap.el === el0).toBe(true);
  const hit = (el0 as ParentNode).querySelector(keySelector);
  if (!hit) throw new Error(`Missing key element selector=${keySelector}`);
  const anySame = snap.keyEls.some((x) => x === hit);
  expect(anySame).toBe(false);
}

export const targets = {
  DEFAULT: DEFAULT_TARGET,
};

export { viewFactories };
