import type { ReadonlySignal } from "@preact/signals-core";
import { computed } from "@preact/signals-core";

import type { EntryContent, EntryId, Model, Scalar } from "./model";
import { normalizeLabel } from "./model";

type LabeledValue = { label?: string; value: Value };

type BlankValue = { kind: "blank" };
type IssueValue = { kind: "issue"; message: string };
type ScalarValue = { kind: "scalar"; value: Scalar };
type EntryGroupValue = { kind: "entry-group"; entryIds: readonly EntryId[] };
type ValueGroupValue = { kind: "value-group"; items: readonly LabeledValue[] };

export type Value =
  | BlankValue
  | IssueValue
  | ScalarValue
  | EntryGroupValue
  | ValueGroupValue;

export const V = {
  blank: (): Value => ({ kind: "blank" }),
  issue: (message: string): Value => ({ kind: "issue", message }),
  scalar: (value: Scalar): Value => ({ kind: "scalar", value }),
  entryGroup: (entryIds: readonly EntryId[]): Value => ({
    kind: "entry-group",
    entryIds,
  }),
  valueGroup: (items: readonly LabeledValue[]): Value => ({
    kind: "value-group",
    items,
  }),
} as const;

export const isPresent = (v: Value): boolean =>
  v.kind !== "blank" && v.kind !== "issue";
export const isTrue = (v: Value): boolean =>
  v.kind === "scalar" && v.value === true;

export function isBlankValue(v: Value): v is BlankValue {
  return v.kind === "blank";
}

export function isIssueValue(v: Value): v is IssueValue {
  return v.kind === "issue";
}

export function isScalarValue(v: Value): v is ScalarValue {
  return v.kind === "scalar";
}

export function isEntryGroupValue(v: Value): v is EntryGroupValue {
  return v.kind === "entry-group";
}

export function isValueGroupValue(v: Value): v is ValueGroupValue {
  return v.kind === "value-group";
}

export type EvalEnv = {
  lookup(name: string): Value;
  resolve(id: EntryId): Value;
  getLabel(id: EntryId): string;
};

type Interpreter = (expr: string, env: EvalEnv) => Value;

type EvalCtx = { visiting: Set<EntryId> };
const makeEvalCtx = (): EvalCtx => ({ visiting: new Set<EntryId>() });

