import type { ReadonlySignal, Signal } from "@preact/signals-core";
import { batch, computed, signal } from "@preact/signals-core";

import { CoreInvariantError, DEV, devAssert } from "../dev";

export type EntryId = number;
export type Scalar = true | number | string;

export type ViewName = "outline" | "table" | "slider";

type BlankContent = { type: "blank" };
type ScalarContent = { type: "scalar"; value: Scalar };
type ItemContent = { type: "item"; childIds: readonly EntryId[] };
type FormulaContent = { type: "formula"; expr: string };
type QueryContent = {
  type: "query";
  from: string;
  where: string;
  orderBy: string;
};

type EntryContentSettable = BlankContent | ScalarContent | ItemContent;
export type EntryContent = EntryContentSettable | FormulaContent | QueryContent;

export type Entry = {
  readonly id: EntryId;
  readonly parentId: EntryId | null;
  readonly label: string;
  readonly view: ViewName | null;
  readonly content: EntryContent;
};

type ItemEntry = Entry & { content: ItemContent };

export type SnapshotNodeContent =
  | { type: "blank" }
  | { type: "scalar"; value: Scalar }
  | { type: "item"; children: SnapshotNode[] }
  | { type: "formula"; expr: string }
  | { type: "query"; from: string; where: string; orderBy: string };

export type SnapshotNode = {
  id: EntryId;
  label?: string;
  view?: ViewName;
  content: SnapshotNodeContent;
};

export type SnapshotData = {
  version: number;
  rootId: EntryId;
  nextId: EntryId;
  root: SnapshotNode;
};

export type CoreOpErrorCode =
  | "ROOT_NOT_SET"
  | "UNKNOWN_ENTRY"
  | "DUPLICATE_ENTRY_ID"
  | "DUPLICATE_CHILD_LABEL"
  | "CANNOT_MOVE_ROOT"
  | "CANNOT_MOVE_INTO_SELF"
  | "CANNOT_MOVE_INTO_DESCENDANT"
  | "PARENT_NOT_ITEM"
  | "ITEM_MEMBERSHIP_VIA_MOVE"
  | "CANNOT_CONVERT_NONEMPTY_ITEM";

export class CoreOpError extends Error {
  readonly code: CoreOpErrorCode;

  constructor(code: CoreOpErrorCode, message: string) {
    super(message);
    this.name = "CoreOpError";
    this.code = code;
  }
}

export function isCoreOpError(err: unknown): err is CoreOpError {
  return err instanceof CoreOpError;
}

export type CoreApiErrorCode =
  | "INVALID_NODE_ID"
  | "DERIVED_NODE_ID"
  | "UNKNOWN_NODE_ID"
  | "SNAPSHOT_ROOT_MISMATCH"
  | "SNAPSHOT_PARSE_ERROR";

export class CoreApiError extends Error {
  readonly code: CoreApiErrorCode;

  constructor(code: CoreApiErrorCode, message: string) {
    super(message);
    this.name = "CoreApiError";
    this.code = code;
  }
}

export function isCoreApiError(err: unknown): err is CoreApiError {
  return err instanceof CoreApiError;
}

type MoveSpec = { childId: EntryId; toParentId: EntryId; toIndex?: number };

type MoveResult = {
  fromParentId: EntryId | null;
  toParentId: EntryId | null;
  fromIndex: number | null;
  toIndex: number | null;
};

export type EntryPatch = {
  label?: string;
  view?: ViewName | null;
  content?: EntryContent;
};

export type Op =
  | { type: "create"; entry: Entry }
  | { type: "patch"; id: EntryId; next: EntryPatch }
  | { type: "move"; spec: MoveSpec }
  | { type: "remove"; id: EntryId };

export type TransactionMeta = {
  source?: "user" | "remote" | "rule" | "undo" | "redo" | string;
  origin?: string;
  seq?: number;
};

export type Transaction = {
  readonly ops: readonly Op[];
  readonly meta?: TransactionMeta;
};

export type ApplyDelta = {
  readonly removed: readonly EntryId[];
  readonly touched: readonly EntryId[];
};
export type ApplyResult = {
  readonly delta: ApplyDelta;
  readonly undoOps: readonly Op[];
};

type LocateInParentResult = {
  readonly parentId: EntryId;
  readonly index: number;
  readonly childIds: EntryId[];
};

