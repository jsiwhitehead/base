import type { Result } from "./eval";
import {
  isBlankResult,
  isEntryItemResult,
  isIssueResult,
  isResultItemResult,
  isScalarResult,
} from "./eval";
import type { EntryContent, EntryId, Model } from "./model";
import { isFormulaContent, isQueryContent } from "./model";

export type CoreReadErrorCode =
  | "INVALID_NODE_ID"
  | "UNKNOWN_NODE_ID"
  | "INVALID_NODE_PATH"
  | "CONTENT_MISMATCH"
  | "SHAPE_CHILD_NOT_FOUND";

export class CoreReadError extends Error {
  readonly code: CoreReadErrorCode;

  constructor(code: CoreReadErrorCode, message: string) {
    super(message);
    this.name = "CoreReadError";
    this.code = code;
  }
}

export function isCoreReadError(err: unknown): err is CoreReadError {
  return err instanceof CoreReadError;
}

export type NodeId = string;

export type Value = true | number | string;
export type ValueOrBlank = Value | null;

export type Content =
  | { type: "value"; value: ValueOrBlank }
  | { type: "issue"; message: string }
  | { type: "item"; children: readonly NodeId[] };

export type Connected =
  | { type: "formula"; expr: string }
  | { type: "query"; from: string; where: string; orderBy: string };

export type Mode =
  | { type: "readonly" }
  | { type: "plain" }
  | { type: "connected"; conn: Connected };

export type Node = { id: NodeId; label?: string; content: Content; mode: Mode };

export type NodeRef = { entryId: EntryId; path: readonly number[] };

export type ReadEvaluator = { result(id: EntryId): Result };

export type ReadApi = { node(id: NodeId): Node };

type CreateReadApiOpts = { evaluator: ReadEvaluator; model: Model };

type ResolvedNode = { result: Result; label?: string };

const childrenOfResolved = (
  base: NodeRef,
  result: Result,
): readonly NodeId[] => {
  if (isEntryItemResult(result))
    return result.entryIds.map((entryId) => nodeIdOf(entryId, []));
  if (isResultItemResult(result))
    return result.nodes.map((_node, i) =>
      nodeIdOf(base.entryId, [...base.path, i]),
    );
  return [];
};

const resolve = (
  model: Model,
  evaluator: ReadEvaluator,
  ref: NodeRef,
): ResolvedNode => {
  let cur: Result = evaluator.result(ref.entryId);
  let label: string | undefined =
    model.readEntry(ref.entryId).label.trim() || undefined;

  for (let i = 0; i < ref.path.length; i += 1) {
    const idx = ref.path[i]!;
    if (!isResultItemResult(cur))
      throw new CoreReadError("INVALID_NODE_PATH", "Invalid node path");
    const node = cur.nodes[idx];
    if (!node)
      throw new CoreReadError("INVALID_NODE_PATH", "Invalid node path");
    label = node.label?.trim() || undefined;
    cur = node.result;
  }

  return { result: cur, ...(label ? { label } : {}) };
};

const modeFromContent = (ref: NodeRef, content: EntryContent): Mode => {
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

const toContent = (ref: NodeRef, result: Result): Content => {
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
  return { type: "item", children: childrenOfResolved(ref, result) };
};

export const nodeIdOf = (
  entryId: EntryId,
  path: readonly number[] = [],
): NodeId => `${String(entryId)}:${path.length ? path.join(",") : ""}`;

export const parseNodeId = (id: NodeId): NodeRef | null => {
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

export const refFromNodeId = (id: NodeId): NodeRef => {
  const ref = parseNodeId(id);
  if (!ref) throw new CoreReadError("INVALID_NODE_ID", "Invalid node id");
  return ref;
};

export const entryIdFromNodeId = (id: NodeId): EntryId | null => {
  const ref = parseNodeId(id);
  return ref && ref.path.length === 0 ? ref.entryId : null;
};

export function createReadApi(opts: CreateReadApiOpts): ReadApi {
  const { evaluator, model } = opts;

  return {
    node(id: NodeId): Node {
      const ref = refFromNodeId(id);
      if (!model.hasEntry(ref.entryId))
        throw new CoreReadError("UNKNOWN_NODE_ID", "Unknown node id");
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
