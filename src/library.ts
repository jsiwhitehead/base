import {
  type Primitive,
  type DataNode,
  type DataSignal,
  type ChildSignal,
  isLiteral,
  isBlock,
  isData,
  isSignal,
  createLiteral,
  createBlock,
  createFunction,
  createSignal,
  library,
  childToData,
} from "./data";

export type EvalValue = Primitive | DataNode | ChildSignal;

function toPrimitive(value: EvalValue): Primitive {
  const node = toData(value) ?? createLiteral("");
  if (isLiteral(node)) return node.value;
  if (isBlock(node)) throw new TypeError("Expected a primitive, got a block");
  throw new TypeError("Expected a primitive, got a function");
}

export function toBoolean(value: EvalValue): boolean {
  return Boolean(toPrimitive(value));
}

export function toNumber(input: EvalValue): number {
  const n = Number(toPrimitive(input));
  if (!Number.isFinite(n)) {
    throw new TypeError(`Expected a number, got ${String(input)}`);
  }
  return n;
}

export function toString(input: EvalValue): string {
  return String(toPrimitive(input));
}

export function toData(value: EvalValue): DataNode | undefined {
  if (isSignal(value)) return childToData(value);
  return isData(value) ? value : createLiteral(value);
}

export function toSignal(value: EvalValue): DataSignal {
  const node = toData(value) ?? createLiteral("");
  return createSignal(isData(node) ? node : createLiteral(node));
}

export function equals(a: EvalValue, b: EvalValue): boolean {
  return toPrimitive(a) === toPrimitive(b);
}

function lit(v: Primitive) {
  return createSignal(createLiteral(v));
}

function fn(impl: (...args: DataSignal[]) => DataSignal): ChildSignal {
  return createSignal(createFunction(impl));
}

function toNumberList(input: EvalValue): number[] {
  const node = toData(input);
  const literals = isBlock(node)
    ? node.items.map(childToData).filter(isLiteral)
    : isLiteral(node)
    ? [node]
    : [];
  return literals.map((l) => Number(l.value)).filter((n) => Number.isFinite(n));
}

library["bool"] = createSignal(
  createBlock(
    {
      not: fn((x) => toSignal(!toBoolean(x))),
      and: fn((a, b) => toSignal(toBoolean(a) ? b : a)),
      or: fn((a, b) => toSignal(toBoolean(a) ? a : b)),
      all: fn((...args) => toSignal(args.every(toBoolean))),
      any: fn((...args) => toSignal(args.some(toBoolean))),
    },
    []
  )
);

library["num"] = createSignal(
  createBlock(
    {
      abs: fn((x) => lit(Math.abs(toNumber(x)))),
      round: fn((x, places = lit(0)) => {
        const n = toNumber(x);
        const p = toNumber(places);
        const factor = 10 ** p;
        return lit(Math.round(n * factor) / factor);
      }),
      ceil: fn((x) => lit(Math.ceil(toNumber(x)))),
      floor: fn((x) => lit(Math.floor(toNumber(x)))),
      clamp: fn((x, min, max) => {
        const v = toNumber(x);
        const mn = toNumber(min);
        const mx = toNumber(max);
        return lit(Math.min(Math.max(v, mn), mx));
      }),
      sum: fn((...args) => {
        const nums = args.flatMap(toNumberList);
        return lit(nums.reduce((a, b) => a + b, 0));
      }),
      average: fn((...args) => {
        const nums = args.flatMap(toNumberList);
        return lit(
          nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
        );
      }),
      min: fn((...args) => {
        const nums = args.flatMap(toNumberList);
        return lit(nums.length ? Math.min(...nums) : 0);
      }),
      max: fn((...args) => {
        const nums = args.flatMap(toNumberList);
        return lit(nums.length ? Math.max(...nums) : 0);
      }),
      lessThan: fn((a, b) => lit(toNumber(a) < toNumber(b))),
      lessOrEqual: fn((a, b) => lit(toNumber(a) <= toNumber(b))),
      greaterThan: fn((a, b) => lit(toNumber(a) > toNumber(b))),
      greaterOrEqual: fn((a, b) => lit(toNumber(a) >= toNumber(b))),
    },
    []
  )
);

library["text"] = createSignal(
  createBlock(
    {
      length: fn((s) => lit(toString(s).length)),
      trim: fn((s) => lit(toString(s).trim())),
      startsWith: fn((s, prefix) =>
        toSignal(toString(s).startsWith(toString(prefix)))
      ),
      endsWith: fn((s, suffix) =>
        toSignal(toString(s).endsWith(toString(suffix)))
      ),
      includes: fn((s, substr) =>
        toSignal(toString(s).includes(toString(substr)))
      ),
      toLower: fn((s) => lit(toString(s).toLowerCase())),
      toUpper: fn((s) => lit(toString(s).toUpperCase())),
    },
    []
  )
);
