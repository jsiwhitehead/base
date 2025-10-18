import {
  ERR,
  type Value,
  type ListValue,
  type FunctionValue,
  type ValueSignal,
  isBlank,
  isList,
  isFunction,
  createBlank,
  createLiteral,
  createList,
  createFunction,
  createSignal,
  toBool,
  toNumber,
  toText,
  numOpt,
  textOpt,
  listOpt,
  fnOpt,
  boolExpect,
  scalarToValue,
  childToValue,
} from "./data";
import {
  iterCells,
  listMap,
  listFilter,
  listReduce,
  listSort,
  listNumbersOpt,
  listTextsOpt,
} from "./tree";

function valueFn(op: (...values: Value[]) => Value): ValueSignal {
  return createSignal(
    createFunction((...args: (ValueSignal | undefined)[]) => {
      const values = Array.from({ length: op.length }, (_, i) =>
        args[i] ? args[i]!.get() : createBlank()
      );
      return createSignal(op(...values));
    })
  );
}

type ArgSpec<T> =
  | { kind: "req"; convert: (value: Value) => T | null }
  | { kind: "opt"; convert: (value: Value) => T | null; fallback: T };

const reqNum = { kind: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ kind: "opt", convert: numOpt, fallback: d } as const);

const reqText = { kind: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ kind: "opt", convert: textOpt, fallback: d } as const);

const reqList = { kind: "req", convert: listOpt } as const;
const optList = (d: ListValue) =>
  ({ kind: "opt", convert: listOpt, fallback: d } as const);

const reqFn = { kind: "req", convert: fnOpt } as const;
const optFn = <F extends FunctionValue | null>(d: F) =>
  ({ kind: "opt", convert: fnOpt, fallback: d } as const);

function typedFn<A extends any[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (...args: A) => Value
): ValueSignal {
  return createSignal(
    createFunction((...sigArgs: (ValueSignal | undefined)[]) => {
      const inputs: Value[] = Array.from({ length: specs.length }, (_, i) =>
        sigArgs[i] ? sigArgs[i]!.get() : createBlank()
      );

      const resolved: unknown[] = [];
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i]!;
        const v = spec.convert(inputs[i]!);
        if (spec.kind === "req") {
          if (v === null) return createSignal(createBlank());
          resolved.push(v);
        } else {
          resolved.push(v === null ? spec.fallback : v);
        }
      }

      return createSignal(impl(...(resolved as A)));
    })
  );
}

function reduceNumbers(
  source: ListValue,
  op: (nums: number[]) => number | null
): number | null {
  const nums = listNumbersOpt(source);
  return nums.length ? op(nums) : null;
}

