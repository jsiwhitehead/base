import {
  ERR,
  type ValueEntry,
  type ItemEntry,
  type DataNode,
  type BlockNode,
  type WriteSignal,
  type DataSignal,
  type ChildSignal,
  getParent,
  getParentSignal,
  isBlank,
  isLiteral,
  isBlock,
  newUid,
  createBlank,
  createLiteral,
  createComputed,
  createSignal,
  childToData,
} from "./data";

/* Root */

let __dataRoot: ChildSignal | null = null;

export function setDataRoot(root: ChildSignal) {
  __dataRoot = root;
}

export function getDataRoot(): ChildSignal {
  if (!__dataRoot) throw new Error("Data root not set");
  return __dataRoot;
}

/* Entries */

type BlockEntry =
  | ({ kind: "value" } & ValueEntry)
  | ({ kind: "item" } & ItemEntry);

export function* iterEntries(src: BlockNode): Generator<BlockEntry> {
  for (const v of src.values) {
    yield { kind: "value", uid: v.uid, key: v.key, child: v.child };
  }
  for (const i of src.items) {
    yield { kind: "item", uid: i.uid, child: i.child };
  }
}

function entryIndexByUid(es: BlockEntry[], uid: number): number {
  return es.findIndex((e) => e.uid === uid);
}

type EntryView = BlockEntry & {
  id: string | number;
  index: number;
};

function* enumerateEntries(src: BlockNode): Generator<EntryView> {
  let itemIndex1 = 1;
  let vIdx = 0;
  let iIdx = 0;
  for (const e of iterEntries(src)) {
    const id = e.kind === "value" ? e.key : itemIndex1++;
    const index = e.kind === "value" ? vIdx++ : iIdx++;
    yield { ...e, id, index };
  }
}

function entrySignals(e: EntryView) {
  const idSig = createSignal(createLiteral(e.id));
  const valSig = createSignal(childToData(e.child));
  return { idSig, valSig };
}

function createBlockFromEntries(entries: Iterable<BlockEntry>): BlockNode {
  const values: ValueEntry[] = [];
  const items: ItemEntry[] = [];
  for (const e of entries) {
    if (e.kind === "value")
      values.push({ uid: e.uid ?? newUid(), key: e.key, child: e.child });
    else items.push({ uid: e.uid ?? newUid(), child: e.child });
  }
  return { kind: "block", values, items };
}

/* Blocks */

