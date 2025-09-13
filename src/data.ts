import {
  type Signal as BaseSignal,
  computed,
  signal,
} from "@preact/signals-core";
import { evalExpr } from "./code";

/* Static Types */

export type Primitive = string | number | boolean;

export type ResolvedBlock = {
  kind: "block";
  values: Record<string, ResolvedDeep>;
  items: ResolvedDeep[];
};

export type ResolvedDeep = ResolvedBlock | Primitive;

/* Resolved Types */

export type Literal = {
  kind: "literal";
  parentContainer?: BaseSignal<NonSignal>;
  value: Primitive;
};

export type Block = {
  kind: "block";
  parentContainer?: BaseSignal<NonSignal>;
  container?: BaseSignal<NonSignal>;
  values: Record<string, Value>;
  items: Value[];
};

export type Resolved = Block | Literal;

/* Signal Types */

export type Code = {
  kind: "code";
  parentContainer?: BaseSignal<NonSignal>;
  code: BaseSignal<string>;
  result: BaseSignal<Resolved>;
};

export type Signal = {
  kind: "signal";
  parentContainer?: BaseSignal<NonSignal>;
  value: BaseSignal<NonSignal>;
};

export type NonSignal = Code | Resolved;

export type Value = Signal | Code | Resolved;

/* Type Guards */

const hasKind = (v: unknown, k: string): boolean =>
  typeof v === "object" && v !== null && (v as any).kind === k;

export function isLiteral(v: Value): v is Literal {
  return hasKind(v, "literal");
}

export function isBlock(v: Value): v is Block {
  return hasKind(v, "block");
}

export function isCode(v: Value): v is Code {
  return hasKind(v, "code");
}

export function isSignal(v: Value): v is Signal {
  return hasKind(v, "signal");
}

/* Scope */

function parentBlockFromContainer(
  parentContainer?: BaseSignal<NonSignal>
): Block | undefined {
  if (!parentContainer) return undefined;
  const maybe = parentContainer.value;
  return isBlock(maybe) ? maybe : undefined;
}

export function lookupScope(start: Block | undefined, name: string): Value {
  for (
    let cur = start;
    cur;
    cur = parentBlockFromContainer(cur.parentContainer)
  ) {
    const hit = cur.values[name];
    if (hit !== undefined) return hit;
  }
  throw new Error(`Unbound identifier: ${name}`);
}

/* Constructors */

export function makeLiteral(
  value: Primitive,
  parent?: Block | undefined
): Literal {
  return { kind: "literal", parentContainer: parent?.container, value };
}

export function makeBlock(
  values: Record<string, Value> = {},
  items: Value[] = [],
  parent?: Block | undefined
): Block {
  const base: Block = {
    kind: "block",
    parentContainer: parent?.container,
    values: {},
    items: [],
  };
  return build(base, values, items);
}

export function makeCode(expr: BaseSignal<string>, parent?: Block): Code {
  const parentContainer = parent?.parentContainer;
  const result = computed(() => {
    const start = parentBlockFromContainer(parentContainer);
    const getter = (name: string): Value => lookupScope(start, name);
    return evalExpr(expr.value, getter);
  });
  return { kind: "code", parentContainer, code: expr, result };
}

export function makeSignal(
  initial: NonSignal,
  parent?: Block | undefined
): Signal {
  const valueSignal = signal(initial);
  if (isBlock(initial)) initial.container = valueSignal;
  const parentContainer = parent?.container;
  const sig: Signal = { kind: "signal", parentContainer, value: valueSignal };
  setParentContainerIfNeeded(sig, parent);
  return sig;
}

/* Resolve */

export function resolve(v: Value): Resolved {
  if (isCode(v)) {
    return v.result.value;
  }
  if (isSignal(v)) {
    const inner = v.value.value;
    if (isCode(inner)) return inner.result.value;
    return inner;
  }
  return v;
}

export function resolveDeep(v: Value): ResolvedDeep {
  const r = resolve(v);
  if (isLiteral(r)) return r.value;
  const values = Object.fromEntries(
    Object.entries(r.values).map(([k, val]) => [k, resolveDeep(val)])
  );
  const items = r.items.map(resolveDeep);
  return { kind: "block", values, items };
}

