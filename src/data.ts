import {
  type Signal as PSignal,
  type ReadonlySignal as PReadonlySignal,
  signal,
  computed,
  batch,
} from "@preact/signals-core";

/* Errors */

export const ERR = {
  flag: "Expected flag (true or blank)",
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
  nameOnNonList: (name: string) =>
    `Cannot access name '${name}' of non-list value`,
  unknownName: (name: string) => `Unknown name '${name}'`,

  unboundIdentifier: (name: string) => `Unbound identifier: ${name}`,
  templateParameter: (name: string) => `Template parameter: ${name}`,
  cannotResolveFunctionValue: "Cannot statically resolve a function value",
} as const;

/* Types */

export type ScalarPrimitive = true | number | string;

export type ErrorValue = {
  kind: "error";
  message: string;
};

export type BlankValue = { kind: "blank" };

export type ScalarValue = {
  kind: "scalar";
  value: ScalarPrimitive;
};

export type ListValue = {
  kind: "list";
  cells: Cell[];
  valueCellUid?: number;
};

export type StructuralValue = BlankValue | ScalarValue | ListValue;

export type FunctionValue = {
  kind: "function";
  fn: (...args: ValueSignal[]) => ValueSignal;
};

export type DataValue = StructuralValue | FunctionValue;

export type Value = DataValue | ErrorValue;

export type FlowValue = {
  kind: "flow";
  code: string;
  result: ReadSignal<Value>;
};

export type LinkValue = {
  kind: "link";
  source: string;
  filter: string;
  result: ReadSignal<Value>;
};

export type TemplateValue<
  Body extends DataValue | FlowValue | LinkValue =
    | DataValue
    | FlowValue
    | LinkValue
> = {
  kind: "template";
  params: string[];
  body: Body;
};

export type EvalValue = FlowValue | LinkValue | TemplateValue;

type ReadSignal<T> = {
  kind: "signal";
  get(): T;
  peek(): T;
};

export type WriteSignal<T> = ReadSignal<T> & {
  set(next: T): void;
};

export type Signal<T> = ReadSignal<T> | WriteSignal<T>;

export type ValueSignal<T extends Value = Value> = Signal<T>;

export type CellValueSignal =
  | ReadSignal<Value>
  | WriteSignal<DataValue | EvalValue>;

export type Cell = {
  uid: number;
  name: Signal<string>;
  view: Signal<string>;
  value: CellValueSignal;
};

export type StaticError = { kind: "error"; message: string };

export type StaticCell = {
  name?: string;
  view?: string;
  value: StaticValue;
};

export type StaticListValue = {
  kind: "list";
  cells: StaticCell[];
};

export type StaticValue =
  | StaticError
  | BlankValue
  | ScalarPrimitive
  | StaticListValue;

/* Guards */

function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export const isError = (v: unknown): v is ErrorValue => hasKind(v, "error");
export const isBlank = (v: unknown): v is BlankValue => hasKind(v, "blank");
export const isScalar = (v: unknown): v is ScalarValue => hasKind(v, "scalar");
export const isList = (v: unknown): v is ListValue => hasKind(v, "list");
export const isFunction = (v: unknown): v is FunctionValue =>
  hasKind(v, "function");
export const isValue = (v: unknown): v is Value =>
  isError(v) || isBlank(v) || isScalar(v) || isList(v) || isFunction(v);
export const isFlow = (v: unknown): v is FlowValue => hasKind(v, "flow");
export const isLink = (v: unknown): v is LinkValue => hasKind(v, "link");
export const isTemplate = (v: unknown): v is TemplateValue =>
  hasKind(v, "template");
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

type ParentSig = PSignal<
  WriteSignal<ListValue | TemplateValue<ListValue>> | undefined
>;
const parentMap = new WeakMap<CellValueSignal, ParentSig>();

export function getParentSignal(sig: CellValueSignal): ParentSig {
  let p = parentMap.get(sig);
  if (!p) {
    p = signal(undefined);
    parentMap.set(sig, p);
  }
  return p;
}

export function getParent(
  value: CellValueSignal
): WriteSignal<ListValue | TemplateValue<ListValue>> | undefined {
  return getParentSignal(value).peek();
}