export type Model = {
  setRoot(id: EntryId): void;
  rootId(): EntryId;

  createId(): EntryId;
  peekNextId(): EntryId;
  setNextId(next: EntryId): void;

  ops: {
    create(entry: Entry): Op;
    patch(id: EntryId, next: EntryPatch): Op;
    move(spec: MoveSpec): Op;
    remove(id: EntryId): Op;
    transaction(ops: readonly Op[], meta?: Transaction["meta"]): Transaction;
  };

  entrySignal(id: EntryId): ReadonlySignal<Entry>;

  hasEntry(id: EntryId): boolean;
  readEntry(id: EntryId): Entry;
  peekEntry(id: EntryId): Entry;

  contentTypeOf(id: EntryId): EntryContent["type"];
  canEditScalarText(id: EntryId): boolean;

  childIdsOf(itemId: EntryId): EntryId[];
  findChildIdByLabel(itemId: EntryId, label: string): EntryId | null;
  locateInParent(childId: EntryId): LocateInParentResult | null;

  apply(txn: Transaction): ApplyResult;

  snapshot(id: EntryId): SnapshotNode;
  exportSnapshot(): SnapshotData;
  replaceState(data: SnapshotData): void;
};

type EntryRecord = {
  entrySignal: Signal<Entry>;
  childLabelIndexSignal?: ReadonlySignal<Map<string, EntryId>>;
};

type EntrySnapshotRecord = { record: EntryRecord; entry: Entry };

function isBlankContent(content: EntryContent): content is BlankContent {
  return content.type === "blank";
}

function isScalarContent(content: EntryContent): content is ScalarContent {
  return content.type === "scalar";
}

export function isItemContent(content: EntryContent): content is ItemContent {
  return content.type === "item";
}

export function isFormulaContent(
  content: EntryContent,
): content is FormulaContent {
  return content.type === "formula";
}

export function isQueryContent(content: EntryContent): content is QueryContent {
  return content.type === "query";
}

function isItemEntry(entry: Entry): entry is ItemEntry {
  return isItemContent(entry.content);
}

function assertNever(_exhaustive: never, message: string): never {
  throw new CoreInvariantError(message);
}

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len));
}

export function normalizeLabel(label: string): string {
  return label.trim();
}

export function makeBlankEntry(id: EntryId): Entry {
  return {
    id,
    parentId: null,
    label: "",
    view: null,
    content: { type: "blank" },
  };
}

export function makeItemEntry(id: EntryId): Entry {
  return {
    id,
    parentId: null,
    label: "",
    view: null,
    content: { type: "item", childIds: [] },
  };
}

