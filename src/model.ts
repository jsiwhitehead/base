import {
  signal,
  computed,
  batch,
  type ReadonlySignal,
} from "@preact/signals-core";

export type ItemId = number | string;
export type Scalar = true | number | string;
export type ViewId = string;

export type StoredContent =
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "scalar"; value: Scalar }>
  | Readonly<{ kind: "group"; items: readonly ItemId[] }>
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

type GetSignal<T> = { kind: "signal"; get(): T; peek(): T };
type SetSignal<T> = GetSignal<T> & { set(next: T): void };

function createAtom<T>(initial: T): SetSignal<T> {
  const s = signal(initial);
  return {
    kind: "signal",
    get: () => s.value,
    peek: () => s.peek(),
    set: (next) => {
      s.value = next;
    },
  };
}

function createComputed<T>(fn: () => T): GetSignal<T> {
  const s: ReadonlySignal<T> = computed(fn);
  return { kind: "signal", get: () => s.value, peek: () => s.peek() };
}

type ItemRec = {
  atom: SetSignal<Item>;
  valueSig?: GetSignal<Value>;
  labelIndexSig?: GetSignal<Map<string, ItemId>>;
};

const items = new Map<ItemId, ItemRec>();

let __rootId: ItemId | null = null;

export function setRoot(id: ItemId) {
  __rootId = id;
}

export function getRoot(): ItemId {
  if (__rootId == null) throw new Error("Root not set");
  return __rootId;
}

function itemRec(id: ItemId): ItemRec {
  const rec = items.get(id);
  if (!rec) throw new Error(`Unknown item id: ${String(id)}`);
  return rec;
}

function itemAtom(id: ItemId): SetSignal<Item> {
  return itemRec(id).atom;
}

function createItem(initial: Item): void {
  if (items.has(initial.id))
    throw new Error(`Duplicate item id: ${String(initial.id)}`);
  items.set(initial.id, { atom: createAtom(initial) });
}

let __nextId: number = 1;
export function allocId(): number {
  return __nextId++;
}
export function setNextId(next: number): void {
  __nextId = next;
}

export const V = {
  blank(): Value {
    return { kind: "blank" };
  },
  issue(message: string): Value {
    return { kind: "issue", message };
  },
  scalar(value: Scalar): Value {
    return { kind: "scalar", value };
  },
  itemGroup(items: ItemId[]): Value {
    return { kind: "item-group", items };
  },
  valueGroup(items: LabeledValue[]): Value {
    return { kind: "value-group", items };
  },
};

export function isPresent(v: Value): boolean {
  return v.kind !== "blank" && v.kind !== "issue";
}

export function isTrue(v: Value): boolean {
  return v.kind === "scalar" && v.value === true;
}

function isIssue(v: Value): v is { kind: "issue"; message: string } {
  return v.kind === "issue";
}

type EvalCtx = { visiting: Set<ItemId> };
const makeEvalCtx = (): EvalCtx => ({ visiting: new Set<ItemId>() });

function evaluateValueRoot(id: ItemId): Value {
  return evaluateValue(id, makeEvalCtx());
}

function valueSig(id: ItemId): GetSignal<Value> {
  const rec = itemRec(id);
  if (!rec.valueSig) rec.valueSig = createComputed(() => evaluateValueRoot(id));
  return rec.valueSig;
}

function materializeReadonly(v: Value, ctx: EvalCtx): Value {
  if (v.kind === "item-group") {
    return V.valueGroup(
      v.items.map((id) => ({
        label: itemAtom(id).get().label || undefined,
        value: materializeReadonly(evaluateValue(id, ctx), ctx),
      }))
    );
  }

  if (v.kind === "value-group") {
    return V.valueGroup(
      v.items.map((it) => ({
        label: it.label,
        value: materializeReadonly(it.value, ctx),
      }))
    );
  }

  return v;
}

export type EvalEnv = {
  lookup(name: string): Value;
  resolve(id: ItemId): Value;
  getLabel(id: ItemId): string;
};

export type Interpreter = (expr: string, env: EvalEnv) => Value;

let interpretExpr: Interpreter = () =>
  V.issue("Interpreter not set (call setInterpreter)");

export function setInterpreter(fn: Interpreter) {
  interpretExpr = fn;
}

function ownerLabelIndexSig(ownerId: ItemId): GetSignal<Map<string, ItemId>> {
  const rec = itemRec(ownerId);
  if (!rec.labelIndexSig) {
    rec.labelIndexSig = createComputed(() => {
      const owner = itemAtom(ownerId).get();
      if (owner.content.kind !== "group") return new Map<string, ItemId>();

      const m = new Map<string, ItemId>();
      for (const childId of owner.content.items) {
        const child = itemAtom(childId).get();
        if (child.label) m.set(child.label, childId);
      }
      return m;
    });
  }
  return rec.labelIndexSig;
}

