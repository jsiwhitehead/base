import { type Signal, computed, signal } from "@preact/signals-core";
import { evalExpr } from "./code";

/* Static Types */

export type Primitive = string | number | boolean;

export type ResolvedBlock = {
  kind: "block";
  values: Record<string, ResolvedDeep>;
  items: ResolvedDeep[];
};

export type ResolvedDeep = ResolvedBlock | Primitive;

/* Node Types */

export type LiteralNode = {
  kind: "literal";
  value: Primitive;
};

export type BlockNode = {
  kind: "block";
  values: Record<string, Box>;
  items: Box[];
};

export type Resolved = BlockNode | LiteralNode;

export type CodeNode = {
  kind: "code";
  code: Signal<string>;
  result: Signal<Resolved>;
};

export type Node = CodeNode | Resolved;

/* Box Types */

export type Box<T extends Node = Node> = {
  kind: "box";
  value: Signal<T>;
  parent?: BlockBox;
};

export type BlockBox = Box<BlockNode>;

/* Type Guards */

function hasKind(v: unknown, k: string): boolean {
  return typeof v === "object" && v !== null && (v as any).kind === k;
}

export function isLiteral(v: Node): v is LiteralNode {
  return hasKind(v, "literal");
}

export function isBlock(v: Node): v is BlockNode {
  return hasKind(v, "block");
}

export function isCode(v: Node): v is CodeNode {
  return hasKind(v, "code");
}

/* Scope */

export function lookupInScope(start: BlockBox | undefined, name: string): Box {
  for (let cur = start; cur; cur = cur.parent) {
    const hit = cur.value.value.values[name];
    if (hit !== undefined) return hit;
  }
  throw new Error(`Unbound identifier: ${name}`);
}

/* Constructors */

export function makeLiteral(value: Primitive): LiteralNode {
  return { kind: "literal", value };
}

export function makeBlock(
  values: Record<string, Box> = {},
  items: Box[] = []
): BlockNode {
  const block: BlockNode = { kind: "block", values: {}, items: [] };
  return build(block, values, items);
}

export function makeCode(code: Signal<string>, parent?: BlockBox): CodeNode {
  const result = computed(() => {
    const getter = (name: string): Box => lookupInScope(parent, name);
    return evalExpr(code.value, getter);
  });
  return { kind: "code", code, result };
}

export function makeBox<T extends Node>(initial: T, parent?: BlockBox): Box<T> {
  return { kind: "box", value: signal<T>(initial), parent };
}

/* Resolve */

export function resolveShallow(b: Box): Resolved {
  const v = b.value.value;
  if (isCode(v)) return v.result.value;
  return v;
}

export function resolveDeep(b: Box): ResolvedDeep {
  const n = resolveShallow(b);
  if (n.kind === "literal") return n.value;
  const values = Object.fromEntries(
    Object.entries(n.values).map(([k, v]) => [k, resolveDeep(v)])
  );
  const items = n.items.map(resolveDeep);
  return { kind: "block", values, items };
}

/* Helpers */

function build(
  block: BlockNode,
  values: BlockNode["values"],
  items: BlockNode["items"]
): BlockNode {
  const next: BlockNode = {
    kind: "block",
    values,
    items,
  };
  return next;
}

function insertItemAt(
  block: BlockNode,
  index: number,
  newItem: Box
): BlockNode {
  return build(block, block.values, block.items.toSpliced(index, 0, newItem));
}

/* Queries */

export function keyOfChild(block: BlockNode, child: Box): string | undefined {
  return Object.entries(block.values).find(([, v]) => v === child)?.[0];
}

export function orderedChildren(block: BlockNode): Box[] {
  return [...Object.values(block.values), ...block.items];
}

/* Transformations */

export function renameChildKey(
  block: BlockNode,
  child: Box,
  nextKey: string
): BlockNode {
  const currentKey = keyOfChild(block, child);
  if (!currentKey) return block;
  if (!nextKey || nextKey === currentKey) return block;
  if (nextKey in block.values && nextKey !== currentKey) return block;

  const newValues = { ...block.values };
  delete newValues[currentKey];
  newValues[nextKey] = child;
  return build(block, newValues, block.items);
}

export function convertValueToItem(block: BlockNode, child: Box): BlockNode {
  const key = keyOfChild(block, child);
  if (!key) return block;
  const { [key]: _removed, ...rest } = block.values;
  return build(block, rest, [child, ...block.items]);
}

export function removeChild(block: BlockNode, child: Box): BlockNode {
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

export function replaceChild(
  block: BlockNode,
  target: Box,
  next: Box
): BlockNode {
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
  block: BlockNode,
  referenceItem: Box,
  newItem: Box
): BlockNode {
  const idx = block.items.indexOf(referenceItem);
  if (idx < 0) return block;
  return insertItemAt(block, idx, newItem);
}

export function insertItemAfter(
  block: BlockNode,
  referenceItem: Box,
  newItem: Box
): BlockNode {
  const idx = block.items.indexOf(referenceItem);
  if (idx < 0) return block;
  return insertItemAt(block, idx + 1, newItem);
}

export function itemToKeyValue(
  block: BlockNode,
  item: Box,
  key: string
): BlockNode {
  const idx = block.items.indexOf(item);
  if (idx < 0) return block;
  return build(
    block,
    { ...block.values, [key]: item },
    block.items.toSpliced(idx, 1)
  );
}

export function keyValueToItem(block: BlockNode, key: string): BlockNode {
  if (!(key in block.values)) return block;
  const { [key]: value, ...rest } = block.values;
  const idx = Math.max(0, Math.min(0, block.items.length));
  return build(block, rest, block.items.toSpliced(idx, 0, value!));
}

export function wrapChildInShallowBlock(
  block: BlockNode,
  child: Box
): BlockNode {
  const wrapperBox = makeBox(makeBlock({}, [child]), child.parent);
  return replaceChild(block, child, wrapperBox);
}

export function unwrapSingleChildBlock(
  block: BlockNode,
  wrapper: BlockBox
): BlockNode {
  const children = orderedChildren(wrapper.value.value);
  if (children.length !== 1) return block;
  return replaceChild(block, wrapper, children[0]!);
}
