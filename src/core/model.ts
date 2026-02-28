import type { ReadonlySignal, Signal } from "@preact/signals-core";
import { batch, computed, signal } from "@preact/signals-core";

import { DEV, devAssert } from "../dev";

export type EntryId = number;
export type Scalar = true | number | string;

export type ViewName = "outline" | "table" | "slider";

type BlankContent = { type: "blank" };
type ScalarContent = { type: "scalar"; value: Scalar };
type GroupContent = { type: "group"; childIds: readonly EntryId[] };
type FormulaContent = { type: "formula"; expr: string };
type QueryContent = {
  type: "query";
  from: string;
  where: string;
  orderBy: string;
};

type EntryContentSettable = BlankContent | ScalarContent | GroupContent;
export type EntryContent = EntryContentSettable | FormulaContent | QueryContent;

export type Entry = {
  readonly id: EntryId;
  readonly parentId: EntryId | null;
  readonly label: string;
  readonly view: ViewName | null;
  readonly content: EntryContent;
};

type GroupEntry = Entry & { content: GroupContent };

export type SnapshotNodeContent =
  | { type: "blank" }
  | { type: "scalar"; value: Scalar }
  | { type: "group"; children: SnapshotNode[] }
  | { type: "formula"; expr: string }
  | { type: "query"; from: string; where: string; orderBy: string };

export type SnapshotNode = {
  id: EntryId;
  label?: string;
  view?: ViewName;
  content: SnapshotNodeContent;
};

export type SnapshotData = {
  rootId: EntryId;
  nextId: EntryId;
  root: SnapshotNode;
};

type MoveSpec = { childId: EntryId; toParentId: EntryId; toIndex?: number };

type MoveResult = {
  fromParentId: EntryId | null;
  toParentId: EntryId | null;
  fromIndex: number | null;
  toIndex: number | null;
};

type EntryPatch = {
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
  expanded?: true;
};

export type Transaction = {
  readonly ops: readonly Op[];
  readonly meta?: TransactionMeta;
};

