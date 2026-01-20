import {
  signal,
  computed,
  batch,
  type ReadonlySignal,
} from "@preact/signals-core";

export type ItemId = number | string;
export type Scalar = true | number | string;
export type ViewId = string;

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
  view: ViewId;
  content: StoredContent;
}>;

export type LabeledValue = { label?: string; value: Value };

export type Value =
  | { kind: "blank" }
  | { kind: "issue"; message: string }
  | { kind: "scalar"; value: Scalar }
  | { kind: "item-group"; items: ItemId[] }
  | { kind: "value-group"; items: LabeledValue[] };

export const V = {
  blank: (): Value => ({ kind: "blank" }),
  issue: (message: string): Value => ({ kind: "issue", message }),
  scalar: (value: Scalar): Value => ({ kind: "scalar", value }),
  itemGroup: (items: ItemId[]): Value => ({ kind: "item-group", items }),
  valueGroup: (items: LabeledValue[]): Value => ({
    kind: "value-group",
    items,
  }),
} as const;

export function isPresent(v: Value): boolean {
  return v.kind !== "blank" && v.kind !== "issue";
}

export function isTrue(v: Value): boolean {
  return v.kind === "scalar" && v.value === true;
}

function isIssue(v: Value): v is { kind: "issue"; message: string } {
  return v.kind === "issue";
}

export type EvalEnv = {
  lookup(name: string): Value;
  resolve(id: ItemId): Value;
  getLabel(id: ItemId): string;
};

export type Interpreter = (expr: string, env: EvalEnv) => Value;

export type StaticContent =
  | { kind: "blank" }
  | Scalar
  | { kind: "group"; items: StaticItem[] }
  | { kind: "derived"; expr: string }
  | { kind: "lens"; from: string; where: string; orderBy: string };

export type StaticItem = {
  label?: string;
  view?: string;
  content: StaticContent;
};

export type ItemInfo = {
  id: ItemId;
  ownerId: ItemId | null;
  label: string;
  view: ViewId;
  content: StoredContent;

  contentKind: StoredContent["kind"];
  contentSettable: boolean;

  derivedExpr?: string;
  lensSpec?: { from: string; where: string; orderBy: string };
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
  view?: ViewId;
  content?: StoredContent;
}>;

export type Op =
  | Readonly<{ kind: "create"; item: Item }>
  | Readonly<{ kind: "patch"; id: ItemId; next: Patch }>
  | Readonly<{ kind: "reparent"; spec: ReparentSpec }>;

export type Txn = Readonly<{
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

  allocId(): number;
  setNextId(next: number): void;

  setInterpreter(fn: Interpreter): void;

  make: {
    blank(id: ItemId): Item;
    group(id: ItemId): Item;
  };

  op: {
    create(item: Item): Op;
    patch(id: ItemId, next: Patch): Op;
    patchLabel(id: ItemId, label: string): Op;
    patchView(id: ItemId, view: ViewId): Op;
    patchContent(id: ItemId, content: StoredContent): Op;
    reparent(spec: ReparentSpec): Op;
    detach(childId: ItemId): Op;
    txn(ops: readonly Op[], meta?: Txn["meta"]): Txn;
  };

  sel: {
    item(id: ItemId): ItemInfo;
    value(id: ItemId): Value;
    groupItems(id: ItemId): ItemId[];
    childByLabel(ownerId: ItemId, label: string): ItemId | null;
    locateInOwner(childId: ItemId): LocateInOwnerResult | null;
    canEditScalarText(id: ItemId): boolean;
  };

  ops: {
    create(item: Item): void;
    patch(id: ItemId, next: Patch): void;
    reparent(spec: ReparentSpec): ReparentResult;
  };

  apply(txn: Txn): ApplyResult;

  snapshotStored(id: ItemId): StaticItem;
  compactUnreachable(): { removed: number };
};

export function isContentSettableKind(kind: StoredContent["kind"]): boolean {
  return kind !== "derived" && kind !== "lens";
}