/* Lists */

function listCellSignals(src: ListValue): {
  cell: Cell;
  indexSig: ValueSignal;
  nameSig: ValueSignal;
  valSig: ValueSignal;
}[] {
  return src.cells.map((c, i) => {
    const indexSig = createSignal(createScalar(i + 1));
    const nameSig = createComputed(() => {
      const n = c.name.get();
      return n ? createScalar(n) : createBlank();
    });
    const valSig = createComputed(() => evalValue(c.value));
    return { cell: c, indexSig, nameSig, valSig };
  });
}

export function listMap(
  src: ListValue,
  f: (value: ValueSignal, index: ValueSignal, name: ValueSignal) => ValueSignal
): ListValue {
  return createList(
    listCellSignals(src).map(({ cell, indexSig, nameSig, valSig }) => ({
      uid: newUid(),
      name: cell.name,
      value: createComputed(() => {
        try {
          return f(valSig, indexSig, nameSig).get();
        } catch (err) {
          return createError(err instanceof Error ? err.message : String(err));
        }
      }),
    }))
  );
}

export function listFilter(
  src: ListValue,
  pred: (
    value: ValueSignal,
    index: ValueSignal,
    name: ValueSignal
  ) => ValueSignal
): ListValue {
  return createList(
    listCellSignals(src)
      .filter(({ valSig, indexSig, nameSig }) =>
        isTruthy(pred(valSig, indexSig, nameSig).get())
      )
      .map(({ cell }) => cell),
    src.valueCellUid
  );
}

export function listReduce(
  src: ListValue,
  rf: (
    acc: ValueSignal,
    value: ValueSignal,
    index: ValueSignal,
    name: ValueSignal
  ) => ValueSignal,
  init: ValueSignal
): ValueSignal {
  const seq = listCellSignals(src);
  if (seq.length === 0) return init;

  const step = (acc: ValueSignal, e: (typeof seq)[number]) =>
    rf(acc, e.valSig, e.indexSig, e.nameSig);

  if (!isBlank(init.get())) {
    return seq.reduce(step, init);
  }

  const first = createSignal(evalValue(src.cells[0]!.value));
  return seq.slice(1).reduce(step, first);
}