export function blockNumbersOpt(n: BlockNode): number[] {
  const out: number[] = [];
  for (const e of iterEntries(n)) {
    const node = childToData(e.child);
    if (isBlank(node)) continue;
    if (isLiteral(node) && typeof node.value === "number") out.push(node.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

export function blockTextsOpt(n: BlockNode): string[] {
  const out: string[] = [];
  for (const e of iterEntries(n)) {
    const node = childToData(e.child);
    if (isBlank(node)) continue;
    if (isLiteral(node) && typeof node.value === "string") out.push(node.value);
    else throw new TypeError(ERR.textOrBlank);
  }
  return out;
}

export function blockMap(
  src: BlockNode,
  f: (value: DataSignal, id: DataSignal) => DataSignal
): BlockNode {
  return createBlockFromEntries(
    Array.from(enumerateEntries(src), (e) => {
      const { idSig, valSig } = entrySignals(e);
      return { ...e, child: createComputed(() => f(valSig, idSig).get()) };
    })
  );
}

export function blockFilter(
  src: BlockNode,
  pred: (value: DataSignal, id: DataSignal) => boolean
): BlockNode {
  return createBlockFromEntries(
    Array.from(enumerateEntries(src)).filter((e) => {
      const { idSig, valSig } = entrySignals(e);
      return pred(valSig, idSig);
    })
  );
}

export function blockReduce(
  src: BlockNode,
  rf: (acc: DataSignal, value: DataSignal, id: DataSignal) => DataSignal,
  init: DataSignal
): DataSignal {
  const seq = Array.from(enumerateEntries(src));
  if (seq.length === 0) return init;

  const step = (acc: DataSignal, e: EntryView) => {
    const { idSig, valSig } = entrySignals(e);
    return rf(acc, valSig, idSig);
  };

  if (!isBlank(init.get())) return seq.reduce(step, init);

  const first = createSignal(childToData(seq[0]!.child));
  return seq.slice(1).reduce(step, first);
}

function sortRank(n: DataNode): [number, any] {
  // numbers < text < true < other < blank
  if (isBlank(n)) return [4, null];
  if (isLiteral(n)) {
    const v = n.value;
    if (typeof v === "number") return [0, v];
    if (typeof v === "string") return [1, v];
    if (v === true) return [2, 1];
  }
  return [3, null];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function sortCmp<T extends { sortKey: DataNode; index: number }>(
  a: T,
  b: T
): number {
  const [ra, va] = sortRank(a.sortKey);
  const [rb, vb] = sortRank(b.sortKey);
  if (ra !== rb) return ra - rb;
  if (ra === 0) {
    const d = (va as number) - (vb as number);
    if (d) return d;
  } else if (ra === 1) {
    const d = collator.compare(va as string, vb as string);
    if (d) return d;
  }
  return a.index - b.index;
}

export function blockSort(
  src: BlockNode,
  keySelector: null | ((value: DataSignal, id: DataSignal) => DataSignal)
): BlockNode {
  const rows = Array.from(enumerateEntries(src), (e) => {
    if (!keySelector) return { ...e, sortKey: childToData(e.child) };
    const { idSig, valSig } = entrySignals(e);
    return { ...e, sortKey: keySelector(valSig, idSig).get() };
  });
  rows.sort(sortCmp);
  return createBlockFromEntries(rows);
}

/* Navigation */

export type NodePath = number[];

export function resolvePath(path: NodePath): ChildSignal | null {
  let cur: ChildSignal = getDataRoot();
  for (const uid of path) {
    const node = childToData(cur);
    if (!isBlock(node)) return null;
    const es = Array.from(iterEntries(node));
    const i = entryIndexByUid(es, uid);
    if (i < 0) return null;
    cur = es[i]!.child;
  }
  return cur;
}

export function parentPath(path: NodePath): NodePath | null {
  if (path.length === 0) return null;
  return path.slice(0, -1);
}

export function firstChildPath(path: NodePath): NodePath | null {
  const node = resolvePath(path)!;
  const data = childToData(node);
  if (!isBlock(data)) return null;
  const es = Array.from(iterEntries(data));
  return es.length ? [...path, es[0]!.uid] : null;
}

export function siblingPath(path: NodePath, dir: -1 | 1): NodePath | null {
  if (path.length === 0) return null;

  const pp = parentPath(path)!;
  const parentNode = resolvePath(pp)!;
  const block = childToData(parentNode);
  if (!isBlock(block)) return null;

  const es = Array.from(iterEntries(block));
  const i = entryIndexByUid(es, path[path.length - 1]!);
  const j = i + dir;
  if (j < 0 || j >= es.length) return null;

  return [...pp, es[j]!.uid];
}

/* Mutations */

export function withLocatedPath(
  path: NodePath,
  fn: (ctx: {
    parent: WriteSignal<BlockNode>;
    parentPath: NodePath;
    before: BlockEntry[];
    index: number;
    child: ChildSignal;
  }) => { after: BlockEntry[]; path: NodePath }
): NodePath {
  if (path.length === 0) return path;

  const child = resolvePath(path)!;
  const parent = getParent(child)!;
  const parentPath = path.slice(0, -1);

  const before = Array.from(iterEntries(parent.get()));
  const uid = path[path.length - 1]!;
  const index = entryIndexByUid(before, uid)!;

  const result = fn({ parent, parentPath, before, index, child });

  if (result.after !== before) parent.set(createBlockFromEntries(result.after));
  return result.path;
}

function replaceAt(
  es: BlockEntry[],
  i: number,
  nextChild: ChildSignal
): BlockEntry[] {
  const out = es.slice();
  out[i] = { ...es[i]!, child: nextChild };
  return out;
}

function removeAt(es: BlockEntry[], i: number): BlockEntry[] {
  const out = es.slice();
  out.splice(i, 1);
  return out;
}

function insertItemAt(
  es: BlockEntry[],
  i: number,
  child: ChildSignal
): { es: BlockEntry[]; uid: number } {
  const uid = newUid();
  const out = es.slice();
  out.splice(i, 0, { kind: "item", uid, child });
  return { es: out, uid };
}

function indexOfFirstItem(es: BlockEntry[]) {
  const k = es.findIndex((x) => x.kind === "item");
  return k < 0 ? es.length : k;
}

function isValueEntry(
  e: BlockEntry
): e is Extract<BlockEntry, { kind: "value" }> {
  return e.kind === "value";
}

export function assignKey(path: NodePath, nextKey: string): NodePath {
  return withLocatedPath(path, ({ parentPath, before, index }) => {
    if (before.some((e) => e.kind === "value" && e.key === nextKey)) {
      return { after: before, path: [...parentPath, before[index]!.uid] };
    }
    const e = before[index]!;
    if (e.kind === "value") {
      const after = before.slice();
      if (e.key !== nextKey) after[index] = { ...e, key: nextKey };
      return { after, path: [...parentPath, e.uid] };
    }

    const cut = removeAt(before, index);
    const at = indexOfFirstItem(cut);
    cut.splice(at, 0, {
      kind: "value",
      uid: e.uid,
      key: nextKey,
      child: e.child,
    });
    return { after: cut, path: [...parentPath, e.uid] };
  });
}

export function removeKey(path: NodePath): NodePath {
  return withLocatedPath(path, ({ parentPath, before, index }) => {
    const e = before[index]!;
    if (e.kind !== "value") {
      return { after: before, path: [...parentPath, e.uid] };
    }

    const after = removeAt(before, index);
    const at = indexOfFirstItem(after);
    after.splice(at, 0, { kind: "item", uid: e.uid, child: e.child });
    return { after, path: [...parentPath, e.uid] };
  });
}

export function insertBefore(path: NodePath): NodePath {
  return withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const item = createSignal(createBlank() as DataNode);
    getParentSignal(item).value = parent;

    const insertAt = isValueEntry(before[index]!)
      ? indexOfFirstItem(before)
      : index;

    const { es: after, uid } = insertItemAt(before, insertAt, item);
    return { after, path: [...parentPath, uid] };
  });
}

export function insertAfter(path: NodePath): NodePath {
  return withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const item = createSignal(createBlank() as DataNode);
    getParentSignal(item).value = parent;

    const insertAt = isValueEntry(before[index]!)
      ? indexOfFirstItem(before)
      : index + 1;

    const { es: after, uid } = insertItemAt(before, insertAt, item);
    return { after, path: [...parentPath, uid] };
  });
}

