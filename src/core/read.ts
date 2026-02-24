import type { Result } from "./eval";
import {
  isBlankResult,
  isEntryGroupResult,
  isIssueResult,
  isResultGroupResult,
  isScalarResult,
} from "./eval";
import type { EntryContent, EntryId, Model } from "./model";
import { isFormulaContent, isQueryContent } from "./model";

export class CoreReadError extends Error {
  readonly code = "CORE_READ_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "CoreReadError";
  }
}

export function isCoreReadError(err: unknown): err is CoreReadError {
  return err instanceof CoreReadError;
}

export type ItemId = string;

export type Value = true | number | string;
export type ValueOrBlank = Value | null;

export type Content =
  | { type: "value"; value: ValueOrBlank }
  | { type: "issue"; message: string }
  | { type: "group"; children: readonly ItemId[] };

export type Connected =
  | { type: "formula"; expr: string }
  | { type: "query"; from: string; where: string; orderBy: string };

export type Mode =
  | { type: "readonly" }
  | { type: "plain" }
  | { type: "connected"; conn: Connected };

export type Item = {
  id: ItemId;
  label?: string;
  content: Content;
  mode: Mode;
};

export type ItemRef = { entryId: EntryId; path: readonly number[] };

export type ReadEvaluator = {
  result(id: EntryId): Result;
};

export type ReadApi = {
  item(id: ItemId): Item;
};

type CreateReadApiOpts = {
  getEvaluator: () => ReadEvaluator;
  getModel: () => Model;
};

type ResolvedItem = { result: Result; label?: string };

const childrenOfResolved = (
  base: ItemRef,
  result: Result,
): readonly ItemId[] => {
  if (isEntryGroupResult(result))
    return result.entryIds.map((entryId) => itemIdOf(entryId, []));
  if (isResultGroupResult(result))
    return result.items.map((_item, i) =>
      itemIdOf(base.entryId, [...base.path, i]),
    );
  return [];
};

const resolve = (
  model: Model,
  evaluator: ReadEvaluator,
  ref: ItemRef,
): ResolvedItem => {
  let cur: Result = evaluator.result(ref.entryId);
  let label: string | undefined =
    model.readEntry(ref.entryId).label.trim() || undefined;

  for (let i = 0; i < ref.path.length; i += 1) {
    const idx = ref.path[i]!;
    if (!isResultGroupResult(cur)) throw new CoreReadError("Invalid item path");
    const item = cur.items[idx];
    if (!item) throw new CoreReadError("Invalid item path");
    label = item.label?.trim() || undefined;
    cur = item.result;
  }

  return { result: cur, ...(label ? { label } : {}) };
};

const modeFromContent = (ref: ItemRef, content: EntryContent): Mode => {
  if (ref.path.length) return { type: "readonly" };
  if (isFormulaContent(content))
    return { type: "connected", conn: { type: "formula", expr: content.expr } };
  if (isQueryContent(content)) {
    return {
      type: "connected",
      conn: {
        type: "query",
        from: content.from,
        where: content.where,
        orderBy: content.orderBy,
      },
    };
  }
  return { type: "plain" };
};

const toContent = (ref: ItemRef, result: Result): Content => {
  if (isBlankResult(result)) return { type: "value", value: null };
  if (isIssueResult(result)) return { type: "issue", message: result.message };
  if (isScalarResult(result)) {
    const scalar = result.result;
    return {
      type: "value",
      value:
        scalar === true ||
        typeof scalar === "number" ||
        typeof scalar === "string"
          ? scalar
          : null,
    };
  }
  return { type: "group", children: childrenOfResolved(ref, result) };
};

export const itemIdOf = (
  entryId: EntryId,
  path: readonly number[] = [],
): ItemId => `${String(entryId)}:${path.length ? path.join(",") : ""}`;

export const parseItemId = (id: ItemId): ItemRef | null => {
  const i = id.indexOf(":");
  if (i === -1) return null;

  const head = id.slice(0, i);
  const entryId = Number(head);
  if (!Number.isFinite(entryId)) return null;

  const rest = id.slice(i + 1);
  if (!rest.trim()) return { entryId: entryId as EntryId, path: [] };

  const parts = rest.split(",");
  const path: number[] = [];
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    path.push(n);
  }

  return { entryId: entryId as EntryId, path };
};

export const refFromItemId = (id: ItemId): ItemRef => {
  const ref = parseItemId(id);
  if (!ref) throw new CoreReadError("Invalid item id");
  return ref;
};

export const entryIdFromItemId = (id: ItemId): EntryId | null => {
  const ref = parseItemId(id);
  return ref && ref.path.length === 0 ? ref.entryId : null;
};

export function createReadApi(opts: CreateReadApiOpts): ReadApi {
  const { getEvaluator, getModel } = opts;

  return {
    item(id: ItemId): Item {
      const model = getModel();
      const evaluator = getEvaluator();
      const ref = refFromItemId(id);
      if (!model.hasEntry(ref.entryId))
        throw new CoreReadError("Unknown item id");
      const resolved = resolve(model, evaluator, ref);
      const content = toContent(ref, resolved.result);
      const stored = model.readEntry(ref.entryId).content;

      return {
        id,
        ...(resolved.label ? { label: resolved.label } : {}),
        content,
        mode: modeFromContent(ref, stored),
      };
    },
  };
}
