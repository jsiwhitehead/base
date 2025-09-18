import { type Signal, signal } from "@preact/signals-core";
import { evalCode } from "./code";

/* Node Types */

export type Primitive = string | number | boolean;

export type LiteralNode = {
  kind: "literal";
  value: Primitive;
};

export type BlockNode = {
  kind: "block";
  values: [string, Box][];
  items: Box[];
};

export type EvalNode = BlockNode | LiteralNode;

export type CodeNode = {
  kind: "code";
  code: string;
};

export type Node = CodeNode | EvalNode;

export type Box<T extends Node = Node> = {
  kind: "box";
  value: Signal<T>;
  parent?: Box<BlockNode>;
};

/* Static Types */

export type StaticBlock = {
  kind: "block";
  values: [string, StaticNode][];
  items: StaticNode[];
};

export type StaticError = {
  kind: "error";
  message: string;
};

export type StaticNode = StaticBlock | StaticError | Primitive;

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

export function resolveShallow(b: Box): EvalNode {
  const v = b.value.value;
  if (isCode(v)) {
    const getter = (name: string): Box => lookupInScope(b.parent, name);
    return evalCode(v.code, getter);
  }
  return v;
}

export function resolveDeep(b: Box): StaticNode {
  try {
    const n = resolveShallow(b);
    if (n.kind === "literal") return n.value;
    return {
      kind: "block",
      values: n.values.map(([k, vb]) => [k, resolveDeep(vb)]),
      items: n.items.map(resolveDeep),
    };
  } catch (err) {
    return {
      kind: "error",
      message:
        err instanceof Error ? err.message : "Unknown error during evaluation",
    };
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
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  reference: Box,
  newItem: Box
): BlockNode {
  const loc = findChildLocation(parentBlock, reference);
  if (!loc) return parentBlock;

  newItem.parent = parentBox;

  if (loc.kind === "item") {
    return insertItemAtIndex(parentBlock, loc.index, newItem);
  }
  return insertItemAtIndex(parentBlock, 0, newItem);
}

export function insertAfter(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  reference: Box,
  newItem: Box
): BlockNode {
  const loc = findChildLocation(parentBlock, reference);
  if (!loc) return parentBlock;

  newItem.parent = parentBox;

  if (loc.kind === "item") {
    return insertItemAtIndex(parentBlock, loc.index + 1, newItem);
  }
  return insertItemAtIndex(parentBlock, 0, newItem);
}

export function replaceChildWith(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  target: Box,
  next: Box
): BlockNode {
  const loc = findChildLocation(parentBlock, target);
  if (!loc) return parentBlock;

  next.parent = parentBox;
  if (target.parent === parentBox) target.parent = undefined;

  return replaceChildAt(parentBlock, loc, next);
}

export function assignKey(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  child: Box,
  nextKey: string
): BlockNode {
  const trimmed = nextKey.trim();
  if (!trimmed) return parentBlock;

  if (parentBlock.values.some(([k]) => k === trimmed)) return parentBlock;

  const loc = findChildLocation(parentBlock, child);
  if (!loc) return parentBlock;

  if (loc.kind === "value") {
    const currentKey = parentBlock.values[loc.index]![0];
    if (currentKey === trimmed) return parentBlock;
    const [, val] = parentBlock.values[loc.index]!;
    const nextValues = parentBlock.values.toSpliced(loc.index, 1, [
      trimmed,
      val,
    ]);
    return makeBlock(nextValues, parentBlock.items);
  }

  const nextItems = parentBlock.items.toSpliced(loc.index, 1);
  const nextValues = [...parentBlock.values, [trimmed, child] as [string, Box]];
  return makeBlock(nextValues, nextItems);
}

export function removeKey(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  child: Box
): BlockNode {
  const loc = findChildLocation(parentBlock, child);
  if (!loc || loc.kind !== "value") return parentBlock;

  const [, val] = parentBlock.values[loc.index]!;
  const nextValues = parentBlock.values.toSpliced(loc.index, 1);
  return insertItemAtIndex(makeBlock(nextValues, parentBlock.items), 0, val);
}

export function removeChild(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  child: Box
): BlockNode {
  const loc = findChildLocation(parentBlock, child);
  if (!loc) return parentBlock;

  if (child.parent === parentBox) child.parent = undefined;

  return removeChildAt(parentBlock, loc);
}

export function wrapWithBlock(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  child: Box
): BlockNode {
  const loc = findChildLocation(parentBlock, child);
  if (!loc) return parentBlock;

  const wrapper = makeBox(makeBlock([], [child]), parentBox);
  child.parent = wrapper;

  return replaceChildAt(parentBlock, loc, wrapper);
}

export function unwrapBlockIfSingleChild(
  parentBox: Box<BlockNode>,
  parentBlock: BlockNode,
  maybeWrapper: Box
): BlockNode {
  const n = maybeWrapper.value.value;
  if (!isBlock(n)) return parentBlock;

  const { values, items } = n;
  if (values.length !== 0 || items.length !== 1) return parentBlock;

  const sole = items[0]!;
  const loc = findChildLocation(parentBlock, maybeWrapper);
  if (!loc) return parentBlock;

  sole.parent = parentBox;
  if (maybeWrapper.parent === parentBox) maybeWrapper.parent = undefined;

  return replaceChildAt(parentBlock, loc, sole);
}