export function wrapWithBlock(path: NodePath): NodePath {
  return withLocatedPath(
    path,
    ({ parentPath, parent, before, index, child }) => {
      const innerUid = newUid();
      const wrapper = createSignal(
        createBlockFromEntries([{ kind: "item", uid: innerUid, child }])
      );
      getParentSignal(wrapper).value = parent;
      getParentSignal(child).value = wrapper;

      const after = replaceAt(before, index, wrapper);
      const wrapperUid = before[index]!.uid;
      return { after, path: [...parentPath, wrapperUid, innerUid] };
    }
  );
}

export function unwrapBlockIfSingleChild(path: NodePath): NodePath {
  const innerChild = resolvePath(path)!;
  const wrapperSig = getParent(innerChild)!;
  const wrapperNode = wrapperSig.get();

  if (wrapperNode.values.length !== 0 || wrapperNode.items.length !== 1) {
    return path;
  }

  return withLocatedPath(
    parentPath(path)!,
    ({ parent: grandparent, parentPath: gpPath, before, index }) => {
      getParentSignal(innerChild).value = grandparent;
      getParentSignal(wrapperSig).value = undefined;

      const after = replaceAt(before, index, innerChild);
      const wrapperUid = before[index]!.uid;
      return { after, path: [...gpPath, wrapperUid] };
    }
  );
}

export function removeChild(path: NodePath): NodePath {
  return withLocatedPath(path, ({ parentPath, before, index }) => {
    const removed = before[index]!;
    const after = removeAt(before, index);
    getParentSignal(removed.child).value = undefined;

    if (after.length === 0) {
      return { after, path: parentPath };
    }

    const focusUid =
      before[index - 1]?.uid ?? before[index + 1]?.uid ?? after[0]!.uid;

    return { after, path: [...parentPath, focusUid] };
  });
}
