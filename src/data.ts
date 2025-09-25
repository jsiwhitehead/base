import { type Signal as PSignal, signal as s } from "@preact/signals-core";

import { evalCode } from "./code";

/* Node Types */

export type Primitive = string | number | boolean;

export type LiteralNode = {
  kind: "literal";
  value: Primitive;
};

export type BlockNode = {
  kind: "block";
  values: [string, Signal][];
  items: Signal[];
};

export type FunctionNode = {
  kind: "function";
  fn: (...args: Signal[]) => Signal;
};

export type DataNode = FunctionNode | BlockNode | LiteralNode;

export type CodeNode = {
  kind: "code";
  code: string;
};

export type Node = CodeNode | DataNode;

/* Signal Types */

type BaseSignal<T extends Node> = {
  kind: "signal";
  get(): T;
  peek(): T;
};

export type ReadonlySignal<T extends DataNode = DataNode> = BaseSignal<T>;

export type WritableSignal<T extends Node = Node> = BaseSignal<T> & {
  set(next: T): void;
};

export type DataSignal<T extends DataNode = DataNode> =
  | ReadonlySignal<T>
  | WritableSignal<T>;

export type CodeSignal = WritableSignal<CodeNode>;

export type Signal = CodeSignal | DataSignal;

/* Static Types */

export type StaticError = {
  kind: "error";
  message: string;
};

export type StaticBlock = {
  kind: "block";
  values: [string, StaticNode][];
  items: StaticNode[];
};

export type StaticNode = StaticBlock | StaticError | Primitive;

/* Parent Store */

type ParentSig = PSignal<DataSignal<BlockNode> | undefined>;

const parentMap = new WeakMap<Signal, ParentSig>();

