import { signal } from "@preact/signals-core";

import { elInfo, nodeMeta, mountCache } from "./code";
import type { DataBlock, DataNode } from "./code";

type NodeContext = {
  node: DataNode;
  parent: DataNode;
  parentVal: DataBlock;
  all: DataNode[];
  allIdx: number;
  itemIdx: number;
  valueKey: string | null;
};

export function isBlock(v: DataBlock | string): v is DataBlock {
  return typeof v !== "string";
}

const focusNode = (node?: DataNode) => {
  if (node) mountCache.get(node)?.mount.el.focus();
};

function orderedChildren(block: DataBlock): DataNode[] {
  const valueNodes = Object.keys(block.values).map((k) => block.values[k]!);
  return [...valueNodes, ...block.items];
}

function valueKeyForNode(block: DataBlock, node: DataNode): string | null {
  for (const [k, v] of Object.entries(block.values)) {
    if (v === node) return k;
  }
  return null;
}

function getNodeContext(node?: DataNode): NodeContext | null {
  if (!node) return null;

  const meta = nodeMeta.get(node);
  if (!meta || !meta.parent) return null;

  const parentVal = meta.parent.peek() as DataBlock;
  if (!isBlock(parentVal)) return null;

  const all = orderedChildren(parentVal);
  const allIdx = all.indexOf(node);
  if (allIdx < 0) return null;

  const itemIdx = parentVal.items.indexOf(node);
  const valueKey = valueKeyForNode(parentVal, node);

  return {
    node,
    parent: meta.parent,
    parentVal,
    all,
    allIdx,
    itemIdx,
    valueKey,
  };
}

function withNodeCtx(el: HTMLElement, fn: (ctx: NodeContext) => void) {
  const ctx = getNodeContext(elInfo.get(el)?.node);
  if (ctx) fn(ctx);
}

export function focusPreviousSibling(el: HTMLElement) {
  withNodeCtx(el, ({ all, allIdx }) => {
    focusNode(all[allIdx - 1]);
  });
}
export function focusNextSibling(el: HTMLElement) {
  withNodeCtx(el, ({ all, allIdx }) => {
    focusNode(all[allIdx + 1]);
  });
}
export function focusParent(el: HTMLElement) {
  withNodeCtx(el, ({ parent }) => focusNode(parent));
}
export function focusFirstChild(el: HTMLElement) {
  const { node } = elInfo.get(el)!;
  const nodeVal = node.peek();
  if (isBlock(nodeVal)) focusNode(orderedChildren(nodeVal)[0]);
}

export function insertEmptyNodeBefore(el: HTMLElement) {
  withNodeCtx(el, ({ parent, parentVal, itemIdx }) => {
    const newNode = signal("");
    const insertAt = itemIdx >= 0 ? itemIdx : 0;
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(insertAt, 0, newNode),
    };
    queueMicrotask(() => focusNode(newNode));
  });
}
export function insertEmptyNodeAfter(el: HTMLElement) {
  withNodeCtx(el, ({ parent, parentVal, itemIdx }) => {
    const newNode = signal("");
    const insertAt = itemIdx >= 0 ? itemIdx + 1 : 0;
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(insertAt, 0, newNode),
    };
    queueMicrotask(() => focusNode(newNode));
  });
}
export function removeNodeAtElement(el: HTMLElement) {
  withNodeCtx(
    el,
    ({
      parent,
      parentVal,
      itemIdx,
      valueKey,
      all,
      allIdx,
      parent: parentNode,
    }) => {
      const focus = all[allIdx - 1] || all[allIdx + 1] || parentNode;
      if (itemIdx >= 0) {
        parent.value = {
          ...parentVal,
          items: parentVal.items.toSpliced(itemIdx, 1),
        };
      } else if (valueKey) {
        const { [valueKey]: _removed, ...restValues } = parentVal.values;
        parent.value = {
          ...parentVal,
          values: restValues,
        };
      }
      queueMicrotask(() => focusNode(focus));
    }
  );
}

export function wrapNodeInBlock(el: HTMLElement) {
  withNodeCtx(el, ({ node, parent, parentVal, itemIdx, valueKey }) => {
    const wrapper = signal({ values: {}, items: [node] });
    if (itemIdx >= 0) {
      parent.value = {
        ...parentVal,
        items: parentVal.items.toSpliced(itemIdx, 1, wrapper),
      };
    } else if (valueKey) {
      parent.value = {
        ...parentVal,
        values: { ...parentVal.values, [valueKey]: wrapper },
      };
    }
    queueMicrotask(() => focusNode(node));
  });
}
export function unwrapNodeFromBlock(el: HTMLElement) {
  const node = elInfo.get(el)!.node;
  const ctx = getNodeContext(node);
  const parentCtx = getNodeContext(ctx?.parent);
  if (!parentCtx) return;
  const { parent, parentVal, itemIdx, valueKey } = parentCtx;
  if (itemIdx >= 0) {
    parent.value = {
      ...parentVal,
      items: parentVal.items.toSpliced(itemIdx, 1, node),
    };
  } else if (valueKey) {
    parent.value = {
      ...parentVal,
      values: { ...parentVal.values, [valueKey]: node },
    };
  }
  queueMicrotask(() => focusNode(node));
}
