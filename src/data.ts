import {
  type Signal as PSignal,
  type ReadonlySignal as PReadonlySignal,
  signal,
  computed,
} from "@preact/signals-core";

/* Errors */

export const ERR = {
  boolean: "Expected boolean (true or blank)",
  literal: "Expected literal value",
  number: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  textOrBlock: "Expected text or block",
  block: "Expected block",
  function: "Expected function",
  funcOrBlank: "Expected function (key selector) or blank",

  sliceStepZero: "Slice step cannot be 0",

  indexFinite: "Index must be a finite number",
  indexOneBased: "Index must be 1 or greater",
  indexNonBlock: "Cannot index into a non-block value",
  indexOutOfRange: (index: number, len: number) =>
    `Index ${index} is out of range (items length ${len})`,
  indexKeyMustBeTextOrNumber: "Index/key must evaluate to text or number",
  propOnNonBlock: (prop: string) =>
    `Cannot access property '${prop}' of non-block value`,
  unknownProperty: (prop: string) => `Unknown property '${prop}'`,

  unboundIdentifier: (name: string) => `Unbound identifier: ${name}`,
  cannotResolveFunctionNode: "Cannot statically resolve a function node",
} as const;

/* Types */

export type Primitive = true | number | string;

export type BlankNode = { kind: "blank" };

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

export type StaticError = { kind: "error"; message: string };

export type StaticBlock = {
  kind: "block";
  values: [string, StaticNode][];
  items: StaticNode[];
};

export type StaticNode = StaticError | BlankNode | Primitive | StaticBlock;

/* Type guards */

function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export const isBlank = (v: unknown): v is BlankNode => hasKind(v, "blank");
export const isLiteral = (v: unknown): v is LiteralNode =>
  hasKind(v, "literal");
export const isBlock = (v: unknown): v is BlockNode => hasKind(v, "block");
export const isFunction = (v: unknown): v is FunctionNode =>
  hasKind(v, "function");
export const isData = (v: unknown): v is DataNode =>
  isBlank(v) || isLiteral(v) || isBlock(v) || isFunction(v);
export const isIfElse = (v: unknown): v is IfElseNode => hasKind(v, "ifelse");
export const isCode = (v: unknown): v is CodeNode => hasKind(v, "code");
export const isSignal = (
  v: unknown
): v is ReadSignal<unknown> | WriteSignal<unknown> => hasKind(v, "signal");
export const isWritableSignal = (v: unknown): v is WriteSignal<unknown> =>
  isSignal(v) && typeof (v as any).set === "function";
export const isStaticError = (v: unknown): v is StaticError =>
  hasKind(v, "error");
export const isStaticBlock = (v: unknown): v is StaticBlock =>
  hasKind(v, "block");

/* Parents */

type ParentSig = PSignal<WriteSignal<BlockNode> | undefined>;
const parentMap = new WeakMap<ChildSignal, ParentSig>();

function getParentSignal(sig: ChildSignal): ParentSig {
  let p = parentMap.get(sig);
  if (!p) {
    p = signal(undefined);
    parentMap.set(sig, p);
  }
  return p;
}

export function getParent(
  child: ChildSignal
): WriteSignal<BlockNode> | undefined {
  return getParentSignal(child).peek();
}

const caseInsensitiveScopes = new WeakSet<DataSignal<BlockNode>>();
export function markScopeCaseInsensitive(scope: DataSignal<BlockNode>) {
  caseInsensitiveScopes.add(scope);
}

/* Constructors */

export const createBlank = (): BlankNode => ({ kind: "blank" });
export const createLiteral = (value: Primitive): LiteralNode => ({
  kind: "literal",
  value,
});
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
export const createFunction = (
  fn: (...args: DataSignal[]) => DataSignal
): FunctionNode => ({ kind: "function", fn });

export const createIfElse = (
  cond: DataSignal,
  thenSig: DataSignal,
  elseSig?: DataSignal
): IfElseNode => ({ kind: "ifelse", if: cond, then: thenSig, else: elseSig });

export const createCode = (code: string): CodeNode => ({ kind: "code", code });

export function createComputed<T extends DataNode>(fn: () => T): ReadSignal<T> {
  const rsig = computed(fn);
  return { kind: "signal", get: () => rsig.value, peek: () => rsig.peek() };
}