export function createModel(): Model {
  const entries = new Map<EntryId, EntryRecord>();

  let root: EntryId | null = null;
  let nextId = 1;

  const setRoot = (id: EntryId): void => {
    root = id;
  };

  const rootId = (): EntryId => {
    if (root == null) throw new CoreOpError("ROOT_NOT_SET", "Root not set");
    return root;
  };

  const createId = (): EntryId => nextId++;
  const peekNextId = (): EntryId => nextId;
  const setNextId = (next: EntryId): void => {
    nextId = next;
  };

  const hasEntry = (id: EntryId): boolean => entries.has(id);

  const entryRecord = (id: EntryId): EntryRecord => {
    const record = entries.get(id);
    if (!record)
      throw new CoreOpError("UNKNOWN_ENTRY", `Unknown entry id: ${String(id)}`);
    return record;
  };

  const entrySignal = (id: EntryId): ReadonlySignal<Entry> =>
    entryRecord(id).entrySignal;

  const readEntry = (id: EntryId): Entry => entrySignal(id).value;
  const peekEntry = (id: EntryId): Entry => entrySignal(id).peek();

  const createEntryInternal = (initial: Entry): void => {
    if (entries.has(initial.id))
      throw new CoreOpError(
        "DUPLICATE_ENTRY_ID",
        `Duplicate entry id: ${String(initial.id)}`,
      );
    entries.set(initial.id, { entrySignal: signal(initial) });
  };

  const snapshotEntries = (): Map<EntryId, EntrySnapshotRecord> =>
    new Map(
      [...entries].map(([id, record]) => [
        id,
        { record, entry: record.entrySignal.peek() },
      ]),
    );

  const restoreEntries = (
    snapshot: Map<EntryId, EntrySnapshotRecord>,
  ): void => {
    batch(() => {
      entries.clear();
      for (const [id, snap] of snapshot) {
        entries.set(id, snap.record);
        snap.record.entrySignal.value = snap.entry;
      }
    });
  };

  const childLabelIndexSignal = (
    itemId: EntryId,
  ): ReadonlySignal<Map<string, EntryId>> => {
    const itemRecord = entryRecord(itemId);
    return (itemRecord.childLabelIndexSignal ??= computed(() => {
      const itemEntry = entrySignal(itemId).value;
      if (!isItemContent(itemEntry.content)) return new Map<string, EntryId>();

      const childLabelIndex = new Map<string, EntryId>();
      for (const childId of itemEntry.content.childIds) {
        if (!entries.has(childId)) continue;
        const child = entrySignal(childId).value;
        const label = normalizeLabel(child.label);
        if (label) childLabelIndex.set(label, childId);
      }
      return childLabelIndex;
    }));
  };

  function assertUniqueChildLabels(parentId: EntryId): void {
    const parent = entrySignal(parentId).peek();
    if (!isItemEntry(parent))
      throw new CoreInvariantError("Parent is not an item");

    const seen = new Set<string>();
    for (const childId of parent.content.childIds) {
      if (!entries.has(childId)) continue;

      const label = normalizeLabel(entrySignal(childId).peek().label);
      if (!label) continue;

      if (seen.has(label))
        throw new CoreOpError(
          "DUPLICATE_CHILD_LABEL",
          `Duplicate label '${label}' in item`,
        );
      seen.add(label);
    }
  }

  const ops = {
    create: (entry: Entry): Op => ({ type: "create", entry }),
    patch: (id: EntryId, next: EntryPatch): Op => ({ type: "patch", id, next }),
    move: (spec: MoveSpec): Op => ({ type: "move", spec }),
    remove: (id: EntryId): Op => ({ type: "remove", id }),
    transaction: (
      opList: readonly Op[],
      meta?: Transaction["meta"],
    ): Transaction => (meta ? { ops: opList, meta } : { ops: opList }),
  } as const;

  const expectGroupParent = (
    parentId: EntryId,
  ): { entrySignal: Signal<Entry>; parent: ItemEntry } => {
    const parentSignal = entryRecord(parentId).entrySignal;
    const parent = parentSignal.peek();
    if (!isItemEntry(parent))
      throw new CoreOpError("PARENT_NOT_ITEM", "Parent is not an item");
    return { entrySignal: parentSignal, parent };
  };

  const getItemEntry = (id: EntryId | null): ItemEntry | null => {
    if (id == null || !entries.has(id)) return null;
    const entry = entrySignal(id).peek();
    return isItemEntry(entry) ? entry : null;
  };

  function move(spec: MoveSpec): MoveResult {
    const { childId, toParentId } = spec;

    if (!entries.has(childId))
      throw new CoreOpError("UNKNOWN_ENTRY", "Unknown child");
    if (childId === rootId())
      throw new CoreOpError("CANNOT_MOVE_ROOT", "Cannot move root");
    if (toParentId === childId)
      throw new CoreOpError(
        "CANNOT_MOVE_INTO_SELF",
        "Cannot move node into itself",
      );
    let cur: EntryId | null = toParentId;
    while (cur != null) {
      if (!entries.has(cur)) break;
      if (cur === childId)
        throw new CoreOpError(
          "CANNOT_MOVE_INTO_DESCENDANT",
          "Cannot move node into its descendant",
        );
      cur = entryRecord(cur).entrySignal.peek().parentId;
    }

    const childRecord = entryRecord(childId);
    const child = childRecord.entrySignal.peek();
    const fromParentId = child.parentId;

    let fromIndex: number | null = null;
    let toIndex: number | null = null;
    let preparedChildIds: EntryId[] | null = null;

    const fromParent = getItemEntry(fromParentId);
    const toParent = getItemEntry(toParentId);

    if (fromParentId != null) {
      if (!fromParent)
        throw new CoreOpError("PARENT_NOT_ITEM", "Parent is not an item");
      const i = fromParent.content.childIds.indexOf(childId);
      fromIndex = i >= 0 ? i : null;
    }

    if (!toParent)
      throw new CoreOpError("PARENT_NOT_ITEM", "Parent is not an item");

    const baseline =
      toParentId === fromParentId && fromIndex != null
        ? toParent.content.childIds.filter((cid) => cid !== childId)
        : [...toParent.content.childIds];

    const len = baseline.length;
    const rawAt = spec.toIndex == null ? len : clampIndex(spec.toIndex, len);
    toIndex = rawAt;

    preparedChildIds = [
      ...baseline.slice(0, rawAt),
      childId,
      ...baseline.slice(rawAt),
    ];

    if (
      fromParentId != null &&
      toParentId === fromParentId &&
      fromIndex != null &&
      toIndex != null &&
      toIndex === fromIndex
    ) {
      return { fromParentId, toParentId, fromIndex, toIndex };
    }

    batch(() => {
      if (preparedChildIds) {
        const { entrySignal: parentSignal, parent } =
          expectGroupParent(toParentId);
        parentSignal.value = {
          ...parent,
          content: { type: "item", childIds: preparedChildIds },
        };
      }

      if (fromParentId != null && fromParentId !== toParentId) {
        const { entrySignal: parentSignal, parent } =
          expectGroupParent(fromParentId);
        if (parent.content.childIds.includes(childId)) {
          parentSignal.value = {
            ...parent,
            content: {
              type: "item",
              childIds: parent.content.childIds.filter((x) => x !== childId),
            },
          };
        }
      }

      const nextParentId = toParentId ?? null;
      if (child.parentId !== nextParentId) {
        childRecord.entrySignal.value = { ...child, parentId: nextParentId };
      }
    });

    return { fromParentId, toParentId, fromIndex, toIndex };
  }

  const patch = (id: EntryId, next: EntryPatch): void => {
    const record = entryRecord(id);
    const currentEntry = record.entrySignal.peek();
    let nextContent = next.content;

    if (nextContent !== undefined) {
      const currentContent = currentEntry.content;
      const requestedContent = nextContent;

      if (isItemContent(requestedContent)) {
        if (requestedContent.childIds.length !== 0)
          throw new CoreOpError(
            "ITEM_MEMBERSHIP_VIA_MOVE",
            "Item membership must be modified via move",
          );

        if (isItemContent(currentContent)) {
          nextContent = undefined;
        }
      } else {
        if (
          isItemContent(currentContent) &&
          currentContent.childIds.length !== 0
        )
          throw new CoreOpError(
            "CANNOT_CONVERT_NONEMPTY_ITEM",
            "Cannot convert non-empty item to non-item",
          );
      }
    }

    record.entrySignal.value = {
      ...currentEntry,
      ...(next.label !== undefined ? { label: next.label } : {}),
      ...(next.view !== undefined ? { view: next.view } : {}),
      ...(nextContent !== undefined ? { content: nextContent } : {}),
    };
  };

  const remove = (
    id: EntryId,
  ): { removedIds: EntryId[]; parentTouched: EntryId | null } => {
    if (!entries.has(id))
      throw new CoreOpError("UNKNOWN_ENTRY", "Unknown entry");

    const record = entryRecord(id);
    const currentEntry = record.entrySignal.peek();
    const isRoot = id === rootId();
    const parentId = currentEntry.parentId;
    const removedIds: EntryId[] = [];

    const collectDescendants = (rootChildId: EntryId): void => {
      if (!entries.has(rootChildId)) return;
      const childEntry = entryRecord(rootChildId).entrySignal.peek();
      if (isItemContent(childEntry.content)) {
        for (const cid of childEntry.content.childIds) collectDescendants(cid);
      }
      removedIds.push(rootChildId);
    };

    if (isItemEntry(currentEntry)) {
      for (const childId of currentEntry.content.childIds) {
        collectDescendants(childId);
      }
    }
    if (!isRoot) removedIds.push(id);

    batch(() => {
      if (!isRoot && parentId != null) {
        const { entrySignal: parentSignal, parent: parentVal } =
          expectGroupParent(parentId);

        if (parentVal.content.childIds.includes(id)) {
          parentSignal.value = {
            ...parentVal,
            content: {
              type: "item",
              childIds: parentVal.content.childIds.filter((x) => x !== id),
            },
          };
        }
      }

      for (const removedId of removedIds) {
        if (removedId === id) continue;
        entries.delete(removedId);
      }

      if (isRoot) {
        record.entrySignal.value = {
          id: currentEntry.id,
          parentId: null,
          label: "",
          view: null,
          content: { type: "blank" },
        };
      } else {
        entries.delete(id);
      }
    });

    return {
      removedIds: isRoot ? [id, ...removedIds] : removedIds,
      parentTouched: isRoot ? null : parentId,
    };
  };

  const snapshotContentFromEntryContent = (
    content: EntryContent,
    itemChildren: SnapshotNode[] = [],
  ): SnapshotNodeContent => {
    switch (content.type) {
      case "blank":
        return { type: "blank" };
      case "scalar":
        return { type: "scalar", value: content.value };
      case "formula":
        return { type: "formula", expr: content.expr };
      case "query":
        return {
          type: "query",
          from: content.from,
          where: content.where,
          orderBy: content.orderBy,
        };
      case "item":
        return { type: "item", children: itemChildren };
      default:
        return assertNever(content, "Unknown entry content");
    }
  };

  const entryContentFromSnapshotContent = (
    content: SnapshotNodeContent,
  ): EntryContent => {
    switch (content.type) {
      case "blank":
        return { type: "blank" };
      case "scalar":
        return { type: "scalar", value: content.value };
      case "formula":
        return { type: "formula", expr: content.expr };
      case "query":
        return {
          type: "query",
          from: content.from,
          where: content.where,
          orderBy: content.orderBy,
        };
      case "item":
        return { type: "item", childIds: [] };
      default:
        return assertNever(content, "Unknown snapshot content");
    }
  };

  const captureSubtree = (rootEntryId: EntryId): SnapshotNode => {
    const entry = peekEntry(rootEntryId);
    const children = isItemContent(entry.content)
      ? entry.content.childIds.map((childId) => captureSubtree(childId))
      : [];
    return {
      id: entry.id,
      ...(entry.label ? { label: entry.label } : {}),
      ...(entry.view ? { view: entry.view } : {}),
      content: snapshotContentFromEntryContent(entry.content, children),
    };
  };

  const entryFromSnapshotNode = (
    node: SnapshotNode,
    parentId: EntryId | null,
  ): Entry => {
    return {
      id: node.id,
      parentId,
      label: node.label ?? "",
      view: node.view ?? null,
      content: entryContentFromSnapshotContent(node.content),
    };
  };

  const pushCreateSubtreeOps = (
    node: SnapshotNode,
    out: Op[],
    parentId: EntryId | null,
    opts?: { skipRoot?: true },
  ): void => {
    if (!opts?.skipRoot)
      out.push(ops.create(entryFromSnapshotNode(node, parentId)));
    if (node.content.type !== "item") return;
    for (let i = 0; i < node.content.children.length; i += 1) {
      const child = node.content.children[i]!;
      pushCreateSubtreeOps(child, out, node.id);
    }
  };

  const pushRestoreMoves = (node: SnapshotNode, out: Op[]): void => {
    if (node.content.type !== "item") return;
    for (let i = 0; i < node.content.children.length; i += 1) {
      const child = node.content.children[i]!;
      out.push(
        ops.move({
          childId: child.id,
          toParentId: node.id,
          toIndex: i,
        }),
      );
      pushRestoreMoves(child, out);
    }
  };

  const appendRestoreMovesInUndoBuildOrder = (
    node: SnapshotNode,
    out: Op[],
  ): void => {
    const restoreOps: Op[] = [];
    pushRestoreMoves(node, restoreOps);
    out.push(...restoreOps.toReversed());
  };

  const apply = (txn: Transaction): ApplyResult => {
    const removed = new Set<EntryId>();
    const touched = new Set<EntryId>();
    const undoBuildOps: Op[] = [];
    const snapshot = snapshotEntries();

    try {
      batch(() => {
        for (const op of txn.ops) {
          switch (op.type) {
            case "create": {
              undoBuildOps.push(ops.remove(op.entry.id));
              createEntryInternal(op.entry);
              touched.add(op.entry.id);
              break;
            }

            case "patch": {
              const currentEntry = peekEntry(op.id);
              const inversePatch: EntryPatch = {};
              if (
                op.next.label !== undefined &&
                op.next.label !== currentEntry.label
              ) {
                inversePatch.label = currentEntry.label;
              }
              if (
                op.next.view !== undefined &&
                op.next.view !== currentEntry.view
              ) {
                inversePatch.view = currentEntry.view;
              }
              if (op.next.content !== undefined) {
                if (
                  !(
                    op.next.content.type === "item" &&
                    currentEntry.content.type === "item"
                  )
                ) {
                  inversePatch.content = currentEntry.content;
                }
              }
              if (
                inversePatch.label !== undefined ||
                inversePatch.view !== undefined ||
                inversePatch.content !== undefined
              ) {
                undoBuildOps.push(ops.patch(op.id, inversePatch));
              }
              patch(op.id, op.next);
              touched.add(op.id);
              break;
            }

            case "move": {
              const child = peekEntry(op.spec.childId);
              const parentId = child.parentId;
              if (parentId != null) {
                const loc = locateInParent(op.spec.childId);
                undoBuildOps.push(
                  ops.move({
                    childId: op.spec.childId,
                    toParentId: parentId,
                    ...(loc ? { toIndex: loc.index } : {}),
                  }),
                );
              }
              const moveResult = move(op.spec);
              touched.add(op.spec.childId);
              if (moveResult.fromParentId != null)
                touched.add(moveResult.fromParentId);
              if (moveResult.toParentId != null)
                touched.add(moveResult.toParentId);
              break;
            }

            case "remove": {
              const removedEntry = peekEntry(op.id);
              const subtree = captureSubtree(op.id);
              if (op.id === rootId()) {
                if (subtree.content.type === "item") {
                  appendRestoreMovesInUndoBuildOrder(subtree, undoBuildOps);
                  pushCreateSubtreeOps(subtree, undoBuildOps, null, {
                    skipRoot: true,
                  });
                  undoBuildOps.push(
                    ops.patch(op.id, {
                      label: removedEntry.label,
                      view: removedEntry.view,
                      content: { type: "item", childIds: [] },
                    }),
                  );
                } else {
                  undoBuildOps.push(
                    ops.patch(op.id, {
                      label: removedEntry.label,
                      view: removedEntry.view,
                      content: removedEntry.content,
                    }),
                  );
                }
              } else {
                const parentId = removedEntry.parentId;
                if (parentId == null)
                  throw new CoreInvariantError(
                    "Remove inverse expects non-root node to have a parent",
                  );
                const loc = locateInParent(op.id);
                appendRestoreMovesInUndoBuildOrder(subtree, undoBuildOps);
                undoBuildOps.push(
                  ops.move({
                    childId: op.id,
                    toParentId: parentId,
                    ...(loc ? { toIndex: loc.index } : {}),
                  }),
                );
                pushCreateSubtreeOps(subtree, undoBuildOps, null);
              }
              const removeResult = remove(op.id);
              for (const removedId of removeResult.removedIds) {
                removed.add(removedId);
                touched.add(removedId);
              }
              if (removeResult.parentTouched != null)
                touched.add(removeResult.parentTouched);
              break;
            }

            default:
              return assertNever(op, "Unknown op");
          }
        }
      });

      const itemsToCheck = new Set<EntryId>();
      for (const id of touched) {
        const entry = entries.get(id)?.entrySignal.peek();
        if (!entry) continue;

        if (isItemEntry(entry)) itemsToCheck.add(id);
        if (entry.parentId != null && entries.has(entry.parentId))
          itemsToCheck.add(entry.parentId);
      }
      for (const itemId of itemsToCheck) assertUniqueChildLabels(itemId);
      if (DEV) assertValidInternal();
      return {
        delta: { removed: [...removed], touched: [...touched] },
        undoOps: undoBuildOps.toReversed(),
      };
    } catch (err) {
      restoreEntries(snapshot);
      throw err;
    }
  };

  const contentTypeOf = (id: EntryId): EntryContent["type"] =>
    entrySignal(id).value.content.type;

  const canEditScalarText = (id: EntryId): boolean => {
    const content = readEntry(id).content;
    return isBlankContent(content) || isScalarContent(content);
  };

  const childIdsOf = (itemId: EntryId): EntryId[] => {
    const itemEntry = entrySignal(itemId).value;
    return isItemContent(itemEntry.content)
      ? [...itemEntry.content.childIds]
      : [];
  };

  const findChildIdByLabel = (
    itemId: EntryId,
    label: string,
  ): EntryId | null => {
    const normalizedLabel = normalizeLabel(label);
    if (!normalizedLabel) return null;
    return childLabelIndexSignal(itemId).value.get(normalizedLabel) ?? null;
  };

  const locateInParent = (childId: EntryId): LocateInParentResult | null => {
    if (!entries.has(childId)) return null;

    const child = readEntry(childId);
    const parentId = child.parentId;
    if (parentId == null) return null;

    if (!entries.has(parentId)) return null;

    const parent = readEntry(parentId);
    if (!isItemEntry(parent)) return null;

    const childIds = [...parent.content.childIds];
    const index = childIds.indexOf(childId);
    if (index < 0) return null;

    return { parentId, index, childIds };
  };

  function assertValidInternal(): void {
    devAssert(root != null, "Root not set");
    if (root == null) return;
    devAssert(entries.has(root), `Root entry missing: ${String(root)}`);
    devAssert(
      entries.get(root)!.entrySignal.peek().parentId == null,
      `Root entry ${root} must not have a parent`,
    );

    const groupChildIdsOf = (id: EntryId): readonly EntryId[] | null => {
      const entry = entries.get(id)?.entrySignal.peek();
      if (!entry) return null;
      return isItemEntry(entry) ? entry.content.childIds : null;
    };

    for (const [itemId, record] of entries) {
      const itemEntry = record.entrySignal.peek();
      if (!isItemEntry(itemEntry)) continue;

      const childIds = itemEntry.content.childIds;

      const seenIds = new Set<EntryId>();
      for (const childId of childIds) {
        devAssert(
          !seenIds.has(childId),
          `Item ${itemId} contains duplicate child id ${childId}`,
        );
        seenIds.add(childId);

        devAssert(
          entries.has(childId),
          `Item ${itemId} references missing child id ${childId}`,
        );

        const child = entries.get(childId)!.entrySignal.peek();
        devAssert(
          child.parentId === itemId,
          `Child ${childId} has parentId=${String(child.parentId)} but is listed under item ${itemId}`,
        );
      }

      const seenLabels = new Set<string>();
      for (const childId of childIds) {
        const child = entries.get(childId)!.entrySignal.peek();
        const label = normalizeLabel(child.label);
        if (!label) continue;
        devAssert(
          !seenLabels.has(label),
          `Duplicate label '${label}' in item ${itemId}`,
        );
        seenLabels.add(label);
      }
    }

    for (const [childId, record] of entries) {
      const child = record.entrySignal.peek();
      const parentId = child.parentId;
      if (parentId == null) continue;

      devAssert(
        entries.has(parentId),
        `Entry ${childId} has missing parent ${parentId}`,
      );

      const parentChildIds = groupChildIdsOf(parentId);
      devAssert(
        parentChildIds != null,
        `Entry ${childId} parent ${parentId} is not an item`,
      );

      const count = parentChildIds!.reduce(
        (n, x) => n + (x === childId ? 1 : 0),
        0,
      );
      devAssert(
        count === 1,
        `Entry ${childId} parent ${parentId} contains it ${count} times (expected 1)`,
      );
    }

    for (const [id] of entries) {
      const seen = new Set<EntryId>();
      let cur: EntryId | null = id;
      while (cur != null) {
        devAssert(!seen.has(cur), `Cycle detected in parent chain at ${cur}`);
        seen.add(cur);
        const record = entries.get(cur);
        if (!record) break;
        cur = record.entrySignal.peek().parentId;
      }
    }
  }

  const snapshotNodeContent = (content: EntryContent): SnapshotNodeContent =>
    snapshotContentFromEntryContent(
      content,
      content.type === "item" ? content.childIds.map(snapshot) : [],
    );

  const snapshot = (id: EntryId): SnapshotNode => {
    const entry = entrySignal(id).value;
    const label = normalizeLabel(entry.label) ? entry.label : undefined;
    const view = entry.view ?? undefined;
    return {
      id: entry.id,
      ...(label ? { label } : {}),
      ...(view ? { view } : {}),
      content: snapshotNodeContent(entry.content),
    };
  };

  const exportSnapshot = (): SnapshotData => ({
    version: 1,
    rootId: rootId(),
    nextId,
    root: snapshot(rootId()),
  });

  const flattenParsedSnapshot = (
    parsedRoot: ParsedSnapshotNode,
  ): Map<EntryId, Entry> => {
    const nextEntries = new Map<EntryId, Entry>();

    const visit = (
      node: ParsedSnapshotNode,
      parentId: EntryId | null,
    ): void => {
      const content: EntryContent =
        node.content.type === "item"
          ? { type: "item", childIds: node.children.map((child) => child.id) }
          : node.content;
      nextEntries.set(node.id, {
        id: node.id,
        parentId,
        label: node.label,
        view: node.view,
        content,
      });
      for (const child of node.children) visit(child, node.id);
    };

    visit(parsedRoot, null);
    return nextEntries;
  };

  const replaceState = (data: SnapshotData): void => {
    if (!isRecord(data))
      throw new CoreApiError(
        "SNAPSHOT_PARSE_ERROR",
        "snapshot must be an object",
      );

    const version = readInt(data.version, "snapshot.version");
    if (version !== 1)
      throw new CoreApiError(
        "SNAPSHOT_PARSE_ERROR",
        `Unsupported snapshot version: ${version}`,
      );

    const nextRootId = readInt(data.rootId, "snapshot.rootId") as EntryId;
    const nextIdFromSnapshot = readInt(
      data.nextId,
      "snapshot.nextId",
    ) as EntryId;
    const seen = new Set<EntryId>();
    const maxIdRef = { value: 0 };
    const parsedRoot = parseSnapshotNode(
      data.root,
      "snapshot.root",
      seen,
      maxIdRef,
    );

    if (parsedRoot.id !== nextRootId)
      throw new CoreApiError(
        "SNAPSHOT_PARSE_ERROR",
        "snapshot.rootId must match snapshot.root.id",
      );
    if (nextIdFromSnapshot <= maxIdRef.value)
      throw new CoreApiError(
        "SNAPSHOT_PARSE_ERROR",
        "snapshot.nextId must be greater than all entry ids",
      );

    const nextEntries = flattenParsedSnapshot(parsedRoot);

    batch(() => {
      root = nextRootId;
      nextId = nextIdFromSnapshot;

      for (const id of [...entries.keys()]) {
        if (!nextEntries.has(id)) entries.delete(id);
      }

      for (const [id, entry] of nextEntries) {
        const existing = entries.get(id);
        if (existing) {
          existing.entrySignal.value = entry;
        } else {
          entries.set(id, { entrySignal: signal(entry) });
        }
      }

      if (DEV) assertValidInternal();
    });
  };

  return {
    setRoot,
    rootId,

    createId,
    peekNextId,
    setNextId,

    ops,

    entrySignal,

    hasEntry,
    readEntry,
    peekEntry,

    contentTypeOf,
    canEditScalarText,

    childIdsOf,
    findChildIdByLabel,
    locateInParent,

    apply,

    snapshot,
    exportSnapshot,
    replaceState,
  };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object";
}

