import type { ReadonlySignal } from "@preact/signals-core";
import { computed } from "@preact/signals-core";

import type { EntryContent, EntryId, Model, Scalar } from "./model";
import { normalizeLabel } from "./model";

type LabeledResult = { label?: string; result: Result };

type BlankResult = { type: "blank" };
type IssueResult = { type: "issue"; message: string };
type ScalarResult = { type: "scalar"; result: Scalar };
type EntryGroupResult = { type: "entry-group"; entryIds: readonly EntryId[] };
type ResultGroupResult = {
  type: "result-group";
  items: readonly LabeledResult[];
};

export type Result =
  | BlankResult
  | IssueResult
  | ScalarResult
  | EntryGroupResult
  | ResultGroupResult;

export const Results = {
  blank: (): Result => ({ type: "blank" }),
  issue: (message: string): Result => ({ type: "issue", message }),
  scalar: (scalar: Scalar): Result => ({ type: "scalar", result: scalar }),
  entryGroup: (entryIds: readonly EntryId[]): Result => ({
    type: "entry-group",
    entryIds,
  }),
  resultGroup: (items: readonly LabeledResult[]): Result => ({
    type: "result-group",
    items,
  }),
} as const;

export const isPresent = (result: Result): boolean =>
  result.type !== "blank" && result.type !== "issue";
export const isTrue = (result: Result): boolean =>
  result.type === "scalar" && result.result === true;

export function isBlankResult(v: Result): v is BlankResult {
  return v.type === "blank";
}

export function isIssueResult(v: Result): v is IssueResult {
  return v.type === "issue";
}

export function isScalarResult(v: Result): v is ScalarResult {
  return v.type === "scalar";
}

export function isEntryGroupResult(v: Result): v is EntryGroupResult {
  return v.type === "entry-group";
}

export function isResultGroupResult(v: Result): v is ResultGroupResult {
  return v.type === "result-group";
}

function assertNever(_exhaustive: never, message: string): never {
  throw new Error(message);
}

export type EvalEnv = {
  lookup(name: string): Result;
  resolve(id: EntryId): Result;
  getLabel(id: EntryId): string;
};

type Interpreter = (expr: string, env: EvalEnv) => Result;

type EvalCtx = { visiting: Set<EntryId> };
const createEvalCtx = (): EvalCtx => ({ visiting: new Set<EntryId>() });

const CYCLIC_DEPENDENCY_MESSAGE = "Cyclic dependency";
const MISSING_ENTRY_MESSAGE = "Missing entry";

function withVisiting(ctx: EvalCtx, id: EntryId, run: () => Result): Result {
  if (ctx.visiting.has(id)) return Results.issue(CYCLIC_DEPENDENCY_MESSAGE);
  ctx.visiting.add(id);
  try {
    return run();
  } catch (err) {
    return Results.issue(err instanceof Error ? err.message : String(err));
  } finally {
    ctx.visiting.delete(id);
  }
}

const SORT_COLLATOR = new Intl.Collator(undefined, { sensitivity: "base" });

type SortKey =
  | { rank: 0; value: number }
  | { rank: 1; value: string }
  | { rank: 2 }
  | { rank: 3 }
  | { rank: 4 };

const sortKeyFor = (result: Result): SortKey => {
  if (isBlankResult(result) || isIssueResult(result)) return { rank: 4 };
  if (isScalarResult(result)) {
    if (typeof result.result === "number")
      return { rank: 0, value: result.result };
    if (typeof result.result === "string")
      return { rank: 1, value: result.result };
    if (result.result === true) return { rank: 2 };
    return assertNever(result.result, "Unhandled scalar variant");
  }
  if (isEntryGroupResult(result) || isResultGroupResult(result))
    return { rank: 3 };
  return assertNever(result, "Unhandled result variant");
};

const compareSortKey = (a: Result, b: Result): number => {
  const aKey = sortKeyFor(a);
  const bKey = sortKeyFor(b);
  if (aKey.rank !== bKey.rank) return aKey.rank - bKey.rank;

  if (aKey.rank === 0 && bKey.rank === 0) {
    const delta = aKey.value - bKey.value;
    if (delta) return delta;
  } else if (aKey.rank === 1 && bKey.rank === 1) {
    const delta = SORT_COLLATOR.compare(aKey.value, bKey.value);
    if (delta) return delta;
  }
  return 0;
};