export function lookupValue(name: string, fromId: ItemId, ctx: EvalCtx): Value {
  let cur: ItemId | null = fromId;

  while (cur != null) {
    const curItem = itemAtom(cur).get();
    const ownerId = curItem.ownerId;
    if (ownerId == null) break;

    const idx = ownerLabelIndexSig(ownerId).get();
    const hit = idx.get(name);
    if (hit != null) return evaluateValue(hit, ctx);

    cur = ownerId;
  }

  return V.issue(`Unbound identifier: ${name}`);
}

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

function unwrapItemGroup(
  v: Value,
  typeMessage: string
):
  | { kind: "blank" }
  | { kind: "issue"; value: Value }
  | { kind: "ok"; items: ItemId[] } {
  if (v.kind === "blank") return { kind: "blank" };
  if (v.kind === "issue") return { kind: "issue", value: v };
  if (v.kind === "item-group") return { kind: "ok", items: v.items };
  return { kind: "issue", value: V.issue(typeMessage) };
}

function sortRank(v: Value): [number, any] {
  // Sorting: numbers < text < true < other < blank/issue
  if (v.kind === "blank" || v.kind === "issue") return [4, null];
  if (v.kind === "scalar") {
    const lit = v.value;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function compareSortKey(a: Value, b: Value): number {
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
}

function evaluateLens(
  ownerId: ItemId,
  spec: Extract<StoredContent, { kind: "lens" }>,
  ctx: EvalCtx
): Value {
  const from = spec.from.trim();
  if (!from) return V.blank();

  const forkCtx = (base: EvalCtx): EvalCtx => ({
    visiting: new Set(base.visiting),
  });

  const sourceVal = interpretExpr(from, {
    lookup: (name) => lookupValue(name, ownerId, ctx),
    resolve: (childId) => evaluateValue(childId, ctx),
    getLabel: (childId) => itemAtom(childId).get().label,
  });

  const unwrapped = unwrapItemGroup(
    sourceVal,
    "Lens 'from' must evaluate to an item-group"
  );

  if (unwrapped.kind === "blank") return V.blank();
  if (unwrapped.kind === "issue") return unwrapped.value;

  let ids: ItemId[] = [...unwrapped.items];

  const where = spec.where.trim();
  if (where) {
    const next: ItemId[] = [];

    for (let i = 0; i < ids.length; i++) {
      const rowId = ids[i]!;
      const rowCtx = forkCtx(ctx);

      const row = evaluateValue(rowId, rowCtx);
      if (isIssue(row)) return row;

      const position = V.scalar(i + 1);
      const label = V.scalar(itemAtom(rowId).get().label || "");

      const pred = interpretExpr(where, {
        lookup: (name) => {
          if (name === "_") return row;
          if (name === "position") return position;
          if (name === "label") return label;
          return lookupValue(name, ownerId, rowCtx);
        },
        resolve: (childId) => evaluateValue(childId, rowCtx),
        getLabel: (childId) => itemAtom(childId).get().label,
      });

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

      const row = evaluateValue(rowId, rowCtx);
      if (isIssue(row)) return row;

      const position = V.scalar(i + 1);
      const label = V.scalar(itemAtom(rowId).get().label || "");

      const key = interpretExpr(orderBy, {
        lookup: (name) => {
          if (name === "_") return row;
          if (name === "position") return position;
          if (name === "label") return label;
          return lookupValue(name, ownerId, rowCtx);
        },
        resolve: (childId) => evaluateValue(childId, rowCtx),
        getLabel: (childId) => itemAtom(childId).get().label,
      });

      if (isIssue(key)) return key;

      rows.push({ rowId, i, key });
    }

    rows.sort((a, b) => compareSortKey(a.key, b.key) || a.i - b.i);
    ids = rows.map((r) => r.rowId);
  }

  return V.itemGroup(ids);
}

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function parseScalar(text: string): Scalar {
  const t = text.trim();
  if (NUM_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t === "true") return true;
  return text;
}

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

function isContentSettableKind(kind: StoredContent["kind"]): boolean {
  return kind !== "derived" && kind !== "lens";
}

export const sel = {
  item(id: ItemId): ItemInfo {
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

  value(id: ItemId): Value {
    return valueSig(id).get();
  },

  groupItems(id: ItemId): ItemId[] {
    const v = valueSig(id).get();
    return v.kind === "item-group" ? v.items : [];
  },
} as const;

export type OpResult = { focus?: ItemId; caret?: number };

function expectGroupOwner(ownerId: ItemId): {
  ownerAtom: SetSignal<Item>;
  owner: Item;
} {
  const ownerAtom = itemAtom(ownerId);
  const owner = ownerAtom.peek();
  if (owner.content.kind !== "group") throw new Error("Owner is not a group");
  return { ownerAtom, owner };
}

function clampIndex(i: number, len: number) {
  return Math.max(0, Math.min(i, len));
}

type GroupOwnerLoc = {
  childId: ItemId;
  childAtom: SetSignal<Item>;
  child: Item;

  ownerId: ItemId;
  ownerAtom: SetSignal<Item>;
  owner: Item;

  index: number;
  items: readonly ItemId[];
};

function locateInGroupOwner(childId: ItemId): GroupOwnerLoc | null {
  const childAtom = itemAtom(childId);
  const child = childAtom.peek();
  const ownerId = child.ownerId;
  if (ownerId == null) return null;

  const ownerAtom = itemAtom(ownerId);
  const owner = ownerAtom.peek();
  if (owner.content.kind !== "group") throw new Error("Owner is not a group");

  const items = owner.content.items;
  const index = items.indexOf(childId);
  if (index < 0) return null;

  return {
    childId,
    childAtom,
    child,
    ownerId,
    ownerAtom,
    owner,
    index,
    items,
  };
}

export type MoveSpec = {
  childId: ItemId;
  toOwnerId: ItemId | null;
  toIndex?: number;
};

export type MoveResult = {
  fromOwnerId: ItemId | null;
  toOwnerId: ItemId | null;
  fromIndex: number | null;
  toIndex: number | null;
};

export function move(spec: MoveSpec): MoveResult {
  const { childId, toOwnerId } = spec;

  const childAtom = itemAtom(childId);
  const child = childAtom.peek();
  const fromOwnerId = child.ownerId;

  let fromIndex: number | null = null;
  let toIndex: number | null = null;

  const fromOwner =
    fromOwnerId != null && items.has(fromOwnerId)
      ? (() => {
          const o = itemAtom(fromOwnerId).peek();
          return o.content.kind === "group" ? o : null;
        })()
      : null;

  const toOwner =
    toOwnerId != null && items.has(toOwnerId)
      ? (() => {
          const o = itemAtom(toOwnerId).peek();
          return o.content.kind === "group" ? o : null;
        })()
      : null;

  if (fromOwnerId != null) {
    if (!fromOwner) throw new Error("Owner is not a group");
    const i = fromOwner.content.items.indexOf(childId);
    fromIndex = i >= 0 ? i : null;
  }

  if (toOwnerId != null) {
    if (!toOwner) throw new Error("Owner is not a group");
    const len = toOwner.content.items.length;
    const rawAt = spec.toIndex == null ? len : clampIndex(spec.toIndex, len);

    const adjusted =
      toOwnerId === fromOwnerId && fromIndex != null && rawAt > fromIndex
        ? rawAt - 1
        : rawAt;

    toIndex = adjusted;
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
        const after = before.filter((x) => x !== childId);
        ownerAtom.set({ ...owner, content: { kind: "group", items: after } });
      }
    }

    if (toOwnerId != null) {
      const { ownerAtom, owner } = expectGroupOwner(toOwnerId);
      const before = owner.content.items;

      const at =
        toIndex == null ? before.length : clampIndex(toIndex, before.length);

      const nextItems = [...before.slice(0, at), childId, ...before.slice(at)];

      ownerAtom.set({ ...owner, content: { kind: "group", items: nextItems } });
      childAtom.set({ ...child, ownerId: toOwnerId });
    } else {
      childAtom.set({ ...child, ownerId: null });
    }
  });

  return { fromOwnerId, toOwnerId, fromIndex, toIndex };
}