type GetSignal<T> = { get(): T; peek(): T };
type SetSignal<T> = GetSignal<T> & { set(next: T): void };

const createAtom = <T>(initial: T): SetSignal<T> => {
  const s = signal(initial);
  return {
    get: () => s.value,
    peek: () => s.peek(),
    set: (next) => (s.value = next),
  };
};

const createComputed = <T>(fn: () => T): GetSignal<T> => {
  const s: ReadonlySignal<T> = computed(fn);
  return { get: () => s.value, peek: () => s.peek() };
};

type ItemRec = {
  atom: SetSignal<Item>;
  valueSig?: GetSignal<Value>;
  childLabelIndexSig?: GetSignal<Map<string, ItemId>>;
};

type EvalCtx = { visiting: Set<ItemId> };
const makeEvalCtx = (): EvalCtx => ({ visiting: new Set<ItemId>() });

export function createStore(): Store {
  const items = new Map<ItemId, ItemRec>();

  let rootId: ItemId | null = null;
  let nextId = 1;

  let interpretExpr: Interpreter = () =>
    V.issue("Interpreter not set (call store.setInterpreter)");

  const setRoot = (id: ItemId) => {
    rootId = id;
  };

  const getRoot = (): ItemId => {
    if (rootId == null) throw new Error("Root not set");
    return rootId;
  };

  const allocId = () => nextId++;

  const setNextIdFn = (n: number) => {
    nextId = n;
  };

  const setInterpreter = (fn: Interpreter) => {
    interpretExpr = fn;
  };

  const itemRec = (id: ItemId): ItemRec => {
    const rec = items.get(id);
    if (!rec) throw new Error(`Unknown item id: ${String(id)}`);
    return rec;
  };

  const itemAtom = (id: ItemId) => itemRec(id).atom;

  const createItemInternal = (initial: Item): void => {
    if (items.has(initial.id))
      throw new Error(`Duplicate item id: ${String(initial.id)}`);
    items.set(initial.id, { atom: createAtom(initial) });
  };

  const evaluateValueRoot = (id: ItemId): Value =>
    evaluateValue(id, makeEvalCtx());

  const valueSig = (id: ItemId): GetSignal<Value> => {
    const rec = itemRec(id);
    return (rec.valueSig ??= createComputed(() => evaluateValueRoot(id)));
  };

  const childLabelIndexSig = (
    groupId: ItemId,
  ): GetSignal<Map<string, ItemId>> => {
    const rec = itemRec(groupId);
    return (rec.childLabelIndexSig ??= createComputed(() => {
      const it = itemAtom(groupId).get();
      if (it.content.kind !== "group") return new Map<string, ItemId>();
      const m = new Map<string, ItemId>();
      for (const childId of it.content.items) {
        const child = itemAtom(childId).get();
        if (child.label) m.set(child.label, childId);
      }
      return m;
    }));
  };

  const lookupValue = (name: string, fromId: ItemId, ctx: EvalCtx): Value => {
    let cur: ItemId | null = fromId;
    while (cur != null) {
      const ownerId = itemAtom(cur).get().ownerId;
      if (ownerId == null) break;

      const hit = childLabelIndexSig(ownerId).get().get(name);
      if (hit != null) return evaluateValue(hit, ctx);

      cur = ownerId;
    }
    return V.issue(`Unbound identifier: ${name}`);
  };

  const materializeReadonly = (v: Value, ctx: EvalCtx): Value => {
    if (v.kind === "item-group") {
      return V.valueGroup(
        v.items.map((id) => ({
          label: itemAtom(id).get().label || undefined,
          value: materializeReadonly(evaluateValue(id, ctx), ctx),
        })),
      );
    }
    if (v.kind === "value-group") {
      return V.valueGroup(
        v.items.map((it) => ({
          label: it.label,
          value: materializeReadonly(it.value, ctx),
        })),
      );
    }
    return v;
  };

  function evaluateValue(id: ItemId, ctx: EvalCtx): Value {
    if (ctx.visiting.has(id)) return V.issue("Cyclic dependency");
    ctx.visiting.add(id);

    try {
      const it = itemAtom(id).get();

      switch (it.content.kind) {
        case "blank":
          return V.blank();
        case "scalar":
          return V.scalar(it.content.value);
        case "group":
          return V.itemGroup([...it.content.items]);
        case "derived": {
          const expr = it.content.expr.trim();
          if (!expr) return V.blank();
          const out = interpretExpr(expr, {
            lookup: (name) => lookupValue(name, id, ctx),
            resolve: (childId) => evaluateValue(childId, ctx),
            getLabel: (childId) => itemAtom(childId).get().label,
          });
          return materializeReadonly(out, ctx);
        }
        case "lens":
          return evaluateLens(id, it.content, ctx);
      }
    } catch (err) {
      return V.issue(err instanceof Error ? err.message : String(err));
    } finally {
      ctx.visiting.delete(id);
    }
  }

  const unwrapItemGroup = (
    v: Value,
    typeMessage: string,
  ):
    | { kind: "blank" }
    | { kind: "issue"; value: Value }
    | { kind: "ok"; items: ItemId[] } => {
    if (v.kind === "blank") return { kind: "blank" };
    if (v.kind === "issue") return { kind: "issue", value: v };
    if (v.kind === "item-group") return { kind: "ok", items: v.items };
    return { kind: "issue", value: V.issue(typeMessage) };
  };

  const sortRank = (v: Value): [number, unknown] => {
    if (v.kind === "blank" || v.kind === "issue") return [4, null];
    if (v.kind === "scalar") {
      const lit = v.value;
      if (typeof lit === "number") return [0, lit];
      if (typeof lit === "string") return [1, lit];
      if (lit === true) return [2, 1];
    }
    return [3, null];
  };

  const collator = new Intl.Collator(undefined, { sensitivity: "base" });

  const compareSortKey = (a: Value, b: Value): number => {
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

  function evaluateLens(
    ownerId: ItemId,
    spec: Extract<StoredContent, { kind: "lens" }>,
    ctx: EvalCtx,
  ): Value {
    const from = spec.from.trim();
    if (!from) return V.blank();

    const forkCtx = (base: EvalCtx): EvalCtx => ({
      visiting: new Set(base.visiting),
    });

    const baseEnv: EvalEnv = {
      lookup: (name) => lookupValue(name, ownerId, ctx),
      resolve: (childId) => evaluateValue(childId, ctx),
      getLabel: (childId) => itemAtom(childId).get().label,
    };

    const sourceVal = interpretExpr(from, baseEnv);
    const unwrapped = unwrapItemGroup(
      sourceVal,
      "Lens 'from' must evaluate to an item-group",
    );

    if (unwrapped.kind === "blank") return V.blank();
    if (unwrapped.kind === "issue") return unwrapped.value;

    let ids: ItemId[] = [...unwrapped.items];

    const evalRowExpr = (
      expr: string,
      rowId: ItemId,
      i: number,
      rowCtx: EvalCtx,
    ): Value => {
      const row = evaluateValue(rowId, rowCtx);
      if (isIssue(row)) return row;

      const position = V.scalar(i + 1);
      const label = V.scalar(itemAtom(rowId).get().label || "");

      return interpretExpr(expr, {
        lookup: (name) => {
          if (name === "_") return row;
          if (name === "position") return position;
          if (name === "label") return label;

          const hit = childLabelIndexSig(rowId).get().get(name);
          if (hit != null) return evaluateValue(hit, rowCtx);

          return lookupValue(name, rowId, rowCtx);
        },
        resolve: (childId) => evaluateValue(childId, rowCtx),
        getLabel: (childId) => itemAtom(childId).get().label,
      });
    };

    const where = spec.where.trim();
    if (where) {
      const next: ItemId[] = [];
      for (let i = 0; i < ids.length; i++) {
        const rowId = ids[i]!;
        const rowCtx = forkCtx(ctx);

        const pred = evalRowExpr(where, rowId, i, rowCtx);
        if (isIssue(pred)) return pred;
        if (isTrue(pred)) next.push(rowId);
      }
      ids = next;
    }

    const orderBy = spec.orderBy.trim();
    if (orderBy) {
      const rows: { rowId: ItemId; i: number; key: Value }[] = [];
      for (let i = 0; i < ids.length; i++) {
        const rowId = ids[i]!;
        const rowCtx = forkCtx(ctx);

        const key = evalRowExpr(orderBy, rowId, i, rowCtx);
        if (isIssue(key)) return key;

        rows.push({ rowId, i, key });
      }
      rows.sort((a, b) => compareSortKey(a.key, b.key) || a.i - b.i);
      ids = rows.map((r) => r.rowId);
    }

    return V.itemGroup(ids);
  }

  const make = {
    blank: (id: ItemId): Item => ({
      id,
      ownerId: null,
      label: "",
      view: "" as ViewId,
      content: { kind: "blank" },
    }),
    group: (id: ItemId): Item => ({
      id,
      ownerId: null,
      label: "",
      view: "" as ViewId,
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
    patchView: (id: ItemId, view: ViewId): Op => ({
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
    txn: (ops: readonly Op[], meta?: Txn["meta"]): Txn =>
      meta ? { ops, meta } : { ops },
  } as const;

  const locateInOwner = (childId: ItemId): LocateInOwnerResult | null => {
    const child = sel.item(childId);
    const ownerId = child.ownerId;
    if (ownerId == null) return null;

    const owner = sel.item(ownerId);
    if (owner.contentKind !== "group") return null;

    const items2 = sel.groupItems(ownerId);
    const index = items2.indexOf(childId);
    if (index < 0) return null;

    return { ownerId, index, items: items2 };
  };

  const canEditScalarText = (id: ItemId): boolean => {
    const it = sel.item(id);
    return (
      it.contentSettable &&
      (it.contentKind === "blank" || it.contentKind === "scalar")
    );
  };

  const childByLabel = (ownerId: ItemId, label: string): ItemId | null => {
    try {
      const hit = childLabelIndexSig(ownerId).get().get(label);
      return hit ?? null;
    } catch {
      return null;
    }
  };

  const sel: Store["sel"] = {
    item: (id: ItemId): ItemInfo => {
      const it = itemAtom(id).get();
      const kind = it.content.kind;

      const base: ItemInfo = {
        id: it.id,
        ownerId: it.ownerId,
        label: it.label,
        view: it.view,
        content: it.content,
        contentKind: kind,
        contentSettable: isContentSettableKind(kind),
      };

      if (kind === "derived") return { ...base, derivedExpr: it.content.expr };
      if (kind === "lens")
        return {
          ...base,
          lensSpec: {
            from: it.content.from,
            where: it.content.where,
            orderBy: it.content.orderBy,
          },
        };

      return base;
    },

    value: (id: ItemId): Value => valueSig(id).get(),

    groupItems: (id: ItemId): ItemId[] => {
      const v = valueSig(id).get();
      return v.kind === "item-group" ? v.items : [];
    },

    childByLabel,

    locateInOwner,

    canEditScalarText,
  } as const;

  const clampIndex = (i: number, len: number) => Math.max(0, Math.min(i, len));

  const expectGroupOwner = (
    ownerId: ItemId,
  ): { ownerAtom: SetSignal<Item>; owner: Item } => {
    const ownerAtom = itemAtom(ownerId);
    const owner = ownerAtom.peek();
    if (owner.content.kind !== "group") throw new Error("Owner is not a group");
    return { ownerAtom, owner };
  };

  const isGroupItem = (id: ItemId | null): Item | null => {
    if (id == null || !items.has(id)) return null;
    const o = itemAtom(id).peek();
    return o.content.kind === "group" ? o : null;
  };

  function reparent(spec: ReparentSpec): ReparentResult {
    const { childId, toOwnerId } = spec;

    const childAtom = itemAtom(childId);
    const child = childAtom.peek();
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
        const { ownerAtom, owner } = expectGroupOwner(fromOwnerId);
        const before = owner.content.items;
        if (before.includes(childId)) {
          ownerAtom.set({
            ...owner,
            content: {
              kind: "group",
              items: before.filter((x) => x !== childId),
            },
          });
        }
      }

      if (toOwnerId != null) {
        const { ownerAtom, owner } = expectGroupOwner(toOwnerId);
        const before = owner.content.items;
        const at = clampIndex(toIndex ?? before.length, before.length);
        ownerAtom.set({
          ...owner,
          content: {
            kind: "group",
            items: [...before.slice(0, at), childId, ...before.slice(at)],
          },
        });
        childAtom.set({ ...child, ownerId: toOwnerId });
      } else {
        childAtom.set({ ...child, ownerId: null });
      }
    });

    return { fromOwnerId, toOwnerId, fromIndex, toIndex };
  }

  const patch = (id: ItemId, next: Patch): void => {
    const a = itemAtom(id);
    const cur = a.peek();
    a.set({
      ...cur,
      ...(next.label !== undefined ? { label: next.label } : null),
      ...(next.view !== undefined ? { view: next.view } : null),
      ...(next.content !== undefined ? { content: next.content } : null),
    });
  };

  const ops: Store["ops"] = {
    create: (item: Item) => createItemInternal(item),
    patch,
    reparent,
  } as const;

  const apply = (txn: Txn): ApplyResult => {
    const created: ItemId[] = [];
    const touchedSet = new Set<ItemId>();
    const reparentResults: ReparentResult[] = [];

    batch(() => {
      for (const op0 of txn.ops) {
        switch (op0.kind) {
          case "create":
            createItemInternal(op0.item);
            created.push(op0.item.id);
            touchedSet.add(op0.item.id);
            break;
          case "patch":
            patch(op0.id, op0.next);
            touchedSet.add(op0.id);
            break;
          case "reparent": {
            const res = reparent(op0.spec);
            reparentResults.push(res);
            touchedSet.add(op0.spec.childId);
            if (res.fromOwnerId != null) touchedSet.add(res.fromOwnerId);
            if (res.toOwnerId != null) touchedSet.add(res.toOwnerId);
            break;
          }
          default: {
            const never: never = op0;
            throw new Error(`Unknown op: ${String((never as any)?.kind)}`);
          }
        }
      }
    });

    return { created, touched: [...touchedSet], reparent: reparentResults };
  };

  const collectReachableFrom = (root: ItemId): Set<ItemId> => {
    const seen = new Set<ItemId>();
    const stack: ItemId[] = [root];

    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);

      const it = itemAtom(id).peek();
      if (it.content.kind === "group")
        for (const cid of it.content.items) stack.push(cid);
    }

    return seen;
  };

  const compactUnreachable = (): { removed: number } => {
    const keep = collectReachableFrom(getRoot());
    let removed = 0;
    for (const [id] of items) {
      if (!keep.has(id)) {
        items.delete(id);
        removed++;
      }
    }
    return { removed };
  };

  const snapshotStoredContent = (content: StoredContent): StaticContent => {
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
        return {
          kind: "group",
          items: content.items.map((childId) => snapshotStored(childId)),
        };
    }
  };

  const snapshotStored = (id: ItemId): StaticItem => {
    const it = itemAtom(id).get();
    const label = it.label.trim() ? it.label : undefined;
    const view = it.view.trim() ? it.view : undefined;
    return { label, view, content: snapshotStoredContent(it.content) };
  };

  return {
    setRoot,
    getRoot,

    allocId,
    setNextId: setNextIdFn,

    setInterpreter,

    make,
    op,

    sel,
    ops,

    apply,

    snapshotStored,
    compactUnreachable,
  };
}
