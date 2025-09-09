import { signal } from "@preact/signals-core";

import { elInfo, nodeMeta } from "./code";
import type { DataBlock, DataNode } from "./code";

type ParentIndex = {
  node: DataNode;
  parent: DataNode;
  parentVal: DataBlock;
  idx: number;
};

export function isBlock(v: DataBlock | string): v is DataBlock {
  return typeof v !== "string";
}

function getParentIndex(fromEl: HTMLElement): ParentIndex | null {
  const info = elInfo.get(fromEl);
  if (!info) return null;

  const meta = nodeMeta.get(info.node);
  if (!meta || !meta.parent) return null;

  const parentVal = meta.parent.peek() as DataBlock;
  if (!isBlock(parentVal)) return null;

  const idx = parentVal.items.indexOf(info.node);
  if (idx < 0) return null;

  return { node: info.node, parent: meta.parent, parentVal, idx };
}

export function insertEmptySiblingAfter(el: HTMLElement) {
  const ctx = getParentIndex(el);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(idx + 1, 0, signal("")),
  };

  queueMicrotask(() => {
    const target = container?.children.item(idx + 1) as HTMLElement | null;
    target?.focus();
  });
}

export function removeNodeAtElement(el: HTMLElement) {
  const ctx = getParentIndex(el);
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
  const ctx = getParentIndex(el);
  if (!ctx) return;
  const { node, parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = {
    ...parentVal,
    items: parentVal.items.toSpliced(
      idx,
      1,
      signal<DataBlock>({ values: {}, items: [node] })
    ),
  };

  queueMicrotask(() => {
    const blockEl = container?.children
      .item(idx)!
      .children.item(0) as HTMLElement | null;
    blockEl?.focus();
  });
}
