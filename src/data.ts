import { type Signal as PSignal, signal as s } from "@preact/signals-core";

import { evalCode } from "./code";

/* Data Types */

export type Primitive = boolean | number | string;

export type LiteralNode = {
  kind: "literal";
  value: Primitive;
};

export type BlockNode = {
  kind: "block";
  values: [string, ChildSignal][];
  items: ChildSignal[];
};

export type FunctionNode = {
  kind: "function";
  fn: (...args: DataSignal[]) => DataSignal;
};

export type DataNode = LiteralNode | BlockNode | FunctionNode;

/* Eval Types */

export type IfElseNode = {
  kind: "ifelse";
  if: DataSignal;
  then: DataSignal;
  else?: DataSignal;
};

export type CodeNode = {
  kind: "code";
  code: string;
};

export type EvalNode = IfElseNode | CodeNode;

/* Signal Types */

type ReadSignal<T> = {
  kind: "signal";
  get(): T;
  peek(): T;
};

export type WriteSignal<T> = ReadSignal<T> & {
  set(next: T): void;
};

export type DataSignal<T extends DataNode = DataNode> = WriteSignal<T>;

export type ChildSignal =
  | ReadSignal<DataNode>
  | WriteSignal<DataNode | EvalNode>;

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

export type StaticNode = StaticError | Primitive | StaticBlock;

/* Parent Store */

type ParentSig = PSignal<DataSignal<BlockNode> | undefined>;
const parentMap = new WeakMap<ChildSignal, ParentSig>();

function getParentSignal(sig: ChildSignal): ParentSig {
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
  return isLiteral(v) || isBlock(v) || isFunction(v);
}

export function isIfElse(v: unknown): v is IfElseNode {
  return hasKind(v, "ifelse");
}

export function isCode(v: unknown): v is CodeNode {
  return hasKind(v, "code");
}

export function isSignal(
  v: unknown
): v is ReadSignal<unknown> | WriteSignal<unknown> {
  return hasKind(v, "signal");
}

export function isWritableSignal(v: unknown): v is WriteSignal<unknown> {
  return hasKind(v, "signal") && typeof (v as any).set === "function";
}

export function isStaticError(v: unknown): v is StaticError {
  return hasKind(v, "error");
}

/* Constructors */

export function createLiteral(value: Primitive): LiteralNode {
  return { kind: "literal", value };
}

export function createBlock(
  values: [string, ChildSignal][] | Record<string, ChildSignal> = [],
  items: ChildSignal[] = []
): BlockNode {
  return {
    kind: "block",
    values: Array.isArray(values) ? values : Object.entries(values),
    items,
  };
}

export function createFunction(
  fn: (...args: DataSignal[]) => DataSignal
): FunctionNode {
  return { kind: "function", fn };
}

export function createIfElse(
  cond: DataSignal,
  thenSig: DataSignal,
  elseSig?: DataSignal
): IfElseNode {
  return { kind: "ifelse", if: cond, then: thenSig, else: elseSig };
}

export function createCode(code: string): CodeNode {
  return { kind: "code", code };
}

export function createSignal<T>(initial: T): WriteSignal<T> {
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
  values: [string, ChildSignal][] = [],
  items: ChildSignal[] = []
): DataSignal<BlockNode> {
  const parent = createSignal(createBlock([], []));
  for (const [_, v] of values) getParentSignal(v).value = parent;
  for (const v of items) getParentSignal(v).value = parent;
  parent.set(createBlock(values, items));
  return parent;
}

/* Evaluate */

export const library: Record<string, DataSignal> = Object.create(null);

