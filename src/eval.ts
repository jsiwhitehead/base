import { computed, type ReadonlySignal } from "@preact/signals-core";
import type { ItemId, Scalar, StoredContent, Store } from "./store";

export type LabeledValue = { label?: string; value: Value };

export type Value =
  | { kind: "blank" }
  | { kind: "issue"; message: string }
  | { kind: "scalar"; value: Scalar }
  | { kind: "item-group"; items: ItemId[] }
  | { kind: "value-group"; items: LabeledValue[] };

export const V = {
  blank: (): Value => ({ kind: "blank" }),
  issue: (message: string): Value => ({ kind: "issue", message }),
  scalar: (value: Scalar): Value => ({ kind: "scalar", value }),
  itemGroup: (items: ItemId[]): Value => ({ kind: "item-group", items }),
  valueGroup: (items: LabeledValue[]): Value => ({
    kind: "value-group",
    items,
  }),
} as const;

export const isPresent = (v: Value) => v.kind !== "blank" && v.kind !== "issue";
export const isTrue = (v: Value) => v.kind === "scalar" && v.value === true;

const isIssue = (v: Value): v is { kind: "issue"; message: string } =>
  v.kind === "issue";

export type EvalEnv = {
  lookup(name: string): Value;
  resolve(id: ItemId): Value;
  getLabel(id: ItemId): string;
};

export type Interpreter = (expr: string, env: EvalEnv) => Value;

type EvalCtx = { visiting: Set<ItemId> };
const makeEvalCtx = (): EvalCtx => ({ visiting: new Set<ItemId>() });

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

