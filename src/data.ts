import { signal } from "@preact/signals-core";

import { elInfo, nodeMeta } from "./code";
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

export function insertEmptyNodeBefore(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx, 0, signal("")),
  };

  queueMicrotask(() => {
    (container?.children.item(idx) as HTMLElement | null)?.focus();
  });
}

export function insertEmptyNodeAfter(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx + 1, 0, signal("")),
  };

  queueMicrotask(() => {
    (container?.children.item(idx + 1) as HTMLElement | null)?.focus();
  });
}

export function removeNodeAtElement(el: HTMLElement) {
  const ctx = getParentContext(elInfo.get(el)?.node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const next =
    el.previousElementSibling || el.nextElementSibling || el.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx, 1),
  };

  queueMicrotask(() => {
    (next as HTMLElement | null)?.focus();
  });
}

export function wrapNodeInBlock(el: HTMLElement) {
  const node = elInfo.get(el)!.node;
  const ctx = getParentContext(node);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(
      idx,
      1,
      signal({ values: {}, items: [node] })
    ),
  };

  queueMicrotask(() => {
    (
      container?.children.item(idx)!.children.item(0) as HTMLElement | null
    )?.focus();
  });
}

export function unwrapNodeFromBlock(el: HTMLElement) {
  const node = elInfo.get(el)!.node;
  const ctx = getParentContext(node);
  const parentCtx = getParentContext(ctx?.parent);
  if (!parentCtx) return;
  const { parent, parentVal, idx } = parentCtx;

  const container = el.parentElement?.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx, 1, node),
  };

  queueMicrotask(() => {
    (container?.children.item(idx) as HTMLElement | null)?.focus();
  });
}
