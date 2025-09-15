import { type Signal, signal } from "@preact/signals-core";

import { evalCode } from "./code";

/* Static Types */

export type Primitive = string | number | boolean;

export type ResolvedBlock = {
  kind: "block";
  values: [string, ResolvedDeep][];
  items: ResolvedDeep[];
};

export type ResolvedDeep = ResolvedBlock | Primitive;

/* Node Types */

export type LiteralNode = {
  kind: "literal";
  value: Primitive;
};

export type BlockNode = {
  kind: "block";
  values: [string, Box][];
  items: Box[];
};

export type Resolved = BlockNode | LiteralNode;

export type CodeNode = {
  kind: "code";
  code: string;
};

export type Node = CodeNode | Resolved;

/* Box Types */

export type Box<T extends Node = Node> = {
  kind: "box";
  value: Signal<T>;
  parent?: BlockBox;
};

export type BlockBox = Box<BlockNode>;

/* Type Guards */

export function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export function isLiteral(v: unknown): v is LiteralNode {
  return hasKind(v, "literal");
}

export function isBlock(v: unknown): v is BlockNode {
  return hasKind(v, "block");
}

export function isCode(v: unknown): v is CodeNode {
  return hasKind(v, "code");
}

export function isBox(v: unknown): v is Box {
  return hasKind(v, "box");
}

/* Scope */

export function lookupInScope(start: BlockBox | undefined, name: string): Box {
  for (let cur = start; cur; cur = cur.parent) {
    const kv = cur.value.value.values.find(([k]) => k === name);
    if (kv) return kv[1];
  }
  throw new Error(`Unbound identifier: ${name}`);
}

/* Constructors */

export function makeLiteral(value: Primitive): LiteralNode {
  return { kind: "literal", value };
}

export function makeBlock(
  values: [string, Box][] = [],
  items: Box[] = []
): BlockNode {
  return { kind: "block", values, items };
}

export function makeCode(code: string): CodeNode {
  return { kind: "code", code };
}

export function makeBox<T extends Node>(initial: T, parent?: BlockBox): Box<T> {
  return { kind: "box", value: signal<T>(initial), parent };
}

/* Resolve */

export function resolveShallow(b: Box): Resolved {
  const v = b.value.value;
  if (isCode(v)) {
    const getter = (name: string): Box => lookupInScope(b.parent, name);
    return evalCode(v.code, getter);
  }
  return v;
}

export function resolveDeep(b: Box): ResolvedDeep {
  const v = b.value.value;
  try {
    const n = resolveShallow(b);
    if (n.kind === "literal") return n.value;
    return {
      kind: "block",
      values: n.values.map(([k, vb]) => [k, resolveDeep(vb)]),
      items: n.items.map(resolveDeep),
    };
  } catch (_err) {
    return `Error in code: '${(v as CodeNode).code}'`;
  }
}

/* Helpers */

type ChildLoc =
  | { kind: "item"; index: number }
  | { kind: "value"; index: number };

function withParentBlock(child: Box, f: (block: BlockNode) => BlockNode) {
  if (!child.parent) return;
  child.parent.value.value = f(child.parent.value.peek());
}

function locateChildIn(block: BlockNode, child: Box): ChildLoc | undefined {
  const itemIdx = block.items.indexOf(child);
  if (itemIdx >= 0) return { kind: "item", index: itemIdx };

  const valIdx = block.values.findIndex(([, v]) => v === child);
  if (valIdx >= 0) return { kind: "value", index: valIdx };

  return undefined;
}

function updateParentAt(
  child: Box,
  op: (block: BlockNode, loc: ChildLoc) => BlockNode
) {
  withParentBlock(child, (block) => {
    const loc = locateChildIn(block, child);
    if (!loc) return block;
    return op(block, loc);
  });
}

function replaceAt(block: BlockNode, loc: ChildLoc, next: Box): BlockNode {
  if (loc.kind === "item") {
    return makeBlock(block.values, block.items.toSpliced(loc.index, 1, next));
  } else {
    const curKey = block.values[loc.index]![0];
    const nextValues = block.values.toSpliced(loc.index, 1, [curKey, next]);
    return makeBlock(nextValues, block.items);
  }
}

function removeAt(block: BlockNode, loc: ChildLoc): BlockNode {
  if (loc.kind === "item") {
    return makeBlock(block.values, block.items.toSpliced(loc.index, 1));
  } else {
    return makeBlock(block.values.toSpliced(loc.index, 1), block.items);
  }
}

