import { batch } from "@preact/signals-core";

import {
  ERR,
  type ListValue,
  type DataValue,
  type Value,
  type WriteSignal,
  type ValueSignal,
  type ChildSignal,
  type Cell,
  isBlank,
  isLiteral,
  isList,
  isFlow,
  isWritableSignal,
  getParentSignal,
  getParent,
  newUid,
  createError,
  createBlank,
  createLiteral,
  createList,
  createFlow,
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
  for (const { child } of list.cells) {
    const v = childToValue(child);
    if (isBlank(v)) continue;
    if (isLiteral(v) && typeof v.value === "number") out.push(v.value);
    else throw new TypeError(ERR.numOrBlank);
  }
  return out;
}

export function listTextsOpt(list: ListValue): string[] {
  const out: string[] = [];
  for (const { child } of list.cells) {
    const v = childToValue(child);
    if (isBlank(v)) continue;
    if (isLiteral(v) && typeof v.value === "string") out.push(v.value);
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
      uid: newUid(),
      name: cell.name,
      child: createComputed(() => {
        try {
          return f(valSig, indexSig, nameSig).get();
        } catch (err) {
          return createError(err instanceof Error ? err.message : String(err));
        }
      }),
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
    const d = va - vb;
    if (d) return d;
  } else if (ra === 1) {
    const d = collator.compare(va, vb);
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
    const v = childToValue(cur);
    if (!isList(v)) return null;
    const cell = v.cells.find((e) => e.uid === uid);
    if (!cell) return null;
    cur = cell.child;
  }
  return cur;
}

export function parentPath(path: CellPath): CellPath | null {
  return path.length ? path.slice(0, -1) : null;
}

export function firstChildPath(path: CellPath): CellPath | null {
  const child = resolvePath(path);
  if (!child) return null;
  const v = childToValue(child);
  return isList(v) && v.cells.length ? [...path, v.cells[0]!.uid] : null;
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

type CellKind = "text" | "text-readonly" | "list" | "flow";

export function getCellKind(path: CellPath): CellKind | null {
  const child = resolvePath(path);
  if (!child) return null;

  const v = child.peek();

  if (isFlow(v)) return "flow";
  if (isList(v)) return "list";

  return isWritableSignal(child) ? "text" : "text-readonly";
}

function flattenLeaves(): CellPath[] {
  const result: CellPath[] = [];

  function walk(path: CellPath, child: ChildSignal): void {
    const v = child.peek();

    if (isFlow(v)) {
      result.push(path);

      const out = v.result.peek();
      if (isList(out)) {
        for (const cell of out.cells) {
          walk([...path, cell.uid], cell.child);
        }
      }
      return;
    }

    if (isList(v)) {
      for (const cell of v.cells) {
        walk([...path, cell.uid], cell.child);
      }
      return;
    }

    result.push(path);
  }

  walk([], getDataRoot());
  return result;
}

export function neighborLeafPath(from: CellPath, dir: -1 | 1): CellPath | null {
  const leaves = flattenLeaves();
  const key = from.join(".");
  const i = leaves.findIndex((p) => p.join(".") === key);
  if (i === -1) return null;
  return leaves[i + dir] ?? null;
}

/* Mutations */

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseTextToValue(text: string): DataValue {
  const trimmed = text.trim();
  if (NUM_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return createLiteral(n);
  }
  return createLiteral(trimmed);
}

export function setText(path: CellPath, raw: string): CellPath {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const cur = sig.peek();

  if (isFlow(cur)) {
    if (cur.code !== raw) sig.set(createFlow(sig, raw));
    return path;
  }

  if (!isLiteral(cur) && !isBlank(cur)) return path;

  const next = parseTextToValue(raw);
  if (isLiteral(cur) && isLiteral(next) && cur.value === next.value)
    return path;

  sig.set(next);
  return path;
}

export function toggleTextCode(path: CellPath): TransformResult {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return null;

  const cur = sig.peek();

  if (isFlow(cur)) {
    sig.set(createBlank());
    return { path };
  }

  if (isLiteral(cur) || isBlank(cur)) {
    sig.set(createFlow(sig, ""));
    return { path, caret: 0 };
  }

  return null;
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
  const before = parent.peek().cells;
  const uid = path[path.length - 1]!;
  const index = before.findIndex((e) => e.uid === uid);
  if (index < 0) return path;

  let nextPath = path;
  batch(() => {
    const { after, path: p } = fn({ parent, parentPath, before, index, child });
    nextPath = p;
    if (after !== before) parent.set(createList(after));
  });

  return nextPath;
}

function makeBlankCell(child: ChildSignal): Cell {
  return {
    uid: newUid(),
    name: createSignal(""),
    view: createSignal(""),
    child,
  };
}

function insertAt(cs: Cell[], i: number, cell: Cell): Cell[] {
  return [...cs.slice(0, i), cell, ...cs.slice(i)];
}

function replaceAt(cs: Cell[], i: number, cell: Cell): Cell[] {
  return [...cs.slice(0, i), cell, ...cs.slice(i + 1)];
}

function removeAt(cs: Cell[], i: number): Cell[] {
  return [...cs.slice(0, i), ...cs.slice(i + 1)];
}

export function setName(path: CellPath, name: string): CellPath {
  return withLocatedPath(path, ({ before, index, parentPath }) => {
    before[index]!.name.set(name);
    return { after: before, path: [...parentPath, before[index]!.uid] };
  });
}

export type TransformResult = { path: CellPath; caret?: number } | null;

export function insertBefore(path: CellPath): TransformResult {
  const np = withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const child = createSignal(createBlank());
    getParentSignal(child).value = parent;

    const cell = makeBlankCell(child);
    const after = insertAt(before, index, cell);
    return { after, path: [...parentPath, cell.uid] };
  });
  return { path: np };
}

