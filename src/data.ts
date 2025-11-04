import {
  type Signal as PSignal,
  type ReadonlySignal as PReadonlySignal,
  signal,
  computed,
  batch,
} from "@preact/signals-core";

/* Errors */

export const ERR = {
  boolean: "Expected condition (true or blank)",
  literal: "Expected literal value",
  number: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  textOrList: "Expected text or list",
  list: "Expected list",
  function: "Expected function",
  funcOrBlank: "Expected function or blank",

  sliceStepZero: "Slice step cannot be 0",

  indexFinite: "Index must be a finite number",
  indexOneBased: "Index must be 1 or greater",
  indexNonList: "Cannot index into a non-list value",
  indexOutOfRange: (index: number, len: number) =>
    `Index ${index} is out of range (length ${len})`,
  indexNameMustBeTextOrNumber: "Index/name must evaluate to text or number",
  propOnNonList: (prop: string) =>
    `Cannot access property '${prop}' of non-list value`,
  unknownProperty: (prop: string) => `Unknown property '${prop}'`,

  unboundIdentifier: (name: string) => `Unbound identifier: ${name}`,
  cannotResolveFunctionValue: "Cannot statically resolve a function value",
} as const;

/* Types */

export type Primitive = true | number | string;

export type ErrorValue = {
  kind: "error";
  message: string;
};

export type BlankValue = { kind: "blank" };

export type LiteralValue = {
  kind: "literal";
  value: Primitive;
};

export type ListValue = {
  kind: "list";
  cells: Cell[];
};

export type RenderValue = ErrorValue | BlankValue | LiteralValue | ListValue;

export type FunctionValue = {
  kind: "function";
  fn: (...args: ValueSignal[]) => ValueSignal;
};

export type Value = RenderValue | FunctionValue;

export type FlowValue = {
  kind: "flow";
  code: string;
  result: ReadSignal<Value>;
};

export type EvalValue = FlowValue;

type ReadSignal<T> = {
  kind: "signal";
  get(): T;
  peek(): T;
};

export type WriteSignal<T> = ReadSignal<T> & {
  set(next: T): void;
};

export type ValueSignal<T extends Value = Value> =
  | ReadSignal<T>
  | WriteSignal<T>;

export type ChildSignal = ReadSignal<Value> | WriteSignal<Value | EvalValue>;

export type Cell = {
  uid: number;
  name: WriteSignal<string>;
  view: WriteSignal<string>;
  child: ChildSignal;
};

export type StaticError = { kind: "error"; message: string };

export type StaticCell = {
  name?: string;
  view?: string; // omitted when ""
  value: StaticValue;
};

export type StaticListValue = {
  kind: "list";
  cells: StaticCell[];
};

export type StaticValue =
  | StaticError
  | BlankValue
  | Primitive
  | StaticListValue;

/* Guards */

function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export const isError = (v: unknown): v is ErrorValue => hasKind(v, "error");
export const isBlank = (v: unknown): v is BlankValue => hasKind(v, "blank");
export const isLiteral = (v: unknown): v is LiteralValue =>
  hasKind(v, "literal");
export const isList = (v: unknown): v is ListValue => hasKind(v, "list");
export const isFunction = (v: unknown): v is FunctionValue =>
  hasKind(v, "function");
export const isValue = (v: unknown): v is Value =>
  isError(v) || isBlank(v) || isLiteral(v) || isList(v) || isFunction(v);
export const isFlow = (v: unknown): v is FlowValue => hasKind(v, "flow");
export const isSignal = (
  v: unknown
): v is ReadSignal<unknown> | WriteSignal<unknown> => hasKind(v, "signal");
export const isWritableSignal = (v: unknown): v is WriteSignal<unknown> =>
  isSignal(v) && typeof (v as any).set === "function";
export const isStaticError = (v: unknown): v is StaticError =>
  hasKind(v, "error");
export const isStaticList = (v: unknown): v is StaticListValue =>
  hasKind(v, "list");

/* Parents */

type ParentSig = PSignal<WriteSignal<ListValue> | undefined>;
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
): WriteSignal<ListValue> | undefined {
  return getParentSignal(child).peek();
}

/* Constructors */

let __nextCellUid = 1;
export function newUid() {
  return __nextCellUid++;
}

export const createError = (message: string): ErrorValue => ({
  kind: "error",
  message,
});