export function createSignal<T>(initial: T): WriteSignal<T> {
  const sig = signal(initial);
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

/* Conversions */

function primTruthy(p: Primitive): boolean {
  if (p === true) return true;
  if (typeof p === "number") return p !== 0;
  return p.length > 0;
}

function blockNonEmpty(b: BlockNode | StaticBlock): boolean {
  return b.values.length > 0 || b.items.length > 0;
}

export function toBool(node: DataNode): boolean | null {
  if (isBlank(node)) return null;
  if (isLiteral(node)) return primTruthy(node.value);
  if (isBlock(node)) return blockNonEmpty(node);
  return null;
}

export function toNumber(node: DataNode): number | null {
  if (isBlank(node)) return null;
  if (isLiteral(node)) {
    const v = node.value;
    if (typeof v === "number") return v;
    if (v === true) return 1;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

export function toText(node: DataNode): string | null {
  if (isBlank(node)) return null;
  if (isLiteral(node)) return String(node.value);
  return null;
}

export function numOpt(value: DataNode): number | null {
  if (isBlank(value)) return null;
  if (isLiteral(value) && typeof value.value === "number") return value.value;
  throw new TypeError(ERR.numOrBlank);
}

export function textOpt(value: DataNode): string | null {
  if (isBlank(value)) return null;
  if (isLiteral(value) && typeof value.value === "string") return value.value;
  throw new TypeError(ERR.textOrBlank);
}

export function blockOpt(value: DataNode): BlockNode | null {
  if (isBlank(value)) return null;
  if (isBlock(value)) return value;
  throw new TypeError(ERR.block);
}

export function fnOpt(value: DataNode): FunctionNode | null {
  if (isBlank(value)) return null;
  if (isFunction(value)) return value as FunctionNode;
  throw new TypeError(ERR.function);
}

export function boolExpect(value: DataNode): boolean {
  if (isBlank(value)) return false;
  if (isLiteral(value) && value.value === true) return true;
  throw new TypeError(ERR.boolean);
}

export function primExpect(value: DataNode): Primitive {
  if (isLiteral(value)) return value.value;
  throw new TypeError(ERR.literal);
}

export function numExpect(value: DataNode): number {
  if (isLiteral(value) && typeof value.value === "number") return value.value;
  throw new TypeError(ERR.number);
}

export function scalarToData(
  v: boolean | number | string | null
): BlankNode | LiteralNode {
  if (v === null || v === false) return createBlank();
  return createLiteral(v);
}

export function size(node: DataNode): number | null {
  if (isBlank(node)) return null;
  if (isLiteral(node) && typeof node.value === "string")
    return node.value.length;
  if (isBlock(node)) return node.values.length + node.items.length;
  throw new TypeError(ERR.textOrBlock);
}

/* Slice */

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function rangeIndices(start: number, end: number, step: number): number[] {
  if (step === 0) throw new RangeError(ERR.sliceStepZero);
  const delta = end - start;
  if (delta === 0) return [start];
  if (Math.sign(delta) !== Math.sign(step)) return [];
  const n = Math.floor(Math.abs(delta) / Math.abs(step)) + 1;
  return Array.from({ length: n }, (_, i) => start + i * step);
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
  return indices.map((i) => text.charAt(i - 1)).join("");
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

/* Evaluation */

const evalCode: (
  code: string,
  scope: (name: string) => DataSignal
) => DataNode = require("./code").evalCode;

function toStaticError(err: unknown): StaticError {
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function isStaticTruthy(n: StaticNode): boolean {
  if (isStaticError(n) || isBlank(n)) return false;
  if (isStaticBlock(n)) return blockNonEmpty(n);
  return primTruthy(n);
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
  throw new Error(ERR.unboundIdentifier(name));
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
    message: ERR.cannotResolveFunctionNode,
  };
}

/* Getters */

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

function listChildrenInOrder(parent: BlockNode): ChildSignal[] {
  return [...parent.values.map(([, v]) => v), ...parent.items];
}

export function getByKey(block: BlockNode, key: string): DataNode {
  if (!isBlock(block)) {
    throw new TypeError(ERR.propOnNonBlock(key));
  }
  const pair = block.values.find(([k]) => k === key);
  if (!pair) throw new ReferenceError(ERR.unknownProperty(key));
  return childToData(pair[1]);
}

export function getByIndex(block: BlockNode, index1: number): DataNode {
  if (!Number.isFinite(index1)) {
    throw new TypeError(ERR.indexFinite);
  }
  const idx0 = Math.trunc(index1) - 1;
  if (idx0 < 0) {
    throw new RangeError(ERR.indexOneBased);
  }
  if (!isBlock(block)) {
    throw new TypeError(ERR.indexNonBlock);
  }
  const child = block.items[idx0];
  if (!child) {
    throw new RangeError(ERR.indexOutOfRange(index1, block.items.length));
  }
  return childToData(child);
}

export function getByKeyOrIndex(block: BlockNode, value: DataNode): DataNode {
  if (isLiteral(value)) {
    const lit = value.value;
    if (typeof lit === "number") return getByIndex(block, lit);
    if (typeof lit === "string") return getByKey(block, lit);
  }
  throw new TypeError(ERR.indexKeyMustBeTextOrNumber);
}

export function getKeyOfChild(
  parentBlock: BlockNode,
  child: ChildSignal
): string | undefined {
  const loc = findChildLocation(parentBlock, child);
  return loc?.kind === "value" ? parentBlock.values[loc.index]![0] : undefined;
}

function siblingAtOffset(
  child: ChildSignal,
  offset: -1 | 1
): ChildSignal | undefined {
  const parent = getParent(child);
  if (!parent) return undefined;
  const list = listChildrenInOrder(parent.peek());
  const i = list.indexOf(child);
  const j = i + offset;
  return i >= 0 && j >= 0 && j < list.length ? list[j] : undefined;
}

export const getPrevSibling = (child: ChildSignal): ChildSignal | undefined =>
  siblingAtOffset(child, -1);

export const getNextSibling = (child: ChildSignal): ChildSignal | undefined =>
  siblingAtOffset(child, 1);

export function getFirstChild(child: ChildSignal): ChildSignal | undefined {
  const n = child.peek();
  if (!isBlock(n)) return undefined;
  return n.values.length ? n.values[0]![1] : n.items[0];
}

/* Mutations */

function withLocatedChild(
  child: ChildSignal,
  fn: (ctx: {
    parentSignal: WriteSignal<BlockNode>;
    parentBlock: BlockNode;
    loc: ChildLoc;
  }) => BlockNode | void
): void {
  const parentSignal = getParent(child);
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

function nextFocusForRemoval(child: ChildSignal): ChildSignal {
  const parent = getParent(child);
  if (!parent) return child;
  const list = listChildrenInOrder(parent.peek());
  const i = list.indexOf(child);
  const prev = i > 0 ? list[i - 1]! : null;
  const next = i >= 0 && i + 1 < list.length ? list[i + 1]! : null;
  return prev ?? next ?? (parent as unknown as ChildSignal);
}

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
  withLocatedChild(child, ({ parentSignal, parentBlock, loc }) => {
    const wrapper = createSignal(createBlock([], [child]));
    getParentSignal(wrapper).value = parentSignal;
    getParentSignal(child).value = wrapper;
    return replaceChildAt(parentBlock, loc, wrapper);
  });
  return child;
}

export function unwrapBlockIfSingleChild(child: ChildSignal): ChildSignal {
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

/* Blocks */

export function blockChildNodes(n: BlockNode): DataNode[] {
  return [
    ...n.values.map(([, vs]) => childToData(vs)),
    ...n.items.map(childToData),
  ];
}

type BlockEntry =
  | { kind: "value"; child: ChildSignal; id: string; index: number }
  | { kind: "item"; child: ChildSignal; id: number; index: number };

function blockEntries(src: BlockNode): BlockEntry[] {
  const vals = src.values.map<BlockEntry>(([key, child], i) => ({
    kind: "value",
    child,
    id: key,
    index: i,
  }));
  const items = src.items.map<BlockEntry>((child, j) => ({
    kind: "item",
    child,
    id: j + 1,
    index: src.values.length + j,
  }));
  return [...vals, ...items];
}

function sortRank(n: DataNode): [number, any] {
  // numbers < text < true < other < blank
  if (isBlank(n)) return [4, null];
  if (isLiteral(n)) {
    const v = n.value;
    if (typeof v === "number") return [0, v];
    if (typeof v === "string") return [1, v];
    if (v === true) return [2, 1];
  }
  return [3, null];
}
const collator = new Intl.Collator(undefined, { sensitivity: "base" });
function sortCmp<T extends { key: DataNode; index: number }>(
  a: T,
  b: T
): number {
  const [ra, va] = sortRank(a.key);
  const [rb, vb] = sortRank(b.key);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const d = (va as number) - (vb as number);
    if (d) return d;
  } else if (ra === 1) {
    const d = collator.compare(va as string, vb as string);
    if (d) return d;
  }
  return a.index - b.index;
}

export function blockMap(
  src: BlockNode,
  f: (value: DataSignal, id: DataSignal) => DataSignal
): BlockNode {
  const vals: [string, ChildSignal][] = [];
  const items: ChildSignal[] = [];

  for (const e of blockEntries(src)) {
    const out = createComputed(() =>
      f(
        createSignal(childToData(e.child)),
        createSignal(createLiteral(e.id))
      ).get()
    );
    e.kind === "value" ? vals.push([e.id as string, out]) : items.push(out);
  }
  return createBlock(vals, items);
}

export function blockFilter(
  src: BlockNode,
  pred: (value: DataSignal, id: DataSignal) => boolean
): BlockNode {
  const vals: [string, ChildSignal][] = [];
  const items: ChildSignal[] = [];

  for (const e of blockEntries(src)) {
    if (
      pred(
        createSignal(childToData(e.child)),
        createSignal(createLiteral(e.id))
      )
    ) {
      e.kind === "value"
        ? vals.push([e.id as string, e.child])
        : items.push(e.child);
    }
  }
  return createBlock(vals, items);
}

export function blockReduce(
  src: BlockNode,
  rf: (acc: DataSignal, value: DataSignal, id: DataSignal) => DataSignal,
  init?: DataSignal
): DataSignal {
  const seq = blockEntries(src);
  if (seq.length === 0) return init ?? createSignal(createBlank());

  const reducer = (acc: DataSignal, e: BlockEntry) =>
    rf(
      acc,
      createSignal(childToData(e.child)),
      createSignal(createLiteral(e.id))
    );

  if (init && !isBlank(init.get())) return seq.reduce(reducer, init);
  const first = createSignal(childToData(seq[0]!.child));
  return seq.slice(1).reduce(reducer, first);
}

export function blockSort(
  src: BlockNode,
  keySelector: null | ((value: DataSignal, id: DataSignal) => DataSignal)
): BlockNode {
  const selectKey = (child: ChildSignal, id: string | number): DataNode => {
    if (!keySelector) return childToData(child);
    return keySelector(
      createSignal(childToData(child)),
      createSignal(createLiteral(id))
    ).get();
  };

  const sortedValues = src.values
    .map(([id, child], index) => ({
      id,
      child,
      index,
      key: selectKey(child, id),
    }))
    .sort(sortCmp)
    .map(({ id, child }) => [id, child] as [string, ChildSignal]);

  const sortedItems = src.items
    .map((child, index) => ({
      child,
      index,
      key: selectKey(child, index + 1),
    }))
    .sort(sortCmp)
    .map(({ child }) => child);

  return createBlock(sortedValues, sortedItems);
}

function blockNumbersOpt(n: BlockNode): number[] {
  const out: number[] = [];
  for (const node of blockChildNodes(n)) {
    if (isBlank(node)) continue;
    if (isLiteral(node) && typeof node.value === "number") out.push(node.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

export function reduceNumbers(
  source: BlockNode,
  op: (nums: number[]) => number | null
): number | null {
  const nums = blockNumbersOpt(source);
  return nums.length ? op(nums) : null;
}

export function blockTextsOpt(n: BlockNode): string[] {
  const out: string[] = [];
  for (const node of blockChildNodes(n)) {
    if (isBlank(node)) continue;
    if (isLiteral(node) && typeof node.value === "string") out.push(node.value);
    else throw new TypeError(ERR.textOrBlank);
  }
  return out;
}
