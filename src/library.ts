import {
  type Primitive,
  type BlockNode,
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
  createBlockSignal,
  childToData,
} from "./data";

export type EvalValue = Primitive | DataNode | ChildSignal;

/* Conversions */

function toPrimitive(value: EvalValue): Primitive {
  const node = toData(value) ?? createLiteral("");
  if (isLiteral(node)) return node.value;
  if (isBlock(node)) throw new TypeError("Expected a primitive, got a block");
  throw new TypeError("Expected a primitive, got a function");
}

export function toBoolean(value: EvalValue): boolean {
  return Boolean(toPrimitive(value));
}

export function toNumber(value: EvalValue): number {
  const n = Number(toPrimitive(value));
  if (!Number.isFinite(n)) {
    throw new TypeError(`Expected a number, got ${String(value)}`);
  }
  return n;
}

export function toString(value: EvalValue): string {
  return String(toPrimitive(value));
}

export function toData(value: EvalValue): DataNode | undefined {
  if (isSignal(value)) return childToData(value);
  return isData(value) ? value : createLiteral(value);
}

export function toSignal(value: EvalValue): DataSignal {
  const node = toData(value) ?? createLiteral("");
  return createSignal(isData(node) ? node : createLiteral(node));
}

/* Helpers */

export function equals(a: EvalValue, b: EvalValue): boolean {
  return toPrimitive(a) === toPrimitive(b);
}

function lit(v: Primitive) {
  return createSignal(createLiteral(v));
}

function fn(impl: (...args: DataSignal[]) => DataSignal): ChildSignal {
  return createSignal(createFunction(impl));
}

function toList<T>(
  value: EvalValue,
  map: (p: Primitive) => T | undefined
): T[] {
  const node = toData(value);
  const values: Primitive[] = isBlock(node)
    ? node.items
        .map(childToData)
        .filter(isLiteral)
        .map((l) => l.value)
    : isLiteral(node)
    ? [node.value]
    : [];
  return values.map(map).filter((x): x is T => x !== undefined);
}

function toNumberList(value: EvalValue): number[] {
  return toList(value, (p) => {
    const n = Number(p);
    return Number.isFinite(n) ? n : undefined;
  });
}

function toStringList(value: EvalValue): string[] {
  return toList(value, (p) => String(p));
}

function stringsToBlock(parts: string[]) {
  return createSignal(
    createBlock(
      {},
      parts.map((p) => createSignal(createLiteral(p)))
    )
  );
}

/* Library */