function sortRank(v: Value): [number, any] {
  // numbers < text < true < other < blank
  if (isBlank(v)) return [4, null];
  if (isScalar(v)) {
    const lit = v.value;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function sortCmp<T extends { sortKey: Value; index: number }>(
  a: T,
  b: T
): number {
  const [ra, va] = sortRank(a.sortKey);
  const [rb, vb] = sortRank(b.sortKey);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const d = va - vb;
    if (d) return d;
  } else if (ra === 1) {
    const d = collator.compare(va, vb);
    if (d) return d;
  }
  return a.index - b.index;
}

export function listSort(
  src: ListValue,
  keySelector:
    | null
    | ((
        value: ValueSignal,
        index: ValueSignal,
        name: ValueSignal
      ) => ValueSignal)
): ListValue {
  const rows = listCellSignals(src).map(
    ({ cell, indexSig, nameSig, valSig }, i) => ({
      uid: cell.uid,
      name: cell.name,
      view: cell.view,
      value: cell.value,
      index: i,
      sortKey: keySelector
        ? keySelector(valSig, indexSig, nameSig).get()
        : evalValue(cell.value),
    })
  );

  rows.sort(sortCmp);
  return createList(rows, src.valueCellUid);
}

/* Constructors */

let nextCellUid = 1;
export function newUid() {
  return nextCellUid++;
}

export const createError = (message: string): ErrorValue => ({
  kind: "error",
  message,
});

export const createBlank = (): BlankValue => ({ kind: "blank" });

export const createScalar = (value: ScalarPrimitive): ScalarValue => ({
  kind: "scalar",
  value,
});

export function createList(
  cells: {
    uid?: number;
    name?: string | Signal<string>;
    view?: string | Signal<string>;
    value: CellValueSignal;
  }[] = [],
  valueCellUid?: number
): ListValue {
  const outCells = cells.map((c) => {
    let nameSig: Signal<string>;
    if (isSignal(c.name)) {
      nameSig = c.name;
    } else {
      nameSig = createSignal<string>(c.name ?? "");
    }

    let viewSig: Signal<string>;
    if (isSignal(c.view)) {
      viewSig = c.view;
    } else {
      viewSig = createSignal<string>(c.view ?? "");
    }

    return {
      uid: c.uid ?? newUid(),
      name: nameSig,
      view: viewSig,
      value: c.value,
    };
  });
  return {
    kind: "list",
    cells: outCells,
    valueCellUid: outCells.find((c) => c.uid === valueCellUid)?.uid,
  };
}

export const createFunction = (
  fn: (...args: ValueSignal[]) => ValueSignal
): FunctionValue => ({ kind: "function", fn });

function flowComputed(
  owner: CellValueSignal,
  code: string,
  params?: ScopeParams
): ReadSignal<Value> {
  return createComputed<Value>(() => {
    try {
      return evalCode(code, (name: string) =>
        lookupInScope(name, owner, params)
      );
    } catch (err) {
      return createError(err instanceof Error ? err.message : String(err));
    }
  });
}

export function createFlow(owner: CellValueSignal, code: string): FlowValue {
  return { kind: "flow", code, result: flowComputed(owner, code) };
}

export function createLink(
  owner: CellValueSignal,
  source: string,
  filter: string
): LinkValue {
  const result = createComputed<Value>(() => {
    try {
      if (!source.trim()) return createBlank();

      const target = lookupInScope(source, owner).get();
      if (!isList(target)) throw new TypeError(ERR.list);

      const code = filter.trim();
      if (!code) return createList(target.cells, target.valueCellUid);

      const pred = evalCode(code, (n: string) => lookupInScope(n, owner));
      if (!isFunction(pred)) throw new TypeError(ERR.function);

      return listFilter(target, pred.fn);
    } catch (err) {
      return createError(err instanceof Error ? err.message : String(err));
    }
  });

  return { kind: "link", source, filter, result };
}

export function createTemplate<Body extends DataValue | FlowValue | LinkValue>(
  params: string[],
  body: Body
): TemplateValue<Body> {
  return { kind: "template", params, body };
}

export function createComputed<T>(fn: () => T): ReadSignal<T> {
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
    name?: string | Signal<string>;
    view?: string | Signal<string>;
    value: CellValueSignal;
  }[] = [],
  valueCellUid?: number
): WriteSignal<ListValue> {
  const parent = createSignal(createList([]));

  batch(() => {
    for (const c of cells) {
      getParentSignal(c.value).value = parent;
    }
    parent.set(createList(cells, valueCellUid));
  });

  return parent;
}

export function createTemplateListSignal(
  params: string[],
  cells: {
    uid?: number;
    name?: string | Signal<string>;
    view?: string | Signal<string>;
    value: CellValueSignal;
  }[] = [],
  valueCellUid?: number
): WriteSignal<TemplateValue<ListValue>> {
  const parent = createSignal(createTemplate(params, createList()));

  batch(() => {
    for (const c of cells) {
      getParentSignal(c.value).value = parent;
    }
    parent.set(createTemplate(params, createList(cells, valueCellUid)));
  });

  return parent;
}

/* Flow readonly view */

function asReadOnlySignal<T>(sig: Signal<T>): ReadSignal<T> {
  return { kind: "signal", get: () => sig.get(), peek: () => sig.peek() };
}

function readonlyValue(v: Value, params?: ScopeParams): Value {
  if (isError(v) || isBlank(v) || isScalar(v) || isFunction(v)) return v;
  return createList(
    v.cells.map((c) => ({
      uid: newUid(),
      name: asReadOnlySignal(c.name),
      view: asReadOnlySignal(c.view),
      value: createComputed(() =>
        readonlyValue(evalValue(c.value, params), params)
      ),
    })),
    v.valueCellUid
  );
}

/* Conversions */

export function isTruthy(value: Value): boolean {
  if (isError(value) || isBlank(value)) return false;
  return true;
}