export const createBlank = (): BlankValue => ({ kind: "blank" });

export const createLiteral = (value: Primitive): LiteralValue => ({
  kind: "literal",
  value,
});

export function createList(
  cells: {
    uid?: number;
    name?: string | WriteSignal<string>;
    view?: string | WriteSignal<string>;
    child: ChildSignal;
  }[] = []
): ListValue {
  return {
    kind: "list",
    cells: cells.map((c) => {
      let nameSig: WriteSignal<string>;
      if (isSignal(c.name)) {
        nameSig = c.name;
      } else {
        nameSig = createSignal<string>(c.name ?? "");
      }

      let viewSig: WriteSignal<string>;
      if (isSignal(c.view)) {
        viewSig = c.view;
      } else {
        viewSig = createSignal<string>(c.view ?? "");
      }

      return {
        uid: c.uid ?? newUid(),
        name: nameSig,
        view: viewSig,
        child: c.child,
      };
    }),
  };
}

export const createFunction = (
  fn: (...args: ValueSignal[]) => ValueSignal
): FunctionValue => ({ kind: "function", fn });

export function createFlow(owner: ChildSignal, code: string): FlowValue {
  const result = createComputed<Value>(() => {
    try {
      return evalCode(code, (name: string) => lookupInScope(name, owner));
    } catch (err) {
      return createError(err instanceof Error ? err.message : String(err));
    }
  });
  return { kind: "flow", code, result };
}

export function createComputed<T extends Value>(fn: () => T): ReadSignal<T> {
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

export function createListSignal(
  cells: {
    uid?: number;
    name?: string | WriteSignal<string>;
    view?: string | WriteSignal<string>;
    child: ChildSignal;
  }[] = []
): ValueSignal<ListValue> {
  const parent = createSignal(createList([]));

  batch(() => {
    for (const c of cells) {
      getParentSignal(c.child).value = parent;
    }
    parent.set(createList(cells));
  });

  return parent;
}

/* Conversions */

export function toBool(value: Value): boolean | null {
  if (isError(value) || isBlank(value)) return false;
  return true;
}

export function toNumber(value: Value): number | null {
  if (isBlank(value)) return null;
  if (isLiteral(value)) {
    const v = value.value;
    if (typeof v === "number") return v;
    if (v === true) return 1;
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }
  return null;
}

export function toText(value: Value): string | null {
  if (isError(value)) return value.message;
  if (isBlank(value)) return null;
  if (isLiteral(value)) return String(value.value);
  return null;
}

export function numOpt(value: Value): number | null {
  if (isBlank(value)) return null;
  if (isLiteral(value) && typeof value.value === "number") return value.value;
  throw new TypeError(ERR.numOrBlank);
}

export function textOpt(value: Value): string | null {
  if (isBlank(value)) return null;
  if (isLiteral(value) && typeof value.value === "string") return value.value;
  throw new TypeError(ERR.textOrBlank);
}

export function listOpt(value: Value): ListValue | null {
  if (isBlank(value)) return null;
  if (isList(value)) return value;
  throw new TypeError(ERR.list);
}

export function fnOpt(value: Value): FunctionValue | null {
  if (isBlank(value)) return null;
  if (isFunction(value)) return value as FunctionValue;
  throw new TypeError(ERR.function);
}

export function boolExpect(value: Value): boolean {
  if (isBlank(value)) return false;
  if (isLiteral(value) && value.value === true) return true;
  throw new TypeError(ERR.boolean);
}

export function primExpect(value: Value): Primitive {
  if (isLiteral(value)) return value.value;
  throw new TypeError(ERR.literal);
}

export function numExpect(value: Value): number {
  if (isLiteral(value) && typeof value.value === "number") return value.value;
  throw new TypeError(ERR.number);
}

export function scalarToValue(
  v: boolean | number | string | null
): BlankValue | LiteralValue {
  if (v === null || v === false) return createBlank();
  return createLiteral(v);
}

export function size(value: Value): number | null {
  if (isError(value)) return null;
  if (isBlank(value)) return null;
  if (isLiteral(value) && typeof value.value === "string")
    return value.value.length;
  if (isList(value)) return value.cells.length;
  throw new TypeError(ERR.textOrList);
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

export function sliceList(
  list: ListValue,
  start: number | null,
  end: number | null,
  step: number | null
): ListValue {
  const indices = computeSliceIndices(start, end, step, list.cells.length);
  const cells = indices.map((oneBased) => list.cells[oneBased - 1]!);
  return createList(cells);
}

export function createRangeList(
  start: number | null,
  end: number | null,
  step: number | null = null
): ListValue {
  const indices = computeSliceIndices(start, end, step, null);
  const cells = indices.map((n) => ({
    child: createSignal(createLiteral(n)),
  }));
  return createList(cells);
}

/* Evaluation */

const evalCode: (code: string, scope: (name: string) => ValueSignal) => Value =
  require("./code").evalCode;

function toStaticError(err: unknown): StaticError {
  return {
    kind: "error",
    message: err instanceof Error ? err.message : String(err),
  };
}

let __globalLib: Map<string, ValueSignal> | null = null;
export function setGlobalLibrary(entries: Record<string, ValueSignal>) {
  __globalLib = new Map(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v])
  );
}