function withVisiting(ctx: EvalCtx, id: EntryId, run: () => Value): Value {
  if (ctx.visiting.has(id)) return V.issue("Cyclic dependency");
  ctx.visiting.add(id);
  try {
    return run();
  } catch (err) {
    return V.issue(err instanceof Error ? err.message : String(err));
  } finally {
    ctx.visiting.delete(id);
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

const sortRank = (v: Value): [number, unknown] => {
  if (isBlankValue(v) || isIssueValue(v)) return [4, null];
  if (isScalarValue(v)) {
    const lit = v.value;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
};

const compareSortKey = (a: Value, b: Value): number => {
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

type Evaluator = {
  valueSignal(id: EntryId): ReadonlySignal<Value>;
  value(id: EntryId): Value;
  entryIds(id: EntryId): EntryId[];
  prune(ids: readonly EntryId[]): void;
  dispose(): void;
};

export function createEvaluator(opts: {
  model: Model;
  interpret: Interpreter;
}): Evaluator {
  const { model } = opts;
  const interpretExpr = opts.interpret;

  const cache = new Map<EntryId, CacheRec>();

  const rec = (id: EntryId): CacheRec => {
    let r = cache.get(id);
    if (!r) {
      r = {};
      cache.set(id, r);
    }
    return r;
  };

  const baseEnvFor = (ownerId: EntryId, ctx: EvalCtx): EvalEnv => ({
    lookup: (name) => lookupInAncestors(name, ownerId, ctx),
    resolve: (id) => evaluateValue(id, ctx),
    getLabel: (id) => normalizeLabel(model.readEntry(id).label),
  });

  const lookupInAncestors = (
    name: string,
    fromId: EntryId,
    ctx: EvalCtx,
  ): Value => {
    let cur: EntryId | null = fromId;
    while (cur != null) {
      if (!model.hasEntry(cur)) break;

      const ownerId: EntryId | null = model.readEntry(cur).ownerId;
      if (ownerId == null) break;
      if (!model.hasEntry(ownerId)) break;

      const hit = model.findChildIdByLabel(ownerId, name);
      if (hit != null) return evaluateValue(hit, ctx);

      cur = ownerId;
    }
    return V.issue(`Unbound identifier: ${name}`);
  };

  const materializeEntryGroups = (v: Value, ctx: EvalCtx): Value => {
    if (isEntryGroupValue(v)) {
      return V.valueGroup(
        v.entryIds
          .filter((id) => model.hasEntry(id))
          .map((id) => ({
            label: model.readEntry(id).label || undefined,
            value: materializeEntryGroups(evaluateValue(id, ctx), ctx),
          })),
      );
    }
    if (isValueGroupValue(v)) {
      return V.valueGroup(
        v.items.map((it) => ({
          label: it.label,
          value: materializeEntryGroups(it.value, ctx),
        })),
      );
    }
    return v;
  };

  type UnwrapEntryGroupResult =
    | { kind: "blank" }
    | { kind: "issue"; value: Value }
    | { kind: "ok"; entryIds: readonly EntryId[] };

  const unwrapEntryGroup = (
    v: Value,
    typeMessage: string,
  ): UnwrapEntryGroupResult => {
    if (isBlankValue(v)) return { kind: "blank" };
    if (isIssueValue(v)) return { kind: "issue", value: v };
    if (isEntryGroupValue(v)) return { kind: "ok", entryIds: v.entryIds };
    return { kind: "issue", value: V.issue(typeMessage) };
  };

  const forkCtx = (base: EvalCtx): EvalCtx => ({
    visiting: new Set(base.visiting),
  });

  function evaluateLens(
    ownerId: EntryId,
    spec: Extract<EntryContent, { kind: "lens" }>,
    ctx: EvalCtx,
  ): Value {
    const from = spec.from.trim();
    if (!from) return V.blank();

    const baseEnv = baseEnvFor(ownerId, ctx);
    const sourceVal = interpretExpr(from, baseEnv);
    const unwrapped = unwrapEntryGroup(
      sourceVal,
      "Lens 'from' must evaluate to an entry-group",
    );

    if (unwrapped.kind === "blank") return V.blank();
    if (unwrapped.kind === "issue") return unwrapped.value;

    let entryIds: EntryId[] = [...unwrapped.entryIds].filter((id) =>
      model.hasEntry(id),
    );

    const evalRowExpr = (
      expr: string,
      rowId: EntryId,
      i: number,
      rowCtx: EvalCtx,
    ): Value => {
      if (!model.hasEntry(rowId)) return V.issue("Missing entry");

      const row = evaluateValue(rowId, rowCtx);
      if (isIssueValue(row)) return row;

      const position = V.scalar(i + 1);
      const label = V.scalar(model.readEntry(rowId).label || "");

      return interpretExpr(expr, {
        lookup: (name) => {
          if (name === "_") return row;
          if (name === "position") return position;
          if (name === "label") return label;

          const hit = model.findChildIdByLabel(rowId, name);
          if (hit != null) return evaluateValue(hit, rowCtx);

          return lookupInAncestors(name, rowId, rowCtx);
        },
        resolve: (id) => evaluateValue(id, rowCtx),
        getLabel: (id) => normalizeLabel(model.readEntry(id).label),
      });
    };

    const where = spec.where.trim();
    if (where) {
      const next: EntryId[] = [];
      for (let i = 0; i < entryIds.length; i++) {
        const rowId = entryIds[i]!;
        const rowCtx = forkCtx(ctx);
        const pred = evalRowExpr(where, rowId, i, rowCtx);
        if (isIssueValue(pred)) return pred;
        if (isTrue(pred)) next.push(rowId);
      }
      entryIds = next;
    }

    const orderBy = spec.orderBy.trim();
    if (orderBy) {
      const rows: { rowId: EntryId; i: number; key: Value }[] = [];
      for (let i = 0; i < entryIds.length; i++) {
        const rowId = entryIds[i]!;
        const rowCtx = forkCtx(ctx);
        const key = evalRowExpr(orderBy, rowId, i, rowCtx);
        rows.push({ rowId, i, key });
      }
      rows.sort((a, b) => compareSortKey(a.key, b.key) || a.i - b.i);
      entryIds = rows.map((r) => r.rowId);
    }

    return V.entryGroup(entryIds);
  }

  function evaluateValue(id: EntryId, ctx: EvalCtx): Value {
    if (!model.hasEntry(id)) return V.issue("Missing entry");

    return withVisiting(ctx, id, () => {
      if (!model.hasEntry(id)) return V.issue("Missing entry");

      const it = model.readEntry(id);
      switch (it.content.kind) {
        case "blank":
          return V.blank();
        case "scalar":
          return V.scalar(it.content.value);
        case "group":
          return V.entryGroup(
            [...it.content.childIds].filter((cid) => model.hasEntry(cid)),
          );
        case "derived": {
          const expr = it.content.expr.trim();
          if (!expr) return V.blank();
          const out = interpretExpr(expr, baseEnvFor(id, ctx));
          return materializeEntryGroups(out, ctx);
        }
        case "lens":
          return evaluateLens(id, it.content, ctx);
      }
    });
  }

  const valueSignal = (id: EntryId): ReadonlySignal<Value> => {
    const r = rec(id);
    return (r.valueSignal ??= computed(() => evaluateValue(id, makeEvalCtx())));
  };

  const value = (id: EntryId): Value => valueSignal(id).value;

  const entryIds = (id: EntryId): EntryId[] => {
    const v = value(id);
    return isEntryGroupValue(v) ? [...v.entryIds] : [];
  };

  const prune = (ids: readonly EntryId[]): void => {
    for (const id of ids) cache.delete(id);
  };

  const dispose = (): void => {
    cache.clear();
  };

  return { valueSignal, value, entryIds, prune, dispose };
}
