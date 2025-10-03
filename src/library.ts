import {
  type Primitive,
  type BlockNode,
  type DataNode,
  type DataSignal,
  type ChildSignal,
  isBlank,
  isLiteral,
  isBlock,
  isFunction,
  createBlank,
  createLiteral,
  createBlock,
  createFunction,
  createComputed,
  createSignal,
  createBlockSignal,
  childToData,
  markCaseInsensitiveScope,
} from "./data";

/* Errors */

const ERR = {
  bool: "Expected boolean (true or blank)",
  lit: "Expected literal value",
  num: "Expected number",
  numOrBlank: "Expected number or blank",
  text: "Expected text",
  textOrBlank: "Expected text or blank",
  numsOrBlank: "Expected numbers or blanks",
  textsOrBlank: "Expected texts or blanks",
  block: "Expected block",
  func: "Expected function",
};

/* Constructors */

export function blank(): DataSignal {
  return createSignal(createBlank());
}

export function lit(value: Primitive): DataSignal {
  return createSignal(createLiteral(value));
}

export function bool(flag: boolean): DataSignal {
  return flag ? lit(true) : blank();
}

export function fn(impl: (...argSigs: DataSignal[]) => DataSignal): DataSignal {
  return createSignal(createFunction(impl));
}

/* Convertors */

export function asJsBool(valueSig: DataSignal): boolean {
  const node = valueSig.get();
  if (isBlank(node)) return false;
  if (isLiteral(node) && node.value === true) return true;
  throw new TypeError(ERR.bool);
}

export function primExpect(valueSig: DataSignal): Primitive {
  const node = valueSig.get();
  if (isLiteral(node)) return node.value;
  throw new TypeError(ERR.lit);
}

export function numExpect(valueSig: DataSignal): number {
  const node = valueSig.get();
  if (isLiteral(node) && typeof node.value === "number") return node.value;
  throw new TypeError(ERR.num);
}

export function textExpect(valueSig: DataSignal): string {
  const node = valueSig.get();
  if (isLiteral(node) && typeof node.value === "string") return node.value;
  throw new TypeError(ERR.text);
}

export function numOpt(valueSig: DataSignal): number | null {
  const node = valueSig.get();
  if (isBlank(node)) return null;
  if (isLiteral(node) && typeof node.value === "number") return node.value;
  throw new TypeError(ERR.numOrBlank);
}

export function textOpt(valueSig: DataSignal): string | null {
  const node = valueSig.get();
  if (isBlank(node)) return null;
  if (isLiteral(node) && typeof node.value === "string") return node.value;
  throw new TypeError(ERR.textOrBlank);
}

export function numOr(valueSig: DataSignal, defaultNumber: number): number {
  return numOpt(valueSig) ?? defaultNumber;
}

export function textOr(valueSig: DataSignal, defaultText: string): string {
  return textOpt(valueSig) ?? defaultText;
}

export function mapNums(
  mapNumbersToPrimitive: (...numbers: number[]) => Primitive
): (...argSigs: DataSignal[]) => DataSignal {
  return (...argSigs: DataSignal[]) => {
    const numbers = argSigs.map(numOpt);
    if (numbers.some((n) => n === null)) return blank();
    return lit(mapNumbersToPrimitive(...(numbers as number[])));
  };
}

/* Coercions */

function toBool(node: DataNode): DataNode {
  if (isBlank(node)) return createBlank();
  if (isLiteral(node)) {
    const v = node.value;
    if (v === true) return createLiteral(true);
    if (typeof v === "number")
      return v !== 0 ? createLiteral(true) : createBlank();
    if (typeof v === "string")
      return v.length > 0 ? createLiteral(true) : createBlank();
    return createBlank();
  }
  if (isBlock(node)) {
    return node.values.length > 0 || node.items.length > 0
      ? createLiteral(true)
      : createBlank();
  }
  return createBlank();
}

function toText(node: DataNode): DataNode {
  if (isBlank(node)) return createBlank();
  if (isLiteral(node)) return createLiteral(String(node.value));
  return createBlank();
}

function toNumber(node: DataNode): DataNode {
  if (isBlank(node)) return createBlank();
  if (isLiteral(node)) {
    const v = node.value;
    if (typeof v === "number") return createLiteral(v);
    if (v === true) return createLiteral(1);
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? createLiteral(n) : createBlank();
    }
  }
  return createBlank();
}

