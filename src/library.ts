import {
  ERR,
  type GroupContent,
  type FunctionContent,
  type Content,
  type ContentSignal,
  isBlank,
  isScalar,
  isGroup,
  isFunction,
  groupMap,
  groupFilter,
  groupReduce,
  groupSort,
  createBlank,
  createScalar,
  createGroup,
  createFunction,
  createSignal,
  isTruthy,
  toNumber,
  toText,
  numOpt,
  textOpt,
  groupOpt,
  fnOpt,
  primitiveToContent,
  evalStructural,
} from "./model";

function contentFn(op: (...contents: Content[]) => Content): ContentSignal {
  return createSignal(
    createFunction((...args: (ContentSignal | undefined)[]) => {
      const contents = Array.from({ length: op.length }, (_, i) =>
        args[i] ? args[i]!.get() : createBlank()
      );
      return createSignal(op(...contents));
    })
  );
}

type ArgSpec<T> =
  | { kind: "req"; convert: (content: Content) => T | null }
  | { kind: "opt"; convert: (content: Content) => T | null; fallback: T };

const reqNum = { kind: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ kind: "opt", convert: numOpt, fallback: d } as const);

const reqText = { kind: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ kind: "opt", convert: textOpt, fallback: d } as const);

const reqGroup = { kind: "req", convert: groupOpt } as const;
const optGroup = (d: GroupContent) =>
  ({ kind: "opt", convert: groupOpt, fallback: d } as const);

const reqFn = { kind: "req", convert: fnOpt } as const;
const optFn = <F extends FunctionContent | null>(d: F) =>
  ({ kind: "opt", convert: fnOpt, fallback: d } as const);

function typedFn<A extends any[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (...args: A) => Content
): ContentSignal {
  return createSignal(
    createFunction((...sigArgs: (ContentSignal | undefined)[]) => {
      const inputs: Content[] = Array.from({ length: specs.length }, (_, i) =>
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

function groupNumbersOpt(group: GroupContent): number[] {
  const out: number[] = [];
  for (const { content } of group.items) {
    const v = evalStructural(content);
    if (isBlank(v)) continue;
    if (isScalar(v) && typeof v.value === "number") out.push(v.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

function groupTextsOpt(group: GroupContent): string[] {
  const out: string[] = [];
  for (const { content } of group.items) {
    const v = evalStructural(content);
    if (isBlank(v)) continue;
    if (isScalar(v) && typeof v.value === "string") out.push(v.value);
    else throw new TypeError(ERR.textOrBlank);
  }
  return out;
}

function reduceNumbers(
  source: GroupContent,
  op: (nums: number[]) => number | null
): number | null {
  const nums = groupNumbersOpt(source);
  return nums.length ? op(nums) : null;
}

export const library = {
  /* Converters */

  to_flag: contentFn((v) => primitiveToContent(isTruthy(v))),

  to_text: contentFn((v) => primitiveToContent(toText(v))),

  to_number: contentFn((v) => primitiveToContent(toNumber(v))),

  number_or: contentFn((content, fallback) => {
    const n = numOpt(content);
    return createScalar(n === null ? numOpt(fallback) ?? 0 : n);
  }),

  text_or: contentFn((content, fallback) => {
    const t = textOpt(content);
    return t === null ? createScalar(textOpt(fallback) ?? "") : createScalar(t);
  }),

  if_blank: contentFn((content, fallback) =>
    isBlank(content) ? fallback ?? createBlank() : content
  ),

  first_present: contentFn((...contents) => {
    for (const v of contents) if (!isBlank(v)) return v;
    return createBlank();
  }),

  /* Logic */

  not: contentFn((v) => (isTruthy(v) ? createBlank() : createScalar(true))),

  and: contentFn((l, r) =>
    isTruthy(l) && isTruthy(r) ? createScalar(true) : createBlank()
  ),

  or: contentFn((l, r) =>
    isTruthy(l) || isTruthy(r) ? createScalar(true) : createBlank()
  ),

  if: contentFn((cond, thenV, elseV) => (isTruthy(cond) ? thenV : elseV)),

  all: contentFn((...contents) =>
    contents.every((v) => !isBlank(v)) ? createScalar(true) : createBlank()
  ),

  any: contentFn((...contents) =>
    contents.some((v) => !isBlank(v)) ? createScalar(true) : createBlank()
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
    return createGroup(
      t.split(sep).map((p) => ({ content: createSignal(createScalar(p)) }))
    );
  }),

  /* Groups */

  join: typedFn([reqGroup, optText(",")], (groupV, sep) => {
    const parts = groupTextsOpt(groupV);
    return parts.length ? createScalar(parts.join(sep)) : createBlank();
  }),

  count: typedFn([reqGroup], (source) =>
    createScalar(
      source.items.filter((c) => !isBlank(evalStructural(c.content))).length
    )
  ),

  count_blank: typedFn([reqGroup], (source) =>
    createScalar(
      source.items.filter((c) => isBlank(evalStructural(c.content))).length
    )
  ),

  map: typedFn([reqGroup, reqFn], (source, fnValue) =>
    groupMap(source, (content, index, name) => fnValue.fn(content, index, name))
  ),

  filter: typedFn([reqGroup, reqFn], (source, predValue) =>
    groupFilter(source, (content, index, name) =>
      predValue.fn(content, index, name)
    )
  ),

  sort: typedFn([reqGroup, optFn(null)], (source, keyValue) =>
    groupSort(
      source,
      keyValue
        ? (content, index, name) => keyValue.fn(content, index, name)
        : null
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
        if (!isGroup(src)) throw new TypeError(ERR.group);
        const rf = fnSig.get();
        if (!isFunction(rf)) throw new TypeError(ERR.function);
        return groupReduce(
          src,
          (acc, content, index, name) => rf.fn(acc, content, index, name),
          initSig
        );
      }
    )
  ),

  /* Number reducers */

  sum: typedFn([reqGroup], (source) =>
    primitiveToContent(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0))
    )
  ),

  avg: typedFn([reqGroup], (source) =>
    primitiveToContent(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length)
    )
  ),

  min: typedFn([reqGroup], (source) =>
    primitiveToContent(reduceNumbers(source, (ns) => Math.min(...ns)))
  ),

  max: typedFn([reqGroup], (source) =>
    primitiveToContent(reduceNumbers(source, (ns) => Math.max(...ns)))
  ),
};
