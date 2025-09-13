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
  return { kind: "block", values, items };
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

type ChildLoc =
  | { kind: "item"; index: number }
  | { kind: "value"; key: string };

function withParentBlock(child: Box, f: (block: BlockNode) => BlockNode) {
  if (!child.parent) return;
  child.parent.value.value = f(child.parent.value.peek());
}

function locateChildIn(block: BlockNode, child: Box): ChildLoc | undefined {
  const idx = block.items.indexOf(child);
  if (idx >= 0) return { kind: "item", index: idx };
  const key = Object.entries(block.values).find(([, v]) => v === child)?.[0];
  return key ? { kind: "value", key } : undefined;
}

function withoutKey<T>(obj: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _removed, ...rest } = obj;
  return rest;
}

function updateParentAt(
  child: Box,
  op: (block: BlockNode, loc: ChildLoc) => BlockNode
) {
  withParentBlock(child, (block) => {
    const loc = locateChildIn(block, child);
    if (!loc) return block;
    return op(block, loc);
  });
}

function replaceAt(block: BlockNode, loc: ChildLoc, next: Box): BlockNode {
  return loc.kind === "item"
    ? makeBlock(block.values, block.items.toSpliced(loc.index, 1, next))
    : makeBlock({ ...block.values, [loc.key]: next }, block.items);
}

function removeAt(block: BlockNode, loc: ChildLoc): BlockNode {
  return loc.kind === "item"
    ? makeBlock(block.values, block.items.toSpliced(loc.index, 1))
    : makeBlock(withoutKey(block.values, loc.key), block.items);
}

function insertItemAt(block: BlockNode, index: number, item: Box): BlockNode {
  return makeBlock(block.values, block.items.toSpliced(index, 0, item));
}

function orderedChildren(block: BlockNode): Box[] {
  return [...Object.values(block.values), ...block.items];
}

export function keyOfChild(child: Box): string | undefined {
  if (!child.parent) return undefined;
  const block = child.parent.value.peek();
  const loc = locateChildIn(block, child);
  return loc?.kind === "value" ? loc.key : undefined;
}

/* Transformations */

export function renameChildKey(child: Box, nextKey: string) {
  updateParentAt(child, (block, loc) => {
    if (loc.kind !== "value") return block;
    const currentKey = loc.key;
    if (!nextKey || nextKey === currentKey) return block;
    if (nextKey in block.values && nextKey !== currentKey) return block;

    const rest = withoutKey(block.values, currentKey);
    return makeBlock({ ...rest, [nextKey]: child }, block.items);
  });
}

export function convertValueToItem(child: Box) {
  updateParentAt(child, (block, loc) => {
    if (loc.kind !== "value") return block;
    const rest = withoutKey(block.values, loc.key);
    return insertItemAt(makeBlock(rest, block.items), 0, child);
  });
}

export function removeChild(child: Box) {
  updateParentAt(child, (block, loc) => removeAt(block, loc));
}

export function replaceChild(target: Box, next: Box) {
  updateParentAt(target, (block, loc) => replaceAt(block, loc, next));
}

export function insertItemBefore(referenceItem: Box, newItem: Box) {
  updateParentAt(referenceItem, (block, loc) => {
    if (loc.kind !== "item") return block;
    return insertItemAt(block, loc.index, newItem);
  });
}

export function insertItemAfter(referenceItem: Box, newItem: Box) {
  updateParentAt(referenceItem, (block, loc) => {
    if (loc.kind !== "item") return block;
    return insertItemAt(block, loc.index + 1, newItem);
  });
}

export function itemToKeyValue(item: Box, key: string) {
  updateParentAt(item, (block, loc) => {
    if (loc.kind !== "item" || !key) return block;
    return makeBlock(
      { ...block.values, [key]: item },
      block.items.toSpliced(loc.index, 1)
    );
  });
}

export function keyValueToItem(contextChild: Box, key: string) {
  withParentBlock(contextChild, (block) => {
    if (!(key in block.values)) return block;
    const value = block.values[key]!;
    const rest = withoutKey(block.values, key);
    return insertItemAt(makeBlock(rest, block.items), 0, value);
  });
}

export function wrapChildInShallowBlock(child: Box) {
  const parentBox = child.parent;
  if (!parentBox) return;
  const wrapperBox = makeBox(makeBlock({}, [child]), parentBox);
  replaceChild(child, wrapperBox);
}

export function unwrapSingleChildBlock(wrapper: BlockBox) {
  const parentBox = wrapper.parent;
  if (!parentBox) return;
  const children = orderedChildren(wrapper.value.value);
  if (children.length !== 1) return;
  replaceChild(wrapper, children[0]!);
}
