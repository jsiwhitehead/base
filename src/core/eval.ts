import type { ReadonlySignal } from "@preact/signals-core";
import { computed } from "@preact/signals-core";

import type { EntryContent, EntryId, Model, Scalar } from "./model";
import { normalizeLabel } from "./model";

type LabeledResult = { label?: string; result: Result };

type BlankResult = { kind: "blank" };
type IssueResult = { kind: "issue"; message: string };
type ScalarResult = { kind: "scalar"; result: Scalar };
type EntryGroupResult = { kind: "entry-group"; entryIds: readonly EntryId[] };
type ResultGroupResult = { kind: "result-group"; items: readonly LabeledResult[] };

export type Result =
  | BlankResult
  | IssueResult
  | ScalarResult
  | EntryGroupResult
  | ResultGroupResult;

export const Results = {
  blank: (): Result => ({ kind: "blank" }),
  issue: (message: string): Result => ({ kind: "issue", message }),
  scalar: (scalar: Scalar): Result => ({ kind: "scalar", result: scalar }),
  entryGroup: (entryIds: readonly EntryId[]): Result => ({
    kind: "entry-group",
    entryIds,
  }),
  resultGroup: (items: readonly LabeledResult[]): Result => ({
    kind: "result-group",
    items,
  }),
} as const;

export const isPresent = (v: Result): boolean =>
  v.kind !== "blank" && v.kind !== "issue";
export const isTrue = (v: Result): boolean =>
  v.kind === "scalar" && v.result === true;

export function isBlankResult(v: Result): v is BlankResult {
  return v.kind === "blank";
}

export function isIssueResult(v: Result): v is IssueResult {
  return v.kind === "issue";
}

export function isScalarResult(v: Result): v is ScalarResult {
  return v.kind === "scalar";
}

export function isEntryGroupResult(v: Result): v is EntryGroupResult {
  return v.kind === "entry-group";
}

export function isResultGroupResult(v: Result): v is ResultGroupResult {
  return v.kind === "result-group";
}

export type EvalEnv = {
  lookup(name: string): Result;
  resolve(id: EntryId): Result;
  getLabel(id: EntryId): string;
};

type Interpreter = (expr: string, env: EvalEnv) => Result;

type EvalCtx = { visiting: Set<EntryId> };
const makeEvalCtx = (): EvalCtx => ({ visiting: new Set<EntryId>() });