export type ApplyDelta = {
  readonly removed: readonly EntryId[];
  readonly touched: readonly EntryId[];
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

  childIdsOf(groupId: EntryId): EntryId[];
  findChildIdByLabel(groupId: EntryId, label: string): EntryId | null;
  locateInParent(childId: EntryId): LocateInParentResult | null;

  apply(txn: Transaction): ApplyDelta;

  snapshot(id: EntryId): SnapshotNode;
  exportSnapshot(): SnapshotData;
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

export function isGroupContent(content: EntryContent): content is GroupContent {
  return content.type === "group";
}

export function isFormulaContent(
  content: EntryContent,
): content is FormulaContent {
  return content.type === "formula";
}

export function isQueryContent(content: EntryContent): content is QueryContent {
  return content.type === "query";
}

function isGroupEntry(entry: Entry): entry is GroupEntry {
  return isGroupContent(entry.content);
}

function assertNever(_exhaustive: never, message: string): never {
  throw new Error(message);
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

export function makeGroupEntry(id: EntryId): Entry {
  return {
    id,
    parentId: null,
    label: "",
    view: null,
    content: { type: "group", childIds: [] },
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
    if (root == null) throw new Error("Root not set");
    return root;
  };

  const createId = (): EntryId => nextId++;
  const setNextId = (next: EntryId): void => {
    nextId = next;
  };

  const hasEntry = (id: EntryId): boolean => entries.has(id);

  const entryRecord = (id: EntryId): EntryRecord => {
    const record = entries.get(id);
    if (!record) throw new Error(`Unknown entry id: ${String(id)}`);
    return record;
  };

  const entrySignal = (id: EntryId): ReadonlySignal<Entry> =>
    entryRecord(id).entrySignal;

  const readEntry = (id: EntryId): Entry => entrySignal(id).value;
  const peekEntry = (id: EntryId): Entry => entrySignal(id).peek();

  const createEntryInternal = (initial: Entry): void => {
    if (entries.has(initial.id))
      throw new Error(`Duplicate entry id: ${String(initial.id)}`);
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
    groupId: EntryId,
  ): ReadonlySignal<Map<string, EntryId>> => {
    const groupRecord = entryRecord(groupId);
    return (groupRecord.childLabelIndexSignal ??= computed(() => {
      const groupEntry = entrySignal(groupId).value;
      if (!isGroupContent(groupEntry.content))
        return new Map<string, EntryId>();

      const childLabelIndex = new Map<string, EntryId>();
      for (const childId of groupEntry.content.childIds) {
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
    if (!isGroupEntry(parent)) throw new Error("Parent is not a group");

    const seen = new Set<string>();
    for (const childId of parent.content.childIds) {
      if (!entries.has(childId)) continue;

      const label = normalizeLabel(entrySignal(childId).peek().label);
      if (!label) continue;

      if (seen.has(label))
        throw new Error(`Duplicate label '${label}' in group`);
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
  ): { entrySignal: Signal<Entry>; parent: GroupEntry } => {
    const parentSignal = entryRecord(parentId).entrySignal;
    const parent = parentSignal.peek();
    if (!isGroupEntry(parent)) throw new Error("Parent is not a group");
    return { entrySignal: parentSignal, parent };
  };

  const getGroupEntry = (id: EntryId | null): GroupEntry | null => {
    if (id == null || !entries.has(id)) return null;
    const entry = entrySignal(id).peek();
    return isGroupEntry(entry) ? entry : null;
  };

  function move(spec: MoveSpec): MoveResult {
    const { childId, toParentId } = spec;

    if (!entries.has(childId)) throw new Error("Unknown child");
    if (childId === rootId()) throw new Error("Cannot move root");
    if (toParentId === childId) throw new Error("Cannot move item into itself");
    let cur: EntryId | null = toParentId;
    while (cur != null) {
      if (!entries.has(cur)) break;
      if (cur === childId)
        throw new Error("Cannot move item into its descendant");
      cur = entryRecord(cur).entrySignal.peek().parentId;
    }

    const childRecord = entryRecord(childId);
    const child = childRecord.entrySignal.peek();
    const fromParentId = child.parentId;

    let fromIndex: number | null = null;
    let toIndex: number | null = null;
    let preparedChildIds: EntryId[] | null = null;

    const fromParent = getGroupEntry(fromParentId);
    const toParent = getGroupEntry(toParentId);

    if (fromParentId != null) {
      if (!fromParent) throw new Error("Parent is not a group");
      const i = fromParent.content.childIds.indexOf(childId);
      fromIndex = i >= 0 ? i : null;
    }

    if (!toParent) throw new Error("Parent is not a group");

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
          content: { type: "group", childIds: preparedChildIds },
        };
      }

      if (fromParentId != null && fromParentId !== toParentId) {
        const { entrySignal: parentSignal, parent } =
          expectGroupParent(fromParentId);
        if (parent.content.childIds.includes(childId)) {
          parentSignal.value = {
            ...parent,
            content: {
              type: "group",
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

      if (isGroupContent(requestedContent)) {
        if (requestedContent.childIds.length !== 0)
          throw new Error("Group membership must be modified via move");

        if (isGroupContent(currentContent)) {
          nextContent = undefined;
        }
      } else {
        if (
          isGroupContent(currentContent) &&
          currentContent.childIds.length !== 0
        )
          throw new Error("Cannot convert non-empty group to non-group");
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
    if (!entries.has(id)) throw new Error("Unknown entry");

    const record = entryRecord(id);
    const currentEntry = record.entrySignal.peek();
    const isRoot = id === rootId();
    const parentId = currentEntry.parentId;
    const removedIds: EntryId[] = [];

    const collectDescendants = (rootChildId: EntryId): void => {
      if (!entries.has(rootChildId)) return;
      const childEntry = entryRecord(rootChildId).entrySignal.peek();
      if (isGroupContent(childEntry.content)) {
        for (const cid of childEntry.content.childIds) collectDescendants(cid);
      }
      removedIds.push(rootChildId);
    };

    if (isGroupEntry(currentEntry)) {
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
              type: "group",
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

  const apply = (txn: Transaction): ApplyDelta => {
    const removed = new Set<EntryId>();
    const touched = new Set<EntryId>();
    const snapshot = snapshotEntries();

    try {
      batch(() => {
        for (const op of txn.ops) {
          switch (op.type) {
            case "create":
              createEntryInternal(op.entry);
              touched.add(op.entry.id);
              break;

            case "patch":
              patch(op.id, op.next);
              touched.add(op.id);
              break;

            case "move": {
              const moveResult = move(op.spec);
              touched.add(op.spec.childId);
              if (moveResult.fromParentId != null)
                touched.add(moveResult.fromParentId);
              if (moveResult.toParentId != null)
                touched.add(moveResult.toParentId);
              break;
            }

            case "remove": {
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

      const groupsToCheck = new Set<EntryId>();
      for (const id of touched) {
        const entry = entries.get(id)?.entrySignal.peek();
        if (!entry) continue;

        if (isGroupEntry(entry)) groupsToCheck.add(id);
        if (entry.parentId != null && entries.has(entry.parentId))
          groupsToCheck.add(entry.parentId);
      }
      for (const groupId of groupsToCheck) assertUniqueChildLabels(groupId);
      if (DEV) assertValidInternal();
      return { removed: [...removed], touched: [...touched] };
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

  const childIdsOf = (groupId: EntryId): EntryId[] => {
    const groupEntry = entrySignal(groupId).value;
    return isGroupContent(groupEntry.content)
      ? [...groupEntry.content.childIds]
      : [];
  };

  const findChildIdByLabel = (
    groupId: EntryId,
    label: string,
  ): EntryId | null => {
    const normalizedLabel = normalizeLabel(label);
    if (!normalizedLabel) return null;
    return childLabelIndexSignal(groupId).value.get(normalizedLabel) ?? null;
  };

  const locateInParent = (childId: EntryId): LocateInParentResult | null => {
    if (!entries.has(childId)) return null;

    const child = readEntry(childId);
    const parentId = child.parentId;
    if (parentId == null) return null;

    if (!entries.has(parentId)) return null;

    const parent = readEntry(parentId);
    if (!isGroupEntry(parent)) return null;

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
      return isGroupEntry(entry) ? entry.content.childIds : null;
    };

    for (const [groupId, record] of entries) {
      const groupEntry = record.entrySignal.peek();
      if (!isGroupEntry(groupEntry)) continue;

      const childIds = groupEntry.content.childIds;

      const seenIds = new Set<EntryId>();
      for (const childId of childIds) {
        devAssert(
          !seenIds.has(childId),
          `Group ${groupId} contains duplicate child id ${childId}`,
        );
        seenIds.add(childId);

        devAssert(
          entries.has(childId),
          `Group ${groupId} references missing child id ${childId}`,
        );

        const child = entries.get(childId)!.entrySignal.peek();
        devAssert(
          child.parentId === groupId,
          `Child ${childId} has parentId=${String(child.parentId)} but is listed under group ${groupId}`,
        );
      }

      const seenLabels = new Set<string>();
      for (const childId of childIds) {
        const child = entries.get(childId)!.entrySignal.peek();
        const label = normalizeLabel(child.label);
        if (!label) continue;
        devAssert(
          !seenLabels.has(label),
          `Duplicate label '${label}' in group ${groupId}`,
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
        `Entry ${childId} parent ${parentId} is not a group`,
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

  const snapshotNodeContent = (content: EntryContent): SnapshotNodeContent => {
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
      case "group":
        return { type: "group", children: content.childIds.map(snapshot) };
      default:
        return assertNever(content, "Unknown entry content");
    }
  };

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
    rootId: rootId(),
    nextId,
    root: snapshot(rootId()),
  });

  return {
    setRoot,
    rootId,

    createId,
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
    throw new Error(`${path} must be a finite integer`);
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
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
  throw new Error(`${path} must be a valid view name`);
}

function readScalar(value: unknown, path: string): Scalar {
  if (value === true) return value;
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(`${path} must be true, a finite number, or a string`);
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
  if (!isRecord(input)) throw new Error(`${path} must be an object`);

  const id = readInt(input.id, `${path}.id`) as EntryId;
  if (seen.has(id)) throw new Error(`${path}.id duplicates entry id ${id}`);
  seen.add(id);
  if (id > maxIdRef.value) maxIdRef.value = id;

  const label = readOptionalString(input.label, `${path}.label`) ?? "";
  const view = readOptionalView(input.view, `${path}.view`) ?? null;

  const contentInput = input.content;
  if (!isRecord(contentInput))
    throw new Error(`${path}.content must be an object`);
  const kind = contentInput.type;
  if (typeof kind !== "string")
    throw new Error(`${path}.content.type must be a string`);

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
    case "group": {
      const childrenInput = contentInput.children;
      if (!Array.isArray(childrenInput))
        throw new Error(`${path}.content.children must be an array`);
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
        content: { type: "group", childIds: [] },
        children,
      };
    }
    default:
      throw new Error(`${path}.content.type is invalid`);
  }
}

export function createModelFromSnapshot(snapshot: SnapshotData): Model {
  if (!isRecord(snapshot)) throw new Error("snapshot must be an object");

  const rootId = readInt(snapshot.rootId, "snapshot.rootId") as EntryId;
  const nextId = readInt(snapshot.nextId, "snapshot.nextId") as EntryId;
  const seen = new Set<EntryId>();
  const maxIdRef = { value: 0 };
  const root = parseSnapshotNode(
    snapshot.root,
    "snapshot.root",
    seen,
    maxIdRef,
  );

  if (root.id !== rootId)
    throw new Error("snapshot.rootId must match snapshot.root.id");
  if (nextId <= maxIdRef.value)
    throw new Error("snapshot.nextId must be greater than all entry ids");

  const model = createModel();
  model.setRoot(rootId);
  model.setNextId(nextId);

  const createOps: Op[] = [];
  const moveOps: Op[] = [];

  const queueNode = (node: ParsedSnapshotNode): void => {
    createOps.push(
      model.ops.create({
        id: node.id,
        parentId: null,
        label: node.label,
        view: node.view,
        content: node.content,
      }),
    );

    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i]!;
      queueNode(child);
      moveOps.push(
        model.ops.move({ childId: child.id, toParentId: node.id, toIndex: i }),
      );
    }
  };

  queueNode(root);
  model.apply(model.ops.transaction([...createOps, ...moveOps]));
  return model;
}