function insertItemAt(block: BlockNode, index: number, item: Box): BlockNode {
  return makeBlock(block.values, block.items.toSpliced(index, 0, item));
}

export function orderedChildren(block: BlockNode): Box[] {
  return [...block.values.map(([, v]) => v), ...block.items];
}

export function keyOfChild(child: Box): string | undefined {
  if (!child.parent) return;
  const block = child.parent.value.peek();
  const loc = locateChildIn(block, child);
  if (loc?.kind === "value") return block.values[loc.index]![0];
  return undefined;
}

/* Transformations */

export function renameChildKey(child: Box, nextKey: string): Box | undefined {
  let result: Box | undefined = child;
  updateParentAt(child, (block, loc) => {
    if (loc.kind !== "value") return block;

    const currentKey = block.values[loc.index]![0];
    if (!nextKey || nextKey === currentKey) return block;
    if (block.values.some(([k]) => k === nextKey)) return block;

    const [, val] = block.values[loc.index]!;
    const nextValues = block.values.toSpliced(loc.index, 1, [nextKey, val]);
    result = child;
    return makeBlock(nextValues, block.items);
  });
  return result;
}

export function moveValueToItems(child: Box): Box | undefined {
  let result: Box | undefined = child;
  updateParentAt(child, (block, loc) => {
    if (loc.kind !== "value") return block;
    const [, val] = block.values[loc.index]!;
    const nextValues = block.values.toSpliced(loc.index, 1);
    result = child;
    return insertItemAt(makeBlock(nextValues, block.items), 0, val);
  });
  return result;
}

export function removeChild(child: Box): Box | undefined {
  const parentBox = child.parent;
  if (!parentBox) return;

  const block = parentBox.value.peek();
  const all = orderedChildren(block);
  const idx = all.indexOf(child);
  const focusTarget: Box | undefined =
    all[idx - 1] ?? all[idx + 1] ?? parentBox;

  updateParentAt(child, (block, loc) => removeAt(block, loc));
  return focusTarget;
}

export function replaceChild(target: Box, next: Box): Box | undefined {
  updateParentAt(target, (block, loc) => replaceAt(block, loc, next));
  return next;
}

export function insertItemBefore(
  referenceItem: Box,
  newItem: Box
): Box | undefined {
  let result: Box | undefined = newItem;
  updateParentAt(referenceItem, (block, loc) => {
    if (loc.kind === "item") {
      return insertItemAt(block, loc.index, newItem);
    }
    return insertItemAt(block, 0, newItem);
  });
  return result;
}

export function insertItemAfter(
  referenceItem: Box,
  newItem: Box
): Box | undefined {
  let result: Box | undefined = newItem;
  updateParentAt(referenceItem, (block, loc) => {
    if (loc.kind === "item") {
      return insertItemAt(block, loc.index + 1, newItem);
    }
    return insertItemAt(block, 0, newItem);
  });
  return result;
}

export function itemToKeyValue(item: Box, key: string): Box | undefined {
  let result: Box | undefined = item;
  updateParentAt(item, (block, loc) => {
    if (loc.kind !== "item") return block;
    if (block.values.some(([k]) => k === key)) return block;

    const nextItems = block.items.toSpliced(loc.index, 1);
    const nextValues = [...block.values, [key, item] as [string, Box]];
    return makeBlock(nextValues, nextItems);
  });
  return result;
}

export function keyValueToItem(
  contextChild: Box,
  key: string
): Box | undefined {
  let result: Box | undefined;
  withParentBlock(contextChild, (block) => {
    const idx = block.values.findIndex(([k]) => k === key);
    if (idx < 0) return block;

    const [, value] = block.values[idx]!;
    const nextValues = block.values.toSpliced(idx, 1);
    result = value;
    return insertItemAt(makeBlock(nextValues, block.items), 0, value);
  });
  return result;
}

export function wrapChildInShallowBlock(child: Box): Box | undefined {
  const parentBox = child.parent;
  if (!parentBox) return;
  const wrapperBox = makeBox(makeBlock([], [child]), parentBox);
  replaceChild(child, wrapperBox);
  return child;
}

export function unwrapSingleChildBlock(wrapper: Box): Box | undefined {
  const parentBox = wrapper.parent;
  if (!parentBox) return;

  const node = wrapper.value.peek();
  if (!isBlock(node)) return;

  const children = orderedChildren(node);
  if (children.length !== 1) return;

  const onlyChild = children[0]!;
  replaceChild(wrapper, onlyChild);
  return onlyChild;
}
