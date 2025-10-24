import {
  ERR,
  type Value,
  type ListValue,
  type WriteSignal,
  type ValueSignal,
  type ChildSignal,
  type Cell,
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
  createList,
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

/* Lists */

export function listNumbersOpt(list: ListValue): number[] {
  const out: number[] = [];
  for (const e of list.cells) {
    const value = childToValue(e.child);
    if (isBlank(value)) continue;
    if (isLiteral(value) && typeof value.value === "number")
      out.push(value.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

export function listTextsOpt(list: ListValue): string[] {
  const out: string[] = [];
  for (const e of list.cells) {
    const value = childToValue(e.child);
    if (isBlank(value)) continue;
    if (isLiteral(value) && typeof value.value === "string")
      out.push(value.value);
    else throw new TypeError(ERR.textOrBlank);
  }
  return out;
}

function listCellSignals(src: ListValue): {
  cell: Cell;
  indexSig: ValueSignal;
  nameSig: ValueSignal;
  valSig: ValueSignal;
}[] {
  return src.cells.map((c, i) => {
    const indexSig = createSignal(createLiteral(i + 1));
    const nameSig = createComputed(() => {
      const n = c.name.get();
      return n ? createLiteral(n) : createBlank();
    });
    const valSig = createSignal(childToValue(c.child));
    return { cell: c, indexSig, nameSig, valSig };
  });
}

export function listMap(
  src: ListValue,
  f: (value: ValueSignal, index: ValueSignal, name: ValueSignal) => ValueSignal
): ListValue {
  return createList(
    listCellSignals(src).map(({ cell, indexSig, nameSig, valSig }) => ({
      uid: cell.uid,
      name: cell.name,
      child: createComputed(() => f(valSig, indexSig, nameSig).get()),
    }))
  );
}

export function listFilter(
  src: ListValue,
  pred: (value: ValueSignal, index: ValueSignal, name: ValueSignal) => boolean
): ListValue {
  return createList(
    listCellSignals(src)
      .filter(({ indexSig, nameSig, valSig }) =>
        pred(valSig, indexSig, nameSig)
      )
      .map(({ cell }) => cell)
  );
}

export function listReduce(
  src: ListValue,
  rf: (
    acc: ValueSignal,
    value: ValueSignal,
    index: ValueSignal,
    name: ValueSignal
  ) => ValueSignal,
  init: ValueSignal
): ValueSignal {
  const seq = listCellSignals(src);
  if (seq.length === 0) return init;

  const step = (acc: ValueSignal, e: (typeof seq)[number]) =>
    rf(acc, e.valSig, e.indexSig, e.nameSig);

  if (!isBlank(init.get())) {
    return seq.reduce(step, init);
  }

  const first = createSignal(childToValue(src.cells[0]!.child));
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
  keySelector:
    | null
    | ((
        value: ValueSignal,
        index: ValueSignal,
        name: ValueSignal
      ) => ValueSignal)
): ListValue {
  const rows = listCellSignals(src).map(
    ({ cell, indexSig, nameSig, valSig }, i) => ({
      uid: cell.uid,
      name: cell.name,
      child: cell.child,
      index: i,
      sortKey: keySelector
        ? keySelector(valSig, indexSig, nameSig).get()
        : childToValue(cell.child),
    })
  );

  rows.sort(sortCmp);
  return createList(rows);
}

/* Navigation */

export type CellPath = number[];

function resolvePath(path: CellPath): ChildSignal | null {
  let cur: ChildSignal = getDataRoot();
  for (const uid of path) {
    const value = childToValue(cur);
    if (!isList(value)) return null;
    const i = value.cells.findIndex((e) => e.uid === uid);
    if (i < 0) return null;
    cur = value.cells[i]!.child;
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
  return value.cells.length ? [...path, value.cells[0]!.uid] : null;
}

export function siblingPath(path: CellPath, dir: -1 | 1): CellPath | null {
  if (path.length === 0) return null;

  const pp = parentPath(path);
  if (!pp) return null;

  const parentChild = resolvePath(pp);
  if (!parentChild) return null;

  const list = childToValue(parentChild);
  if (!isList(list)) return null;

  const cs = list.cells;
  const i = cs.findIndex((e) => e.uid === path[path.length - 1]!);
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
    before: Cell[];
    index: number;
    child: ChildSignal;
  }) => { after: Cell[]; path: CellPath }
): CellPath {
  if (path.length === 0) return path;

  const child = resolvePath(path);
  if (!child) return path;

  const parent = getParent(child);
  if (!parent) return path;

  const parentPath = path.slice(0, -1);

  const before = parent.get().cells;
  const uid = path[path.length - 1]!;
  const index = before.findIndex((e) => e.uid === uid);
  if (index < 0) return path;

  const result = fn({ parent, parentPath, before, index, child });

  if (result.after !== before) parent.set(createList(result.after));
  return result.path;
}

function replaceAt(cs: Cell[], i: number, nextChild: ChildSignal): Cell[] {
  const out = cs.slice();
  out[i] = { ...cs[i]!, child: nextChild };
  return out;
}

function removeAt(cs: Cell[], i: number): Cell[] {
  const out = cs.slice();
  out.splice(i, 1);
  return out;
}

function insertAt(
  cs: Cell[],
  i: number,
  child: ChildSignal
): { cs: Cell[]; uid: number } {
  const uid = newUid();
  const out = cs.slice();
  out.splice(i, 0, { uid, name: createSignal(""), child });
  return { cs: out, uid };
}

export function setName(path: CellPath, name: string): CellPath {
  return withLocatedPath(path, ({ before, index, parentPath }) => {
    before[index]!.name.set(name);
    return { after: before, path: [...parentPath, before[index]!.uid] };
  });
}

export function insertBefore(path: CellPath): CellPath {
  return withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const item = createSignal(createBlank() as Value);
    getParentSignal(item).value = parent;

    const { cs: after, uid } = insertAt(before, index, item);
    return { after, path: [...parentPath, uid] };
  });
}

export function insertAfter(path: CellPath): CellPath {
  return withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const item = createSignal(createBlank() as Value);
    getParentSignal(item).value = parent;

    const { cs: after, uid } = insertAt(before, index + 1, item);
    return { after, path: [...parentPath, uid] };
  });
}

export function wrapWithList(path: CellPath): CellPath {
  return withLocatedPath(
    path,
    ({ parentPath, parent, before, index, child }) => {
      const innerUid = newUid();
      const wrapper = createSignal(createList([{ uid: innerUid, child }]));
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
  if (wrapperValue.cells.length !== 1) {
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
