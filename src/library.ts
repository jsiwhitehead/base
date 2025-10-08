import {
  ERR,
  type DataNode,
  type BlockNode,
  type FunctionNode,
  type DataSignal,
  isBlank,
  isBlock,
  isFunction,
  createBlank,
  createLiteral,
  createBlock,
  createFunction,
  createSignal,
  toBool,
  toNumber,
  toText,
  numOpt,
  textOpt,
  blockOpt,
  fnOpt,
  boolExpect,
  scalarToData,
  childToData,
} from "./data";
import {
  iterEntries,
  blockMap,
  blockFilter,
  blockReduce,
  blockSort,
  blockNumbersOpt,
  blockTextsOpt,
} from "./tree";

function dataFn(op: (...nodes: DataNode[]) => DataNode): DataSignal {
  return createSignal(
    createFunction((...args: (DataSignal | undefined)[]) => {
      const nodes = Array.from({ length: op.length }, (_, i) =>
        args[i] ? args[i]!.get() : createBlank()
      );
      return createSignal(op(...nodes));
    })
  );
}

type ArgSpec<T> =
  | { kind: "req"; convert: (node: DataNode) => T | null }
  | { kind: "opt"; convert: (node: DataNode) => T | null; fallback: T };

const reqNum = { kind: "req", convert: numOpt } as const;
const optNum = (d: number) =>
  ({ kind: "opt", convert: numOpt, fallback: d } as const);

const reqText = { kind: "req", convert: textOpt } as const;
const optText = (d: string) =>
  ({ kind: "opt", convert: textOpt, fallback: d } as const);

const reqBlock = { kind: "req", convert: blockOpt } as const;
const optBlock = (d: BlockNode) =>
  ({ kind: "opt", convert: blockOpt, fallback: d } as const);

const reqFn = { kind: "req", convert: fnOpt } as const;
const optFn = <F extends FunctionNode | null>(d: F) =>
  ({ kind: "opt", convert: fnOpt, fallback: d } as const);

function typedFn<A extends any[]>(
  specs: { [K in keyof A]: ArgSpec<A[K]> },
  impl: (...args: A) => DataNode
): DataSignal {
  return createSignal(
    createFunction((...sigArgs: (DataSignal | undefined)[]) => {
      const nodes: DataNode[] = Array.from({ length: specs.length }, (_, i) =>
        sigArgs[i] ? sigArgs[i]!.get() : createBlank()
      );

      const resolved = [];
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i]!;
        const v = spec.convert(nodes[i]!);
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
  source: BlockNode,
  op: (nums: number[]) => number | null
): number | null {
  const nums = blockNumbersOpt(source);
  return nums.length ? op(nums) : null;
}

export const library = {
  /* Convertors */

  to_bool: dataFn((n) => scalarToData(toBool(n))),

  to_text: dataFn((n) => scalarToData(toText(n))),

  to_number: dataFn((n) => scalarToData(toNumber(n))),

  number_or: dataFn((value, fallback) => {
    const n = numOpt(value);
    return createLiteral(n === null ? numOpt(fallback) ?? 0 : n);
  }),

  text_or: dataFn((value, fallback) => {
    const t = textOpt(value);
    return t === null
      ? createLiteral(textOpt(fallback) ?? "")
      : createLiteral(t);
  }),

  if_blank: dataFn((value, fallback) =>
    isBlank(value) ? fallback ?? createBlank() : value
  ),

  first_present: dataFn((...nodes) => {
    for (const n of nodes) if (!isBlank(n)) return n;
    return createBlank();
  }),

  /* Logic */

  not: dataFn((v) => (toBool(v) ? createBlank() : createLiteral(true))),

  and: dataFn((l, r) =>
    toBool(l) && toBool(r) ? createLiteral(true) : createBlank()
  ),

  or: dataFn((l, r) =>
    toBool(l) || toBool(r) ? createLiteral(true) : createBlank()
  ),

  all: dataFn((...nodes) =>
    nodes.every((n) => !isBlank(n)) ? createLiteral(true) : createBlank()
  ),

  any: dataFn((...nodes) =>
    nodes.some((n) => !isBlank(n)) ? createLiteral(true) : createBlank()
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
    return createBlock(
      [],
      t.split(sep).map((p) => createSignal(createLiteral(p)))
    );
  }),

  /* Blocks */

  join: typedFn([reqBlock, optText(",")], (blockN, sep) => {
    const parts = blockTextsOpt(blockN);
    return parts.length ? createLiteral(parts.join(sep)) : createBlank();
  }),

  count: typedFn([reqBlock], (source) => {
    let cnt = 0;
    for (const e of iterEntries(source)) {
      if (!isBlank(childToData(e.child))) cnt++;
    }
    return createLiteral(cnt);
  }),

  count_blank: typedFn([reqBlock], (source) => {
    let cnt = 0;
    for (const e of iterEntries(source)) {
      if (isBlank(childToData(e.child))) cnt++;
    }
    return createLiteral(cnt);
  }),

  map: typedFn([reqBlock, reqFn], (source, fnNode) =>
    blockMap(source, (value, id) => fnNode.fn(value, id))
  ),

  filter: typedFn([reqBlock, reqFn], (source, predNode) =>
    blockFilter(source, (value, id) => boolExpect(predNode.fn(value, id).get()))
  ),

  sort: typedFn([reqBlock, optFn(null)], (source, keyNode) =>
    blockSort(source, keyNode ? (value, id) => keyNode.fn(value, id) : null)
  ),

  reduce: createSignal(
    createFunction(
      (
        sourceSig = createSignal(createBlank()),
        fnSig = createSignal(createBlank()),
        initSig = createSignal(createBlank())
      ) => {
        const src = sourceSig.get();
        if (!isBlock(src)) throw new TypeError(ERR.block);
        const rf = fnSig.get();
        if (!isFunction(rf)) throw new TypeError(ERR.function);
        return blockReduce(
          src,
          (acc, value, id) => rf.fn(acc, value, id),
          initSig
        );
      }
    )
  ),

  /* Number reducers */

  sum: typedFn([reqBlock], (source) =>
    scalarToData(reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0)))
  ),

  avg: typedFn([reqBlock], (source) =>
    scalarToData(
      reduceNumbers(source, (ns) => ns.reduce((a, b) => a + b, 0) / ns.length)
    )
  ),

  min: typedFn([reqBlock], (source) =>
    scalarToData(reduceNumbers(source, (ns) => Math.min(...ns)))
  ),

  max: typedFn([reqBlock], (source) =>
    scalarToData(reduceNumbers(source, (ns) => Math.max(...ns)))
  ),
};
