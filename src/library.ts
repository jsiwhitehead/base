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
    convert: createSignal(
      createBlock(
        {
          to_bool: fn((valueSig = blank()) =>
            createSignal(toBool(valueSig.get()))
          ),
          to_text: fn((valueSig = blank()) =>
            createSignal(toText(valueSig.get()))
          ),
          to_number: fn((valueSig = blank()) =>
            createSignal(toNumber(valueSig.get()))
          ),
        },
        []
      )
    ),

    logic: createSignal(
      createBlock(
        {
          not: fn((valueSig = blank()) => {
            return bool(!asJsBool(valueSig));
          }),

          and: fn((leftSig = blank(), rightSig = blank()) => {
            return bool(asJsBool(leftSig) && asJsBool(rightSig));
          }),

          or: fn((leftSig = blank(), rightSig = blank()) => {
            return bool(asJsBool(leftSig) || asJsBool(rightSig));
          }),

          all: fn((...argSigs: DataSignal[]) =>
            bool(argSigs.every((sig) => !isBlank(sig.get())))
          ),

          any: fn((...argSigs: DataSignal[]) =>
            bool(argSigs.some((sig) => !isBlank(sig.get())))
          ),
        },
        []
      )
    ),

    number: createSignal(
      createBlock(
        {
          abs: fn((valueSig = blank()) => {
            const valueNumber = numOpt(valueSig);
            if (valueNumber === null) return blank();
            return lit(Math.abs(valueNumber));
          }),

          round: fn((valueSig = blank(), placesSig = blank()) => {
            const valueNumber = numOpt(valueSig);
            if (valueNumber === null) return blank();
            const decimalPlaces = numOr(placesSig, 0);
            const factor = 10 ** decimalPlaces;
            return lit(Math.round(valueNumber * factor) / factor);
          }),

          ceil: fn((valueSig = blank()) => {
            const valueNumber = numOpt(valueSig);
            if (valueNumber === null) return blank();
            return lit(Math.ceil(valueNumber));
          }),

          floor: fn((valueSig = blank()) => {
            const valueNumber = numOpt(valueSig);
            if (valueNumber === null) return blank();
            return lit(Math.floor(valueNumber));
          }),

          clamp: fn(
            (valueSig = blank(), minSig = blank(), maxSig = blank()) => {
              const valueNumber = numOpt(valueSig);
              if (valueNumber === null) return blank();
              const minValue = numOr(minSig, Number.NEGATIVE_INFINITY);
              const maxValue = numOr(maxSig, Number.POSITIVE_INFINITY);
              return lit(Math.min(Math.max(valueNumber, minValue), maxValue));
            }
          ),

          sum: fn((...argSigs: DataSignal[]) => {
            const numbersFlat = argSigs.flatMap(numbersFlatOrBlank);
            if (numbersFlat.length === 0) return blank();
            return lit(numbersFlat.reduce((a, b) => a + b, 0));
          }),

          avg: fn((...argSigs: DataSignal[]) => {
            const numbersFlat = argSigs.flatMap(numbersFlatOrBlank);
            if (numbersFlat.length === 0) return blank();
            return lit(
              numbersFlat.reduce((a, b) => a + b, 0) / numbersFlat.length
            );
          }),

          min: fn((...argSigs: DataSignal[]) => {
            const numbersFlat = argSigs.flatMap(numbersFlatOrBlank);
            if (numbersFlat.length === 0) return blank();
            return lit(Math.min(...numbersFlat));
          }),

          max: fn((...argSigs: DataSignal[]) => {
            const numbersFlat = argSigs.flatMap(numbersFlatOrBlank);
            if (numbersFlat.length === 0) return blank();
            return lit(Math.max(...numbersFlat));
          }),

          pow: fn((baseSig = blank(), exponentSig = blank()) => {
            const baseNumber = numOpt(baseSig);
            if (baseNumber === null) return blank();
            return lit(baseNumber ** numOr(exponentSig, 1));
          }),

          sqrt: fn((valueSig = blank()) => {
            const valueNumber = numOpt(valueSig);
            if (valueNumber === null) return blank();
            return lit(Math.sqrt(valueNumber));
          }),

          mod: fn((dividendSig = blank(), modulusSig = blank()) => {
            const dividendNumber = numOpt(dividendSig);
            if (dividendNumber === null) return blank();
            const modulus = numOr(modulusSig, 1);
            return lit(((dividendNumber % modulus) + modulus) % modulus);
          }),
        },
        []
      )
    ),

    text: createSignal(
      createBlock(
        {
          len: fn((textSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            return lit(text.length);
          }),

          trim: fn((textSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            return lit(text.trim());
          }),

          starts_with: fn((textSig = blank(), prefixSig = blank()) => {
            const text = textOpt(textSig);
            const prefix = textOpt(prefixSig);
            if (text === null || prefix === null) return blank();
            return bool(text.startsWith(prefix));
          }),

          ends_with: fn((textSig = blank(), suffixSig = blank()) => {
            const text = textOpt(textSig);
            const suffix = textOpt(suffixSig);
            if (text === null || suffix === null) return blank();
            return bool(text.endsWith(suffix));
          }),

          contains: fn((textSig = blank(), searchSig = blank()) => {
            const text = textOpt(textSig);
            const search = textOpt(searchSig);
            if (text === null || search === null) return blank();
            return bool(text.includes(search));
          }),

          lower: fn((textSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            return lit(text.toLowerCase());
          }),

          upper: fn((textSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            return lit(text.toUpperCase());
          }),

          replace: fn(
            (
              textSig = blank(),
              searchSig = blank(),
              replacementSig = blank()
            ) => {
              const text = textOpt(textSig);
              const search = textOpt(searchSig);
              const replacement = textOpt(replacementSig);
              if (text === null || search === null || replacement === null)
                return blank();
              return lit(text.replaceAll(search, replacement));
            }
          ),

          slice: fn(
            (textSig = blank(), startSig = blank(), endSig = blank()) => {
              const text = textOpt(textSig);
              if (text === null) return blank();
              const startIndex = numOr(startSig, 0);
              const endIndex = numOpt(endSig);
              return lit(text.slice(startIndex, endIndex ?? undefined));
            }
          ),

          index_of: fn(
            (
              textSig = blank(),
              searchSig = blank(),
              fromIndexSig = blank()
            ) => {
              const text = textOpt(textSig);
              if (text === null) return blank();
              const searchText = textOr(searchSig, "");
              const fromIndex = numOr(fromIndexSig, 0);
              return lit(text.indexOf(searchText, fromIndex));
            }
          ),

          pad_start: fn(
            (
              textSig = blank(),
              targetLengthSig = blank(),
              padTextSig = blank()
            ) => {
              const text = textOpt(textSig);
              if (text === null) return blank();
              const targetLength = numOr(targetLengthSig, 0);
              const padText = textOr(padTextSig, " ");
              return lit(text.padStart(targetLength, padText));
            }
          ),

          pad_end: fn(
            (
              textSig = blank(),
              targetLengthSig = blank(),
              padTextSig = blank()
            ) => {
              const text = textOpt(textSig);
              if (text === null) return blank();
              const targetLength = numOr(targetLengthSig, 0);
              const padText = textOr(padTextSig, " ");
              return lit(text.padEnd(targetLength, padText));
            }
          ),

          split: fn(
            (textSig = blank(), separatorSig = blank(), limitSig = blank()) => {
              const text = textOpt(textSig);
              if (text === null) return blank();
              const separator = textOr(separatorSig, "");
              const limit = numOpt(limitSig);
              const parts =
                limit === null
                  ? text.split(separator)
                  : text.split(separator, limit);
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
            return lit(
              textsFlatRequired(blockSig).join(textOr(separatorSig, ","))
            );
          }),

          capitalize: fn((textSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            return lit(
              text ? text.charAt(0).toUpperCase() + text.slice(1) : ""
            );
          }),

          repeat: fn((textSig = blank(), timesSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            const times = Math.max(0, Math.floor(numOr(timesSig, 0)));
            return lit(text.repeat(times));
          }),

          left: fn((textSig = blank(), countSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            const count = Math.max(0, Math.floor(numOr(countSig, 0)));
            return lit(text.slice(0, count));
          }),

          right: fn((textSig = blank(), countSig = blank()) => {
            const text = textOpt(textSig);
            if (text === null) return blank();
            const count = Math.max(0, Math.floor(numOr(countSig, 0)));
            return lit(count ? text.slice(-count) : "");
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
  createBlockSignal(createLibrary(), [root]);
  return root;
}