type CacheRecord = { resultSignal?: ReadonlySignal<Result> };

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

  const cache = new Map<EntryId, CacheRecord>();

  const cacheRecordFor = (id: EntryId): CacheRecord => {
    let cacheRecord = cache.get(id);
    if (!cacheRecord) {
      cacheRecord = {};
      cache.set(id, cacheRecord);
    }
    return cacheRecord;
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
          .map((id) => {
            const label = model.readEntry(id).label || undefined;
            return {
              ...(label ? { label } : {}),
              result: materializeEntryGroups(evaluateResult(id, ctx), ctx),
            };
          }),
      );
    }
    if (isResultGroupResult(v)) {
      return Results.resultGroup(
        v.items.map((it) => ({
          ...(it.label ? { label: it.label } : {}),
          result: materializeEntryGroups(it.result, ctx),
        })),
      );
    }
    return v;
  };

  type UnwrapEntryGroupResult =
    | { type: "blank" }
    | { type: "issue"; result: Result }
    | { type: "ok"; entryIds: readonly EntryId[] };

  const unwrapEntryGroup = (
    v: Result,
    typeMessage: string,
  ): UnwrapEntryGroupResult => {
    if (isBlankResult(v)) return { type: "blank" };
    if (isIssueResult(v)) return { type: "issue", result: v };
    if (isEntryGroupResult(v)) return { type: "ok", entryIds: v.entryIds };
    return { type: "issue", result: Results.issue(typeMessage) };
  };

  const forkCtx = (base: EvalCtx): EvalCtx => ({
    visiting: new Set(base.visiting),
  });

  function evaluateQuery(
    parentId: EntryId,
    spec: Extract<EntryContent, { type: "query" }>,
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

    if (unwrapped.type === "blank") return Results.blank();
    if (unwrapped.type === "issue") return unwrapped.result;

    let entryIds: EntryId[] = [...unwrapped.entryIds].filter((id) =>
      model.hasEntry(id),
    );

    const evaluateRowExpression = (
      expr: string,
      rowId: EntryId,
      i: number,
      rowCtx: EvalCtx,
    ): Result => {
      if (!model.hasEntry(rowId)) return Results.issue(MISSING_ENTRY_MESSAGE);

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
        const pred = evaluateRowExpression(where, rowId, i, rowCtx);
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
        const key = evaluateRowExpression(orderBy, rowId, i, rowCtx);
        rows.push({ rowId, i, key });
      }
      rows.sort((a, b) => compareSortKey(a.key, b.key) || a.i - b.i);
      entryIds = rows.map((r) => r.rowId);
    }

    return Results.entryGroup(entryIds);
  }

  function evaluateResult(id: EntryId, ctx: EvalCtx): Result {
    if (!model.hasEntry(id)) return Results.issue(MISSING_ENTRY_MESSAGE);

    return withVisiting(ctx, id, () => {
      if (!model.hasEntry(id)) return Results.issue(MISSING_ENTRY_MESSAGE);

      const entry = model.readEntry(id);
      switch (entry.content.type) {
        case "blank":
          return Results.blank();
        case "scalar":
          return Results.scalar(entry.content.value);
        case "group":
          return Results.entryGroup(
            [...entry.content.childIds].filter((cid) => model.hasEntry(cid)),
          );
        case "formula": {
          const expr = entry.content.expr.trim();
          if (!expr) return Results.blank();
          const out = interpretExpr(expr, baseEnvFor(id, ctx));
          return materializeEntryGroups(out, ctx);
        }
        case "query":
          return evaluateQuery(id, entry.content, ctx);
        default:
          return assertNever(entry.content, "Unhandled entry content");
      }
    });
  }

  const resultSignal = (id: EntryId): ReadonlySignal<Result> => {
    const cacheRecord = cacheRecordFor(id);
    return (cacheRecord.resultSignal ??= computed(() =>
      evaluateResult(id, createEvalCtx()),
    ));
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
