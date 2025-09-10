import { signal } from "@preact/signals-core";

import { elInfo, nodeMeta, mountCache } from "./code";
import type { DataBlock, DataNode } from "./code";

type NodeContext = {
  node: DataNode;
  parent: DataNode;
  parentVal: DataBlock;
  idx: number;
};

export function isBlock(v: DataBlock | string): v is DataBlock {
  return typeof v !== "string";
}

const focusNode = (node?: DataNode) => {
  if (node) mountCache.get(node)?.mount.el.focus();
};

function getNodeContext(node?: DataNode): NodeContext | null {
  if (!node) return null;

  const meta = nodeMeta.get(node);
  if (!meta || !meta.parent) return null;

  const parentVal = meta.parent.peek() as DataBlock;
  if (!isBlock(parentVal)) return null;

  const idx = parentVal.items.indexOf(node);
  if (idx < 0) return null;

  return { node, parent: meta.parent, parentVal, idx };
}

function withNodeCtx(el: HTMLElement, fn: (ctx: NodeContext) => void) {
  const ctx = getNodeContext(elInfo.get(el)?.node);
  if (ctx) fn(ctx);
}

export function focusPreviousSibling(el: HTMLElement) {
  withNodeCtx(el, ({ parentVal, idx }) => {
    focusNode(parentVal.items[idx - 1]);
  });
}
export function focusNextSibling(el: HTMLElement) {
  withNodeCtx(el, ({ parentVal, idx }) => {
    focusNode(parentVal.items[idx + 1]);
  });
}
export function focusParent(el: HTMLElement) {
  withNodeCtx(el, ({ parent }) => {
    focusNode(parent);
  });
}
export function focusFirstChild(el: HTMLElement) {
  const { node } = elInfo.get(el)!;
  const nodeVal = node.peek();
  if (isBlock(nodeVal)) focusNode(nodeVal.items[0]);
}

export function insertEmptyNodeBefore(el: HTMLElement) {
  withNodeCtx(el, ({ parent, parentVal, idx }) => {
    const newNode = signal("");
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(idx, 0, newNode),
    };
    queueMicrotask(() => focusNode(newNode));
  });
}
export function insertEmptyNodeAfter(el: HTMLElement) {
  withNodeCtx(el, ({ parent, parentVal, idx }) => {
    const newNode = signal("");
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(idx + 1, 0, newNode),
    };
    queueMicrotask(() => focusNode(newNode));
  });
}
export function removeNodeAtElement(el: HTMLElement) {
  withNodeCtx(el, ({ parent, parentVal, idx }) => {
    const focus =
      parentVal.items[idx + 1] || parentVal.items[idx - 1] || parent;
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(idx, 1),
    };
    queueMicrotask(() => focusNode(focus));
  });
}

export function wrapNodeInBlock(el: HTMLElement) {
  withNodeCtx(el, ({ node, parent, parentVal, idx }) => {
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(
        idx,
        1,
        signal({ values: {}, items: [node] })
      ),
    };
    queueMicrotask(() => focusNode(node));
  });
}
export function unwrapNodeFromBlock(el: HTMLElement) {
  withNodeCtx(el, ({ node, parent, parentVal, idx }) => {
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(idx, 1, node),
    };
    queueMicrotask(() => focusNode(node));
  });
}