const sortRank = (v: Value): [number, unknown] => {
  if (v.kind === "blank" || v.kind === "issue") return [4, null];
  if (v.kind === "scalar") {
    const lit = v.value;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
};

const compareSortKey = (a: Value, b: Value) => {
  const [ra, va] = sortRank(a);
  const [rb, vb] = sortRank(b);
  if (ra !== rb) return ra - rb;

  if (ra === 0) {
    const d = (va as number) - (vb as number);
    if (d) return d;
  } else if (ra === 1) {
    const d = collator.compare(String(va), String(vb));
    if (d) return d;
  }
  return 0;
};

type CacheRec = { valueSignal?: ReadonlySignal<Value> };

export type Evaluator = {
  valueSignal(id: ItemId): ReadonlySignal<Value>;
  value(id: ItemId): Value;
  items(id: ItemId): ItemId[];
  prune(ids: readonly ItemId[]): void;
  dispose(): void;
};

export function createEvaluator(opts: {
  store: Store;
  interpret: Interpreter;
}): Evaluator {
  const { store } = opts;
  const interpretExpr = opts.interpret;

  const cache = new Map<ItemId, CacheRec>();

  const rec = (id: ItemId): CacheRec => {
    let r = cache.get(id);
    if (!r) {
      r = {};
      cache.set(id, r);
    }
    return r;
  };

  const baseEnvFor = (ownerId: ItemId, ctx: EvalCtx): EvalEnv => ({
    lookup: (name) => lookupInAncestors(name, ownerId, ctx),
    resolve: (id) => evaluateValue(id, ctx),
    getLabel: (id) => store.normalizeLabel(store.readItem(id).label),
  });

  const lookupInAncestors = (name: string, fromId: ItemId, ctx: EvalCtx) => {
    let cur: ItemId | null = fromId;
    while (cur != null) {
      const ownerId = store.readItem(cur).ownerId;
      if (ownerId == null) break;

      const hit = store.findChildByLabel(ownerId, name);
      if (hit != null) return evaluateValue(hit, ctx);

      cur = ownerId;
    }
    return V.issue(`Unbound identifier: ${name}`);
  };

  const materializeItemGroups = (v: Value, ctx: EvalCtx): Value => {
    if (v.kind === "item-group") {
      return V.valueGroup(
        v.items.map((id) => ({
          label: store.readItem(id).label || undefined,
          value: materializeItemGroups(evaluateValue(id, ctx), ctx),
        })),
      );
    }
    if (v.kind === "value-group") {
      return V.valueGroup(
        v.items.map((it) => ({
          label: it.label,
          value: materializeItemGroups(it.value, ctx),
        })),
      );
    }
    return v;
  };

  const unwrapItemGroup = (v: Value, typeMessage: string) => {
    if (v.kind === "blank") return { kind: "blank" } as const;
    if (v.kind === "issue") return { kind: "issue", value: v } as const;
    if (v.kind === "item-group") return { kind: "ok", items: v.items } as const;
    return { kind: "issue", value: V.issue(typeMessage) } as const;
  };

  const forkCtx = (base: EvalCtx): EvalCtx => ({
    visiting: new Set(base.visiting),
  });

  function evaluateLens(
    ownerId: ItemId,
    spec: Extract<StoredContent, { kind: "lens" }>,
    ctx: EvalCtx,
  ): Value {
    const from = spec.from.trim();
    if (!from) return V.blank();

    const baseEnv = baseEnvFor(ownerId, ctx);
    const sourceVal = interpretExpr(from, baseEnv);
    const unwrapped = unwrapItemGroup(
      sourceVal,
      "Lens 'from' must evaluate to an item-group",
    );

    if (unwrapped.kind === "blank") return V.blank();
    if (unwrapped.kind === "issue") return unwrapped.value;

    let ids: ItemId[] = [...unwrapped.items];

    const evalRowExpr = (
      expr: string,
      rowId: ItemId,
      i: number,
      rowCtx: EvalCtx,
    ): Value => {
      const row = evaluateValue(rowId, rowCtx);
      if (isIssue(row)) return row;

      const position = V.scalar(i + 1);
      const label = V.scalar(store.readItem(rowId).label || "");

      return interpretExpr(expr, {
        lookup: (name) => {
          if (name === "_") return row;
          if (name === "position") return position;
          if (name === "label") return label;

          const hit = store.findChildByLabel(rowId, name);
          if (hit != null) return evaluateValue(hit, rowCtx);

          return lookupInAncestors(name, rowId, rowCtx);
        },
        resolve: (id) => evaluateValue(id, rowCtx),
        getLabel: (id) => store.normalizeLabel(store.readItem(id).label),
      });
    };

    const where = spec.where.trim();
    if (where) {
      const next: ItemId[] = [];
      for (let i = 0; i < ids.length; i++) {
        const rowId = ids[i]!;
        const rowCtx = forkCtx(ctx);
        const pred = evalRowExpr(where, rowId, i, rowCtx);
        if (isIssue(pred)) return pred;
        if (isTrue(pred)) next.push(rowId);
      }
      ids = next;
    }

    const orderBy = spec.orderBy.trim();
    if (orderBy) {
      const rows: { rowId: ItemId; i: number; key: Value }[] = [];
      for (let i = 0; i < ids.length; i++) {
        const rowId = ids[i]!;
        const rowCtx = forkCtx(ctx);
        const key = evalRowExpr(orderBy, rowId, i, rowCtx);
        if (isIssue(key)) return key;
        rows.push({ rowId, i, key });
      }
      rows.sort((a, b) => compareSortKey(a.key, b.key) || a.i - b.i);
      ids = rows.map((r) => r.rowId);
    }

    return V.itemGroup(ids);
  }

  function evaluateValue(id: ItemId, ctx: EvalCtx): Value {
    if (ctx.visiting.has(id)) return V.issue("Cyclic dependency");
    ctx.visiting.add(id);

    try {
      const it = store.readItem(id);
      switch (it.content.kind) {
        case "blank":
          return V.blank();
        case "scalar":
          return V.scalar(it.content.value);
        case "group":
          return V.itemGroup([...it.content.items]);
        case "derived": {
          const expr = it.content.expr.trim();
          if (!expr) return V.blank();
          const out = interpretExpr(expr, baseEnvFor(id, ctx));
          return materializeItemGroups(out, ctx);
        }
        case "lens":
          return evaluateLens(id, it.content, ctx);
      }
    } catch (err) {
      return V.issue(err instanceof Error ? err.message : String(err));
    } finally {
      ctx.visiting.delete(id);
    }
  }

  const valueSignal = (id: ItemId): ReadonlySignal<Value> => {
    const r = rec(id);
    return (r.valueSignal ??= computed(() => evaluateValue(id, makeEvalCtx())));
  };

  const value = (id: ItemId): Value => valueSignal(id).value;

  const items = (id: ItemId): ItemId[] => {
    const v = value(id);
    return v.kind === "item-group" ? v.items : [];
  };

  const prune = (ids: readonly ItemId[]) => {
    for (const id of ids) cache.delete(id);
  };

  const dispose = () => {
    cache.clear();
  };

  return { valueSignal, value, items, prune, dispose };
}
