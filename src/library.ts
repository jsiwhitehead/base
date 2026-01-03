import {
  ERR,
  type ListValue,
  type FunctionValue,
  type Value,
  type ValueSignal,
  isBlank,
  isScalar,
  isList,
  isFunction,
  listMap,
  listFilter,
  listReduce,
  listSort,
  createBlank,
  createScalar,
  createList,
  createFunction,
  createSignal,
  isTruthy,
  toNumber,
  toText,
  numOpt,
  textOpt,
  listOpt,
  fnOpt,
  primitiveToValue,
  evalStructural,
} from "./data";

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

function listNumbersOpt(list: ListValue): number[] {
  const out: number[] = [];
  for (const { value } of list.cells) {
    const v = evalStructural(value);
    if (isBlank(v)) continue;
    if (isScalar(v) && typeof v.value === "number") out.push(v.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

function listTextsOpt(list: ListValue): string[] {
  const out: string[] = [];
  for (const { value } of list.cells) {
    const v = evalStructural(value);
    if (isBlank(v)) continue;
    if (isScalar(v) && typeof v.value === "string") out.push(v.value);
    else throw new TypeError(ERR.textOrBlank);
  }
  return out;
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

  to_flag: valueFn((v) => primitiveToValue(isTruthy(v))),

  to_text: valueFn((v) => primitiveToValue(toText(v))),

  to_number: valueFn((v) => primitiveToValue(toNumber(v))),

  number_or: valueFn((value, fallback) => {
    const n = numOpt(value);
    return createScalar(n === null ? numOpt(fallback) ?? 0 : n);
  }),

  text_or: valueFn((value, fallback) => {
    const t = textOpt(value);
    return t === null ? createScalar(textOpt(fallback) ?? "") : createScalar(t);
  }),

  if_blank: valueFn((value, fallback) =>
    isBlank(value) ? fallback ?? createBlank() : value
  ),

  first_present: valueFn((...values) => {
    for (const v of values) if (!isBlank(v)) return v;
    return createBlank();
  }),

  /* Logic */

  not: valueFn((v) => (isTruthy(v) ? createBlank() : createScalar(true))),

  and: valueFn((l, r) =>
    isTruthy(l) && isTruthy(r) ? createScalar(true) : createBlank()
  ),

  or: valueFn((l, r) =>
    isTruthy(l) || isTruthy(r) ? createScalar(true) : createBlank()
  ),

  if: valueFn((cond, thenV, elseV) => (isTruthy(cond) ? thenV : elseV)),

  all: valueFn((...values) =>
    values.every((v) => !isBlank(v)) ? createScalar(true) : createBlank()
  ),

  any: valueFn((...values) =>
    values.some((v) => !isBlank(v)) ? createScalar(true) : createBlank()
  ),

  /* Number */

  abs: typedFn([reqNum], (n) => createScalar(Math.abs(n))),

  round: typedFn([reqNum, optNum(0)], (n, p) => {
    const f = 10 ** p;
    return createScalar(Math.round(n * f) / f);
  }),

  ceil: typedFn([reqNum], (n) => createScalar(Math.ceil(n))),

  floor: typedFn([reqNum], (n) => createScalar(Math.floor(n))),

  clamp: typedFn(
    [
      reqNum,
      optNum(Number.NEGATIVE_INFINITY),
      optNum(Number.POSITIVE_INFINITY),
    ],
    (n, lo, hi) => createScalar(Math.min(Math.max(n, lo), hi))
  ),

  pow: typedFn([reqNum, optNum(1)], (b, e) => createScalar(b ** e)),

  sqrt: typedFn([reqNum], (n) => createScalar(Math.sqrt(n))),

  mod: typedFn([reqNum, optNum(1)], (d, m) => createScalar(((d % m) + m) % m)),

  /* Text */

  trim: typedFn([reqText], (t) => createScalar(t.trim())),

  starts_with: typedFn([reqText, reqText], (t, p) =>
    t.startsWith(p) ? createScalar(true) : createBlank()
  ),

  ends_with: typedFn([reqText, reqText], (t, s) =>
    t.endsWith(s) ? createScalar(true) : createBlank()
  ),

  contains: typedFn([reqText, reqText], (t, s) =>
    t.includes(s) ? createScalar(true) : createBlank()
  ),

  lower: typedFn([reqText], (t) => createScalar(t.toLowerCase())),

  upper: typedFn([reqText], (t) => createScalar(t.toUpperCase())),

  capitalize: typedFn([reqText], (t) =>
    createScalar(t ? t.charAt(0).toUpperCase() + t.slice(1) : "")
  ),

  replace: typedFn([reqText, reqText, reqText], (t, s, r) =>
    createScalar(t.replaceAll(s, r))
  ),

  index_of: typedFn([reqText, optText(""), optNum(0)], (t, s, from) =>
    createScalar(t.indexOf(s, from))
  ),

  pad_start: typedFn(
    [reqText, optNum(0), optText(" ")],
    (t, targetLen, padText) => createScalar(t.padStart(targetLen, padText))
  ),

  pad_end: typedFn(
    [reqText, optNum(0), optText(" ")],
    (t, targetLen, padText) => createScalar(t.padEnd(targetLen, padText))
  ),

  repeat: typedFn([reqText, optNum(0)], (t, times) =>
    createScalar(t.repeat(Math.max(0, Math.floor(times))))
  ),

  split: typedFn([reqText, optText("")], (t, sep) => {
    return createList(
      t.split(sep).map((p) => ({ value: createSignal(createScalar(p)) }))
    );
  }),

  /* Lists */

  join: typedFn([reqList, optText(",")], (listV, sep) => {
    const parts = listTextsOpt(listV);
    return parts.length ? createScalar(parts.join(sep)) : createBlank();
  }),

  count: typedFn([reqList], (source) =>
    createScalar(
      source.cells.filter((c) => !isBlank(evalStructural(c.value))).length
    )
  ),

  count_blank: typedFn([reqList], (source) =>
    createScalar(
      source.cells.filter((c) => isBlank(evalStructural(c.value))).length
    )
  ),

  map: typedFn([reqList, reqFn], (source, fnValue) =>
    listMap(source, (value, index, name) => fnValue.fn(value, index, name))
  ),

  filter: typedFn([reqList, reqFn], (source, predValue) =>
    listFilter(source, (value, index, name) => predValue.fn(value, index, name))
  ),

  sort: typedFn([reqList, optFn(null)], (source, keyValue) =>
    listSort(
      source,
      keyValue ? (value, index, name) => keyValue.fn(value, index, name) : null
    )
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
          (acc, value, index, name) => rf.fn(acc, value, index, name),
          initSig
        );
      }
    )
  ),

  /* Number reducers */

  sum: typedFn([reqList], (source) =>
    primitiveToValue(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0))
    )
  ),

  avg: typedFn([reqList], (source) =>
    primitiveToValue(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length)
    )
  ),

  min: typedFn([reqList], (source) =>
    primitiveToValue(reduceNumbers(source, (ns) => Math.min(...ns)))
  ),

  max: typedFn([reqList], (source) =>
    primitiveToValue(reduceNumbers(source, (ns) => Math.max(...ns)))
  ),
};
