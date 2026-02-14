import { batch, computed, signal } from "@preact/signals-core";
import type { ReadonlySignal, Signal } from "@preact/signals-core";

import { DEV, devAssert } from "../dev";

export type EntryId = number;
export type Scalar = true | number | string;

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalar(text: string): Scalar | null {
  const t = text.trim();
  if (!t) return null;
  if (NUM_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t === "true") return true;
  return text;
}

export type ViewName = "outline" | "table" | "slider";
export type ViewKind = ViewName | null;

type BlankContent = { kind: "blank" };
type ScalarContent = { kind: "scalar"; value: Scalar };
type GroupContent = { kind: "group"; childIds: readonly EntryId[] };
type FormulaContent = { kind: "formula"; expr: string };
type QueryContent = {
  kind: "query";
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
  readonly view: ViewKind;
  readonly content: EntryContent;
};

type GroupEntry = Entry & { content: GroupContent };

function isBlankContent(content: EntryContent): content is BlankContent {
  return content.kind === "blank";
}

function isScalarContent(content: EntryContent): content is ScalarContent {
  return content.kind === "scalar";
}

export function isGroupContent(content: EntryContent): content is GroupContent {
  return content.kind === "group";
}

export function isFormulaContent(
  content: EntryContent,
): content is FormulaContent {
  return content.kind === "formula";
}

export function isQueryContent(content: EntryContent): content is QueryContent {
  return content.kind === "query";
}

function isGroupEntry(entry: Entry): entry is GroupEntry {
  return isGroupContent(entry.content);
}

type SnapshotContent =
  | { kind: "blank" }
  | { kind: "scalar"; value: Scalar }
  | { kind: "group"; childIds: SnapshotEntry[] }
  | { kind: "formula"; expr: string }
  | { kind: "query"; from: string; where: string; orderBy: string };

type SnapshotEntry = {
  label?: string;
  view?: ViewName;
  content: SnapshotContent;
};

type MoveSpec = {
  childId: EntryId;
  toParentId: EntryId | null;
  toIndex?: number;
};

type MoveResult = {
  fromParentId: EntryId | null;
  toParentId: EntryId | null;
  fromIndex: number | null;
  toIndex: number | null;
};

type EntryPatch = {
  label?: string;
  view?: ViewKind;
  content?: EntryContent;
};

export type Op =
  | { kind: "create"; entry: Entry }
  | { kind: "patch"; id: EntryId; next: EntryPatch }
  | { kind: "move"; spec: MoveSpec }
  | { kind: "remove"; id: EntryId };

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

export type ApplyResult = {
  readonly created: readonly EntryId[];
  readonly touched: readonly EntryId[];
  readonly moved: readonly MoveResult[];
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

  contentKindOf(id: EntryId): EntryContent["kind"];
  canEditScalarText(id: EntryId): boolean;

  childIdsOf(groupId: EntryId): EntryId[];
  findChildIdByLabel(groupId: EntryId, label: string): EntryId | null;
  locateInParent(childId: EntryId): LocateInParentResult | null;

  apply(txn: Transaction): ApplyResult;

  snapshot(id: EntryId): SnapshotEntry;
  pruneUnreachable(): { removed: number; removedIds: EntryId[] };
};

type EntryRec = {
  entrySignal: Signal<Entry>;
  childLabelIndexSignal?: ReadonlySignal<Map<string, EntryId>>;
};

type EntrySnapshotRec = {
  rec: EntryRec;
  entry: Entry;
};

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len));
}

export function normalizeLabel(s: string): string {
  return s.trim();
}

export function makeBlankEntry(id: EntryId): Entry {
  return {
    id,
    parentId: null,
    label: "",
    view: null,
    content: { kind: "blank" },
  };
}

export function makeGroupEntry(id: EntryId): Entry {
  return {
    id,
    parentId: null,
    label: "",
    view: null,
    content: { kind: "group", childIds: [] },
  };
}

