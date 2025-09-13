import {
  type Signal as BaseSignal,
  computed,
  signal,
} from "@preact/signals-core";
import { evalExpr } from "./code";

/* Types */

export type Primitive = string | number | boolean;

export type ResolvedBlock = {
  kind: "block";
  values: Record<string, ResolvedDeep>;
  items: ResolvedDeep[];
};

export type Block = {
  kind: "block";
  parent: BaseSignal<Block | undefined>;
  values: Record<string, Value>;
  items: Value[];
};

export type Code = {
  kind: "code";
  parent: BaseSignal<Block | undefined>;
  code: BaseSignal<string>;
  result: BaseSignal<Value>;
};

export type Signal = {
  kind: "signal";
  value: BaseSignal<Value>;
};

export type ResolvedDeep = ResolvedBlock | Primitive;
export type Resolved = Block | Primitive;
export type Value = Signal | Code | Resolved;

/* Type Guards */

export function isBlock(v: Value): v is Block {
  return typeof v === "object" && v !== null && (v as any).kind === "block";
}

export function isCode(v: Value): v is Code {
  return typeof v === "object" && v !== null && (v as any).kind === "code";
}

export function isSignal(v: Value): v is Signal {
  return typeof v === "object" && v !== null && (v as any).kind === "signal";
}

/* Resolve */

export function resolve(v: Value): Resolved {
  if (isCode(v)) return resolve(v.result.value);
  if (isSignal(v)) return resolve(v.value.value);
  return v;
}

export function resolveDeep(v: Value): ResolvedDeep {
  const r = resolve(v);
  if (isBlock(r)) {
    const values: Record<string, ResolvedDeep> = {};
    for (const [key, val] of Object.entries(r.values)) {
      values[key] = resolveDeep(val);
    }
    const items = r.items.map((item) => resolveDeep(item));
    return { kind: "block", values, items };
  }
  return r;
}

/* Scope */

export function lookup(start: Block | undefined, name: string): Value {
  let cur: Block | undefined = start;
  while (cur) {
    const hit = cur.values[name];
    if (hit !== undefined) return hit;
    cur = cur.parent.value;
  }
  throw new Error(`Unbound identifier: ${name}`);
}

/* Code */

export function makeBlock(
  values: Record<string, Value> = {},
  items: Value[] = [],
  parent?: Block | undefined
): Block {
  const block: Block = {
    kind: "block",
    parent: signal(parent),
    values: {},
    items: [],
  };
  for (const [key, v] of Object.entries(values)) {
    if (isBlock(v) || isCode(v)) v.parent.value = block;
    block.values[key] = isSignal(v) ? v : makeSignal(v);
  }
  for (const v of items) {
    if (isBlock(v) || isCode(v)) v.parent.value = block;
    block.items.push(isSignal(v) ? v : makeSignal(v));
  }
  return block;
}

export function makeCode(
  expr: BaseSignal<string>,
  parent: BaseSignal<Block | undefined>
): Code {
  const result = computed<Value>(() => {
    const getter = (name: string): Value => lookup(parent.value, name);
    return evalExpr(expr.value, getter);
  });
  return { kind: "code", parent, code: expr, result };
}

export function makeSignal(initial: Value): Signal {
  return { kind: "signal", value: signal(initial) };
}