function toStaticError(err: unknown): StaticError {
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function isStaticTruthy(n: StaticNode): boolean {
  if (isStaticError(n)) return false;
  return Boolean(n);
}

function lookupInScope(name: string, start: ChildSignal): ChildSignal {
  let scope = getParentSignal(start).value;
  while (scope) {
    const currentBlock = scope.get();
    const found = currentBlock.values.find(([k]) => k === name);
    if (found) return found[1];
    scope = getParentSignal(scope).value;
  }
  if (Object.prototype.hasOwnProperty.call(library, name)) {
    return library[name]!;
  }
  throw new Error(`Unbound identifier: ${name}`);
}

export function childToData(sig: ChildSignal): DataNode | undefined {
  const v = sig.get();

  if (isIfElse(v)) {
    const condNode = v.if.get();
    const condStatic = resolveData(condNode);
    const truthy = isStaticTruthy(condStatic);

    if (truthy) return v.then.get();
    if (v.else) return v.else.get();
    return undefined;
  }

  if (isCode(v)) {
    return evalCode(v.code, (name: string) => lookupInScope(name, sig));
  }

  return v;
}

export function resolveData(n: DataNode): StaticNode {
  if (n.kind === "literal") return n.value;

  if (n.kind === "block") {
    const values: [string, StaticNode][] = [];
    for (const [k, vsig] of n.values) {
      try {
        const v = childToData(vsig);
        if (v !== undefined) values.push([k, resolveData(v)]);
      } catch (err) {
        values.push([k, toStaticError(err)]);
      }
    }

    const items: StaticNode[] = [];
    for (const isg of n.items) {
      try {
        const v = childToData(isg);
        if (v !== undefined) items.push(resolveData(v));
      } catch (err) {
        items.push(toStaticError(err));
      }
    }

    return { kind: "block", values, items };
  }

  return {
    kind: "error",
    message: "Cannot statically resolve a function node",
  };
}

/* Helpers */

type ChildLoc =
  | { kind: "item"; index: number }
  | { kind: "value"; index: number };

function findChildLocation(
  block: BlockNode,
  child: ChildSignal
): ChildLoc | undefined {
  const itemIdx = block.items.indexOf(child);
  if (itemIdx >= 0) return { kind: "item", index: itemIdx };

  const valIdx = block.values.findIndex(([, v]) => v === child);
  if (valIdx >= 0) return { kind: "value", index: valIdx };

  return undefined;
}

function withLocatedChild(
  parentBlock: BlockNode,
  child: ChildSignal,
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
  item: ChildSignal
): BlockNode {
  return createBlock(block.values, block.items.toSpliced(index, 0, item));
}

function replaceChildAt(
  block: BlockNode,
  loc: ChildLoc,
  next: ChildSignal
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

export function getChildrenInOrder(block: BlockNode): ChildSignal[] {
  return [...block.values.map(([, v]) => v), ...block.items];
}

export function getChildKey(
  parentBlock: BlockNode,
  child: ChildSignal
): string | undefined {
  const loc = findChildLocation(parentBlock, child);
  if (loc?.kind === "value") return parentBlock.values[loc.index]![0];
  return undefined;
}

/* Transformations */

export function insertBefore(
  parentBlock: BlockNode,
  reference: ChildSignal,
  newItem: ChildSignal
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
  reference: ChildSignal,
  newItem: ChildSignal
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
  target: ChildSignal,
  next: ChildSignal
): BlockNode {
  return withLocatedChild(parentBlock, target, ({ parentSignal, loc }) => {
    getParentSignal(target).value = undefined;
    getParentSignal(next).value = parentSignal;
    return replaceChildAt(parentBlock, loc, next);
  });
}

export function assignKey(
  parentBlock: BlockNode,
  child: ChildSignal,
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
      [nextKey, child] as [string, ChildSignal],
    ];
    return createBlock(nextValues, nextItems);
  });
}

export function removeKey(
  parentBlock: BlockNode,
  child: ChildSignal
): BlockNode {
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

export function removeChild(
  parentBlock: BlockNode,
  child: ChildSignal
): BlockNode {
  return withLocatedChild(parentBlock, child, ({ loc }) => {
    getParentSignal(child).value = undefined;
    return removeChildAt(parentBlock, loc);
  });
}

export function wrapWithBlock(
  parentBlock: BlockNode,
  child: ChildSignal
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
  wrapper: ChildSignal
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
