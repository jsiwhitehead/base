import {
  type Signal as PSignal,
  type ReadonlySignal as PReadonlySignal,
  signal as s,
  computed as c,
} from "@preact/signals-core";

import { evalCode } from "./code";

/* Data Types */

export type Primitive = true | number | string;

export type BlankNode = {
  kind: "blank";
};

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

export type DataNode = BlankNode | LiteralNode | BlockNode | FunctionNode;

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

export type DataSignal<T extends DataNode = DataNode> =
  | ReadSignal<T>
  | WriteSignal<T>;

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

export type StaticNode = StaticError | BlankNode | Primitive | StaticBlock;

/* Parent Store */

type ParentSig = PSignal<WriteSignal<BlockNode> | undefined>;
const parentMap = new WeakMap<ChildSignal, ParentSig>();

function getParentSignal(sig: ChildSignal): ParentSig {
  let p = parentMap.get(sig);
  if (!p) {
    p = s<WriteSignal<BlockNode> | undefined>(undefined);
    parentMap.set(sig, p);
  }
  return p;
}

export function getParent(
  child: ChildSignal
): DataSignal<BlockNode> | undefined {
  return getParentSignal(child).peek();
}

/* Type Guards */

export function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export function isBlank(v: unknown): v is BlankNode {
  return hasKind(v, "blank");
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
  return isBlank(v) || isLiteral(v) || isBlock(v) || isFunction(v);
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

export function createBlank(): BlankNode {
  return { kind: "blank" };
}

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

export function createComputed<T extends DataNode>(fn: () => T): ReadSignal<T> {
  const com: PReadonlySignal<T> = c(fn);
  return {
    kind: "signal",
    get: () => com.value,
    peek: () => com.peek(),
  };
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
  values: [string, ChildSignal][] | Record<string, ChildSignal> = [],
  items: ChildSignal[] = []
): DataSignal<BlockNode> {
  const parent = createSignal(createBlock([], []));

  const valueEntries = Array.isArray(values) ? values : Object.entries(values);
  for (const [, v] of valueEntries) getParentSignal(v).value = parent;
  for (const v of items) getParentSignal(v).value = parent;

  parent.set(createBlock(values, items));
  return parent;
}

/* Slice */

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function rangeIndices(s: number, e: number, st: number): number[] {
  if (st === 0) throw new RangeError("Slice step cannot be 0");
  const delta = e - s;
  if (delta === 0) return [s];
  if (Math.sign(delta) !== Math.sign(st)) return [];
  const n = Math.floor(Math.abs(delta) / Math.abs(st)) + 1;
  return Array.from({ length: n }, (_, i) => s + i * st);
}

function computeSliceIndices(
  start: number | null,
  end: number | null,
  step: number | null,
  len: number | null
): number[] {
  if (len == null) {
    const s = Math.trunc(start ?? 1);
    if (end == null) return [];
    const e = Math.trunc(end);
    const st = step != null ? Math.trunc(step) : e >= s ? 1 : -1;
    return rangeIndices(s, e, st);
  }

  const st =
    step != null ? Math.trunc(step) : (end ?? len) >= (start ?? 1) ? 1 : -1;
  const sDefault = st > 0 ? 1 : len;
  const eDefault = st > 0 ? len : 1;
  const s = clamp(Math.trunc(start ?? sDefault), 1, len);
  const e = clamp(Math.trunc(end ?? eDefault), 1, len);
  return rangeIndices(s, e, st);
}

export function sliceText(
  text: string,
  start: number | null,
  end: number | null,
  step: number | null
): string {
  const indices = computeSliceIndices(start, end, step, text.length);
  const out = indices.map((i) => text.charAt(i - 1)).join("");
  return out;
}

export function sliceBlockItems(
  block: BlockNode,
  start: number | null,
  end: number | null,
  step: number | null
): BlockNode {
  const indices = computeSliceIndices(start, end, step, block.items.length);
  const newItems = indices.map((oneBased) => block.items[oneBased - 1]!);
  return createBlock([], newItems);
}

export function createRangeBlock(
  start: number | null,
  end: number | null,
  step: number | null = null
): BlockNode {
  const indices = computeSliceIndices(start, end, step, null);
  const items: ChildSignal[] = indices.map((n) =>
    createSignal(createLiteral(n))
  );
  return createBlock([], items);
}

/* Evaluate */

function toStaticError(err: unknown): StaticError {
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function isStaticTruthy(n: StaticNode): boolean {
  if (isStaticError(n)) return false;
  if (isBlank(n)) return false;
  return Boolean(n);
}

const caseInsensitiveScopes = new WeakSet<DataSignal<BlockNode>>();

export function markCaseInsensitiveScope(scope: DataSignal<BlockNode>) {
  caseInsensitiveScopes.add(scope);
}

function lookupInScope(name: string, start: ChildSignal): DataSignal {
  let scope = getParentSignal(start).value;
  while (scope) {
    const { values } = scope.get();
    const insensitive = caseInsensitiveScopes.has(scope);
    const found = values.find(
      ([k]) =>
        k === name || (insensitive && k.toLowerCase() === name.toLowerCase())
    );
    if (found) return createSignal(childToData(found[1]));
    scope = getParentSignal(scope).value;
  }
  throw new Error(`Unbound identifier: ${name}`);
}

export function childToData(sig: ChildSignal): DataNode {
  const v = sig.get();

  if (isIfElse(v)) {
    const truthy = isStaticTruthy(resolveData(v.if.get()));

    if (truthy) return v.then.get();
    if (v.else) return v.else.get();
    return createBlank();
  }

  if (isCode(v)) {
    return evalCode(v.code, (name: string) => lookupInScope(name, sig));
  }

  return v;
}

export function resolveData(n: DataNode): StaticNode {
  if (n.kind === "blank") return { kind: "blank" };

  if (n.kind === "literal") return n.value;

  if (n.kind === "block") {
    const values: [string, StaticNode][] = n.values.map(([k, vsig]) => {
      try {
        return [k, resolveData(childToData(vsig))];
      } catch (err) {
        return [k, toStaticError(err)];
      }
    });

    const items: StaticNode[] = n.items.map((isg) => {
      try {
        return resolveData(childToData(isg));
      } catch (err) {
        return toStaticError(err);
      }
    });

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
  child: ChildSignal,
  fn: (ctx: {
    parentSignal: WriteSignal<BlockNode>;
    parentBlock: BlockNode;
    loc: ChildLoc;
  }) => BlockNode | void
) {
  const parentSignal = getParentSignal(child).peek();
  if (!parentSignal) return;

  const parentBlock = parentSignal.get();
  const loc = findChildLocation(parentBlock, child);
  if (!loc) return;

  const maybeNext = fn({ parentSignal, parentBlock, loc });
  if (maybeNext && maybeNext !== parentBlock) {
    parentSignal.set(maybeNext);
  }
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
  const [curKey] = block.values[loc.index]!;
  const nextValues = block.values.toSpliced(loc.index, 1, [curKey, next]);
  return createBlock(nextValues, block.items);
}

function removeChildAt(block: BlockNode, loc: ChildLoc): BlockNode {
  if (loc.kind === "item") {
    return createBlock(block.values, block.items.toSpliced(loc.index, 1));
  }
  return createBlock(block.values.toSpliced(loc.index, 1), block.items);
}

function listChildrenInOrder(parent: DataSignal<BlockNode>): ChildSignal[] {
  const node = parent.peek();
  if (!isBlock(node)) return [];
  return [...node.values.map(([, v]) => v), ...node.items];
}

function nextFocusForRemoval(child: ChildSignal): ChildSignal {
  const parent = getParent(child);
  if (!parent) return child;

  const list = listChildrenInOrder(parent);
  const i = list.indexOf(child);

  const prev = i > 0 ? list[i - 1]! : null;
  const next = i >= 0 && i + 1 < list.length ? list[i + 1]! : null;

  return prev ?? next ?? parent;
}

/* Getters */

export function getKeyOfChild(
  parentBlock: BlockNode,
  child: ChildSignal
): string | undefined {
  const loc = findChildLocation(parentBlock, child);
  return loc?.kind === "value" ? parentBlock.values[loc.index]![0] : undefined;
}

export function getByKey(block: DataSignal, key: string): DataSignal {
  const node = block.get();
  if (!isBlock(node)) {
    throw new TypeError(`Cannot access property '${key}' of non-block value`);
  }
  const pair = node.values.find(([k]) => k === key);
  if (!pair) throw new ReferenceError(`Unknown property '${key}'`);
  return createSignal(childToData(pair[1]));
}

export function getByIndex1(block: DataSignal, idx1: number): DataSignal {
  if (!Number.isFinite(idx1)) {
    throw new TypeError("Index must be a finite number");
  }
  const idx0 = Math.trunc(idx1) - 1;
  if (idx0 < 0) {
    throw new RangeError("Index must be 1 or greater");
  }
  const node = block.get();
  if (!isBlock(node)) {
    throw new TypeError("Cannot index into a non-block value");
  }

  const child = node.items[idx0];
  if (!child) {
    throw new RangeError(
      `Index ${idx1} is out of range (items length ${node.items.length})`
    );
  }
  return createSignal(childToData(child));
}

export function getByKeyOrIndex(
  block: DataSignal,
  value: DataSignal
): DataSignal {
  const v = value.get();
  if (isLiteral(v)) {
    const lit = v.value;
    if (typeof lit === "number") {
      return getByIndex1(block, lit);
    }
    if (typeof lit === "string") {
      return getByKey(block, lit);
    }
  }
  throw new TypeError("Index/key must evaluate to text or number");
}

/* Traversal */

export function getPreviousSibling(
  child: ChildSignal
): ChildSignal | undefined {
  const parent = getParent(child);
  if (!parent) return undefined;
  const list = listChildrenInOrder(parent);
  const i = list.indexOf(child);
  return i > 0 ? list[i - 1] : undefined;
}

export function getNextSibling(child: ChildSignal): ChildSignal | undefined {
  const parent = getParent(child);
  if (!parent) return undefined;
  const list = listChildrenInOrder(parent);
  const i = list.indexOf(child);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : undefined;
}

export function getParentChild(child: ChildSignal): ChildSignal | undefined {
  const parent = getParent(child);
  // Consumers that need a ChildSignal (e.g., for focusing) can use this casted form.
  return parent ? (parent as unknown as ChildSignal) : undefined;
}

export function getFirstChild(child: ChildSignal): ChildSignal | undefined {
  const n = child.peek();
  if (!isBlock(n)) return undefined;
  return n.values.length ? n.values[0]![1] : n.items[0];
}

/* Transformations */

export function insertBefore(
  reference: ChildSignal,
  newItem: ChildSignal
): ChildSignal {
  let changed = false;
  withLocatedChild(reference, ({ parentSignal, parentBlock, loc }) => {
    getParentSignal(newItem).value = parentSignal;
    changed = true;
    if (loc.kind === "item") {
      return insertItemAtIndex(parentBlock, loc.index, newItem);
    }
    return insertItemAtIndex(parentBlock, 0, newItem);
  });
  return changed ? newItem : reference;
}

export function insertAfter(
  reference: ChildSignal,
  newItem: ChildSignal
): ChildSignal {
  let changed = false;
  withLocatedChild(reference, ({ parentSignal, parentBlock, loc }) => {
    getParentSignal(newItem).value = parentSignal;
    changed = true;
    if (loc.kind === "item") {
      return insertItemAtIndex(parentBlock, loc.index + 1, newItem);
    }
    return insertItemAtIndex(parentBlock, 0, newItem);
  });
  return changed ? newItem : reference;
}

export function replaceChildWith(
  target: ChildSignal,
  next: ChildSignal
): ChildSignal {
  let replaced = false;
  withLocatedChild(target, ({ parentSignal, parentBlock, loc }) => {
    getParentSignal(target).value = undefined;
    getParentSignal(next).value = parentSignal;
    replaced = true;
    return replaceChildAt(parentBlock, loc, next);
  });
  return replaced ? next : target;
}

export function assignKey(child: ChildSignal, nextKey: string) {
  withLocatedChild(child, ({ parentBlock, loc }) => {
    if (parentBlock.values.some(([k]) => k === nextKey)) return;

    if (loc.kind === "value") {
      const [currentKey, val] = parentBlock.values[loc.index]!;
      if (currentKey === nextKey) return;
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

export function removeKey(child: ChildSignal) {
  withLocatedChild(child, ({ parentBlock, loc }) => {
    if (loc.kind !== "value") return;
    const nextValues = parentBlock.values.toSpliced(loc.index, 1);
    return insertItemAtIndex(
      createBlock(nextValues, parentBlock.items),
      0,
      child
    );
  });
}

export function wrapWithBlock(child: ChildSignal): ChildSignal {
  let ok = false;
  withLocatedChild(child, ({ parentSignal, parentBlock, loc }) => {
    const wrapper = createSignal(createBlock([], [child]));
    getParentSignal(wrapper).value = parentSignal;
    getParentSignal(child).value = wrapper;
    ok = true;
    return replaceChildAt(parentBlock, loc, wrapper);
  });
  return child;
}

export function unwrapBlockIfSingleChild(child: ChildSignal): ChildSignal {
  let unwrapped = false;
  withLocatedChild(child, ({ parentSignal: parentSig, parentBlock }) => {
    if (parentBlock.values.length !== 0 || parentBlock.items.length !== 1)
      return;
    withLocatedChild(
      parentSig,
      ({
        parentSignal: grandparentSig,
        parentBlock: grandparentBlock,
        loc,
      }) => {
        getParentSignal(child).value = grandparentSig;
        getParentSignal(parentSig).value = undefined;
        unwrapped = true;
        return replaceChildAt(grandparentBlock, loc, child);
      }
    );
  });
  return child;
}

export function removeChild(child: ChildSignal): ChildSignal {
  const next = nextFocusForRemoval(child);

  withLocatedChild(child, ({ parentBlock, loc }) => {
    const nextBlock = removeChildAt(parentBlock, loc);
    getParentSignal(child).value = undefined;
    return nextBlock;
  });

  return next;
}
