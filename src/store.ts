import {
  batch,
  computed,
  signal,
  type ReadonlySignal,
  type Signal,
} from "@preact/signals-core";

import { DEV, devAssert } from "./dev";

export type ItemId = number;
export type Scalar = true | number | string;
export type ViewKind = "" | "tree" | "table" | "slider";

type BlankContent = { kind: "blank" };
type ScalarContent = { kind: "scalar"; value: Scalar };
type GroupContent = { kind: "group"; items: readonly ItemId[] };
type DerivedContent = { kind: "derived"; expr: string };
type LensContent = {
  kind: "lens";
  from: string;
  where: string;
  orderBy: string;
};

export type StoredContentSettable = BlankContent | ScalarContent | GroupContent;

export type StoredContent =
  | StoredContentSettable
  | DerivedContent
  | LensContent;

export type Item = {
  readonly id: ItemId;
  readonly ownerId: ItemId | null;
  readonly label: string;
  readonly view: ViewKind;
  readonly content: StoredContent;
};

type GroupItem = Item & { content: GroupContent };

export function isBlankContent(
  content: StoredContent,
): content is BlankContent {
  return content.kind === "blank";
}

export function isScalarContent(
  content: StoredContent,
): content is ScalarContent {
  return content.kind === "scalar";
}

export function isGroupContent(
  content: StoredContent,
): content is GroupContent {
  return content.kind === "group";
}

export function isDerivedContent(
  content: StoredContent,
): content is DerivedContent {
  return content.kind === "derived";
}

export function isLensContent(content: StoredContent): content is LensContent {
  return content.kind === "lens";
}

export function isGroupItem(item: Item): item is GroupItem {
  return isGroupContent(item.content);
}

export type SnapshotContent =
  | { kind: "blank" }
  | Scalar
  | { kind: "group"; items: SnapshotItem[] }
  | { kind: "derived"; expr: string }
  | { kind: "lens"; from: string; where: string; orderBy: string };

export type SnapshotItem = {
  label?: string;
  view?: string;
  content: SnapshotContent;
};

export type ReparentSpec = {
  childId: ItemId;
  toOwnerId: ItemId | null;
  toIndex?: number;
};

export type ReparentResult = {
  fromOwnerId: ItemId | null;
  toOwnerId: ItemId | null;
  fromIndex: number | null;
  toIndex: number | null;
};

export type Patch = {
  label?: string;
  view?: ViewKind;
  content?: StoredContent;
};

export type Op =
  | { kind: "create"; item: Item }
  | { kind: "patch"; id: ItemId; next: Patch }
  | { kind: "reparent"; spec: ReparentSpec };

export type Transaction = {
  readonly ops: readonly Op[];
  readonly meta?: { source?: "local" | "remote" | string };
};

export type ApplyResult = {
  readonly created: readonly ItemId[];
  readonly touched: readonly ItemId[];
  readonly reparent: readonly ReparentResult[];
};

export type LocateInOwnerResult = {
  readonly ownerId: ItemId;
  readonly index: number;
  readonly items: ItemId[];
};

export type Store = {
  setRoot(id: ItemId): void;
  getRoot(): ItemId;

  createId(): ItemId;
  setNextId(next: ItemId): void;

  create: {
    blank(id: ItemId): Item;
    group(id: ItemId): Item;
  };

  op: {
    create(item: Item): Op;
    patch(id: ItemId, next: Patch): Op;
    patchLabel(id: ItemId, label: string): Op;
    patchView(id: ItemId, view: ViewKind): Op;
    patchContent(id: ItemId, content: StoredContent): Op;
    reparent(spec: ReparentSpec): Op;
    detach(childId: ItemId): Op;
    transaction(ops: readonly Op[], meta?: Transaction["meta"]): Transaction;
  };

  itemSignal(id: ItemId): ReadonlySignal<Item>;

  hasItem(id: ItemId): boolean;
  readItem(id: ItemId): Item;
  peekItem(id: ItemId): Item;

  getContentKind(id: ItemId): StoredContent["kind"];

  getChildren(groupId: ItemId): ItemId[];
  findChildByLabel(groupId: ItemId, label: string): ItemId | null;
  locateInOwner(childId: ItemId): LocateInOwnerResult | null;

  apply(txn: Transaction): ApplyResult;

  snapshot(id: ItemId): SnapshotItem;
  compactUnreachable(): { removed: number; removedIds: ItemId[] };

  normalizeLabel(s: string): string;
};

export function canEditTextContent(store: Store, id: ItemId): boolean {
  const content = store.readItem(id).content;
  return isBlankContent(content) || isScalarContent(content);
}