export function createStdLibEntries(): Record<string, ChildSignal> {
  return {
    logic: createSignal(
      createBlock(
        {
          not: fn((x = lit(false)) => lit(!toBoolean(x))),
          and: fn((a = lit(false), b = lit(false)) =>
            toBoolean(a) ? toSignal(b) : toSignal(a)
          ),
          or: fn((a = lit(false), b = lit(false)) =>
            toBoolean(a) ? toSignal(a) : toSignal(b)
          ),
          all: fn((...args) => lit(args.every(toBoolean))),
          any: fn((...args) => lit(args.some(toBoolean))),
        },
        []
      )
    ),

    number: createSignal(
      createBlock(
        {
          abs: fn((x = lit(0)) => lit(Math.abs(toNumber(x)))),
          round: fn((x = lit(0), places = lit(0)) => {
            const n = toNumber(x);
            const p = toNumber(places);
            const f = 10 ** p;
            return lit(Math.round(n * f) / f);
          }),
          ceil: fn((x = lit(0)) => lit(Math.ceil(toNumber(x)))),
          floor: fn((x = lit(0)) => lit(Math.floor(toNumber(x)))),
          clamp: fn(
            (
              x = lit(0),
              min = lit(Number.NEGATIVE_INFINITY),
              max = lit(Number.POSITIVE_INFINITY)
            ) => {
              const v = toNumber(x);
              const mn = toNumber(min);
              const mx = toNumber(max);
              return lit(Math.min(Math.max(v, mn), mx));
            }
          ),
          sum: fn((...args) =>
            lit(args.flatMap(toNumberList).reduce((a, b) => a + b, 0))
          ),
          avg: fn((...args) => {
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
          pow: fn((x = lit(1), y = lit(1)) =>
            lit(Math.pow(toNumber(x), toNumber(y)))
          ),
          sqrt: fn((x = lit(0)) => lit(Math.sqrt(toNumber(x)))),
          mod: fn((a = lit(0), b = lit(1)) => {
            const n = toNumber(a);
            const m = toNumber(b);
            return lit(((n % m) + m) % m);
          }),
        },
        []
      )
    ),

    text: createSignal(
      createBlock(
        {
          len: fn((s = lit("")) => lit(toString(s).length)),
          trim: fn((s = lit("")) => lit(toString(s).trim())),
          starts_with: fn((s = lit(""), prefix = lit("")) =>
            lit(toString(s).startsWith(toString(prefix)))
          ),
          ends_with: fn((s = lit(""), suffix = lit("")) =>
            lit(toString(s).endsWith(toString(suffix)))
          ),
          contains: fn((s = lit(""), substr = lit("")) =>
            lit(toString(s).includes(toString(substr)))
          ),
          lower: fn((s = lit("")) => lit(toString(s).toLowerCase())),
          upper: fn((s = lit("")) => lit(toString(s).toUpperCase())),
          replace: fn((s = lit(""), search = lit(""), replacement = lit("")) =>
            lit(
              ((p) =>
                p === ""
                  ? toString(s)
                  : toString(s).replaceAll(p, toString(replacement)))(
                toString(search)
              )
            )
          ),
          slice: fn((s = lit(""), start = lit(0), end?: DataSignal) =>
            lit(
              toString(s).slice(
                toNumber(start),
                end !== undefined ? toNumber(end) : undefined
              )
            )
          ),
          index_of: fn((s = lit(""), substr = lit(""), fromIndex = lit(0)) =>
            lit(toString(s).indexOf(toString(substr), toNumber(fromIndex)))
          ),
          pad_start: fn((s = lit(""), length = lit(0), padStr = lit(" ")) =>
            lit(
              toString(s).padStart(
                Math.max(0, Math.floor(toNumber(length))),
                toString(padStr)
              )
            )
          ),
          pad_end: fn((s = lit(""), length = lit(0), padStr = lit(" ")) =>
            lit(
              toString(s).padEnd(
                Math.max(0, Math.floor(toNumber(length))),
                toString(padStr)
              )
            )
          ),
          split: fn((s = lit(""), sep = lit(""), limit?: DataSignal) =>
            stringsToBlock(
              toString(s).split(
                toString(sep),
                limit !== undefined
                  ? Math.max(0, Math.floor(toNumber(limit)))
                  : undefined
              )
            )
          ),
          join: fn((list = createSignal(createBlock({}, [])), sep = lit(",")) =>
            lit(toStringList(list).join(toString(sep)))
          ),
          capitalize: fn((s = lit("")) => {
            const str = toString(s);
            return lit(str ? str.charAt(0).toUpperCase() + str.slice(1) : "");
          }),
          repeat: fn((s = lit(""), times = lit(0)) =>
            lit(toString(s).repeat(Math.max(0, Math.floor(toNumber(times)))))
          ),
          left: fn((s = lit(""), n = lit(0)) => {
            const str = toString(s);
            const count = Math.max(0, Math.floor(toNumber(n)));
            return lit(str.slice(0, count));
          }),
          right: fn((s = lit(""), n = lit(0)) => {
            const str = toString(s);
            const count = Math.max(0, Math.floor(toNumber(n)));
            return lit(count ? str.slice(-count) : "");
          }),
        },
        []
      )
    ),
  };
}

export function withLibrary(
  root: DataSignal<BlockNode>
): DataSignal<BlockNode> {
  createBlockSignal(createStdLibEntries(), [root]);
  return root;
}
