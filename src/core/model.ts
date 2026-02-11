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
  readonly ownerId: EntryId | null;
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
  toOwnerId: EntryId | null;
  toIndex?: number;
};

type MoveResult = {
  fromOwnerId: EntryId | null;
  toOwnerId: EntryId | null;
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

type LocateInOwnerResult = {
  readonly ownerId: EntryId;
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
  locateInOwner(childId: EntryId): LocateInOwnerResult | null;

  apply(txn: Transaction): ApplyResult;

  snapshot(id: EntryId): SnapshotEntry;
  pruneUnreachable(): { removed: number; removedIds: EntryId[] };
};

type EntryRec = {
  entrySignal: Signal<Entry>;
  childLabelIndexSignal?: ReadonlySignal<Map<string, EntryId>>;
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
    ownerId: null,
    label: "",
    view: null,
    content: { kind: "blank" },
  };
}

export function makeGroupEntry(id: EntryId): Entry {
  return {
    id,
    ownerId: null,
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
  const setNextId = (n: EntryId): void => {
    nextId = n;
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

  const childLabelIndexSignal = (
    groupId: EntryId,
  ): ReadonlySignal<Map<string, EntryId>> => {
    const rec = entryRec(groupId);
    return (rec.childLabelIndexSignal ??= computed(() => {
      const it = entrySignal(groupId).value;
      if (!isGroupContent(it.content)) return new Map<string, EntryId>();

      const m = new Map<string, EntryId>();
      for (const childId of it.content.childIds) {
        if (!entries.has(childId)) continue;
        const child = entrySignal(childId).value;
        const nm = normalizeLabel(child.label);
        if (nm) m.set(nm, childId);
      }
      return m;
    }));
  };

  function assertUniqueChildLabels(
    ownerId: EntryId,
    opts: {
      childIds?: readonly EntryId[];
      override?: { childId: EntryId; label: string };
    } = {},
  ) {
    const owner = entrySignal(ownerId).peek();
    if (!isGroupEntry(owner)) throw new Error("Owner is not a group");

    const childIds = opts.childIds ?? owner.content.childIds;

    const seen = new Set<string>();
    for (const cid of childIds) {
      if (!entries.has(cid)) continue;

      const it = entrySignal(cid).peek();
      const raw =
        opts.override && opts.override.childId === cid
          ? opts.override.label
          : it.label;

      const nm = normalizeLabel(raw);
      if (!nm) continue;

      if (seen.has(nm)) throw new Error(`Duplicate label '${nm}' in group`);
      seen.add(nm);
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

  const expectGroupOwner = (ownerId: EntryId) => {
    const s = entryRec(ownerId).entrySignal;
    const owner = s.peek();
    if (!isGroupEntry(owner)) throw new Error("Owner is not a group");
    return { entrySignal: s, owner };
  };

  const getGroupEntry = (id: EntryId | null): GroupEntry | null => {
    if (id == null || !entries.has(id)) return null;
    const o = entrySignal(id).peek();
    return isGroupEntry(o) ? o : null;
  };

  function move(spec: MoveSpec): MoveResult {
    const { childId, toOwnerId } = spec;

    if (!entries.has(childId)) throw new Error("Unknown child");

    const childRec = entryRec(childId);
    const child = childRec.entrySignal.peek();
    const fromOwnerId = child.ownerId;

    let fromIndex: number | null = null;
    let toIndex: number | null = null;
    let preparedChildIds: EntryId[] | null = null;

    const fromOwner = getGroupEntry(fromOwnerId);
    const toOwner = getGroupEntry(toOwnerId);

    if (fromOwnerId != null) {
      if (!fromOwner) throw new Error("Owner is not a group");
      const i = fromOwner.content.childIds.indexOf(childId);
      fromIndex = i >= 0 ? i : null;
    }

    if (toOwnerId != null) {
      if (!toOwner) throw new Error("Owner is not a group");

      const baseline =
        toOwnerId === fromOwnerId && fromIndex != null
          ? toOwner.content.childIds.filter((cid) => cid !== childId)
          : [...toOwner.content.childIds];

      const len = baseline.length;
      const rawAt = spec.toIndex == null ? len : clampIndex(spec.toIndex, len);
      toIndex = rawAt;

      preparedChildIds = [
        ...baseline.slice(0, rawAt),
        childId,
        ...baseline.slice(rawAt),
      ];

      assertUniqueChildLabels(toOwnerId, { childIds: preparedChildIds });
    }

    if (
      fromOwnerId != null &&
      toOwnerId === fromOwnerId &&
      fromIndex != null &&
      toIndex != null &&
      toIndex === fromIndex
    ) {
      return { fromOwnerId, toOwnerId, fromIndex, toIndex };
    }

    batch(() => {
      if (toOwnerId != null && preparedChildIds) {
        const { entrySignal: ownerSignal, owner } = expectGroupOwner(toOwnerId);
        ownerSignal.value = {
          ...owner,
          content: {
            kind: "group",
            childIds: preparedChildIds,
          },
        };
      }

      if (fromOwnerId != null && fromOwnerId !== toOwnerId) {
        const { entrySignal: ownerSignal, owner } =
          expectGroupOwner(fromOwnerId);
        if (owner.content.childIds.includes(childId)) {
          ownerSignal.value = {
            ...owner,
            content: {
              kind: "group",
              childIds: owner.content.childIds.filter((x) => x !== childId),
            },
          };
        }
      }

      const nextOwnerId = toOwnerId ?? null;
      if (child.ownerId !== nextOwnerId) {
        childRec.entrySignal.value = { ...child, ownerId: nextOwnerId };
      }
    });

    return { fromOwnerId, toOwnerId, fromIndex, toIndex };
  }

  const patch = (id: EntryId, next: EntryPatch): void => {
    const rec = entryRec(id);
    const cur = rec.entrySignal.peek();

    if (next.label !== undefined) {
      const ownerId = cur.ownerId;
      if (ownerId != null) {
        assertUniqueChildLabels(ownerId, {
          override: { childId: id, label: next.label },
        });
      }
    }

    if (next.content !== undefined) {
      const curC = cur.content;
      const nextC = next.content;

      if (isGroupContent(nextC)) {
        if (isGroupContent(curC))
          throw new Error("Group membership must be modified via move");
        if (nextC.childIds.length !== 0)
          throw new Error("Group membership must be modified via move");
      } else {
        if (isGroupContent(curC) && curC.childIds.length !== 0)
          throw new Error("Cannot convert non-empty group to non-group");
      }
    }

    rec.entrySignal.value = {
      ...cur,
      ...(next.label !== undefined ? { label: next.label } : {}),
      ...(next.view !== undefined ? { view: next.view } : {}),
      ...(next.content !== undefined ? { content: next.content } : {}),
    };
  };

  const remove = (
    id: EntryId,
  ): {
    removedId: EntryId;
    ownerTouched: EntryId | null;
    orphanedChildren: EntryId[];
  } => {
    if (!entries.has(id)) throw new Error("Unknown entry");
    if (id === rootId()) throw new Error("Cannot remove root");

    const rec = entryRec(id);
    const cur = rec.entrySignal.peek();

    const ownerId = cur.ownerId;
    const orphanedChildren: EntryId[] = [];

    batch(() => {
      if (ownerId != null) {
        const owner = getGroupEntry(ownerId);
        if (!owner) throw new Error("Owner is not a group");

        const { entrySignal: ownerSignal, owner: ownerVal } =
          expectGroupOwner(ownerId);

        if (ownerVal.content.childIds.includes(id)) {
          ownerSignal.value = {
            ...ownerVal,
            content: {
              kind: "group",
              childIds: ownerVal.content.childIds.filter((x) => x !== id),
            },
          };
        }
      }

      if (isGroupEntry(cur)) {
        for (const cid of cur.content.childIds) {
          if (!entries.has(cid)) continue;
          const childRec = entryRec(cid);
          const child = childRec.entrySignal.peek();
          if (child.ownerId === id) {
            childRec.entrySignal.value = { ...child, ownerId: null };
            orphanedChildren.push(cid);
          }
        }
      }

      entries.delete(id);
    });

    return { removedId: id, ownerTouched: ownerId, orphanedChildren };
  };

  const apply = (txn: Transaction): ApplyResult => {
    const created: EntryId[] = [];
    const touched = new Set<EntryId>();
    const moved: MoveResult[] = [];

    batch(() => {
      for (const op0 of txn.ops) {
        switch (op0.kind) {
          case "create":
            createEntryInternal(op0.entry);
            created.push(op0.entry.id);
            touched.add(op0.entry.id);
            break;

          case "patch":
            patch(op0.id, op0.next);
            touched.add(op0.id);
            break;

          case "move": {
            const res = move(op0.spec);
            moved.push(res);
            touched.add(op0.spec.childId);
            if (res.fromOwnerId != null) touched.add(res.fromOwnerId);
            if (res.toOwnerId != null) touched.add(res.toOwnerId);
            break;
          }

          case "remove": {
            const res = remove(op0.id);
            touched.add(res.removedId);
            if (res.ownerTouched != null) touched.add(res.ownerTouched);
            for (const cid of res.orphanedChildren) touched.add(cid);
            break;
          }

          default: {
            const never: never = op0;
            throw new Error(`Unknown op: ${String((never as any).kind)}`);
          }
        }
      }
    });

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
    const it = entrySignal(groupId).value;
    return isGroupContent(it.content) ? [...it.content.childIds] : [];
  };

  const findChildIdByLabel = (
    groupId: EntryId,
    label: string,
  ): EntryId | null => {
    const nm = normalizeLabel(label);
    if (!nm) return null;
    return childLabelIndexSignal(groupId).value.get(nm) ?? null;
  };

  const locateInOwner = (childId: EntryId): LocateInOwnerResult | null => {
    if (!entries.has(childId)) return null;

    const child = readEntry(childId);
    const ownerId = child.ownerId;
    if (ownerId == null) return null;

    if (!entries.has(ownerId)) return null;

    const owner = readEntry(ownerId);
    if (!isGroupEntry(owner)) return null;

    const childIds = [...owner.content.childIds];
    const index = childIds.indexOf(childId);
    if (index < 0) return null;

    return { ownerId, index, childIds };
  };

  const collectReachableFrom = (start: EntryId): Set<EntryId> => {
    const seen = new Set<EntryId>();
    const stack: EntryId[] = [start];

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      if (!entries.has(id)) continue;

      seen.add(id);

      const it = entrySignal(id).peek();
      if (isGroupEntry(it))
        for (const cid of it.content.childIds) stack.push(cid);
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
      const it = entries.get(id)?.entrySignal.peek();
      if (!it) return null;
      return isGroupEntry(it) ? it.content.childIds : null;
    };

    for (const [gid, rec] of entries) {
      const it = rec.entrySignal.peek();
      if (!isGroupEntry(it)) continue;

      const childIds = it.content.childIds;

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
          child.ownerId === gid,
          `Child ${cid} has ownerId=${String(child.ownerId)} but is listed under group ${gid}`,
        );
      }

      const seenLabels = new Set<string>();
      for (const cid of childIds) {
        const child = entries.get(cid)!.entrySignal.peek();
        const nm = normalizeLabel(child.label);
        if (!nm) continue;
        devAssert(
          !seenLabels.has(nm),
          `Duplicate label '${nm}' in group ${gid}`,
        );
        seenLabels.add(nm);
      }
    }

    for (const [cid, rec] of entries) {
      const child = rec.entrySignal.peek();
      const ownerId0 = child.ownerId;
      if (ownerId0 == null) continue;

      devAssert(
        entries.has(ownerId0),
        `Entry ${cid} has missing owner ${ownerId0}`,
      );

      const ownerChildIds = groupChildIdsOf(ownerId0);
      devAssert(
        ownerChildIds != null,
        `Entry ${cid} owner ${ownerId0} is not a group`,
      );

      const count = ownerChildIds!.reduce((n, x) => n + (x === cid ? 1 : 0), 0);
      devAssert(
        count === 1,
        `Entry ${cid} owner ${ownerId0} contains it ${count} times (expected 1)`,
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
    const it = entrySignal(id).value;
    const label = it.label.trim() ? it.label : undefined;
    const view = it.view ?? undefined;
    return { label, view, content: snapshotContent(it.content) };
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
    locateInOwner,

    apply,

    snapshot,
    pruneUnreachable,
  };
}