function readInt(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value)
  )
    throw new CoreApiError(
      "SNAPSHOT_PARSE_ERROR",
      `${path} must be a finite integer`,
    );
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string")
    throw new CoreApiError("SNAPSHOT_PARSE_ERROR", `${path} must be a string`);
  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, path);
}

function readOptionalView(value: unknown, path: string): ViewName | undefined {
  if (value === undefined) return undefined;
  if (value === "outline" || value === "table" || value === "slider")
    return value;
  throw new CoreApiError(
    "SNAPSHOT_PARSE_ERROR",
    `${path} must be a valid view name`,
  );
}

function readScalar(value: unknown, path: string): Scalar {
  if (value === true) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new CoreApiError(
    "SNAPSHOT_PARSE_ERROR",
    `${path} must be true, a finite number, or a string`,
  );
}

type ParsedSnapshotNode = {
  id: EntryId;
  label: string;
  view: ViewName | null;
  content: EntryContent;
  children: ParsedSnapshotNode[];
};

function parseSnapshotNode(
  input: unknown,
  path: string,
  seen: Set<EntryId>,
  maxIdRef: { value: number },
): ParsedSnapshotNode {
  if (!isRecord(input))
    throw new CoreApiError("SNAPSHOT_PARSE_ERROR", `${path} must be an object`);

  const id = readInt(input.id, `${path}.id`) as EntryId;
  if (seen.has(id))
    throw new CoreApiError(
      "SNAPSHOT_PARSE_ERROR",
      `${path}.id duplicates entry id ${id}`,
    );
  seen.add(id);
  if (id > maxIdRef.value) maxIdRef.value = id;

  const label = readOptionalString(input.label, `${path}.label`) ?? "";
  const view = readOptionalView(input.view, `${path}.view`) ?? null;

  const contentInput = input.content;
  if (!isRecord(contentInput))
    throw new CoreApiError(
      "SNAPSHOT_PARSE_ERROR",
      `${path}.content must be an object`,
    );
  const kind = contentInput.type;
  if (typeof kind !== "string")
    throw new CoreApiError(
      "SNAPSHOT_PARSE_ERROR",
      `${path}.content.type must be a string`,
    );

  switch (kind) {
    case "blank":
      return { id, label, view, content: { type: "blank" }, children: [] };
    case "scalar":
      return {
        id,
        label,
        view,
        content: {
          type: "scalar",
          value: readScalar(contentInput.value, `${path}.content.value`),
        },
        children: [],
      };
    case "formula":
      return {
        id,
        label,
        view,
        content: {
          type: "formula",
          expr: readString(contentInput.expr, `${path}.content.expr`),
        },
        children: [],
      };
    case "query":
      return {
        id,
        label,
        view,
        content: {
          type: "query",
          from: readString(contentInput.from, `${path}.content.from`),
          where: readString(contentInput.where, `${path}.content.where`),
          orderBy: readString(contentInput.orderBy, `${path}.content.orderBy`),
        },
        children: [],
      };
    case "item": {
      const childrenInput = contentInput.children;
      if (!Array.isArray(childrenInput))
        throw new CoreApiError(
          "SNAPSHOT_PARSE_ERROR",
          `${path}.content.children must be an array`,
        );
      const children = childrenInput.map((child, i) =>
        parseSnapshotNode(
          child,
          `${path}.content.children[${i}]`,
          seen,
          maxIdRef,
        ),
      );
      return {
        id,
        label,
        view,
        content: { type: "item", childIds: [] },
        children,
      };
    }
    default:
      throw new CoreApiError(
        "SNAPSHOT_PARSE_ERROR",
        `${path}.content.type is invalid`,
      );
  }
}