export const library = {
  /* Converters */

  to_bool: valueFn((v) => scalarToValue(toBool(v))),

  to_text: valueFn((v) => scalarToValue(toText(v))),

  to_number: valueFn((v) => scalarToValue(toNumber(v))),

  number_or: valueFn((value, fallback) => {
    const n = numOpt(value);
    return createLiteral(n === null ? numOpt(fallback) ?? 0 : n);
  }),

  text_or: valueFn((value, fallback) => {
    const t = textOpt(value);
    return t === null
      ? createLiteral(textOpt(fallback) ?? "")
      : createLiteral(t);
  }),

  if_blank: valueFn((value, fallback) =>
    isBlank(value) ? fallback ?? createBlank() : value
  ),

  first_present: valueFn((...values) => {
    for (const v of values) if (!isBlank(v)) return v;
    return createBlank();
  }),

  /* Logic */

  not: valueFn((v) => (toBool(v) ? createBlank() : createLiteral(true))),

  and: valueFn((l, r) =>
    toBool(l) && toBool(r) ? createLiteral(true) : createBlank()
  ),

  or: valueFn((l, r) =>
    toBool(l) || toBool(r) ? createLiteral(true) : createBlank()
  ),

  all: valueFn((...values) =>
    values.every((v) => !isBlank(v)) ? createLiteral(true) : createBlank()
  ),

  any: valueFn((...values) =>
    values.some((v) => !isBlank(v)) ? createLiteral(true) : createBlank()
  ),

  /* Number */

  abs: typedFn([reqNum], (n) => createLiteral(Math.abs(n))),

  round: typedFn([reqNum, optNum(0)], (n, p) => {
    const f = 10 ** p;
    return createLiteral(Math.round(n * f) / f);
  }),

  ceil: typedFn([reqNum], (n) => createLiteral(Math.ceil(n))),

  floor: typedFn([reqNum], (n) => createLiteral(Math.floor(n))),

  clamp: typedFn(
    [
      reqNum,
      optNum(Number.NEGATIVE_INFINITY),
      optNum(Number.POSITIVE_INFINITY),
    ],
    (n, lo, hi) => createLiteral(Math.min(Math.max(n, lo), hi))
  ),

  pow: typedFn([reqNum, optNum(1)], (b, e) => createLiteral(b ** e)),

  sqrt: typedFn([reqNum], (n) => createLiteral(Math.sqrt(n))),

  mod: typedFn([reqNum, optNum(1)], (d, m) => createLiteral(((d % m) + m) % m)),

  /* Text */

  trim: typedFn([reqText], (t) => createLiteral(t.trim())),

  starts_with: typedFn([reqText, reqText], (t, p) =>
    t.startsWith(p) ? createLiteral(true) : createBlank()
  ),

  ends_with: typedFn([reqText, reqText], (t, s) =>
    t.endsWith(s) ? createLiteral(true) : createBlank()
  ),

  contains: typedFn([reqText, reqText], (t, s) =>
    t.includes(s) ? createLiteral(true) : createBlank()
  ),

  lower: typedFn([reqText], (t) => createLiteral(t.toLowerCase())),

  upper: typedFn([reqText], (t) => createLiteral(t.toUpperCase())),

  capitalize: typedFn([reqText], (t) =>
    createLiteral(t ? t.charAt(0).toUpperCase() + t.slice(1) : "")
  ),

  replace: typedFn([reqText, reqText, reqText], (t, s, r) =>
    createLiteral(t.replaceAll(s, r))
  ),

  index_of: typedFn([reqText, optText(""), optNum(0)], (t, s, from) =>
    createLiteral(t.indexOf(s, from))
  ),

  pad_start: typedFn(
    [reqText, optNum(0), optText(" ")],
    (t, targetLen, padText) => createLiteral(t.padStart(targetLen, padText))
  ),

  pad_end: typedFn(
    [reqText, optNum(0), optText(" ")],
    (t, targetLen, padText) => createLiteral(t.padEnd(targetLen, padText))
  ),

  repeat: typedFn([reqText, optNum(0)], (t, times) =>
    createLiteral(t.repeat(Math.max(0, Math.floor(times))))
  ),

  split: typedFn([reqText, optText("")], (t, sep) => {
    return createList(
      [],
      t.split(sep).map((p) => createSignal(createLiteral(p)))
    );
  }),

  /* Lists */

  join: typedFn([reqList, optText(",")], (listV, sep) => {
    const parts = listTextsOpt(listV);
    return parts.length ? createLiteral(parts.join(sep)) : createBlank();
  }),

  count: typedFn([reqList], (source) => {
    let cnt = 0;
    for (const e of iterCells(source)) {
      if (!isBlank(childToValue(e.child))) cnt++;
    }
    return createLiteral(cnt);
  }),

  count_blank: typedFn([reqList], (source) => {
    let cnt = 0;
    for (const e of iterCells(source)) {
      if (isBlank(childToValue(e.child))) cnt++;
    }
    return createLiteral(cnt);
  }),

  map: typedFn([reqList, reqFn], (source, fnValue) =>
    listMap(source, (value, id) => fnValue.fn(value, id))
  ),

  filter: typedFn([reqList, reqFn], (source, predValue) =>
    listFilter(source, (value, id) => boolExpect(predValue.fn(value, id).get()))
  ),

  sort: typedFn([reqList, optFn(null)], (source, keyValue) =>
    listSort(source, keyValue ? (value, id) => keyValue.fn(value, id) : null)
  ),

  reduce: createSignal(
    createFunction(
      (
        sourceSig = createSignal(createBlank()),
        fnSig = createSignal(createBlank()),
        initSig = createSignal(createBlank())
      ) => {
        const src = sourceSig.get();
        if (!isList(src)) throw new TypeError(ERR.list);
        const rf = fnSig.get();
        if (!isFunction(rf)) throw new TypeError(ERR.function);
        return listReduce(
          src,
          (acc, value, id) => rf.fn(acc, value, id),
          initSig
        );
      }
    )
  ),

  /* Number reducers */

  sum: typedFn([reqList], (source) =>
    scalarToValue(reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0)))
  ),

  avg: typedFn([reqList], (source) =>
    scalarToValue(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length)
    )
  ),

  min: typedFn([reqList], (source) =>
    scalarToValue(reduceNumbers(source, (ns) => Math.min(...ns)))
  ),

  max: typedFn([reqList], (source) =>
    scalarToValue(reduceNumbers(source, (ns) => Math.max(...ns)))
  ),
};