export function toNumber(value: Value): number | null {
  if (isBlank(value)) return null;
  if (isScalar(value)) {
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
  if (isScalar(value)) return String(value.value);
  return null;
}

export function numOpt(value: Value): number | null {
  if (isBlank(value)) return null;
  if (isScalar(value) && typeof value.value === "number") return value.value;
  throw new TypeError(ERR.numOrBlank);
}

export function textOpt(value: Value): string | null {
  if (isBlank(value)) return null;
  if (isScalar(value) && typeof value.value === "string") return value.value;
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

export function flagExpect(value: Value): boolean {
  if (isBlank(value)) return false;
  if (isScalar(value) && value.value === true) return true;
  throw new TypeError(ERR.flag);
}

export function primExpect(value: Value): ScalarPrimitive {
  if (isScalar(value)) return value.value;
  throw new TypeError(ERR.literal);
}

export function numExpect(value: Value): number {
  if (isScalar(value) && typeof value.value === "number") return value.value;
  throw new TypeError(ERR.number);
}

export function primitiveToValue(
  v: boolean | number | string | null
): BlankValue | ScalarValue {
  if (v === null || v === false) return createBlank();
  return createScalar(v);
}

export function size(value: Value): number | null {
  if (isError(value)) return null;
  if (isBlank(value)) return null;
  if (isScalar(value) && typeof value.value === "string")
    return value.value.length;
  if (isList(value)) return value.cells.length;
  throw new TypeError(ERR.textOrList);
}

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalarInput(text: string): DataValue {
  const trimmed = text.trim();
  if (NUM_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return createScalar(n);
  }
  return createScalar(text);
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
  return createList(cells, list.valueCellUid);
}

export function createRangeList(
  start: number | null,
  end: number | null,
  step: number | null = null
): ListValue {
  const indices = computeSliceIndices(start, end, step, null);
  const cells = indices.map((n) => ({
    value: createSignal(createScalar(n)),
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

type ScopeParams = Map<CellValueSignal, Record<string, ValueSignal>>;

function lookupInScope(
  name: string,
  start: CellValueSignal,
  params?: ScopeParams
): ValueSignal {
  let scope = getParentSignal(start).value;
  while (scope) {
    const outer = scope.get();
    const inner = isTemplate(outer) ? outer.body : outer;

    if (isList(inner)) {
      const found = inner.cells.find((c) => c.name.get() === name);
      if (found) return createSignal(evalValue(found.value, params));
    }

    if (isTemplate(outer) && outer.params.includes(name)) {
      const found = params?.get(scope)?.[name];
      if (found) return createSignal(evalValue(found, params));
      throw new Error(ERR.templateParameter(name));
    }

    scope = getParentSignal(scope).value;
  }

  const libSig = __globalLib?.get(name.toLowerCase());
  if (libSig) return createSignal(libSig.get());

  throw new Error(ERR.unboundIdentifier(name));
}

export function evalStructural(
  sig: CellValueSignal,
  params?: ScopeParams
): Value {
  const v = sig.get();
  if (isFlow(v)) {
    const out = params
      ? flowComputed(sig, v.code, params).get()
      : v.result.get();

    return readonlyValue(out, params);
  }

  if (isLink(v)) {
    return v.result.get();
  }

  if (isTemplate(v)) {
    return evalStructural(createSignal(v.body), params);
  }

  return v;
}

export function evalValue(sig: CellValueSignal, params?: ScopeParams): Value {
  const v = sig.get();

  if (isTemplate(v)) {
    return createFunction((...args) =>
      createComputed(() => {
        const nextParams = new Map(params);
        nextParams.set(
          sig,
          Object.fromEntries(
            v.params.map((p, i) => [p, args[i] ?? createSignal(createBlank())])
          )
        );
        return readonlyValue(
          evalValue(createSignal(v.body), nextParams),
          nextParams
        );
      })
    );
  }

  const value = evalStructural(sig, params);
  if (!isList(value) || value.valueCellUid === undefined) return value;

  return evalValue(
    value.cells.find((c) => c.uid === value.valueCellUid)!.value,
    params
  );
}

export function resolveValue(value: Value): StaticValue {
  if (value.kind === "error") return value;

  if (value.kind === "blank") return { kind: "blank" };
  if (value.kind === "scalar") return value.value;

  if (value.kind === "list") {
    if (value.valueCellUid !== undefined) {
      return resolveValue(
        evalValue(value.cells.find((c) => c.uid === value.valueCellUid)!.value)
      );
    }

    const cells: StaticCell[] = value.cells.map((c) => {
      const nm = c.name.get();
      const vw = c.view.get();
      const outName = nm === "" ? undefined : nm;
      const outView = vw === "" ? undefined : vw;
      try {
        return {
          name: outName,
          view: outView,
          value: resolveValue(evalValue(c.value)),
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

function softWrap<T>(required: boolean, fn: () => T): T | BlankValue {
  if (required) return fn();
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

export function getByName(list: Value, name: string, required = false): Value {
  return softWrap(required, () => {
    if (!isList(list)) throw new TypeError(ERR.nameOnNonList(name));
    const cell = list.cells.find((v) => v.name.get() === name);
    if (!cell) throw new ReferenceError(ERR.unknownName(name));
    return evalValue(cell.value);
  });
}

export function getByIndex(
  list: Value,
  index1: number,
  required = false
): Value {
  return softWrap(required, () => {
    if (!Number.isFinite(index1)) throw new TypeError(ERR.indexFinite);
    const idx0 = Math.trunc(index1) - 1;
    if (idx0 < 0) throw new RangeError(ERR.indexOneBased);
    if (!isList(list)) throw new TypeError(ERR.indexNonList);
    const cell = list.cells[idx0];
    if (!cell)
      throw new RangeError(ERR.indexOutOfRange(index1, list.cells.length));
    return evalValue(cell.value);
  });
}

export function getByIndexOrName(
  list: Value,
  value: Value,
  required = false
): Value {
  return softWrap(required, () => {
    if (!isList(list)) throw new TypeError(ERR.indexNonList);
    if (isScalar(value)) {
      const lit = value.value;
      if (typeof lit === "number") return getByIndex(list, lit, required);
      if (typeof lit === "string") return getByName(list, lit, required);
    }
    throw new TypeError(ERR.indexNameMustBeTextOrNumber);
  });
}

/* Projections */

export type NavLayoutContext = "default" | "table-cell" | "bar-child";

export function getLayoutContext(
  parentCell?: Cell,
  grandparentCell?: Cell
): NavLayoutContext {
  const parentView = parentCell?.view.peek() ?? "";
  const grandparentView = grandparentCell?.view.peek() ?? "";

  return grandparentView === "table"
    ? "table-cell"
    : parentView === "bar"
    ? "bar-child"
    : "default";
}

export type RenderScalar = {
  kind: "scalar";
  text: string;
  number?: number;
  isError: boolean;
  editable: boolean;
};

export type RenderModel = RenderScalar | ListValue;

export function getRenderModel(
  sig: CellValueSignal,
  params?: ScopeParams
): RenderModel {
  const v = evalStructural(sig, params);

  if (isList(v)) return v;

  const stored = sig.get();
  const bodyEditable =
    isWritableSignal(sig) &&
    !isFlow(stored) &&
    !isLink(stored) &&
    !isTemplate(stored);

  if (isError(v)) {
    return {
      kind: "scalar",
      text: v.message,
      isError: true,
      editable: bodyEditable,
    };
  }

  if (isBlank(v)) {
    return {
      kind: "scalar",
      text: "",
      isError: false,
      editable: bodyEditable,
    };
  }

  if (isScalar(v)) {
    return {
      kind: "scalar",
      text: String(v.value),
      isError: false,
      editable: bodyEditable,
      number: typeof v.value === "number" ? v.value : undefined,
    };
  }

  if (isFunction(v)) {
    return {
      kind: "scalar",
      text: "[function]",
      isError: false,
      editable: false,
    };
  }

  return {
    kind: "scalar",
    text: "[unknown]",
    isError: false,
    editable: false,
  };
}

export function getRenderChildren(
  sig: CellValueSignal,
  params?: ScopeParams
): Cell[] {
  const v = evalStructural(sig, params);
  return isList(v) ? v.cells : [];
}

export type EditorFieldMode = "body" | "name" | "header" | "header-multi";

export type EditorField = {
  mode: EditorFieldMode;
  label?: string;
  get: PReadonlySignal<string | null>;
  set?: (next: string) => void;
};

export function getRenderEditors(cell: Cell): EditorField[] {
  const childSig = cell.value;
  const fields: EditorField[] = [];

  if (isFlow(childSig.get())) {
    fields.push({
      mode: "header-multi",
      label: "=",
      get: computed(() => {
        const v = childSig.get();
        return isFlow(v) ? v.code : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isFlow(cur) && cur.code !== next) {
              childSig.set(createFlow(childSig, next));
            }
          }
        : undefined,
    });
    return fields;
  }

  if (isLink(childSig.get())) {
    fields.push({
      mode: "header",
      label: "~",
      get: computed(() => {
        const v = childSig.get();
        return isLink(v) ? v.source : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLink(cur) && cur.source !== next) {
              childSig.set(createLink(childSig, next, cur.filter));
            }
          }
        : undefined,
    });

    fields.push({
      mode: "header-multi",
      label: "filter:",
      get: computed(() => {
        const v = childSig.get();
        return isLink(v) ? v.filter : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isLink(cur) && cur.filter !== next) {
              childSig.set(createLink(childSig, cur.source, next));
            }
          }
        : undefined,
    });

    return fields;
  }

  if (isTemplate(childSig.get())) {
    fields.push({
      mode: "header",
      label: "=>",
      get: computed(() => {
        const v = childSig.get();
        return isTemplate(v) ? v.params.join(", ") : null;
      }),
      set: isWritableSignal(childSig)
        ? (next) => {
            const cur = childSig.peek();
            if (isTemplate(cur)) {
              const nextParams = next
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0);

              const same =
                cur.params.length === nextParams.length &&
                cur.params.every((p, i) => p === nextParams[i]);

              if (!same) childSig.set(createTemplate(nextParams, cur.body));
            }
          }
        : undefined,
    });

    return fields;
  }

  return fields;
}

type RenderProps = {
  truthy(name: string): boolean;
  text(name: string): string | null;
  num(name: string): number | null;
  setFlag(name: string, on: boolean): boolean;
};

export function getRenderProps(
  sig: CellValueSignal,
  params?: ScopeParams
): RenderProps | null {
  const v = evalStructural(sig, params);
  if (!isList(v)) return null;

  const byName = new Map<string, Cell>();
  for (const c of v.cells) {
    const n = c.name.get();
    if (n) byName.set(n, c);
  }

  const read = (name: string): Value => {
    const c = byName.get(name);
    return c ? evalStructural(c.value, params) : createBlank();
  };

  return {
    truthy: (name) => isTruthy(read(name)),

    text: (name) => toText(read(name)),

    num: (name) => toNumber(read(name)),

    setFlag(name: string, value: boolean): boolean {
      const c = byName.get(name);
      if (!c || !isWritableSignal(c.value)) return false;
      c.value.set(primitiveToValue(value));
      return true;
    },
  };
}

type ParentEditContext = {
  parent: WriteSignal<ListValue | TemplateValue<ListValue>>;
  before: Cell[];
  index: number;
  valueCellUid?: number;
  params?: string[];
};

type ParentEditResult = {
  after: Cell[];
  valueCellUid?: number;
};

export function editParentList(
  value: CellValueSignal,
  childUid: number,
  fn: (ctx: ParentEditContext) => ParentEditResult
): ParentEditResult | null {
  const parent = getParent(value);
  if (!parent) return null;

  const pv = parent.peek();
  const isTpl = isTemplate(pv);
  const list = isTpl ? pv.body : pv;

  const before = list.cells;
  const index = before.findIndex((c) => c.uid === childUid);
  if (index < 0) return null;

  let result: ParentEditResult | null = null;

  batch(() => {
    const edit = fn({
      parent,
      before,
      index,
      valueCellUid: list.valueCellUid,
      params: isTpl ? pv.params : undefined,
    });

    const valueCellUid = edit.valueCellUid ?? list.valueCellUid;
    const nextList = createList(edit.after, valueCellUid);

    parent.set(isTpl ? createTemplate(pv.params, nextList) : nextList);
    result = { after: edit.after, valueCellUid: edit.valueCellUid };
  });

  return result;
}
