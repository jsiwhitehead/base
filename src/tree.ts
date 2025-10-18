import {
  ERR,
  type NamedCell,
  type PlainCell,
  type Value,
  type ListValue,
  type WriteSignal,
  type ValueSignal,
  type ChildSignal,
  getParent,
  getParentSignal,
  isBlank,
  isLiteral,
  isList,
  isFlow,
  isWritableSignal,
  newUid,
  createBlank,
  createLiteral,
  createFlowSignal,
  createComputed,
  createSignal,
  childToValue,
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

/* Cells */

type CellEntry =
  | ({ kind: "named" } & NamedCell)
  | ({ kind: "plain" } & PlainCell);

export function* iterCells(src: ListValue): Generator<CellEntry> {
  for (const v of src.named) {
    yield { kind: "named", uid: v.uid, key: v.key, child: v.child };
  }
  for (const p of src.plain) {
    yield { kind: "plain", uid: p.uid, child: p.child };
  }
}

function cellIndexByUid(cs: CellEntry[], uid: number): number {
  return cs.findIndex((e) => e.uid === uid);
}

type CellView = CellEntry & {
  id: string | number;
  index: number;
};

function* enumerateCells(src: ListValue): Generator<CellView> {
  let plainIndex1 = 1;
  let nIdx = 0;
  let pIdx = 0;
  for (const e of iterCells(src)) {
    const id = e.kind === "named" ? e.key : plainIndex1++;
    const index = e.kind === "named" ? nIdx++ : pIdx++;
    yield { ...e, id, index };
  }
}

function cellSignals(e: CellView) {
  const idSig = createSignal(createLiteral(e.id));
  const valSig = createSignal(childToValue(e.child));
  return { idSig, valSig };
}

function createListFromCells(entries: Iterable<CellEntry>): ListValue {
  const named: NamedCell[] = [];
  const plain: PlainCell[] = [];
  for (const e of entries) {
    if (e.kind === "named")
      named.push({ uid: e.uid ?? newUid(), key: e.key, child: e.child });
    else plain.push({ uid: e.uid ?? newUid(), child: e.child });
  }
  return { kind: "list", named, plain };
}

/* Lists */

export function listNumbersOpt(n: ListValue): number[] {
  const out: number[] = [];
  for (const e of iterCells(n)) {
    const value = childToValue(e.child);
    if (isBlank(value)) continue;
    if (isLiteral(value) && typeof value.value === "number")
      out.push(value.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

export function listTextsOpt(n: ListValue): string[] {
  const out: string[] = [];
  for (const e of iterCells(n)) {
    const value = childToValue(e.child);
    if (isBlank(value)) continue;
    if (isLiteral(value) && typeof value.value === "string")
      out.push(value.value);
    else throw new TypeError(ERR.textOrBlank);
  }
  return out;
}

export function listMap(
  src: ListValue,
  f: (value: ValueSignal, id: ValueSignal) => ValueSignal
): ListValue {
  return createListFromCells(
    Array.from(enumerateCells(src), (e) => {
      const { idSig, valSig } = cellSignals(e);
      return { ...e, child: createComputed(() => f(valSig, idSig).get()) };
    })
  );
}

export function listFilter(
  src: ListValue,
  pred: (value: ValueSignal, id: ValueSignal) => boolean
): ListValue {
  return createListFromCells(
    Array.from(enumerateCells(src)).filter((e) => {
      const { idSig, valSig } = cellSignals(e);
      return pred(valSig, idSig);
    })
  );
}

export function listReduce(
  src: ListValue,
  rf: (acc: ValueSignal, value: ValueSignal, id: ValueSignal) => ValueSignal,
  init: ValueSignal
): ValueSignal {
  const seq = Array.from(enumerateCells(src));
  if (seq.length === 0) return init;

  const step = (acc: ValueSignal, e: CellView) => {
    const { idSig, valSig } = cellSignals(e);
    return rf(acc, valSig, idSig);
  };

  if (!isBlank(init.get())) return seq.reduce(step, init);

  const first = createSignal(childToValue(seq[0]!.child));
  return seq.slice(1).reduce(step, first);
}

function sortRank(v: Value): [number, any] {
  // numbers < text < true < other < blank
  if (isBlank(v)) return [4, null];
  if (isLiteral(v)) {
    const lit = v.value;
    if (typeof lit === "number") return [0, lit];
    if (typeof lit === "string") return [1, lit];
    if (lit === true) return [2, 1];
  }
  return [3, null];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base" });

function sortCmp<T extends { sortKey: Value; index: number }>(
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

export function listSort(
  src: ListValue,
  keySelector: null | ((value: ValueSignal, id: ValueSignal) => ValueSignal)
): ListValue {
  const rows = Array.from(enumerateCells(src), (e) => {
    if (!keySelector) return { ...e, sortKey: childToValue(e.child) };
    const { idSig, valSig } = cellSignals(e);
    return { ...e, sortKey: keySelector(valSig, idSig).get() };
  });
  rows.sort(sortCmp);
  return createListFromCells(rows);
}

/* Navigation */

export type CellPath = number[];

function resolvePath(path: CellPath): ChildSignal | null {
  let cur: ChildSignal = getDataRoot();
  for (const uid of path) {
    const value = childToValue(cur);
    if (!isList(value)) return null;
    const cs = Array.from(iterCells(value));
    const i = cellIndexByUid(cs, uid);
    if (i < 0) return null;
    cur = cs[i]!.child;
  }
  return cur;
}

export function parentPath(path: CellPath): CellPath | null {
  if (path.length === 0) return null;
  return path.slice(0, -1);
}

export function firstChildPath(path: CellPath): CellPath | null {
  const child = resolvePath(path);
  if (!child) return null;
  const value = childToValue(child);
  if (!isList(value)) return null;
  const cs = Array.from(iterCells(value));
  return cs.length ? [...path, cs[0]!.uid] : null;
}

export function siblingPath(path: CellPath, dir: -1 | 1): CellPath | null {
  if (path.length === 0) return null;

  const pp = parentPath(path);
  if (!pp) return null;

  const parentChild = resolvePath(pp);
  if (!parentChild) return null;

  const listV = childToValue(parentChild);
  if (!isList(listV)) return null;

  const cs = Array.from(iterCells(listV));
  const i = cellIndexByUid(cs, path[path.length - 1]!);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cs.length) return null;

  return [...pp, cs[j]!.uid];
}

/* Mutations */

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function parseTextToValue(raw: string): Value {
  const t = raw.trim();
  if (t === "") return createBlank();
  if (NUM_RE.test(t) && Number.isFinite(Number(t))) {
    return createLiteral(Number(t));
  }
  return createLiteral(t);
}

export function setText(path: CellPath, raw: string): CellPath {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const cur = sig.peek();

  if (isFlow(cur)) {
    sig.set({
      kind: "flow",
      code: raw,
      result: cur.result,
    });
    return path;
  }

  if (isLiteral(cur) || isBlank(cur)) {
    sig.set(parseTextToValue(raw));
    return path;
  }

  return path;
}

export function toggleCodeText(path: CellPath): CellPath {
  return withLocatedPath(
    path,
    ({ parent, parentPath, before, index, child }) => {
      const cur = child.peek();
      let nextChild: ChildSignal | null = null;

      if (isFlow(cur)) {
        nextChild = createSignal(parseTextToValue(cur.code));
      } else if (isLiteral(cur) || isBlank(cur)) {
        const text = isLiteral(cur) ? String(cur.value) : "";
        nextChild = createFlowSignal(text);
      } else {
        return { after: before, path: [...parentPath, before[index]!.uid] };
      }

      getParentSignal(nextChild).value = parent;
      getParentSignal(child).value = undefined;

      const after = before.slice();
      after[index] = { ...before[index]!, child: nextChild };
      return { after, path: [...parentPath, before[index]!.uid] };
    }
  );
}

export function withLocatedPath(
  path: CellPath,
  fn: (ctx: {
    parent: WriteSignal<ListValue>;
    parentPath: CellPath;
    before: CellEntry[];
    index: number;
    child: ChildSignal;
  }) => { after: CellEntry[]; path: CellPath }
): CellPath {
  if (path.length === 0) return path;

  const child = resolvePath(path);
  if (!child) return path;

  const parent = getParent(child);
  if (!parent) return path;

  const parentPath = path.slice(0, -1);

  const before = Array.from(iterCells(parent.get()));
  const uid = path[path.length - 1]!;
  const index = cellIndexByUid(before, uid);
  if (index < 0) return path;

  const result = fn({ parent, parentPath, before, index, child });

  if (result.after !== before) parent.set(createListFromCells(result.after));
  return result.path;
}

function replaceAt(
  cs: CellEntry[],
  i: number,
  nextChild: ChildSignal
): CellEntry[] {
  const out = cs.slice();
  out[i] = { ...cs[i]!, child: nextChild };
  return out;
}

function removeAt(cs: CellEntry[], i: number): CellEntry[] {
  const out = cs.slice();
  out.splice(i, 1);
  return out;
}

function insertPlainAt(
  cs: CellEntry[],
  i: number,
  child: ChildSignal
): { cs: CellEntry[]; uid: number } {
  const uid = newUid();
  const out = cs.slice();
  out.splice(i, 0, { kind: "plain", uid, child });
  return { cs: out, uid };
}

function indexOfFirstPlain(cs: CellEntry[]) {
  const k = cs.findIndex((x) => x.kind === "plain");
  return k < 0 ? cs.length : k;
}

function isNamedEntry(
  e: CellEntry
): e is Extract<CellEntry, { kind: "named" }> {
  return e.kind === "named";
}

export function assignKey(path: CellPath, nextKey: string): CellPath {
  return withLocatedPath(path, ({ parentPath, before, index }) => {
    if (before.some((e) => e.kind === "named" && e.key === nextKey)) {
      return { after: before, path: [...parentPath, before[index]!.uid] };
    }
    const e = before[index]!;
    if (e.kind === "named") {
      const after = before.slice();
      if (e.key !== nextKey) after[index] = { ...e, key: nextKey };
      return { after, path: [...parentPath, e.uid] };
    }

    const cut = removeAt(before, index);
    const at = indexOfFirstPlain(cut);
    cut.splice(at, 0, {
      kind: "named",
      uid: e.uid,
      key: nextKey,
      child: e.child,
    });
    return { after: cut, path: [...parentPath, e.uid] };
  });
}

export function removeKey(path: CellPath): CellPath {
  return withLocatedPath(path, ({ parentPath, before, index }) => {
    const e = before[index]!;
    if (e.kind !== "named") {
      return { after: before, path: [...parentPath, e.uid] };
    }

    const after = removeAt(before, index);
    const at = indexOfFirstPlain(after);
    after.splice(at, 0, { kind: "plain", uid: e.uid, child: e.child });
    return { after, path: [...parentPath, e.uid] };
  });
}

export function insertBefore(path: CellPath): CellPath {
  return withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const item = createSignal(createBlank() as Value);
    getParentSignal(item).value = parent;

    const insertAt = isNamedEntry(before[index]!)
      ? indexOfFirstPlain(before)
      : index;

    const { cs: after, uid } = insertPlainAt(before, insertAt, item);
    return { after, path: [...parentPath, uid] };
  });
}

export function insertAfter(path: CellPath): CellPath {
  return withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const item = createSignal(createBlank() as Value);
    getParentSignal(item).value = parent;

    const insertAt = isNamedEntry(before[index]!)
      ? indexOfFirstPlain(before)
      : index + 1;

    const { cs: after, uid } = insertPlainAt(before, insertAt, item);
    return { after, path: [...parentPath, uid] };
  });
}

export function wrapWithList(path: CellPath): CellPath {
  return withLocatedPath(
    path,
    ({ parentPath, parent, before, index, child }) => {
      const innerUid = newUid();
      const wrapper = createSignal(
        createListFromCells([{ kind: "plain", uid: innerUid, child }])
      );
      getParentSignal(wrapper).value = parent;
      getParentSignal(child).value = wrapper;

      const after = replaceAt(before, index, wrapper);
      const wrapperUid = before[index]!.uid;
      return { after, path: [...parentPath, wrapperUid, innerUid] };
    }
  );
}

export function unwrapListIfSingleChild(path: CellPath): CellPath {
  const innerChild = resolvePath(path);
  if (!innerChild) return path;

  const wrapperSig = getParent(innerChild);
  if (!wrapperSig) return path;

  const wrapperValue = wrapperSig.get();
  if (wrapperValue.named.length !== 0 || wrapperValue.plain.length !== 1) {
    return path;
  }

  const pPath = parentPath(path);
  if (!pPath) return path;

  return withLocatedPath(
    pPath,
    ({ parent: grandparent, parentPath: gpPath, before, index }) => {
      getParentSignal(innerChild).value = grandparent;
      getParentSignal(wrapperSig).value = undefined;

      const after = replaceAt(before, index, innerChild);
      const wrapperUid = before[index]!.uid;
      return { after, path: [...gpPath, wrapperUid] };
    }
  );
}

export function removeChild(path: CellPath): CellPath {
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