function getParentSignal(sig: Signal): ParentSig {
  let p = parentMap.get(sig);
  if (!p) {
    p = s<DataSignal<BlockNode> | undefined>(undefined);
    parentMap.set(sig, p);
  }
  return p;
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

export function isFunction(v: unknown): v is FunctionNode {
  return hasKind(v, "function");
}

export function isData(v: unknown): v is DataNode {
  return isFunction(v) || isBlock(v) || isLiteral(v);
}

export function isCode(v: unknown): v is CodeNode {
  return hasKind(v, "code");
}

export function isWritableSignal(v: unknown): v is WritableSignal {
  return hasKind(v, "signal") && typeof (v as any).set === "function";
}

export function isSignal(v: unknown): v is Signal {
  return hasKind(v, "signal");
}

/* Constructors */

export function createLiteral(value: Primitive): LiteralNode {
  return { kind: "literal", value };
}

export function createBlock(
  values: [string, Signal][] | Record<string, Signal> = [],
  items: Signal[] = []
): BlockNode {
  return {
    kind: "block",
    values: Array.isArray(values) ? values : Object.entries(values),
    items,
  };
}

export function createFunction(
  fn: (...args: Signal[]) => Signal
): FunctionNode {
  return { kind: "function", fn };
}

export function createCode(code: string): CodeNode {
  return { kind: "code", code };
}

export function createSignal<T extends Node>(initial: T): WritableSignal<T> {
  const sig = s<T>(initial);
  return {
    kind: "signal",
    get: () => sig.value,
    peek: () => sig.peek(),
    set: (next: T) => {
      sig.value = next;
    },
  };
}

export function createBlockSignal(
  values: [string, Signal][] = [],
  items: Signal[] = []
): WritableSignal<BlockNode> {
  const parent = createSignal(createBlock([], []));
  for (const [_, v] of values) getParentSignal(v).value = parent;
  for (const v of items) getParentSignal(v).value = parent;
  parent.set(createBlock(values, items));
  return parent;
}

/* Resolve */

export const library: Record<string, Signal> = Object.create(null);

export function resolveShallow(sig: Signal): DataNode {
  const v = sig.get();
  if (!isCode(v)) return v;

  return evalCode(v.code, (name: string) => {
    let scope = getParentSignal(sig).value;

    while (scope) {
      const currentBlock = scope.get();
      const binding = currentBlock.values.find(([k]) => k === name);
      if (binding) return binding[1];
      scope = getParentSignal(scope).value;
    }

    if (Object.prototype.hasOwnProperty.call(library, name)) {
      return library[name]!;
    }

    throw new Error(`Unbound identifier: ${name}`);
  });
}

export function resolveDeep(sig: Signal): StaticNode {
  try {
    const n = resolveShallow(sig);
    if (n.kind === "literal") {
      return n.value;
    }
    if (n.kind === "block") {
      return {
        kind: "block",
        values: n.values.map(([k, vsig]) => [k, resolveDeep(vsig)]),
        items: n.items.map(resolveDeep),
      };
    }
    return {
      kind: "error",
      message: "Cannot statically resolve a function node",
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

function findChildLocation(
  block: BlockNode,
  child: Signal
): ChildLoc | undefined {
  const itemIdx = block.items.indexOf(child);
  if (itemIdx >= 0) return { kind: "item", index: itemIdx };

  const valIdx = block.values.findIndex(([, v]) => v === child);
  if (valIdx >= 0) return { kind: "value", index: valIdx };

  return undefined;
}

function withLocatedChild(
  parentBlock: BlockNode,
  child: Signal,
  fn: (ctx: { parentSignal: DataSignal<BlockNode>; loc: ChildLoc }) => BlockNode
): BlockNode {
  const parentSignal = getParentSignal(child).peek();
  if (!parentSignal) return parentBlock;

  const loc = findChildLocation(parentBlock, child);
  if (!loc) return parentBlock;

  return fn({ parentSignal, loc });
}

function insertItemAtIndex(
  block: BlockNode,
  index: number,
  item: Signal
): BlockNode {
  return createBlock(block.values, block.items.toSpliced(index, 0, item));
}

function replaceChildAt(
  block: BlockNode,
  loc: ChildLoc,
  next: Signal
): BlockNode {
  if (loc.kind === "item") {
    return createBlock(block.values, block.items.toSpliced(loc.index, 1, next));
  }
  const curKey = block.values[loc.index]![0];
  const nextValues = block.values.toSpliced(loc.index, 1, [curKey, next]);
  return createBlock(nextValues, block.items);
}

function removeChildAt(block: BlockNode, loc: ChildLoc): BlockNode {
  if (loc.kind === "item") {
    return createBlock(block.values, block.items.toSpliced(loc.index, 1));
  }
  return createBlock(block.values.toSpliced(loc.index, 1), block.items);
}

/* Getters */

export function getChildrenInOrder(block: BlockNode): Signal[] {
  return [...block.values.map(([, v]) => v), ...block.items];
}

export function getChildKey(
  parentBlock: BlockNode,
  child: Signal
): string | undefined {
  const loc = findChildLocation(parentBlock, child);
  if (loc?.kind === "value") return parentBlock.values[loc.index]![0];
  return undefined;
}

/* Transformations */

export function insertBefore(
  parentBlock: BlockNode,
  reference: Signal,
  newItem: Signal
): BlockNode {
  return withLocatedChild(parentBlock, reference, ({ parentSignal, loc }) => {
    getParentSignal(newItem).value = parentSignal;
    if (loc.kind === "item") {
      return insertItemAtIndex(parentBlock, loc.index, newItem);
    }
    return insertItemAtIndex(parentBlock, 0, newItem);
  });
}

export function insertAfter(
  parentBlock: BlockNode,
  reference: Signal,
  newItem: Signal
): BlockNode {
  return withLocatedChild(parentBlock, reference, ({ parentSignal, loc }) => {
    getParentSignal(newItem).value = parentSignal;
    if (loc.kind === "item") {
      return insertItemAtIndex(parentBlock, loc.index + 1, newItem);
    }
    return insertItemAtIndex(parentBlock, 0, newItem);
  });
}

export function replaceChildWith(
  parentBlock: BlockNode,
  target: Signal,
  next: Signal
): BlockNode {
  return withLocatedChild(parentBlock, target, ({ parentSignal, loc }) => {
    getParentSignal(target).value = undefined;
    getParentSignal(next).value = parentSignal;
    return replaceChildAt(parentBlock, loc, next);
  });
}

export function assignKey(
  parentBlock: BlockNode,
  child: Signal,
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
      return createBlock(nextValues, parentBlock.items);
    }

    const nextItems = parentBlock.items.toSpliced(loc.index, 1);
    const nextValues = [
      ...parentBlock.values,
      [nextKey, child] as [string, Signal],
    ];
    return createBlock(nextValues, nextItems);
  });
}

export function removeKey(parentBlock: BlockNode, child: Signal): BlockNode {
  return withLocatedChild(parentBlock, child, ({ loc }) => {
    if (loc.kind !== "value") return parentBlock;

    const nextValues = parentBlock.values.toSpliced(loc.index, 1);
    return insertItemAtIndex(
      createBlock(nextValues, parentBlock.items),
      0,
      child
    );
  });
}

export function removeChild(parentBlock: BlockNode, child: Signal): BlockNode {
  return withLocatedChild(parentBlock, child, ({ loc }) => {
    getParentSignal(child).value = undefined;
    return removeChildAt(parentBlock, loc);
  });
}

export function wrapWithBlock(
  parentBlock: BlockNode,
  child: Signal
): BlockNode {
  return withLocatedChild(parentBlock, child, ({ parentSignal, loc }) => {
    const wrapper = createSignal(createBlock([], [child]));
    getParentSignal(wrapper).value = parentSignal;
    getParentSignal(child).value = wrapper;
    return replaceChildAt(parentBlock, loc, wrapper);
  });
}

export function unwrapBlockIfSingleChild(
  parentBlock: BlockNode,
  wrapper: Signal
): BlockNode {
  return withLocatedChild(parentBlock, wrapper, ({ parentSignal, loc }) => {
    const n = wrapper.peek() as BlockNode;

    if (n.values.length !== 0 || n.items.length !== 1) return parentBlock;

    const sole = n.items[0]!;
    getParentSignal(sole).value = parentSignal;
    getParentSignal(wrapper).value = undefined;
    return replaceChildAt(parentBlock, loc, sole);
  });
}
