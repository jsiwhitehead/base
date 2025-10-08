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

export type ValueEntry = { uid: number; key: string; child: ChildSignal };
export type ItemEntry = { uid: number; child: ChildSignal };

export type BlockNode = {
  kind: "block";
  values: ValueEntry[];
  items: ItemEntry[];
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
  result: ReadSignal<DataNode>;
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
  values: Record<string, StaticNode>;
  items: StaticNode[];
};

export type StaticNode = StaticError | BlankNode | Primitive | StaticBlock;

/* Guards */

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

export function getParentSignal(sig: ChildSignal): ParentSig {
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

/* Constructors */

let __nextEntryUid = 1;
export function newUid() {
  return __nextEntryUid++;
}

export const createBlank = (): BlankNode => ({ kind: "blank" });

export const createLiteral = (value: Primitive): LiteralNode => ({
  kind: "literal",
  value,
});

export function createBlock(
  values: [string, ChildSignal][] | Record<string, ChildSignal> = [],
  items: ChildSignal[] = []
): BlockNode {
  const valueEntries = Array.isArray(values) ? values : Object.entries(values);
  return {
    kind: "block",
    values: valueEntries.map(([key, child]) => ({ uid: newUid(), key, child })),
    items: items.map((child) => ({ uid: newUid(), child })),
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

export function createCodeSignal(initialCode: string): WriteSignal<CodeNode> {
  const codeText = signal(initialCode);
  let codeSig!: WriteSignal<CodeNode>;

  const result = createComputed(() =>
    evalCode(codeText.value, (name: string) => lookupInScope(name, codeSig))
  );

  codeSig = {
    kind: "signal",
    get: () => ({ kind: "code", code: codeText.value, result }),
    peek: () => ({ kind: "code", code: codeText.peek(), result }),
    set: (next) => {
      codeText.value = next.code;
    },
  };

  return codeSig;
}

export function createComputed<T extends DataNode>(fn: () => T): ReadSignal<T> {
  const rsig: PReadonlySignal<T> = computed(fn);
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
  const valuesCount = Array.isArray(b.values)
    ? b.values.length
    : Object.keys(b.values).length;
  return valuesCount > 0 || b.items.length > 0;
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
  const newItems = indices.map((oneBased) => block.items[oneBased - 1]!.child);
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

let __globalLib: Map<string, DataSignal> | null = null;
export function setGlobalLibrary(entries: Record<string, DataSignal>) {
  __globalLib = new Map(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v])
  );
}

function lookupInScope(name: string, start: ChildSignal): DataSignal {
  let scope = getParentSignal(start).value;
  while (scope) {
    const { values } = scope.get();
    const found = values.find((v) => v.key === name);
    if (found) return createSignal(childToData(found.child));
    scope = getParentSignal(scope).value;
  }

  if (__globalLib) {
    const libSig = __globalLib.get(name.toLowerCase());
    if (libSig) return createSignal(libSig.get());
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
    return v.result.get();
  }

  return v;
}

export function resolveData(n: DataNode): StaticNode {
  if (n.kind === "blank") return { kind: "blank" };
  if (n.kind === "literal") return n.value;

  if (n.kind === "block") {
    const values: Record<string, StaticNode> = {};
    for (const ve of n.values) {
      try {
        values[ve.key] = resolveData(childToData(ve.child));
      } catch (err) {
        values[ve.key] = toStaticError(err);
      }
    }
    const items: StaticNode[] = n.items.map((ie) => {
      try {
        return resolveData(childToData(ie.child));
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

export function getByKey(block: BlockNode, key: string): DataNode {
  if (!isBlock(block)) {
    throw new TypeError(ERR.propOnNonBlock(key));
  }
  const pair = block.values.find((v) => v.key === key);
  if (!pair) throw new ReferenceError(ERR.unknownProperty(key));
  return childToData(pair.child);
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
  const entry = block.items[idx0];
  if (!entry) {
    throw new RangeError(ERR.indexOutOfRange(index1, block.items.length));
  }
  return childToData(entry.child);
}

export function getByKeyOrIndex(block: BlockNode, value: DataNode): DataNode {
  if (isLiteral(value)) {
    const lit = value.value;
    if (typeof lit === "number") return getByIndex(block, lit);
    if (typeof lit === "string") return getByKey(block, lit);
  }
  throw new TypeError(ERR.indexKeyMustBeTextOrNumber);
}
