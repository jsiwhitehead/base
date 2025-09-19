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

/* Parent Store */

type ParentSig = Signal<Box<BlockNode> | undefined>;

const parentMap = new WeakMap<Box, ParentSig>();

function getParentSignal(b: Box): ParentSig {
  let s = parentMap.get(b);
  if (!s) {
    s = signal<Box<BlockNode> | undefined>(undefined);
    parentMap.set(b, s);
  }
  return s;
}

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

export function makeBox<T extends Node>(initial: T): Box<T> {
  return { kind: "box", value: signal<T>(initial) };
}

export function makeBlockBox(
  values: [string, Box][] = [],
  items: Box[] = []
): Box<BlockNode> {
  const parent = makeBox(makeBlock([], []));
  for (const [_, v] of values) getParentSignal(v).value = parent;
  for (const v of items) getParentSignal(v).value = parent;
  parent.value.value = makeBlock(values, items);
  return parent;
}

/* Resolve */

export function resolveShallow(b: Box): EvalNode {
  const v = b.value.value;
  if (!isCode(v)) return v;

  return evalCode(v.code, (name: string) => {
    let scope: Box<BlockNode> | undefined = getParentSignal(b).value;

    while (scope) {
      const currentBlock = scope.value.value;
      const binding = currentBlock.values.find(([k]) => k === name);
      if (binding) return binding[1];
      scope = getParentSignal(scope).value;
    }

    throw new Error(`Unbound identifier: ${name}`);
  });
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

function withLocatedChild(
  parentBlock: BlockNode,
  child: Box,
  fn: (ctx: { parentBox: Box<BlockNode>; loc: ChildLoc }) => BlockNode
): BlockNode {
  const parentBox = getParentSignal(child).peek();
  if (!parentBox) return parentBlock;

  const loc = findChildLocation(parentBlock, child);
  if (!loc) return parentBlock;

  return fn({ parentBox, loc });
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

export function getChildKey(
  parentBlock: BlockNode,
  child: Box
): string | undefined {
  const loc = findChildLocation(parentBlock, child);
  if (loc?.kind === "value") return parentBlock.values[loc.index]![0];
  return undefined;
}

/* Transformations */

export function insertBefore(
  parentBlock: BlockNode,
  reference: Box,
  newItem: Box
): BlockNode {
  return withLocatedChild(parentBlock, reference, ({ parentBox, loc }) => {
    getParentSignal(newItem).value = parentBox;
    if (loc.kind === "item") {
      return insertItemAtIndex(parentBlock, loc.index, newItem);
    }
    return insertItemAtIndex(parentBlock, 0, newItem);
  });
}

export function insertAfter(
  parentBlock: BlockNode,
  reference: Box,
  newItem: Box
): BlockNode {
  return withLocatedChild(parentBlock, reference, ({ parentBox, loc }) => {
    getParentSignal(newItem).value = parentBox;
    if (loc.kind === "item") {
      return insertItemAtIndex(parentBlock, loc.index + 1, newItem);
    }
    return insertItemAtIndex(parentBlock, 0, newItem);
  });
}

export function replaceChildWith(
  parentBlock: BlockNode,
  target: Box,
  next: Box
): BlockNode {
  return withLocatedChild(parentBlock, target, ({ parentBox, loc }) => {
    getParentSignal(target).value = undefined;
    getParentSignal(next).value = parentBox;
    return replaceChildAt(parentBlock, loc, next);
  });
}

export function assignKey(
  parentBlock: BlockNode,
  child: Box,
  nextKey: string
): BlockNode {
  if (parentBlock.values.some(([k]) => k === nextKey)) return parentBlock;

  return withLocatedChild(parentBlock, child, ({ loc }) => {
    if (loc.kind === "value") {
      const [currentKey, val] = parentBlock.values[loc.index]!;
      if (currentKey === nextKey) return parentBlock;
      const nextValues = parentBlock.values.toSpliced(loc.index, 1, [
        nextKey,
        val,
      ]);
      return makeBlock(nextValues, parentBlock.items);
    }

    const nextItems = parentBlock.items.toSpliced(loc.index, 1);
    const nextValues = [
      ...parentBlock.values,
      [nextKey, child] as [string, Box],
    ];
    return makeBlock(nextValues, nextItems);
  });
}

export function removeKey(parentBlock: BlockNode, child: Box): BlockNode {
  return withLocatedChild(parentBlock, child, ({ loc }) => {
    if (loc.kind !== "value") return parentBlock;

    const nextValues = parentBlock.values.toSpliced(loc.index, 1);
    return insertItemAtIndex(
      makeBlock(nextValues, parentBlock.items),
      0,
      child
    );
  });
}

export function removeChild(parentBlock: BlockNode, child: Box): BlockNode {
  return withLocatedChild(parentBlock, child, ({ loc }) => {
    getParentSignal(child).value = undefined;
    return removeChildAt(parentBlock, loc);
  });
}

export function wrapWithBlock(parentBlock: BlockNode, child: Box): BlockNode {
  return withLocatedChild(parentBlock, child, ({ parentBox, loc }) => {
    const wrapper = makeBox(makeBlock([], [child]));
    getParentSignal(wrapper).value = parentBox;
    getParentSignal(child).value = wrapper;
    return replaceChildAt(parentBlock, loc, wrapper);
  });
}

export function unwrapBlockIfSingleChild(
  parentBlock: BlockNode,
  wrapper: Box
): BlockNode {
  return withLocatedChild(parentBlock, wrapper, ({ parentBox, loc }) => {
    const n = wrapper.value.peek() as BlockNode;
    if (n.values.length !== 0 || n.items.length !== 1) return parentBlock;

    const sole = n.items[0]!;
    getParentSignal(sole).value = parentBox;
    getParentSignal(wrapper).value = undefined;
    return replaceChildAt(parentBlock, loc, sole);
  });
}