function makeBlankItem(id: ItemId): Item {
  return { id, ownerId: null, label: "", view: "", content: { kind: "blank" } };
}

function collectReachableFrom(rootId: ItemId): Set<ItemId> {
  const seen = new Set<ItemId>();
  const stack: ItemId[] = [rootId];

  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);

    const it = itemAtom(id).peek();
    if (it.content.kind === "group") {
      for (const cid of it.content.items) stack.push(cid);
    }
  }

  return seen;
}

export function compactUnreachable(): { removed: number } {
  const root = getRoot();
  const keep = collectReachableFrom(root);

  let removed = 0;
  for (const [id] of items) {
    if (keep.has(id)) continue;
    items.delete(id);
    removed++;
  }

  return { removed };
}

export type InsertAtResult = {
  ownerId: ItemId;
  id: ItemId;
  index: number;
};

export type RemoveFromOwnerResult = {
  ownerId: ItemId;
  id: ItemId;
  index: number;
  prevId: ItemId | null;
  nextId: ItemId | null;
};

export type WrapInGroupResult = {
  ownerId: ItemId;
  childId: ItemId;
  wrapperId: ItemId;
  wrapperIndex: number;
};

export type UnwrapSingleChildResult = {
  ownerId: ItemId;
  childId: ItemId;
  wrapperId: ItemId;
  index: number;
};