/* Helpers */

function blockNodes(n: BlockNode): DataNode[] {
  return [
    ...n.values.map(([, vs]) => childToData(vs)),
    ...n.items.map(childToData),
  ];
}

function blockNumsOpt(n: BlockNode): number[] {
  const out: number[] = [];
  for (const node of blockNodes(n)) {
    if (isBlank(node)) continue;
    if (isLiteral(node) && typeof node.value === "number") {
      out.push(node.value);
      continue;
    }
    throw new TypeError(ERR.numsOrBlank);
  }
  return out;
}

function blockTextsOpt(n: BlockNode): string[] {
  const out: string[] = [];
  for (const node of blockNodes(n)) {
    if (isBlank(node)) continue;
    if (isLiteral(node) && typeof node.value === "string") {
      out.push(node.value);
      continue;
    }
    throw new TypeError(ERR.textsOrBlank);
  }
  return out;
}

type BlockEntry =
  | { kind: "value"; child: ChildSignal; id: string }
  | { kind: "item"; child: ChildSignal; id: number };

function blockEntries(src: BlockNode): BlockEntry[] {
  const vals = src.values.map<BlockEntry>(([key, child]) => ({
    kind: "value",
    child,
    id: key,
  }));
  const items = src.items.map<BlockEntry>((child, j) => ({
    kind: "item",
    child,
    id: j + 1,
  }));
  return vals.concat(items);
}

function sortKeyFor(
  keySelector: DataNode,
  child: ChildSignal,
  id: string | number
): DataNode {
  if (isBlank(keySelector)) {
    return childToData(child);
  }
  if (isFunction(keySelector)) {
    return keySelector.fn(createSignal(childToData(child)), lit(id)).get();
  }
  throw new TypeError("Expected function (key selector) or blank");
}