export function insertAfter(path: CellPath): TransformResult {
  const np = withLocatedPath(path, ({ parent, parentPath, before, index }) => {
    const child = createSignal(createBlank());
    getParentSignal(child).value = parent;

    const cell = makeBlankCell(child);
    const after = insertAt(before, index + 1, cell);
    return { after, path: [...parentPath, cell.uid] };
  });
  return { path: np };
}

export function wrapWithList(path: CellPath): TransformResult {
  const np = withLocatedPath(
    path,
    ({ parent, parentPath, before, index, child }) => {
      const oldCell = before[index]!;
      const wrapperUid = newUid();

      const wrapperSig = createSignal(createList([oldCell]));
      getParentSignal(wrapperSig).value = parent;
      getParentSignal(child).value = wrapperSig;

      const wrapperCell: Cell = {
        uid: wrapperUid,
        name: createSignal(""),
        view: createSignal(""),
        child: wrapperSig,
      };
      return {
        after: replaceAt(before, index, wrapperCell),
        path: [...parentPath, wrapperUid, oldCell.uid],
      };
    }
  );
  return { path: np };
}

export function unwrapIfSingleChild(path: CellPath): TransformResult {
  const innerChild = resolvePath(path);
  if (!innerChild) return null;

  const wrapperSig = getParent(innerChild);
  if (!wrapperSig) return null;

  const wrapperValue = wrapperSig.peek();
  if (wrapperValue.cells.length !== 1) return null;

  const pPath = parentPath(path);
  if (!pPath) return null;

  const np = withLocatedPath(
    pPath,
    ({ parent: grandparent, parentPath: gpPath, before, index }) => {
      const innerCell = wrapperValue.cells[0]!;
      getParentSignal(innerChild).value = grandparent;
      getParentSignal(wrapperSig).value = undefined;
      return {
        after: replaceAt(before, index, innerCell),
        path: [...gpPath, innerCell.uid],
      };
    }
  );
  return { path: np };
}

export function removeCell(path: CellPath): TransformResult {
  const np = withLocatedPath(path, ({ parentPath, before, index }) => {
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
  return { path: np };
}

export function splitCell(
  path: CellPath,
  caretStart: number,
  caretEnd: number = caretStart
): CellPath {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const cur = sig.peek();
  const text = isFlow(cur)
    ? cur.code
    : isLiteral(cur)
    ? String(cur.value)
    : isBlank(cur)
    ? ""
    : null;
  if (text === null) return path;

  const len = text.length;
  const start = Math.min(Math.max(caretStart, 0), len);
  const end = Math.min(Math.max(caretEnd, 0), len);

  const left = text.slice(0, start);
  const right = text.slice(end);

  batch(() => {
    setText(path, left);
    const next = insertAfter(path)!.path;
    setText(next, right);
    path = next;
  });
  return path;
}

export function mergeBackward(path: CellPath): TransformResult {
  const prev = siblingPath(path, -1);
  if (!prev) return null;

  const prevSig = resolvePath(prev);
  const curSig = resolvePath(path);
  if (!prevSig || !curSig) return null;

  const pv = childToValue(prevSig);
  const cv = childToValue(curSig);
  const prevText = isLiteral(pv) ? String(pv.value) : "";
  const curText = isLiteral(cv) ? String(cv.value) : "";
  const caret = prevText.length;

  let nextPath = prev;
  batch(() => {
    setText(prev, prevText + curText);
    nextPath = removeCell(path)?.path ?? prev;
  });

  return { path: nextPath, caret };
}

export function mergeForward(path: CellPath): TransformResult {
  const next = siblingPath(path, 1);
  if (!next) return null;

  const curSig = resolvePath(path);
  const nextSig = resolvePath(next);
  if (!curSig || !nextSig) return null;

  const cv = childToValue(curSig);
  const nv = childToValue(nextSig);
  const curText = isLiteral(cv) ? String(cv.value) : "";
  const nextText = isLiteral(nv) ? String(nv.value) : "";

  let nextPathOut = path;
  batch(() => {
    setText(path, curText + nextText);
    nextPathOut = removeCell(next)?.path ?? path;
  });

  return { path: nextPathOut, caret: curText.length };
}
