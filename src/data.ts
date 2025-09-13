import {
  signal,
  computed,
  type Signal,
  type ReadonlySignal,
} from "@preact/signals-core";
import { evalExpr } from "./code";

export type Block = {
  values: { [key: string]: Node };
  items: Node[];
};

export type Code = {
  kind: "code";
  code: Signal<string>;
  result: ReadonlySignal<any>;
};

export type Value = Block | Code | string | number | boolean;
export type Node = Signal<Value>;

export function isBlock(v: Value): v is Block {
  return !!v && typeof v === "object" && (v as any).kind === undefined;
}
export function isCode(v: Value): v is Code {
  return !!v && typeof v === "object" && (v as any).kind === "code";
}

export type Binding = ReadonlySignal<Node | undefined>;
export interface Scope {
  getBinding(name: string): Binding;
  asObject(): Record<string, any>;
  extend(frame: Signal<Block>): Scope;
}

class FrameScope implements Scope {
  private parent?: Scope;
  private frame?: Signal<Block>;
  private bindingCache = new Map<string, Binding>();

  constructor(frame?: Signal<Block>, parent?: Scope) {
    this.frame = frame;
    this.parent = parent;
  }

  getBinding(name: string): Binding {
    let b = this.bindingCache.get(name);
    if (!b) {
      const parentB = this.parent?.getBinding(name);
      b = computed<Node | undefined>(() => {
        const local = this.frame ? this.frame.value.values[name] : undefined;
        return local ?? parentB?.value;
      });
      this.bindingCache.set(name, b);
    }
    return b;
  }

  extend(frame: Signal<Block>): Scope {
    return new FrameScope(frame, this);
  }

  asObject(): Record<string, any> {
    return new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === "__proto__" || prop === "toString" || prop === "valueOf")
            return undefined;
          const node = this.getBinding(String(prop)).value;
          if (!node) return undefined;
          const val = node.value;
          if (isCode(val)) return val.result.value;
          if (isBlock(val)) return val;
          return val; // primitive
        },
        has: (_t, prop) => this.getBinding(String(prop)).value !== undefined,
      }
    );
  }
}

const ROOT_SCOPE: Scope = new FrameScope();

const scopeSigOf = new WeakMap<Node, Signal<Scope>>();
function ensureScopeSig(n: Node): Signal<Scope> {
  let s = scopeSigOf.get(n);
  if (!s) {
    s = signal<Scope>(ROOT_SCOPE);
    scopeSigOf.set(n, s);
  }
  return s;
}

const visibleScopeOf = new WeakMap<Node, ReadonlySignal<Scope>>();
function getVisibleScope(n: Node): ReadonlySignal<Scope> {
  let s = visibleScopeOf.get(n);
  if (!s) {
    s = computed<Scope>(() => {
      const parentScope = ensureScopeSig(n).value;
      const v = n.value;
      return isBlock(v) ? parentScope.extend(n as Signal<Block>) : parentScope;
    });
    visibleScopeOf.set(n, s);
  }
  return s;
}

/* Factories */

export function makeBlock(init?: Partial<Block>): Node {
  const node = signal<Value>({
    values: init?.values ?? {},
    items: init?.items ?? [],
  });
  ensureScopeSig(node).value = ROOT_SCOPE;
  return node;
}

export function makeCode(expr: Signal<string>): Node {
  const node = signal<Value>(null as any);

  const result = computed(() => {
    const scope = ensureScopeSig(node).value;
    const obj = scope.asObject();
    const src = expr.value;
    return evalExpr(src, obj);
  });

  node.value = {
    kind: "code",
    code: expr,
    result,
  } satisfies Code;

  ensureScopeSig(node).value = ROOT_SCOPE;
  return node;
}

export function makeValue(v: string | number | boolean): Node {
  const n = signal<Value>(v);
  ensureScopeSig(n).value = ROOT_SCOPE;
  return n;
}

/* Mutators */

export function setValue(block: Node, key: string, child: Node) {
  const b = block.value;
  if (!isBlock(b)) throw new Error("setValue: target is not a Block");
  block.value = { ...b, values: { ...b.values, [key]: child } };
  ensureScopeSig(child).value = getVisibleScope(block).value;
}

export function delValue(block: Node, key: string) {
  const b = block.value;
  if (!isBlock(b)) throw new Error("delValue: target is not a Block");
  const { [key]: _removed, ...rest } = b.values;
  block.value = { ...b, values: rest };
}

export function pushItem(block: Node, child: Node) {
  const b = block.value;
  if (!isBlock(b)) throw new Error("pushItem: target is not a Block");
  block.value = { ...b, items: [...b.items, child] };
  ensureScopeSig(child).value = getVisibleScope(block).value;
}

export function insertItem(block: Node, index: number, child: Node) {
  const b = block.value;
  if (!isBlock(b)) throw new Error("insertItem: target is not a Block");
  const next = b.items.slice();
  next.splice(index, 0, child);
  block.value = { ...b, items: next };
  ensureScopeSig(child).value = getVisibleScope(block).value;
}

export function moveNode(
  child: Node,
  newParent: Node,
  into: "values" | "items",
  keyOrIndex?: string | number
) {
  if (!isBlock(newParent.value))
    throw new Error("moveNode: newParent is not a Block");

  if (into === "values") {
    if (typeof keyOrIndex !== "string")
      throw new Error("moveNode(values): key required");
    setValue(newParent, keyOrIndex, child);
  } else {
    insertItem(
      newParent,
      typeof keyOrIndex === "number"
        ? keyOrIndex
        : newParent.value.items.length,
      child
    );
  }
}