export type SplitTextResult = {
  leftId: ItemId;
  rightId: ItemId;
  ownerId: ItemId;
  rightIndex: number;
  caretInRight: number;
};

export type JoinTextResult = {
  keptId: ItemId;
  removedId: ItemId;
  ownerId: ItemId;
  keptIndex: number;
  caret: number;
};

function isTextEditable(id: ItemId): boolean {
  const it = itemAtom(id).peek();
  if (!isContentSettableKind(it.content.kind)) return false;

  if (it.content.kind === "blank") return true;
  if (it.content.kind === "scalar") return true;
  return false;
}

function getScalarTextForEdit(id: ItemId): string {
  const it = itemAtom(id).peek();
  if (it.content.kind === "blank") return "";
  if (it.content.kind === "scalar") return String(it.content.value);
  const v = sel.value(id);
  return v.kind === "scalar" ? String(v.value) : v.kind === "blank" ? "" : "";
}

function setScalarTextDirect(id: ItemId, raw: string): void {
  const a = itemAtom(id);
  const cur = a.peek();
  a.set({ ...cur, content: { kind: "scalar", value: parseScalar(raw) } });
}

export const ops = {
  /* Content patches */

  setLabel(id: ItemId, label: string): void {
    const a = itemAtom(id);
    const cur = a.peek();
    if (cur.label === label) return;
    a.set({ ...cur, label });
  },

  setView(id: ItemId, view: ViewId): void {
    const a = itemAtom(id);
    const cur = a.peek();
    if (cur.view === view) return;
    a.set({ ...cur, view });
  },

  setScalarText(id: ItemId, raw: string): void {
    setScalarTextDirect(id, raw);
  },

  setBlank(id: ItemId): void {
    const a = itemAtom(id);
    const cur = a.peek();
    a.set({ ...cur, content: { kind: "blank" } });
  },

  setDerivedExpr(id: ItemId, expr: string): void {
    const a = itemAtom(id);
    const cur = a.peek();
    a.set({ ...cur, content: { kind: "derived", expr } });
  },

  setLensSpec(
    id: ItemId,
    next: { from: string; where: string; orderBy: string }
  ): void {
    const a = itemAtom(id);
    const cur = a.peek();
    a.set({ ...cur, content: { kind: "lens", ...next } });
  },

  /* Structural edits */

  insertBlankAt(ownerId: ItemId, index: number): InsertAtResult {
    const { owner } = expectGroupOwner(ownerId);
    const at = clampIndex(index, owner.content.items.length);

    const id = allocId();
    if (items.has(id)) throw new Error("Duplicate new id");

    batch(() => {
      createItem(makeBlankItem(id));
      move({ childId: id, toOwnerId: ownerId, toIndex: at });
    });

    return { ownerId, id, index: at };
  },

  insertBlankAfter(anchorId: ItemId): InsertAtResult | null {
    const loc = locateInGroupOwner(anchorId);
    if (!loc) return null;
    return this.insertBlankAt(loc.ownerId, loc.index + 1);
  },

  insertBlankBefore(anchorId: ItemId): InsertAtResult | null {
    const loc = locateInGroupOwner(anchorId);
    if (!loc) return null;
    return this.insertBlankAt(loc.ownerId, loc.index);
  },

  removeFromOwner(id: ItemId): RemoveFromOwnerResult | null {
    const loc = locateInGroupOwner(id);
    if (!loc) return null;

    const { ownerId, owner, items, index } = loc;
    const prevId = items[index - 1] ?? null;
    const nextId = items[index + 1] ?? null;

    move({ childId: id, toOwnerId: null });

    return { ownerId, id, index, prevId, nextId };
  },

  wrapChildInNewGroup(childId: ItemId): WrapInGroupResult | null {
    const loc = locateInGroupOwner(childId);
    if (!loc) return null;

    const { ownerId, index, childAtom, child } = loc;

    const wrapperId = allocId();
    if (items.has(wrapperId)) throw new Error("Duplicate wrapperId");

    batch(() => {
      createItem({
        id: wrapperId,
        ownerId: null,
        label: child.label,
        view: "",
        content: { kind: "group", items: [] },
      });

      move({ childId: wrapperId, toOwnerId: ownerId, toIndex: index });

      childAtom.set({ ...child, label: "" });

      move({ childId, toOwnerId: wrapperId, toIndex: 0 });
    });

    return { ownerId, childId, wrapperId, wrapperIndex: index };
  },

  unwrapIfSingleChild(childId: ItemId): UnwrapSingleChildResult | null {
    const childAtom = itemAtom(childId);
    const child = childAtom.peek();
    const wrapperId = child.ownerId;
    if (wrapperId == null) return null;

    const wrapperAtom = itemAtom(wrapperId);
    const wrapper = wrapperAtom.peek();
    if (wrapper.content.kind !== "group") return null;
    if (
      wrapper.content.items.length !== 1 ||
      wrapper.content.items[0] !== childId
    )
      return null;

    const ownerId = wrapper.ownerId;
    if (ownerId == null) return null;

    const ownerLoc = locateInGroupOwner(wrapperId);
    if (!ownerLoc) return null;

    const idx = ownerLoc.index;

    batch(() => {
      move({ childId, toOwnerId: ownerId, toIndex: idx });

      move({ childId: wrapperId, toOwnerId: null });

      const nextChild = childAtom.peek();
      childAtom.set({ ...nextChild, label: wrapper.label });

      wrapperAtom.set({
        ...wrapper,
        ownerId: null,
        label: "",
        content: { kind: "blank" },
      });
    });

    return { ownerId, childId, wrapperId, index: idx };
  },

  splitTextItem(
    id: ItemId,
    caretStart: number,
    caretEnd: number = caretStart
  ): SplitTextResult | null {
    const loc = locateInGroupOwner(id);
    if (!loc) return null;
    if (!isTextEditable(id)) return null;

    const text = getScalarTextForEdit(id);
    const len = text.length;
    const start = Math.min(Math.max(caretStart, 0), len);
    const end = Math.min(Math.max(caretEnd, 0), len);

    const left = text.slice(0, start);
    const right = text.slice(end);

    const rightId = allocId();
    if (items.has(rightId)) throw new Error("Duplicate new id");

    batch(() => {
      setScalarTextDirect(id, left);

      createItem(makeBlankItem(rightId));
      move({
        childId: rightId,
        toOwnerId: loc.ownerId,
        toIndex: loc.index + 1,
      });

      setScalarTextDirect(rightId, right);
    });

    return {
      leftId: id,
      rightId,
      ownerId: loc.ownerId,
      rightIndex: loc.index + 1,
      caretInRight: 0,
    };
  },

  joinWithPrevious(id: ItemId): JoinTextResult | null {
    const loc = locateInGroupOwner(id);
    if (!loc) return null;
    if (!isTextEditable(id)) return null;

    const { ownerId, index, items: ownerItems } = loc;
    if (index <= 0) return null;

    const prevId = ownerItems[index - 1]!;
    if (!isTextEditable(prevId)) return null;

    const prevText = getScalarTextForEdit(prevId);
    const curText = getScalarTextForEdit(id);
    const caret = prevText.length;

    batch(() => {
      setScalarTextDirect(prevId, prevText + curText);
      move({ childId: id, toOwnerId: null });
    });

    return {
      keptId: prevId,
      removedId: id,
      ownerId,
      keptIndex: index - 1,
      caret,
    };
  },

  joinWithNext(id: ItemId): JoinTextResult | null {
    const loc = locateInGroupOwner(id);
    if (!loc) return null;
    if (!isTextEditable(id)) return null;

    const { ownerId, index, items: ownerItems } = loc;
    const nextId = ownerItems[index + 1];
    if (nextId == null) return null;
    if (!isTextEditable(nextId)) return null;

    const curText = getScalarTextForEdit(id);
    const nextText = getScalarTextForEdit(nextId);
    const caret = curText.length;

    batch(() => {
      setScalarTextDirect(id, curText + nextText);
      move({ childId: nextId, toOwnerId: null });
    });

    return { keptId: id, removedId: nextId, ownerId, keptIndex: index, caret };
  },
} as const;

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

export function snapshotStored(id: ItemId): StaticItem {
  const it = itemAtom(id).get();

  const label = it.label.trim() ? it.label : undefined;
  const view = it.view.trim() ? it.view : undefined;

  return {
    label,
    view,
    content: snapshotStoredContent(it.content),
  };
}

function snapshotStoredContent(content: StoredContent): StaticContent {
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
}
