import {
  type Primitive,
  type BlockNode,
  type DataNode,
  type DataSignal,
  isBlank,
  isLiteral,
  isBlock,
  createBlank,
  createLiteral,
  createBlock,
  createFunction,
  createSignal,
  createBlockSignal,
  resolveItems,
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
  numsOrBlank: "Expected numbers or blanks (including flat blocks)",
  texts: "Expected texts (including flat blocks)",
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

function collectOneLevel<T>(
  sourceSig: DataSignal,
  mapItem: (node: DataNode) => T | undefined
): T[] {
  const sourceNode = sourceSig.get();
  const items = isBlock(sourceNode) ? resolveItems(sourceNode) : [sourceNode];
  return items.flatMap((itemNode) => {
    const mapped = mapItem(itemNode);
    return mapped === undefined ? [] : [mapped];
  });
}

function numbersFlatOrBlank(sourceSig: DataSignal): number[] {
  return collectOneLevel(sourceSig, (node) => {
    if (isBlank(node)) return undefined;
    if (isLiteral(node) && typeof node.value === "number") return node.value;
    throw new TypeError(ERR.numsOrBlank);
  });
}

function textsFlatRequired(sourceSig: DataSignal): string[] {
  return collectOneLevel(sourceSig, (node) => {
    if (isBlank(node)) throw new TypeError(ERR.texts);
    if (isLiteral(node) && typeof node.value === "string") return node.value;
    throw new TypeError(ERR.texts);
  });
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

    /* Counting */

    count: fn((sourceSig = blank()) => {
      const node = sourceSig.get();
      const nodes = isBlock(node) ? resolveItems(node) : [node];
      return lit(nodes.reduce((n, v) => n + (isBlank(v) ? 0 : 1), 0));
    }),

    count_blank: fn((sourceSig = blank()) => {
      const node = sourceSig.get();
      const nodes = isBlock(node) ? resolveItems(node) : [node];
      return lit(nodes.reduce((n, v) => n + (isBlank(v) ? 1 : 0), 0));
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

    sum: fn((...argSigs: DataSignal[]) => {
      const nums = argSigs.flatMap(numbersFlatOrBlank);
      if (!nums.length) return blank();
      return lit(nums.reduce((a, b) => a + b, 0));
    }),

    avg: fn((...argSigs: DataSignal[]) => {
      const nums = argSigs.flatMap(numbersFlatOrBlank);
      if (!nums.length) return blank();
      return lit(nums.reduce((a, b) => a + b, 0) / nums.length);
    }),

    min: fn((...argSigs: DataSignal[]) => {
      const nums = argSigs.flatMap(numbersFlatOrBlank);
      if (!nums.length) return blank();
      return lit(Math.min(...nums));
    }),

    max: fn((...argSigs: DataSignal[]) => {
      const nums = argSigs.flatMap(numbersFlatOrBlank);
      if (!nums.length) return blank();
      return lit(Math.max(...nums));
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

    len: fn((textSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      return lit(t.length);
    }),

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

    replace: fn(
      (textSig = blank(), searchSig = blank(), replacementSig = blank()) => {
        const t = textOpt(textSig),
          s = textOpt(searchSig),
          r = textOpt(replacementSig);
        if (t === null || s === null || r === null) return blank();
        return lit(t.replaceAll(s, r));
      }
    ),

    slice: fn((textSig = blank(), startSig = blank(), endSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      const start = numOr(startSig, 0);
      const end = numOpt(endSig);
      return lit(t.slice(start, end ?? undefined));
    }),

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

    join: fn((blockSig = blank(), separatorSig = blank()) => {
      const node = blockSig.get();
      if (isBlank(node)) return blank();
      return lit(textsFlatRequired(blockSig).join(textOr(separatorSig, ",")));
    }),

    capitalize: fn((textSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      return lit(t ? t.charAt(0).toUpperCase() + t.slice(1) : "");
    }),

    repeat: fn((textSig = blank(), timesSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      const times = Math.max(0, Math.floor(numOr(timesSig, 0)));
      return lit(t.repeat(times));
    }),

    left: fn((textSig = blank(), countSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      const count = Math.max(0, Math.floor(numOr(countSig, 0)));
      return lit(t.slice(0, count));
    }),

    right: fn((textSig = blank(), countSig = blank()) => {
      const t = textOpt(textSig);
      if (t === null) return blank();
      const count = Math.max(0, Math.floor(numOr(countSig, 0)));
      return lit(count ? t.slice(-count) : "");
    }),
  };
}

export function withLibrary(
  root: DataSignal<BlockNode>
): DataSignal<BlockNode> {
  markCaseInsensitiveScope(createBlockSignal(createLibrary(), [root]));
  return root;
}
