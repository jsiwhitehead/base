import {
  batch,
  computed,
  signal,
  type ReadonlySignal,
  type Signal,
} from "@preact/signals-core";

export type ItemId = number;
export type Scalar = true | number | string;
export type ViewKind = string;

export type StoredContentSettable =
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "scalar"; value: Scalar }>
  | Readonly<{ kind: "group"; items: readonly ItemId[] }>;

export type StoredContent =
  | StoredContentSettable
  | Readonly<{ kind: "derived"; expr: string }>
  | Readonly<{ kind: "lens"; from: string; where: string; orderBy: string }>;

export type Item = Readonly<{
  id: ItemId;
  ownerId: ItemId | null;
  label: string;
  view: ViewKind;
  content: StoredContent;
}>;

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

export type Patch = Readonly<{
  label?: string;
  view?: ViewKind;
  content?: StoredContent;
}>;

export type Op =
  | Readonly<{ kind: "create"; item: Item }>
  | Readonly<{ kind: "patch"; id: ItemId; next: Patch }>
  | Readonly<{ kind: "reparent"; spec: ReparentSpec }>;

export type Transaction = Readonly<{
  ops: readonly Op[];
  meta?: Readonly<{ source?: "local" | "remote" | string }>;
}>;

export type ApplyResult = Readonly<{
  created: readonly ItemId[];
  touched: readonly ItemId[];
  reparent: readonly ReparentResult[];
}>;

export type LocateInOwnerResult = Readonly<{
  ownerId: ItemId;
  index: number;
  items: ItemId[];
}>;

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

export const isContentSettableKind = (kind: StoredContent["kind"]) =>
  kind !== "derived" && kind !== "lens";

type ItemRec = {
  itemSignal: Signal<Item>;
  childLabelIndexSignal?: ReadonlySignal<Map<string, ItemId>>;
};

const clampIndex = (i: number, len: number) => Math.max(0, Math.min(i, len));

export function normalizeLabel(s: string): string {
  return s.trim();
}

export function createStore(): Store {
  const items = new Map<ItemId, ItemRec>();

  let rootId: ItemId | null = null;
  let nextId = 1;

  const setRoot = (id: ItemId) => {
    rootId = id;
  };

  const getRoot = (): ItemId => {
    if (rootId == null) throw new Error("Root not set");
    return rootId;
  };

  const createId = () => nextId++;
  const setNextId = (n: ItemId) => {
    nextId = Number(n);
  };

  const hasItem = (id: ItemId) => items.has(id);

  const itemRec = (id: ItemId): ItemRec => {
    const rec = items.get(id);
    if (!rec) throw new Error(`Unknown item id: ${String(id)}`);
    return rec;
  };

  const itemSignal = (id: ItemId): ReadonlySignal<Item> =>
    itemRec(id).itemSignal;

  const readItem = (id: ItemId) => itemSignal(id).value;
  const peekItem = (id: ItemId) => itemSignal(id).peek();

  const createItemInternal = (initial: Item) => {
    if (items.has(initial.id))
      throw new Error(`Duplicate item id: ${String(initial.id)}`);
    items.set(initial.id, { itemSignal: signal(initial) });
  };

  const childLabelIndexSignal = (groupId: ItemId) => {
    const rec = itemRec(groupId);
    return (rec.childLabelIndexSignal ??= computed(() => {
      const it = itemSignal(groupId).value;
      if (it.content.kind !== "group") return new Map<string, ItemId>();
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
    if (owner.content.kind !== "group") throw new Error("Owner is not a group");

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
      view: "" as ViewKind,
      content: { kind: "blank" },
    }),
    group: (id: ItemId): Item => ({
      id,
      ownerId: null,
      label: "",
      view: "" as ViewKind,
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
    if (owner.content.kind !== "group") throw new Error("Owner is not a group");
    return { itemSignal: itemSignal0, owner };
  };

  const isGroupItem = (id: ItemId | null): Item | null => {
    if (id == null || !items.has(id)) return null;
    const o = itemSignal(id).peek();
    return o.content.kind === "group" ? o : null;
  };

  function reparent(spec: ReparentSpec): ReparentResult {
    const { childId, toOwnerId } = spec;

    if (!items.has(childId)) throw new Error("Unknown child");

    const childRec = itemRec(childId);
    const child = childRec.itemSignal.peek();
    const fromOwnerId = child.ownerId;

    let fromIndex: number | null = null;
    let toIndex: number | null = null;

    const fromOwner = isGroupItem(fromOwnerId);
    const toOwner = isGroupItem(toOwnerId);

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

  const patch = (id: ItemId, next: Patch) => {
    const rec = itemRec(id);
    const cur = rec.itemSignal.peek();

    if (next.label !== undefined) {
      const ownerId = cur.ownerId;
      if (ownerId != null)
        assertSiblingLabelUniqueInOwner(ownerId, id, next.label);
    }

    if (next.content !== undefined) {
      if (next.content.kind === "group") {
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
            throw new Error(`Unknown op: ${String((never as any)?.kind)}`);
          }
        }
      }
    });

    return { created, touched: [...touched], reparent: reparentResults };
  };

  const getContentKind = (id: ItemId): StoredContent["kind"] =>
    itemSignal(id).value.content.kind;

  const getChildren = (groupId: ItemId): ItemId[] => {
    const it = itemSignal(groupId).value;
    return it.content.kind === "group" ? [...it.content.items] : [];
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
    if (owner.content.kind !== "group") return null;

    const items2 = [...owner.content.items];
    const index = items2.indexOf(childId);
    if (index < 0) return null;

    return { ownerId, index, items: items2 };
  };

  const collectReachableFrom = (root: ItemId) => {
    const seen = new Set<ItemId>();
    const stack: ItemId[] = [root];

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const it = itemSignal(id).peek();
      if (it.content.kind === "group")
        for (const cid of it.content.items) stack.push(cid);
    }

    return seen;
  };

  const compactUnreachable = () => {
    const keep = collectReachableFrom(getRoot());
    const removedIds: ItemId[] = [];
    for (const [id] of items) {
      if (!keep.has(id)) {
        items.delete(id);
        removedIds.push(id);
      }
    }
    return { removed: removedIds.length, removedIds };
  };

  const snapshotContent = (content: StoredContent): SnapshotContent => {
    switch (content.kind) {
      case "blank":
        return { kind: "blank" };
      case "scalar":
        return content.value;
      case "derived":
        return { kind: "derived", expr: content.expr };
      case "lens":
        return {
          kind: "lens",
          from: content.from,
          where: content.where,
          orderBy: content.orderBy,
        };
      case "group":
        return { kind: "group", items: content.items.map(snapshot) };
    }
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