function sortRank(n: DataNode): [number, any] {
  // numbers < text (locale-aware, case-insensitive) < true < other < blank
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

function sortCmp<T extends { key: DataNode; idx: number }>(a: T, b: T): number {
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
  return a.idx - b.idx;
}

/* Library */

export function createLibrary(): Record<string, DataSignal> {
  return {
    /* Convertors */

    number_or: fn((valueSig = blank(), fallbackSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return lit(numOr(fallbackSig, 0));
      return lit(n);
    }),

    text_or: fn((valueSig = blank(), fallbackSig = blank()) => {
      const t = textOpt(valueSig);
      if (t === null) return lit(textOr(fallbackSig, ""));
      return lit(t);
    }),

    if_blank: fn((valueSig = blank(), fallbackSig = blank()) => {
      return isBlank(valueSig.get()) ? fallbackSig : valueSig;
    }),

    first_present: fn((...argSigs: DataSignal[]) => {
      for (const s of argSigs) if (!isBlank(s.get())) return s;
      return blank();
    }),

    /* Coercion */

    to_bool: fn((valueSig = blank()) => createSignal(toBool(valueSig.get()))),

    to_text: fn((valueSig = blank()) => createSignal(toText(valueSig.get()))),

    to_number: fn((valueSig = blank()) =>
      createSignal(toNumber(valueSig.get()))
    ),

    /* Logic */

    not: fn((valueSig = blank()) => bool(!asJsBool(valueSig))),

    and: fn((leftSig = blank(), rightSig = blank()) =>
      bool(asJsBool(leftSig) && asJsBool(rightSig))
    ),

    or: fn((leftSig = blank(), rightSig = blank()) =>
      bool(asJsBool(leftSig) || asJsBool(rightSig))
    ),

    all: fn((...argSigs: DataSignal[]) =>
      bool(argSigs.every((sig) => !isBlank(sig.get())))
    ),

    any: fn((...argSigs: DataSignal[]) =>
      bool(argSigs.some((sig) => !isBlank(sig.get())))
    ),

    /* Number */

    abs: fn((valueSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return blank();
      return lit(Math.abs(n));
    }),

    round: fn((valueSig = blank(), placesSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return blank();
      const p = numOr(placesSig, 0);
      const f = 10 ** p;
      return lit(Math.round(n * f) / f);
    }),

    ceil: fn((valueSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return blank();
      return lit(Math.ceil(n));
    }),

    floor: fn((valueSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return blank();
      return lit(Math.floor(n));
    }),

    clamp: fn((valueSig = blank(), minSig = blank(), maxSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return blank();
      const minV = numOr(minSig, Number.NEGATIVE_INFINITY);
      const maxV = numOr(maxSig, Number.POSITIVE_INFINITY);
      return lit(Math.min(Math.max(n, minV), maxV));
    }),

    pow: fn((baseSig = blank(), exponentSig = blank()) => {
      const base = numOpt(baseSig);
      if (base === null) return blank();
      return lit(base ** numOr(exponentSig, 1));
    }),

    sqrt: fn((valueSig = blank()) => {
      const n = numOpt(valueSig);
      if (n === null) return blank();
      return lit(Math.sqrt(n));
    }),

    mod: fn((dividendSig = blank(), modulusSig = blank()) => {
      const d = numOpt(dividendSig);
      if (d === null) return blank();
      const m = numOr(modulusSig, 1);
      return lit(((d % m) + m) % m);
    }),

    /* Text */

    trim: fn((textSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      return lit(t.trim());
    }),

    starts_with: fn((textSig = blank(), prefixSig = blank()) => {
      const t = textOpt(textSig),
        p = textOpt(prefixSig);
      if (t === null || p === null) return blank();
      return bool(t.startsWith(p));
    }),

    ends_with: fn((textSig = blank(), suffixSig = blank()) => {
      const t = textOpt(textSig),
        s = textOpt(suffixSig);
      if (t === null || s === null) return blank();
      return bool(t.endsWith(s));
    }),

    contains: fn((textSig = blank(), searchSig = blank()) => {
      const t = textOpt(textSig),
        s = textOpt(searchSig);
      if (t === null || s === null) return blank();
      return bool(t.includes(s));
    }),

    lower: fn((textSig = blank()) => {
      const t = textOpt(textSig);
      return t === null ? blank() : lit(t.toLowerCase());
    }),

    upper: fn((textSig = blank()) => {
      const t = textOpt(textSig);
      return t === null ? blank() : lit(t.toUpperCase());
    }),

    capitalize: fn((textSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      return lit(t ? t.charAt(0).toUpperCase() + t.slice(1) : "");
    }),

    replace: fn(
      (textSig = blank(), searchSig = blank(), replacementSig = blank()) => {
        const t = textOpt(textSig),
          s = textOpt(searchSig),
          r = textOpt(replacementSig);
        if (t === null || s === null || r === null) return blank();
        return lit(t.replaceAll(s, r));
      }
    ),

    index_of: fn(
      (textSig = blank(), searchSig = blank(), fromIndexSig = blank()) => {
        const t = textOpt(textSig);
        if (t === null) return blank();
        return lit(t.indexOf(textOr(searchSig, ""), numOr(fromIndexSig, 0)));
      }
    ),

    pad_start: fn(
      (textSig = blank(), targetLengthSig = blank(), padTextSig = blank()) => {
        const t = textOpt(textSig);
        if (t === null) return blank();
        return lit(
          t.padStart(numOr(targetLengthSig, 0), textOr(padTextSig, " "))
        );
      }
    ),

    pad_end: fn(
      (textSig = blank(), targetLengthSig = blank(), padTextSig = blank()) => {
        const t = textOpt(textSig);
        if (t === null) return blank();
        return lit(
          t.padEnd(numOr(targetLengthSig, 0), textOr(padTextSig, " "))
        );
      }
    ),

    split: fn(
      (textSig = blank(), separatorSig = blank(), limitSig = blank()) => {
        const t = textOpt(textSig);
        if (t === null) return blank();
        const sep = textOr(separatorSig, "");
        const limit = numOpt(limitSig);
        const parts = limit === null ? t.split(sep) : t.split(sep, limit);
        return createSignal(
          createBlock(
            {},
            parts.map((part) => lit(part))
          )
        );
      }
    ),

    repeat: fn((textSig = blank(), timesSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      const times = Math.max(0, Math.floor(numOr(timesSig, 0)));
      return lit(t.repeat(times));
    }),

    /* Blocks */

    count: fn((sourceSig = blank()) => {
      const n = sourceSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      return lit(
        blockNodes(n).reduce((acc, node) => acc + (isBlank(node) ? 0 : 1), 0)
      );
    }),

    count_blank: fn((sourceSig = blank()) => {
      const n = sourceSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      return lit(
        blockNodes(n).reduce((acc, node) => acc + (isBlank(node) ? 1 : 0), 0)
      );
    }),

    map: fn((sourceSig = blank(), fnSig = blank()) => {
      const src = sourceSig.get();
      if (!isBlock(src)) throw new TypeError(ERR.block);
      const f = fnSig.get();
      if (!isFunction(f)) throw new TypeError(ERR.func);

      const vals: [string, ChildSignal][] = [];
      const items: ChildSignal[] = [];

      for (const e of blockEntries(src)) {
        const out = createComputed(() =>
          f.fn(createSignal(childToData(e.child)), lit(e.id)).get()
        );
        e.kind === "value" ? vals.push([e.id, out]) : items.push(out);
      }

      return createSignal(createBlock(vals, items));
    }),

    filter: fn((sourceSig = blank(), predSig = blank()) => {
      const src = sourceSig.get();
      if (!isBlock(src)) throw new TypeError(ERR.block);
      const p = predSig.get();
      if (!isFunction(p)) throw new TypeError(ERR.func);

      const vals: [string, ChildSignal][] = [];
      const items: ChildSignal[] = [];

      for (const e of blockEntries(src)) {
        if (asJsBool(p.fn(createSignal(childToData(e.child)), lit(e.id)))) {
          e.kind === "value" ? vals.push([e.id, e.child]) : items.push(e.child);
        }
      }

      return createSignal(createBlock(vals, items));
    }),

    reduce: fn((sourceSig = blank(), fnSig = blank(), initSig = blank()) => {
      const src = sourceSig.get();
      if (!isBlock(src)) throw new TypeError(ERR.block);
      const rf = fnSig.get();
      if (!isFunction(rf)) throw new TypeError(ERR.func);

      const seq = blockEntries(src);
      if (seq.length === 0) return initSig;

      const reducer = (acc: DataSignal, e: BlockEntry) =>
        rf.fn(acc, createSignal(childToData(e.child)), lit(e.id));

      return !isBlank(initSig.get())
        ? seq.reduce(reducer, initSig)
        : seq
            .slice(1)
            .reduce(reducer, createSignal(childToData(seq[0]!.child)));
    }),

    sort: fn((sourceSig = blank(), keySig = blank()) => {
      const src = sourceSig.get();
      if (!isBlock(src)) throw new TypeError(ERR.block);

      const keySelector = keySig.get();

      const sortedValues = src.values
        .map(([id, child], idx) => ({
          id,
          child,
          idx,
          key: sortKeyFor(keySelector, child, id),
        }))
        .sort(sortCmp)
        .map(({ id, child }) => [id, child] as [string, ChildSignal]);

      const sortedItems = src.items
        .map((child, idx) => ({
          child,
          idx,
          key: sortKeyFor(keySelector, child, idx + 1),
        }))
        .sort(sortCmp)
        .map(({ child }) => child);

      return createSignal(createBlock(sortedValues, sortedItems));
    }),

    /* Number reducers */

    sum: fn((sourceSig = blank()) => {
      const n = sourceSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      const nums = blockNumsOpt(n);
      return nums.length ? lit(nums.reduce((a, b) => a + b, 0)) : blank();
    }),

    avg: fn((sourceSig = blank()) => {
      const n = sourceSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      const nums = blockNumsOpt(n);
      return nums.length
        ? lit(nums.reduce((a, b) => a + b, 0) / nums.length)
        : blank();
    }),

    min: fn((sourceSig = blank()) => {
      const n = sourceSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      const nums = blockNumsOpt(n);
      return nums.length ? lit(Math.min(...nums)) : blank();
    }),

    max: fn((sourceSig = blank()) => {
      const n = sourceSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      const nums = blockNumsOpt(n);
      return nums.length ? lit(Math.max(...nums)) : blank();
    }),

    /* Text reducers */

    join: fn((blockSig = blank(), separatorSig = blank()) => {
      const n = blockSig.get();
      if (!isBlock(n)) throw new TypeError(ERR.block);
      const sep = textOr(separatorSig, ",");
      const parts = blockTextsOpt(n);
      return parts.length ? lit(parts.join(sep)) : blank();
    }),
  };
}

export function withLibrary(
  root: DataSignal<BlockNode>
): DataSignal<BlockNode> {
  markCaseInsensitiveScope(createBlockSignal(createLibrary(), [root]));
  return root;
}
