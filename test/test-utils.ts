import { afterEach, beforeAll, expect } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

import type {
  Content,
  Core,
  DomView,
  Focus,
  ItemId,
  Selection,
  ViewKind,
} from "../src/core";
import { DEFAULT_TARGET, createCore } from "../src/core";
import { parseKeydownIntent } from "../src/dom";
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
  if (content.kind === "group") throw new Error("Expected value content");
  return content.value;
}

export function scalarOfId(
  core: Core,
  id: ItemId,
): true | number | string | null {
  return scalarOf(core.item(id).content);
}

export function childrenOf(core: Core, id: ItemId): readonly ItemId[] {
  const content = core.item(id).content;
  return content.kind === "group" ? content.children : [];
}

export function groupLabels(core: Core, id: ItemId): string[] {
  const item = core.item(id);
  if (item.content.kind !== "group") return [];
  return item.content.children.map((childId) => core.item(childId).label ?? "");
}

type TreeShape =
  | {
      label: string;
      mode: string;
      kind: "value";
      value: true | number | string | null;
    }
  | { label: string; mode: string; kind: "issue"; message: string }
  | { label: string; mode: string; kind: "group"; children: TreeShape[] };

export function tree(core: Core, id: ItemId): TreeShape {
  const item = core.item(id);
  const label = item.label ?? "";
  const mode = item.mode.kind;
  const content = item.content;

  if (content.kind === "value")
    return { label, mode, kind: "value", value: content.value };
  if (content.kind === "issue")
    return { label, mode, kind: "issue", message: content.message };

  return {
    label,
    mode,
    kind: "group",
    children: content.children.map((childId) => tree(core, childId)),
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
  args?: { at?: number; label?: string; view?: ViewKind },
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
    t.setConnected(id, { kind: "formula", expr });
  });
}

export function setQuery(
  core: Core,
  id: ItemId,
  args: { from: string; where?: string; orderBy?: string },
): void {
  core.commit((t) => {
    t.setConnected(id, {
      kind: "query",
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
  const intent = parseKeydownIntent(keyEvent(key, opts));
  if (!intent) return;
  view.onIntent?.(intent);
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
  const targetInput = queryTargetInput(root, target);
  if (!targetInput) throw new Error(`Missing input for target=${target}`);
  return targetInput;
}

export function findFrameEl(root: ParentNode, id: ItemId): HTMLElement | null {
  return root.querySelector(`.ui-frame[data-id="${id}"]`) as HTMLElement | null;
}

export function requireFrameEl(root: ParentNode, id: ItemId): HTMLElement {
  const frameEl = findFrameEl(root, id);
  if (!frameEl) throw new Error(`Missing frame element for id=${String(id)}`);
  return frameEl;
}

export function pointerDown(element: HTMLElement): void {
  element.dispatchEvent(
    new Event("pointerdown", { bubbles: true, cancelable: true }),
  );
}

export function findPresenterSurface(
  fromFrameEl: HTMLElement | null,
): HTMLElement | null {
  if (!fromFrameEl) return null;

  const directHost = fromFrameEl.parentElement;
  if (directHost instanceof HTMLElement && directHost !== fromFrameEl)
    return directHost;

  let cur: HTMLElement | null = fromFrameEl;

  while (cur) {
    const parent: HTMLElement | null = cur.parentElement;
    if (!parent) return cur;

    if (parent.classList.contains("ui-frame")) {
      cur = parent;
      continue;
    }

    return parent;
  }

  return fromFrameEl;
}

export function requirePresenterSurface(
  fromFrameEl: HTMLElement | null,
): HTMLElement {
  const presenterSurface = findPresenterSurface(fromFrameEl);
  if (!presenterSurface) throw new Error("Missing presenter surface");
  return presenterSurface;
}

export function requireEl<T extends Element>(
  element: T | null,
  msg = "Missing element",
): T {
  if (!element) throw new Error(msg);
  return element;
}

export function nodeOrderByDataId(
  root: ParentNode,
  selector: string,
): string[] {
  const els = [...root.querySelectorAll(selector)] as HTMLElement[];
  return els.map((e) => e.dataset.id ?? "");
}

export function requireFocusedFrameEl(root: ParentNode): HTMLElement {
  const focusedFrameEl = root.querySelector(
    `.ui-frame.is-focused`,
  ) as HTMLElement | null;
  if (!focusedFrameEl) throw new Error("Missing focused frame element");
  return focusedFrameEl;
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
  element: Element,
  keySelectors: string[] = [],
): ElSnapshot {
  const keyEls: Element[] = [];
  for (const sel of keySelectors) {
    const hit = (element as ParentNode).querySelector(sel);
    if (!hit) throw new Error(`Missing key element selector=${sel}`);
    keyEls.push(hit);
  }
  return { el: element, keyEls };
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
