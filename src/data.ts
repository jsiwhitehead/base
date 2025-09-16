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
  parent?: Box<BlockNode>;
};

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

export function lookupInScope(
  start: Box<BlockNode> | undefined,
  name: string
): Box {
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

export function makeBox<T extends Node>(
  initial: T,
  parent?: Box<BlockNode>
): Box<T> {
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

function findChildLocation(block: BlockNode, child: Box): ChildLoc | undefined {
  const itemIdx = block.items.indexOf(child);
  if (itemIdx >= 0) return { kind: "item", index: itemIdx };

  const valIdx = block.values.findIndex(([, v]) => v === child);
  if (valIdx >= 0) return { kind: "value", index: valIdx };

  return undefined;
}

function updateParentBlock(child: Box, f: (block: BlockNode) => BlockNode) {
  if (!child.parent) return;
  child.parent.value.value = f(child.parent.value.peek());
}

function updateChildInParent(
  child: Box,
  op: (block: BlockNode, loc: ChildLoc) => BlockNode
) {
  updateParentBlock(child, (block) => {
    const loc = findChildLocation(block, child);
    if (!loc) return block;
    return op(block, loc);
  });
}

function insertItemAtIndex(
  block: BlockNode,
  index: number,
  item: Box
): BlockNode {
  return makeBlock(block.values, block.items.toSpliced(index, 0, item));
}

function replaceChildAt(block: BlockNode, loc: ChildLoc, next: Box): BlockNode {
  if (loc.kind === "item") {
    return makeBlock(block.values, block.items.toSpliced(loc.index, 1, next));
  }
  const curKey = block.values[loc.index]![0];
  const nextValues = block.values.toSpliced(loc.index, 1, [curKey, next]);
  return makeBlock(nextValues, block.items);
}

function removeChildAt(block: BlockNode, loc: ChildLoc): BlockNode {
  if (loc.kind === "item") {
    return makeBlock(block.values, block.items.toSpliced(loc.index, 1));
  }
  return makeBlock(block.values.toSpliced(loc.index, 1), block.items);
}

/* Getters */

export function getChildrenInOrder(block: BlockNode): Box[] {
  return [...block.values.map(([, v]) => v), ...block.items];
}

export function getChildKey(child: Box): string | undefined {
  if (!child.parent) return;
  const block = child.parent.value.peek();
  const loc = findChildLocation(block, child);
  if (loc?.kind === "value") return block.values[loc.index]![0];
  return undefined;
}

/* Transformations */

export function insertBefore(
  referenceItem: Box,
  newItem: Box
): Box | undefined {
  let result: Box | undefined = newItem;
  updateChildInParent(referenceItem, (block, loc) => {
    const parentBox = referenceItem.parent;
    if (parentBox) newItem.parent = parentBox;

    if (loc.kind === "item") {
      return insertItemAtIndex(block, loc.index, newItem);
    }
    return insertItemAtIndex(block, 0, newItem);
  });
  return result;
}

export function insertAfter(referenceItem: Box, newItem: Box): Box | undefined {
  let result: Box | undefined = newItem;
  updateChildInParent(referenceItem, (block, loc) => {
    const parentBox = referenceItem.parent;
    if (parentBox) newItem.parent = parentBox;

    if (loc.kind === "item") {
      return insertItemAtIndex(block, loc.index + 1, newItem);
    }
    return insertItemAtIndex(block, 0, newItem);
  });
  return result;
}

export function replaceChildWith(target: Box, next: Box): Box | undefined {
  const parentBox = target.parent;
  if (parentBox) next.parent = parentBox;

  updateChildInParent(target, (block, loc) => replaceChildAt(block, loc, next));

  if (target.parent === parentBox) target.parent = undefined;
  return next;
}

export function assignKey(child: Box, nextKey: string): Box | undefined {
  let result: Box | undefined = child;
  updateChildInParent(child, (block, loc) => {
    if (block.values.some(([k]) => k === nextKey)) return block;

    if (loc.kind === "value") {
      const currentKey = block.values[loc.index]![0];
      if (nextKey === currentKey) return block;

      const [, val] = block.values[loc.index]!;
      const nextValues = block.values.toSpliced(loc.index, 1, [nextKey, val]);
      result = child;
      return makeBlock(nextValues, block.items);
    }

    const nextItems = block.items.toSpliced(loc.index, 1);
    const nextValues = [...block.values, [nextKey, child] as [string, Box]];
    result = child;
    return makeBlock(nextValues, nextItems);
  });
  return result;
}

export function removeKey(child: Box): Box | undefined {
  let result: Box | undefined = child;
  updateChildInParent(child, (block, loc) => {
    if (loc.kind !== "value") return block;
    const [, val] = block.values[loc.index]!;
    const nextValues = block.values.toSpliced(loc.index, 1);
    result = child;
    return insertItemAtIndex(makeBlock(nextValues, block.items), 0, val);
  });
  return result;
}

export function removeChild(child: Box): Box | undefined {
  const parentBox = child.parent;
  if (!parentBox) return;

  const block = parentBox.value.peek();
  const all = getChildrenInOrder(block);
  const idx = all.indexOf(child);
  const focusTarget: Box | undefined =
    all[idx - 1] ?? all[idx + 1] ?? parentBox;

  updateChildInParent(child, (block, loc) => removeChildAt(block, loc));
  child.parent = undefined;

  return focusTarget;
}

export function wrapWithBlock(child: Box): Box | undefined {
  const parentBox = child.parent;
  if (!parentBox) return;

  const wrapperBox = makeBox(makeBlock([], [child]), parentBox);
  replaceChildWith(child, wrapperBox);

  child.parent = wrapperBox;
  return child;
}

export function unwrapBlockIfSingleChild(child: Box): Box | undefined {
  const parentBox = child.parent;
  if (!parentBox) return;

  const children = getChildrenInOrder(parentBox.value.peek());
  if (children.length !== 1) return;

  const grandparentBox = parentBox.parent;
  if (!grandparentBox) return;

  replaceChildWith(parentBox, child);
  if (parentBox.parent === grandparentBox) parentBox.parent = undefined;

  return child;
}