type ItemRec = {
  itemSignal: Signal<Item>;
  childLabelIndexSignal?: ReadonlySignal<Map<string, ItemId>>;
};

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len));
}

export function normalizeLabel(s: string): string {
  return s.trim();
}

export function createStore(): Store {
  const items = new Map<ItemId, ItemRec>();

  let rootId: ItemId | null = null;
  let nextId = 1;

  const setRoot = (id: ItemId): void => {
    rootId = id;
  };

  const getRoot = (): ItemId => {
    if (rootId == null) throw new Error("Root not set");
    return rootId;
  };

  const createId = (): ItemId => nextId++;
  const setNextId = (n: ItemId): void => {
    nextId = n;
  };

  const hasItem = (id: ItemId): boolean => items.has(id);

  const itemRec = (id: ItemId): ItemRec => {
    const rec = items.get(id);
    if (!rec) throw new Error(`Unknown item id: ${String(id)}`);
    return rec;
  };

  const itemSignal = (id: ItemId): ReadonlySignal<Item> =>
    itemRec(id).itemSignal;

  const readItem = (id: ItemId): Item => itemSignal(id).value;
  const peekItem = (id: ItemId): Item => itemSignal(id).peek();

  const createItemInternal = (initial: Item): void => {
    if (items.has(initial.id))
      throw new Error(`Duplicate item id: ${String(initial.id)}`);
    items.set(initial.id, { itemSignal: signal(initial) });
  };

  const childLabelIndexSignal = (
    groupId: ItemId,
  ): ReadonlySignal<Map<string, ItemId>> => {
    const rec = itemRec(groupId);
    return (rec.childLabelIndexSignal ??= computed(() => {
      const it = itemSignal(groupId).value;
      if (!isGroupContent(it.content)) return new Map<string, ItemId>();
      const m = new Map<string, ItemId>();
      for (const childId of it.content.items) {
        if (!items.has(childId)) continue;
        const child = itemSignal(childId).value;
        const nm = normalizeLabel(child.label);
        if (nm) m.set(nm, childId);
      }
      return m;
    }));
  };

  function assertSiblingLabelUniqueInOwner(
    ownerId: ItemId,
    childId: ItemId,
    nextLabel: string,
  ) {
    const nm = normalizeLabel(nextLabel);
    if (!nm) return;

    const owner = itemSignal(ownerId).peek();
    if (!isGroupItem(owner)) throw new Error("Owner is not a group");

    for (const sid of owner.content.items) {
      if (sid === childId) continue;
      if (!items.has(sid)) continue;
      const sib = itemSignal(sid).peek();
      if (normalizeLabel(sib.label) === nm) {
        throw new Error(`Duplicate label '${nm}' in group`);
      }
    }
  }

  function assertGroupContentHasUniqueChildLabels(
    itemsList: readonly ItemId[],
  ) {
    const seen = new Set<string>();
    for (const cid of itemsList) {
      if (!items.has(cid)) continue;
      const nm = normalizeLabel(itemSignal(cid).peek().label);
      if (!nm) continue;
      if (seen.has(nm)) throw new Error(`Duplicate label '${nm}' in group`);
      seen.add(nm);
    }
  }

  const create = {
    blank: (id: ItemId): Item => ({
      id,
      ownerId: null,
      label: "",
      view: "",
      content: { kind: "blank" },
    }),
    group: (id: ItemId): Item => ({
      id,
      ownerId: null,
      label: "",
      view: "",
      content: { kind: "group", items: [] },
    }),
  } as const;

  const op = {
    create: (item: Item): Op => ({ kind: "create", item }),
    patch: (id: ItemId, next: Patch): Op => ({ kind: "patch", id, next }),
    patchLabel: (id: ItemId, label: string): Op => ({
      kind: "patch",
      id,
      next: { label },
    }),
    patchView: (id: ItemId, view: ViewKind): Op => ({
      kind: "patch",
      id,
      next: { view },
    }),
    patchContent: (id: ItemId, content: StoredContent): Op => ({
      kind: "patch",
      id,
      next: { content },
    }),
    reparent: (spec: ReparentSpec): Op => ({ kind: "reparent", spec }),
    detach: (childId: ItemId): Op => ({
      kind: "reparent",
      spec: { childId, toOwnerId: null },
    }),
    transaction: (
      ops: readonly Op[],
      meta?: Transaction["meta"],
    ): Transaction => (meta ? { ops, meta } : { ops }),
  } as const;

  const expectGroupOwner = (ownerId: ItemId) => {
    const itemSignal0 = itemRec(ownerId).itemSignal;
    const owner = itemSignal0.peek();
    if (!isGroupItem(owner)) throw new Error("Owner is not a group");
    return { itemSignal: itemSignal0, owner };
  };

  const getGroupItem = (id: ItemId | null): GroupItem | null => {
    if (id == null || !items.has(id)) return null;
    const o = itemSignal(id).peek();
    return isGroupItem(o) ? o : null;
  };

  function reparent(spec: ReparentSpec): ReparentResult {
    const { childId, toOwnerId } = spec;

    if (!items.has(childId)) throw new Error("Unknown child");

    const childRec = itemRec(childId);
    const child = childRec.itemSignal.peek();
    const fromOwnerId = child.ownerId;

    let fromIndex: number | null = null;
    let toIndex: number | null = null;

    const fromOwner = getGroupItem(fromOwnerId);
    const toOwner = getGroupItem(toOwnerId);

    if (fromOwnerId != null) {
      if (!fromOwner) throw new Error("Owner is not a group");
      const i = fromOwner.content.items.indexOf(childId);
      fromIndex = i >= 0 ? i : null;
    }

    if (toOwnerId != null) {
      if (!toOwner) throw new Error("Owner is not a group");

      assertSiblingLabelUniqueInOwner(toOwnerId, childId, child.label);

      const len = toOwner.content.items.length;
      const rawAt = spec.toIndex == null ? len : clampIndex(spec.toIndex, len);
      toIndex =
        toOwnerId === fromOwnerId && fromIndex != null && rawAt > fromIndex
          ? rawAt - 1
          : rawAt;
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
      if (fromOwnerId != null) {
        const { itemSignal: ownerSignal, owner } =
          expectGroupOwner(fromOwnerId);
        const before = owner.content.items;
        if (before.includes(childId)) {
          ownerSignal.value = {
            ...owner,
            content: {
              kind: "group",
              items: before.filter((x) => x !== childId),
            },
          };
        }
      }

      if (toOwnerId != null) {
        const { itemSignal: ownerSignal, owner } = expectGroupOwner(toOwnerId);
        const before = owner.content.items;
        const at = clampIndex(toIndex ?? before.length, before.length);
        const nextItems = [
          ...before.slice(0, at),
          childId,
          ...before.slice(at),
        ];
        assertGroupContentHasUniqueChildLabels(nextItems);

        ownerSignal.value = {
          ...owner,
          content: {
            kind: "group",
            items: nextItems,
          },
        };
        childRec.itemSignal.value = { ...child, ownerId: toOwnerId };
      } else {
        childRec.itemSignal.value = { ...child, ownerId: null };
      }
    });

    return { fromOwnerId, toOwnerId, fromIndex, toIndex };
  }

  const patch = (id: ItemId, next: Patch): void => {
    const rec = itemRec(id);
    const cur = rec.itemSignal.peek();

    if (next.label !== undefined) {
      const ownerId = cur.ownerId;
      if (ownerId != null)
        assertSiblingLabelUniqueInOwner(ownerId, id, next.label);
    }

    if (next.content !== undefined) {
      if (isGroupContent(next.content)) {
        throw new Error("Group membership must be modified via reparent");
      }
    }

    rec.itemSignal.value = {
      ...cur,
      ...(next.label !== undefined ? { label: next.label } : {}),
      ...(next.view !== undefined ? { view: next.view } : {}),
      ...(next.content !== undefined ? { content: next.content } : {}),
    };
  };

  const apply = (txn: Transaction): ApplyResult => {
    const created: ItemId[] = [];
    const touched = new Set<ItemId>();
    const reparentResults: ReparentResult[] = [];

    batch(() => {
      for (const op0 of txn.ops) {
        switch (op0.kind) {
          case "create":
            createItemInternal(op0.item);
            created.push(op0.item.id);
            touched.add(op0.item.id);
            break;
          case "patch":
            patch(op0.id, op0.next);
            touched.add(op0.id);
            break;
          case "reparent": {
            const res = reparent(op0.spec);
            reparentResults.push(res);
            touched.add(op0.spec.childId);
            if (res.fromOwnerId != null) touched.add(res.fromOwnerId);
            if (res.toOwnerId != null) touched.add(res.toOwnerId);
            break;
          }
          default: {
            const never: never = op0;
            throw new Error("Unknown op");
          }
        }
      }
    });

    if (DEV) assertValidInternal();
    return { created, touched: [...touched], reparent: reparentResults };
  };

  const getContentKind = (id: ItemId): StoredContent["kind"] =>
    itemSignal(id).value.content.kind;

  const getChildren = (groupId: ItemId): ItemId[] => {
    const it = itemSignal(groupId).value;
    return isGroupContent(it.content) ? [...it.content.items] : [];
  };

  const findChildByLabel = (groupId: ItemId, label: string): ItemId | null => {
    const nm = normalizeLabel(label);
    if (!nm) return null;
    return childLabelIndexSignal(groupId).value.get(nm) ?? null;
  };

  const locateInOwner = (childId: ItemId): LocateInOwnerResult | null => {
    if (!items.has(childId)) return null;

    const child = peekItem(childId);
    const ownerId = child.ownerId;
    if (ownerId == null) return null;

    const owner = peekItem(ownerId);
    if (!isGroupItem(owner)) return null;

    const items2 = [...owner.content.items];
    const index = items2.indexOf(childId);
    if (index < 0) return null;

    return { ownerId, index, items: items2 };
  };

  const collectReachableFrom = (root: ItemId): Set<ItemId> => {
    const seen = new Set<ItemId>();
    const stack: ItemId[] = [root];

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const it = itemSignal(id).peek();
      if (isGroupItem(it)) for (const cid of it.content.items) stack.push(cid);
    }

    return seen;
  };

  const compactUnreachable = (): { removed: number; removedIds: ItemId[] } => {
    const keep = collectReachableFrom(getRoot());
    const removedIds: ItemId[] = [];
    for (const [id] of items) {
      if (!keep.has(id)) {
        items.delete(id);
        removedIds.push(id);
      }
    }
    if (DEV) assertValidInternal();
    return { removed: removedIds.length, removedIds };
  };

  function assertValidInternal() {
    devAssert(rootId != null, "Root not set");
    devAssert(items.has(rootId!), `Root item missing: ${String(rootId)}`);

    const groupItemsOf = (id: ItemId): readonly ItemId[] | null => {
      const it = items.get(id)?.itemSignal.peek();
      if (!it) return null;
      return isGroupItem(it) ? it.content.items : null;
    };

    for (const [gid, rec] of items) {
      const it = rec.itemSignal.peek();
      if (!isGroupItem(it)) continue;

      const childIds = it.content.items;

      const seenIds = new Set<ItemId>();
      for (const cid of childIds) {
        devAssert(
          !seenIds.has(cid),
          `Group ${gid} contains duplicate child id ${cid}`,
        );
        seenIds.add(cid);

        devAssert(
          items.has(cid),
          `Group ${gid} references missing child id ${cid}`,
        );

        const child = items.get(cid)!.itemSignal.peek();
        devAssert(
          child.ownerId === gid,
          `Child ${cid} has ownerId=${String(child.ownerId)} but is listed under group ${gid}`,
        );
      }

      const seenLabels = new Set<string>();
      for (const cid of childIds) {
        const child = items.get(cid)!.itemSignal.peek();
        const nm = normalizeLabel(child.label);
        if (!nm) continue;
        devAssert(
          !seenLabels.has(nm),
          `Duplicate label '${nm}' in group ${gid}`,
        );
        seenLabels.add(nm);
      }
    }

    for (const [cid, rec] of items) {
      const child = rec.itemSignal.peek();
      const ownerId0 = child.ownerId;
      if (ownerId0 == null) continue;

      devAssert(
        items.has(ownerId0),
        `Item ${cid} has missing owner ${ownerId0}`,
      );
      const ownerItems = groupItemsOf(ownerId0);
      devAssert(
        ownerItems != null,
        `Item ${cid} owner ${ownerId0} is not a group`,
      );

      const count = ownerItems!.reduce((n, x) => n + (x === cid ? 1 : 0), 0);
      devAssert(
        count === 1,
        `Item ${cid} owner ${ownerId0} contains it ${count} times (expected 1)`,
      );
    }
  }

  const snapshotContent = (content: StoredContent): SnapshotContent => {
    if (isBlankContent(content)) return { kind: "blank" };
    if (isScalarContent(content)) return content.value;
    if (isDerivedContent(content))
      return { kind: "derived", expr: content.expr };
    if (isLensContent(content)) {
      return {
        kind: "lens",
        from: content.from,
        where: content.where,
        orderBy: content.orderBy,
      };
    }
    if (isGroupContent(content))
      return { kind: "group", items: content.items.map(snapshot) };
    const unreachable: never = content;
    return unreachable;
  };

  const snapshot = (id: ItemId): SnapshotItem => {
    const it = itemSignal(id).value;
    const label = it.label.trim() ? it.label : undefined;
    const view = it.view.trim() ? it.view : undefined;
    return { label, view, content: snapshotContent(it.content) };
  };

  return {
    setRoot,
    getRoot,

    createId,
    setNextId,

    create,
    op,

    itemSignal,

    hasItem,
    readItem,
    peekItem,

    getContentKind,

    getChildren,
    findChildByLabel,
    locateInOwner,

    apply,

    snapshot,
    compactUnreachable,

    normalizeLabel,
  };
}