/* Helpers */

function setParentContainerIfNeeded(v: Value, to?: Block): void {
  const parentContainer = to?.container;
  (v as any).parentContainer = parentContainer;
  if (isSignal(v)) {
    const x = v.value.peek();
    if (isLiteral(x) || isBlock(x) || isCode(x)) {
      (x as any).parentContainer = parentContainer;
      if (isBlock(x)) x.container = v.value;
    }
  }
}

function build(
  block: Block,
  values: Block["values"],
  items: Block["items"]
): Block {
  const next: Block = { ...block, values, items };
  for (const v of Object.values(values)) setParentContainerIfNeeded(v, next);
  for (const i of items) setParentContainerIfNeeded(i, next);
  return next;
}

function insertItemAt(block: Block, index: number, newItem: Value): Block {
  return build(block, block.values, block.items.toSpliced(index, 0, newItem));
}

/* Queries */

export function keyOfChild(block: Block, child: Value): string | undefined {
  return Object.entries(block.values).find(([, v]) => v === child)?.[0];
}

export function orderedChildren(block: Block): Value[] {
  return [...Object.values(block.values), ...block.items];
}

/* Transformations */

export function renameChildKey(
  block: Block,
  child: Value,
  nextKey: string
): Block {
  const currentKey = keyOfChild(block, child);
  if (!currentKey) return block;
  if (!nextKey || nextKey === currentKey) return block;
  if (nextKey in block.values && nextKey !== currentKey) return block;

  const newValues = { ...block.values };
  delete newValues[currentKey];
  newValues[nextKey] = child;
  return build(block, newValues, block.items);
}

export function convertValueToItem(block: Block, child: Value): Block {
  const key = keyOfChild(block, child);
  if (!key) return block;
  const { [key]: _removed, ...rest } = block.values;
  return build(block, rest, [child, ...block.items]);
}

export function removeChild(block: Block, child: Value): Block {
  const idx = block.items.indexOf(child);
  if (idx >= 0) {
    return build(block, block.values, block.items.toSpliced(idx, 1));
  }
  const key = keyOfChild(block, child);
  if (key) {
    const { [key]: _removed, ...rest } = block.values;
    return build(block, rest, block.items);
  }
  return block;
}

export function replaceChild(block: Block, target: Value, next: Value): Block {
  const idx = block.items.indexOf(target);
  if (idx >= 0) {
    return build(block, block.values, block.items.toSpliced(idx, 1, next));
  }
  const key = keyOfChild(block, target);
  if (key) {
    return build(block, { ...block.values, [key]: next }, block.items);
  }
  return block;
}

export function insertItemBefore(
  block: Block,
  referenceItem: Value,
  newItem: Value
): Block {
  const idx = block.items.indexOf(referenceItem);
  if (idx < 0) return block;
  return insertItemAt(block, idx, newItem);
}

export function insertItemAfter(
  block: Block,
  referenceItem: Value,
  newItem: Value
): Block {
  const idx = block.items.indexOf(referenceItem);
  if (idx < 0) return block;
  return insertItemAt(block, idx + 1, newItem);
}

export function itemToKeyValue(block: Block, item: Value, key: string): Block {
  const idx = block.items.indexOf(item);
  if (idx < 0) return block;
  return build(
    block,
    { ...block.values, [key]: item },
    block.items.toSpliced(idx, 1)
  );
}

export function keyValueToItem(block: Block, key: string, atIndex = 0): Block {
  if (!(key in block.values)) return block;
  const { [key]: value, ...rest } = block.values;
  const idx = Math.max(0, Math.min(atIndex, block.items.length));
  return build(block, rest, block.items.toSpliced(idx, 0, value!));
}

export function wrapChildInShallowBlock(block: Block, child: Value): Block {
  return replaceChild(block, child, makeBlock({}, [child], block));
}

export function unwrapSingleChildBlock(block: Block, wrapper: Block): Block {
  const children = orderedChildren(wrapper);
  if (children.length !== 1) return block;
  return replaceChild(block, wrapper, children[0]!);
}