export function createModel(): Model {
  const entries = new Map<EntryId, EntryRec>();

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

  const entryRec = (id: EntryId): EntryRec => {
    const rec = entries.get(id);
    if (!rec) throw new Error(`Unknown entry id: ${String(id)}`);
    return rec;
  };

  const entrySignal = (id: EntryId): ReadonlySignal<Entry> =>
    entryRec(id).entrySignal;

  const readEntry = (id: EntryId): Entry => entrySignal(id).value;
  const peekEntry = (id: EntryId): Entry => entrySignal(id).peek();

  const createEntryInternal = (initial: Entry): void => {
    if (entries.has(initial.id))
      throw new Error(`Duplicate entry id: ${String(initial.id)}`);
    entries.set(initial.id, { entrySignal: signal(initial) });
  };

  const snapshotEntries = (): Map<EntryId, EntrySnapshotRec> =>
    new Map(
      [...entries].map(([id, rec]) => [
        id,
        { rec, entry: rec.entrySignal.peek() },
      ]),
    );

  const restoreEntries = (snapshot: Map<EntryId, EntrySnapshotRec>): void => {
    batch(() => {
      entries.clear();
      for (const [id, snap] of snapshot) {
        entries.set(id, snap.rec);
        snap.rec.entrySignal.value = snap.entry;
      }
    });
  };

  const childLabelIndexSignal = (
    groupId: EntryId,
  ): ReadonlySignal<Map<string, EntryId>> => {
    const groupRec = entryRec(groupId);
    return (groupRec.childLabelIndexSignal ??= computed(() => {
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

  function assertUniqueChildLabels(
    parentId: EntryId,
    opts: {
      childIds?: readonly EntryId[];
      override?: { childId: EntryId; label: string };
    } = {},
  ) {
    const parent = entrySignal(parentId).peek();
    if (!isGroupEntry(parent)) throw new Error("Parent is not a group");

    const childIds = opts.childIds ?? parent.content.childIds;

    const seen = new Set<string>();
    for (const cid of childIds) {
      if (!entries.has(cid)) continue;

      const childEntry = entrySignal(cid).peek();
      const raw =
        opts.override && opts.override.childId === cid
          ? opts.override.label
          : childEntry.label;

      const label = normalizeLabel(raw);
      if (!label) continue;

      if (seen.has(label))
        throw new Error(`Duplicate label '${label}' in group`);
      seen.add(label);
    }
  }

  const ops = {
    create: (entry: Entry): Op => ({ kind: "create", entry }),
    patch: (id: EntryId, next: EntryPatch): Op => ({
      kind: "patch",
      id,
      next,
    }),
    move: (spec: MoveSpec): Op => ({ kind: "move", spec }),
    remove: (id: EntryId): Op => ({ kind: "remove", id }),
    transaction: (
      ops2: readonly Op[],
      meta?: Transaction["meta"],
    ): Transaction => (meta ? { ops: ops2, meta } : { ops: ops2 }),
  } as const;

  const expectGroupParent = (parentId: EntryId) => {
    const s = entryRec(parentId).entrySignal;
    const parent = s.peek();
    if (!isGroupEntry(parent)) throw new Error("Parent is not a group");
    return { entrySignal: s, parent };
  };

  const getGroupEntry = (id: EntryId | null): GroupEntry | null => {
    if (id == null || !entries.has(id)) return null;
    const entry = entrySignal(id).peek();
    return isGroupEntry(entry) ? entry : null;
  };

  function move(spec: MoveSpec): MoveResult {
    const { childId, toParentId } = spec;

    if (!entries.has(childId)) throw new Error("Unknown child");

    const childRec = entryRec(childId);
    const child = childRec.entrySignal.peek();
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

    if (toParentId != null) {
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

      assertUniqueChildLabels(toParentId, { childIds: preparedChildIds });
    }

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
      if (toParentId != null && preparedChildIds) {
        const { entrySignal: parentSignal, parent } =
          expectGroupParent(toParentId);
        parentSignal.value = {
          ...parent,
          content: {
            kind: "group",
            childIds: preparedChildIds,
          },
        };
      }

      if (fromParentId != null && fromParentId !== toParentId) {
        const { entrySignal: parentSignal, parent } =
          expectGroupParent(fromParentId);
        if (parent.content.childIds.includes(childId)) {
          parentSignal.value = {
            ...parent,
            content: {
              kind: "group",
              childIds: parent.content.childIds.filter((x) => x !== childId),
            },
          };
        }
      }

      const nextParentId = toParentId ?? null;
      if (child.parentId !== nextParentId) {
        childRec.entrySignal.value = { ...child, parentId: nextParentId };
      }
    });

    return { fromParentId, toParentId, fromIndex, toIndex };
  }

  const patch = (id: EntryId, next: EntryPatch): void => {
    const rec = entryRec(id);
    const cur = rec.entrySignal.peek();
    let nextContent = next.content;

    if (next.label !== undefined) {
      const parentId = cur.parentId;
      if (parentId != null) {
        assertUniqueChildLabels(parentId, {
          override: { childId: id, label: next.label },
        });
      }
    }

    if (nextContent !== undefined) {
      const curC = cur.content;
      const nextC = nextContent;

      if (isGroupContent(nextC)) {
        if (nextC.childIds.length !== 0)
          throw new Error("Group membership must be modified via move");

        if (isGroupContent(curC)) {
          nextContent = undefined;
        }
      } else {
        if (isGroupContent(curC) && curC.childIds.length !== 0)
          throw new Error("Cannot convert non-empty group to non-group");
      }
    }

    rec.entrySignal.value = {
      ...cur,
      ...(next.label !== undefined ? { label: next.label } : {}),
      ...(next.view !== undefined ? { view: next.view } : {}),
      ...(nextContent !== undefined ? { content: nextContent } : {}),
    };
  };

  const remove = (
    id: EntryId,
  ): {
    removedId: EntryId;
    parentTouched: EntryId | null;
    orphanedChildren: EntryId[];
  } => {
    if (!entries.has(id)) throw new Error("Unknown entry");
    if (id === rootId()) throw new Error("Cannot remove root");

    const rec = entryRec(id);
    const cur = rec.entrySignal.peek();

    const parentId = cur.parentId;
    const orphanedChildren: EntryId[] = [];

    batch(() => {
      if (parentId != null) {
        const parent = getGroupEntry(parentId);
        if (!parent) throw new Error("Parent is not a group");

        const { entrySignal: parentSignal, parent: parentVal } =
          expectGroupParent(parentId);

        if (parentVal.content.childIds.includes(id)) {
          parentSignal.value = {
            ...parentVal,
            content: {
              kind: "group",
              childIds: parentVal.content.childIds.filter((x) => x !== id),
            },
          };
        }
      }

      if (isGroupEntry(cur)) {
        for (const cid of cur.content.childIds) {
          if (!entries.has(cid)) continue;
          const childRec = entryRec(cid);
          const child = childRec.entrySignal.peek();
          if (child.parentId === id) {
            childRec.entrySignal.value = { ...child, parentId: null };
            orphanedChildren.push(cid);
          }
        }
      }

      entries.delete(id);
    });

    return { removedId: id, parentTouched: parentId, orphanedChildren };
  };

  const apply = (txn: Transaction): ApplyResult => {
    const created: EntryId[] = [];
    const touched = new Set<EntryId>();
    const moved: MoveResult[] = [];
    const snapshot = snapshotEntries();

    try {
      batch(() => {
        for (const op of txn.ops) {
          switch (op.kind) {
            case "create":
              createEntryInternal(op.entry);
              created.push(op.entry.id);
              touched.add(op.entry.id);
              break;

            case "patch":
              patch(op.id, op.next);
              touched.add(op.id);
              break;

            case "move": {
              const res = move(op.spec);
              moved.push(res);
              touched.add(op.spec.childId);
              if (res.fromParentId != null) touched.add(res.fromParentId);
              if (res.toParentId != null) touched.add(res.toParentId);
              break;
            }

            case "remove": {
              const res = remove(op.id);
              touched.add(res.removedId);
              if (res.parentTouched != null) touched.add(res.parentTouched);
              for (const cid of res.orphanedChildren) touched.add(cid);
              break;
            }

            default: {
              const never: never = op;
              throw new Error(`Unknown op: ${String((never as any).kind)}`);
            }
          }
        }
      });
    } catch (err) {
      restoreEntries(snapshot);
      throw err;
    }

    if (DEV) assertValidInternal();
    return { created, touched: [...touched], moved };
  };

  const contentKindOf = (id: EntryId): EntryContent["kind"] =>
    entrySignal(id).value.content.kind;

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

  const collectReachableFrom = (start: EntryId): Set<EntryId> => {
    const seen = new Set<EntryId>();
    const stack: EntryId[] = [start];

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      if (!entries.has(id)) continue;

      seen.add(id);

      const entry = entrySignal(id).peek();
      if (isGroupEntry(entry))
        for (const cid of entry.content.childIds) stack.push(cid);
    }
    return seen;
  };

  const pruneUnreachable = (): { removed: number; removedIds: EntryId[] } => {
    const keep = collectReachableFrom(rootId());
    const removedIds: EntryId[] = [];

    for (const [id] of entries) {
      if (!keep.has(id)) {
        entries.delete(id);
        removedIds.push(id);
      }
    }

    if (DEV) assertValidInternal();
    return { removed: removedIds.length, removedIds };
  };

  function assertValidInternal() {
    devAssert(root != null, "Root not set");
    devAssert(entries.has(root!), `Root entry missing: ${String(root)}`);

    const groupChildIdsOf = (id: EntryId): readonly EntryId[] | null => {
      const entry = entries.get(id)?.entrySignal.peek();
      if (!entry) return null;
      return isGroupEntry(entry) ? entry.content.childIds : null;
    };

    for (const [gid, rec] of entries) {
      const groupEntry = rec.entrySignal.peek();
      if (!isGroupEntry(groupEntry)) continue;

      const childIds = groupEntry.content.childIds;

      const seenIds = new Set<EntryId>();
      for (const cid of childIds) {
        devAssert(
          !seenIds.has(cid),
          `Group ${gid} contains duplicate child id ${cid}`,
        );
        seenIds.add(cid);

        devAssert(
          entries.has(cid),
          `Group ${gid} references missing child id ${cid}`,
        );

        const child = entries.get(cid)!.entrySignal.peek();
        devAssert(
          child.parentId === gid,
          `Child ${cid} has parentId=${String(child.parentId)} but is listed under group ${gid}`,
        );
      }

      const seenLabels = new Set<string>();
      for (const cid of childIds) {
        const child = entries.get(cid)!.entrySignal.peek();
        const label = normalizeLabel(child.label);
        if (!label) continue;
        devAssert(
          !seenLabels.has(label),
          `Duplicate label '${label}' in group ${gid}`,
        );
        seenLabels.add(label);
      }
    }

    for (const [cid, rec] of entries) {
      const child = rec.entrySignal.peek();
      const parentId = child.parentId;
      if (parentId == null) continue;

      devAssert(
        entries.has(parentId),
        `Entry ${cid} has missing parent ${parentId}`,
      );

      const parentChildIds = groupChildIdsOf(parentId);
      devAssert(
        parentChildIds != null,
        `Entry ${cid} parent ${parentId} is not a group`,
      );

      const count = parentChildIds!.reduce(
        (n, x) => n + (x === cid ? 1 : 0),
        0,
      );
      devAssert(
        count === 1,
        `Entry ${cid} parent ${parentId} contains it ${count} times (expected 1)`,
      );
    }
  }

  const snapshotContent = (content: EntryContent): SnapshotContent => {
    if (isBlankContent(content)) return { kind: "blank" };
    if (isScalarContent(content))
      return { kind: "scalar", value: content.value };
    if (isFormulaContent(content))
      return { kind: "formula", expr: content.expr };
    if (isQueryContent(content)) {
      return {
        kind: "query",
        from: content.from,
        where: content.where,
        orderBy: content.orderBy,
      };
    }
    if (isGroupContent(content)) {
      return { kind: "group", childIds: content.childIds.map(snapshot) };
    }
    const unreachable: never = content;
    return unreachable;
  };

  const snapshot = (id: EntryId): SnapshotEntry => {
    const entry = entrySignal(id).value;
    const label = entry.label.trim() ? entry.label : undefined;
    const view = entry.view ?? undefined;
    return {
      ...(label ? { label } : {}),
      ...(view ? { view } : {}),
      content: snapshotContent(entry.content),
    };
  };

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

    contentKindOf,
    canEditScalarText,

    childIdsOf,
    findChildIdByLabel,
    locateInParent,

    apply,

    snapshot,
    pruneUnreachable,
  };
}