function lookupInScope(name: string, start: ChildSignal): ValueSignal {
  let scope = getParentSignal(start).value;
  while (scope) {
    const { cells } = scope.get();
    const found = cells.find((v) => v.name.get() === name);
    if (found) return createSignal(childToValue(found.child));
    scope = getParentSignal(scope).value;
  }

  if (__globalLib) {
    const libSig = __globalLib.get(name.toLowerCase());
    if (libSig) return createSignal(libSig.get());
  }

  throw new Error(ERR.unboundIdentifier(name));
}

export function childToValue(sig: ChildSignal): Value {
  const v = sig.get();

  if (isFlow(v)) {
    return v.result.get();
  }

  return v;
}

export function resolveValue(value: Value): StaticValue {
  if (value.kind === "error") return value;

  if (value.kind === "blank") return { kind: "blank" };
  if (value.kind === "literal") return value.value;

  if (value.kind === "list") {
    const cells: StaticCell[] = value.cells.map((c) => {
      const nm = c.name.get();
      const vw = c.view.get();
      const outName = nm === "" ? undefined : nm;
      const outView = vw === "" ? undefined : vw;
      try {
        return {
          name: outName,
          view: outView,
          value: resolveValue(childToValue(c.child)),
        };
      } catch (err) {
        return {
          name: outName,
          view: outView,
          value: toStaticError(err),
        };
      }
    });
    return { kind: "list", cells };
  }

  return {
    kind: "error",
    message: ERR.cannotResolveFunctionValue,
  };
}

/* Getters */

function softWrap<T>(strict: boolean, fn: () => T): T | BlankValue {
  if (strict) return fn();
  try {
    return fn();
  } catch (err) {
    if (
      err instanceof TypeError ||
      err instanceof RangeError ||
      err instanceof ReferenceError
    ) {
      return createBlank();
    }
    throw err;
  }
}

export function getByName(list: Value, name: string, strict = false): Value {
  return softWrap(strict, () => {
    if (!isList(list)) throw new TypeError(ERR.propOnNonList(name));
    const cell = list.cells.find((v) => v.name.get() === name);
    if (!cell) throw new ReferenceError(ERR.unknownProperty(name));
    return childToValue(cell.child);
  });
}

export function getByIndex(list: Value, index1: number, strict = false): Value {
  return softWrap(strict, () => {
    if (!Number.isFinite(index1)) throw new TypeError(ERR.indexFinite);
    const idx0 = Math.trunc(index1) - 1;
    if (idx0 < 0) throw new RangeError(ERR.indexOneBased);
    if (!isList(list)) throw new TypeError(ERR.indexNonList);
    const cell = list.cells[idx0];
    if (!cell)
      throw new RangeError(ERR.indexOutOfRange(index1, list.cells.length));
    return childToValue(cell.child);
  });
}

export function getByIndexOrName(
  list: Value,
  value: Value,
  strict = false
): Value {
  return softWrap(strict, () => {
    if (!isList(list)) throw new TypeError(ERR.indexNonList);
    if (isLiteral(value)) {
      const lit = value.value;
      if (typeof lit === "number") return getByIndex(list, lit, strict);
      if (typeof lit === "string") return getByName(list, lit, strict);
    }
    throw new TypeError(ERR.indexNameMustBeTextOrNumber);
  });
}