function withVisiting(ctx: EvalCtx, id: EntryId, run: () => Result): Result {
  if (ctx.visiting.has(id)) return Results.issue("Cyclic dependency");
  ctx.visiting.add(id);
  try {
    return run();
  } catch (err) {
    return Results.issue(err instanceof Error ? err.message : String(err));
  } finally {
    ctx.visiting.delete(id);
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

const sortRank = (v: Result): [number, unknown] => {
  if (isBlankResult(v) || isIssueResult(v)) return [4, null];
  if (isScalarResult(v)) {
    const lit = v.result;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
};

const compareSortKey = (a: Result, b: Result): number => {
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

type CacheRec = { resultSignal?: ReadonlySignal<Result> };

type Evaluator = {
  resultSignal(id: EntryId): ReadonlySignal<Result>;
  result(id: EntryId): Result;
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

  const baseEnvFor = (parentId: EntryId, ctx: EvalCtx): EvalEnv => ({
    lookup: (name) => lookupInAncestors(name, parentId, ctx),
    resolve: (id) => evaluateResult(id, ctx),
    getLabel: (id) => normalizeLabel(model.readEntry(id).label),
  });

  const lookupInAncestors = (
    name: string,
    fromId: EntryId,
    ctx: EvalCtx,
  ): Result => {
    let cur: EntryId | null = fromId;
    while (cur != null) {
      if (!model.hasEntry(cur)) break;

      const parentId: EntryId | null = model.readEntry(cur).parentId;
      if (parentId == null) break;
      if (!model.hasEntry(parentId)) break;

      const hit = model.findChildIdByLabel(parentId, name);
      if (hit != null) return evaluateResult(hit, ctx);

      cur = parentId;
    }
    return Results.issue(`Unbound identifier: ${name}`);
  };

  const materializeEntryGroups = (v: Result, ctx: EvalCtx): Result => {
    if (isEntryGroupResult(v)) {
      return Results.resultGroup(
        v.entryIds
          .filter((id) => model.hasEntry(id))
          .map((id) => ({
            label: model.readEntry(id).label || undefined,
            result: materializeEntryGroups(evaluateResult(id, ctx), ctx),
          })),
      );
    }
    if (isResultGroupResult(v)) {
      return Results.resultGroup(
        v.items.map((it) => ({
          label: it.label,
          result: materializeEntryGroups(it.result, ctx),
        })),
      );
    }
    return v;
  };

  type UnwrapEntryGroupResult =
    | { kind: "blank" }
    | { kind: "issue"; result: Result }
    | { kind: "ok"; entryIds: readonly EntryId[] };

  const unwrapEntryGroup = (
    v: Result,
    typeMessage: string,
  ): UnwrapEntryGroupResult => {
    if (isBlankResult(v)) return { kind: "blank" };
    if (isIssueResult(v)) return { kind: "issue", result: v };
    if (isEntryGroupResult(v)) return { kind: "ok", entryIds: v.entryIds };
    return { kind: "issue", result: Results.issue(typeMessage) };
  };

  const forkCtx = (base: EvalCtx): EvalCtx => ({
    visiting: new Set(base.visiting),
  });

  function evaluateQuery(
    parentId: EntryId,
    spec: Extract<EntryContent, { kind: "query" }>,
    ctx: EvalCtx,
  ): Result {
    const from = spec.from.trim();
    if (!from) return Results.blank();

    const baseEnv = baseEnvFor(parentId, ctx);
    const sourceResult = interpretExpr(from, baseEnv);
    const unwrapped = unwrapEntryGroup(
      sourceResult,
      "Query 'from' must evaluate to an entry-group",
    );

    if (unwrapped.kind === "blank") return Results.blank();
    if (unwrapped.kind === "issue") return unwrapped.result;

    let entryIds: EntryId[] = [...unwrapped.entryIds].filter((id) =>
      model.hasEntry(id),
    );

    const evalRowExpr = (
      expr: string,
      rowId: EntryId,
      i: number,
      rowCtx: EvalCtx,
    ): Result => {
      if (!model.hasEntry(rowId)) return Results.issue("Missing entry");

      const row = evaluateResult(rowId, rowCtx);
      if (isIssueResult(row)) return row;

      const position = Results.scalar(i + 1);
      const label = Results.scalar(model.readEntry(rowId).label || "");

      return interpretExpr(expr, {
        lookup: (name) => {
          if (name === "_") return row;
          if (name === "position") return position;
          if (name === "label") return label;

          const hit = model.findChildIdByLabel(rowId, name);
          if (hit != null) return evaluateResult(hit, rowCtx);

          return lookupInAncestors(name, rowId, rowCtx);
        },
        resolve: (id) => evaluateResult(id, rowCtx),
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
        if (isIssueResult(pred)) return pred;
        if (isTrue(pred)) next.push(rowId);
      }
      entryIds = next;
    }

    const orderBy = spec.orderBy.trim();
    if (orderBy) {
      const rows: { rowId: EntryId; i: number; key: Result }[] = [];
      for (let i = 0; i < entryIds.length; i++) {
        const rowId = entryIds[i]!;
        const rowCtx = forkCtx(ctx);
        const key = evalRowExpr(orderBy, rowId, i, rowCtx);
        rows.push({ rowId, i, key });
      }
      rows.sort((a, b) => compareSortKey(a.key, b.key) || a.i - b.i);
      entryIds = rows.map((r) => r.rowId);
    }

    return Results.entryGroup(entryIds);
  }

  function evaluateResult(id: EntryId, ctx: EvalCtx): Result {
    if (!model.hasEntry(id)) return Results.issue("Missing entry");

    return withVisiting(ctx, id, () => {
      if (!model.hasEntry(id)) return Results.issue("Missing entry");

      const it = model.readEntry(id);
      switch (it.content.kind) {
        case "blank":
          return Results.blank();
        case "scalar":
          return Results.scalar(it.content.value);
        case "group":
          return Results.entryGroup(
            [...it.content.childIds].filter((cid) => model.hasEntry(cid)),
          );
        case "formula": {
          const expr = it.content.expr.trim();
          if (!expr) return Results.blank();
          const out = interpretExpr(expr, baseEnvFor(id, ctx));
          return materializeEntryGroups(out, ctx);
        }
        case "query":
          return evaluateQuery(id, it.content, ctx);
      }
    });
  }

  const resultSignal = (id: EntryId): ReadonlySignal<Result> => {
    const r = rec(id);
    return (r.resultSignal ??= computed(() => evaluateResult(id, makeEvalCtx())));
  };

  const result = (id: EntryId): Result => resultSignal(id).value;

  const entryIds = (id: EntryId): EntryId[] => {
    const v = result(id);
    return isEntryGroupResult(v) ? [...v.entryIds] : [];
  };

  const prune = (ids: readonly EntryId[]): void => {
    for (const id of ids) cache.delete(id);
  };

  const dispose = (): void => {
    cache.clear();
  };

  return { resultSignal, result, entryIds, prune, dispose };
}
