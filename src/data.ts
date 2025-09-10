import { signal } from "@preact/signals-core";

import { elInfo, nodeMeta, mountCache } from "./code";
import type { DataBlock, DataNode } from "./code";

type ParentIndex = {
  parent: DataNode;
  parentVal: DataBlock;
  idx: number;
};

export function isBlock(v: DataBlock | string): v is DataBlock {
  return typeof v !== "string";
}

function getParentContext(node?: DataNode): ParentIndex | null {
  if (!node) return null;

  const meta = nodeMeta.get(node);
  if (!meta || !meta.parent) return null;

  const parentVal = meta.parent.peek() as DataBlock;
  if (!isBlock(parentVal)) return null;

  const idx = parentVal.items.indexOf(node);
  if (idx < 0) return null;

  return { parent: meta.parent, parentVal, idx };
}

export function focusPreviousSibling(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parentVal, idx } = ctx;
  if (!parentVal.items[idx - 1]) return;
  mountCache.get(parentVal.items[idx - 1]!)!.mount.el.focus();
}
export function focusNextSibling(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parentVal, idx } = ctx;
  if (!parentVal.items[idx + 1]) return;
  mountCache.get(parentVal.items[idx + 1]!)!.mount.el.focus();
}
export function focusParent(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent } = ctx;
  if (!parent) return;
  mountCache.get(parent)!.mount.el.focus();
}
export function focusFirstChild(el: HTMLElement) {
  const { node } = elInfo.get(el)!;
  const nodeVal = node.peek();
  if (!isBlock(nodeVal) || nodeVal.items.length === 0) return;
  mountCache.get(nodeVal.items[0]!)!.mount.el.focus();
}

export function insertEmptyNodeBefore(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const newNode = signal("");
  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx, 0, newNode),
  };
  queueMicrotask(() => {
    mountCache.get(newNode)!.mount.el.focus();
  });
}
export function insertEmptyNodeAfter(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const newNode = signal("");
  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx + 1, 0, newNode),
  };
  queueMicrotask(() => {
    mountCache.get(newNode)!.mount.el.focus();
  });
}
export function removeNodeAtElement(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const focus = parentVal.items[idx + 1] || parentVal.items[idx - 1] || parent;
  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx, 1),
  };
  queueMicrotask(() => {
    mountCache.get(focus)!.mount.el.focus();
  });
}

export function wrapNodeInBlock(el: HTMLElement) {
  const node = elInfo.get(el)!.node;
  const ctx = getParentContext(node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(
      idx,
      1,
      signal({ values: {}, items: [node] })
    ),
  };
  queueMicrotask(() => {
    mountCache.get(node)!.mount.el.focus();
  });
}
export function unwrapNodeFromBlock(el: HTMLElement) {
  const node = elInfo.get(el)!.node;
  const ctx = getParentContext(node);
  const parentCtx = getParentContext(ctx?.parent);
  if (!parentCtx) return;
  const { parent, parentVal, idx } = parentCtx;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx, 1, node),
  };
  queueMicrotask(() => {
    mountCache.get(node)!.mount.el.focus();
  });
}
