import { batch } from "@preact/signals-core";

import {
  type ListValue,
  type TemplateValue,
  type DataValue,
  type WriteSignal,
  type ChildSignal,
  type Cell,
  isBlank,
  isLiteral,
  isList,
  isFlow,
  isLink,
  isTemplate,
  isWritableSignal,
  getParentSignal,
  getParent,
  newUid,
  createBlank,
  createLiteral,
  createList,
  createFlow,
  createLink,
  createTemplate,
  createSignal,
  evalStructural,
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

/* Navigation */

export type CellPath = number[];

export type CellKind = "text" | "text-readonly" | "list" | "flow" | "link";

export type ViewContext = "default" | "table-cell" | "bar-child";

export type NavContext = {
  kind: CellKind | null;
  viewContext: ViewContext;
};

function cellsAlongPath(path: CellPath): Cell[] {
  const cells: Cell[] = [];
  let child: ChildSignal = getDataRoot();

  for (const uid of path) {
    const v = evalStructural(child);
    if (!isList(v)) return [];
    const cell = v.cells.find((c) => c.uid === uid);
    if (!cell) return [];
    cells.push(cell);
    child = cell.child;
  }

  return cells;
}

function resolvePath(path: CellPath): ChildSignal | null {
  if (path.length === 0) return getDataRoot();
  const cells = cellsAlongPath(path);
  const last = cells[cells.length - 1];
  return last ? last.child : null;
}

function getListAt(path: CellPath): ListValue | null {
  const child = resolvePath(path);
  if (!child) return null;
  const v = evalStructural(child);
  return isList(v) ? v : null;
}

export function parentPath(path: CellPath): CellPath | null {
  return path.length ? path.slice(0, -1) : null;
}

export function firstChildPath(path: CellPath): CellPath | null {
  const list = getListAt(path);
  const first = list?.cells[0];
  return first ? [...path, first.uid] : null;
}

export function siblingPath(path: CellPath, dir: -1 | 1): CellPath | null {
  if (path.length === 0) return null;

  const pp = parentPath(path);
  if (!pp) return null;

  const list = getListAt(pp);
  if (!list) return null;

  const cs = list.cells;
  const uid = path[path.length - 1]!;
  const i = cs.findIndex((e) => e.uid === uid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cs.length) return null;

  return [...pp, cs[j]!.uid];
}

export function getNavContext(path: CellPath): NavContext {
  const cells = cellsAlongPath(path);

  const cell = cells[cells.length - 1];
  const parentCell = cells[cells.length - 2];
  const grandparentCell = cells[cells.length - 3];

  let kind: CellKind | null = null;

  if (cell) {
    const child = cell.child;
    const v = child.peek();

    if (isFlow(v)) kind = "flow";
    else if (isLink(v)) kind = "link";
    else if (isList(v) || isTemplate(v)) kind = "list";
    else kind = isWritableSignal(child) ? "text" : "text-readonly";
  }

  const parentView = parentCell?.view.peek() ?? "";
  const grandparentView = grandparentCell?.view.peek() ?? "";

  const viewContext: ViewContext =
    grandparentView === "table"
      ? "table-cell"
      : parentView === "bar"
      ? "bar-child"
      : "default";

  return { kind, viewContext };
}

function flattenLeaves(): CellPath[] {
  const result: CellPath[] = [];

  function walk(path: CellPath, child: ChildSignal): void {
    const v = child.peek();

    if (isFlow(v) || isLink(v)) {
      result.push(path);

      const out = v.result.peek();
      if (isList(out)) {
        for (const cell of out.cells) {
          walk([...path, cell.uid], cell.child);
        }
      }
      return;
    }

    if (isTemplate(v)) {
      const out = evalStructural(child);
      if (isList(out)) {
        for (const cell of out.cells) {
          walk([...path, cell.uid], cell.child);
        }
      } else {
        result.push(path);
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

function neighborLeaf(
  from: CellPath,
  dir: -1 | 1,
  blockPrefix?: CellPath
): CellPath | null {
  const leaves = flattenLeaves();
  const fromKey = from.join(".");
  const blockKey = blockPrefix?.length ? blockPrefix.join(".") : null;

  const i = leaves.findIndex((p) => p.join(".") === fromKey);
  if (i === -1) return null;

  let j = i + dir;
  while (j >= 0 && j < leaves.length) {
    const p = leaves[j]!;
    const key = p.join(".");
    if (!blockKey || !key.startsWith(blockKey)) return p;
    j += dir;
  }

  return null;
}

function tableVerticalNeighborPath(
  from: CellPath,
  dir: -1 | 1
): CellPath | null {
  if (from.length < 2) return null;

  const rowPath = parentPath(from);
  const nextRowPath = rowPath && siblingPath(rowPath, dir);
  if (!rowPath || !nextRowPath) return null;

  const row = getListAt(rowPath);
  const nextRow = getListAt(nextRowPath);
  if (!row || !nextRow) return null;

  const uid = from[from.length - 1]!;
  const colIndex = row.cells.findIndex((c) => c.uid === uid);
  if (colIndex === -1) return null;

  const colName = row.cells[colIndex]!.name.peek();
  if (!colName) return null;

  const target = nextRow.cells.find((c) => c.name.peek() === colName);
  return target ? [...nextRowPath, target.uid] : null;
}

export function navigatePath(
  path: CellPath,
  dir: "left" | "right" | "up" | "down",
  mod: boolean
): CellPath | null {
  const { kind, viewContext } = getNavContext(path);

  if (dir === "left" || dir === "right") {
    const sign: -1 | 1 = dir === "left" ? -1 : 1;

    if (mod && (viewContext === "table-cell" || viewContext === "bar-child")) {
      if (sign === -1) {
        const left = siblingPath(path, -1);
        return left ?? parentPath(path);
      }
      return siblingPath(path, 1);
    }

    if (sign === -1 && (kind === "list" || mod)) {
      const p = parentPath(path);
      if (p && p.length) return p;
    }

    if (sign === 1) {
      if (kind === "list") return firstChildPath(path);
      if (mod) return null;
    }

    return neighborLeaf(path, sign);
  }

  const sign: -1 | 1 = dir === "up" ? -1 : 1;

  if (viewContext === "table-cell") {
    const next = tableVerticalNeighborPath(path, sign);
    if (mod || next) return next ?? null;

    const blockPrefix = path.length > 2 ? path.slice(0, -2) : path.slice(0, 1);
    return neighborLeaf(path, sign, blockPrefix);
  }

  if (viewContext === "bar-child") {
    return mod ? null : neighborLeaf(path, sign, path.slice(0, -1));
  }

  if (mod || kind === "list") {
    return siblingPath(path, sign);
  }

  const target = neighborLeaf(path, sign);
  if (!target) return null;

  const { viewContext: targetView } = getNavContext(target);
  if (targetView === "table-cell" || targetView === "bar-child") {
    const rowPath = parentPath(target);
    const row = rowPath && getListAt(rowPath);
    const first = row?.cells[0];
    if (!rowPath || !first) return target;
    return [...rowPath, first.uid];
  }

  return target;
}

/* Mutations */

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseTextToValue(text: string): DataValue {
  const trimmed = text.trim();
  if (NUM_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return createLiteral(n);
  }
  return createLiteral(text);
}

export function setText(path: CellPath, raw: string): CellPath {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const cur = sig.peek();

  if (isFlow(cur)) {
    if (cur.code !== raw) sig.set(createFlow(sig, raw));
    return path;
  }

  if (isLink(cur)) {
    if (cur.source !== raw) sig.set(createLink(sig, raw, cur.filter));
    return path;
  }

  if (!isLiteral(cur) && !isBlank(cur)) return path;

  const next = parseTextToValue(raw);
  if (isLiteral(cur) && isLiteral(next) && cur.value === next.value)
    return path;

  sig.set(next);
  return path;
}

export function setLinkFilter(path: CellPath, filter: string): CellPath {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const cur = sig.peek();
  if (!isLink(cur)) return path;

  if (cur.filter !== filter) sig.set(createLink(sig, cur.source, filter));
  return path;
}

export function setTemplateParam(path: CellPath, paramText: string): CellPath {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const cur = sig.peek();
  if (!isTemplate(cur)) return path;

  const nextParams = paramText
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const same =
    cur.params.length === nextParams.length &&
    cur.params.every((p, i) => p === nextParams[i]);

  if (!same) sig.set(createTemplate(nextParams, cur.body));
  return path;
}

export function toggleTextCode(path: CellPath): TransformResult {
  const sig = resolvePath(path);
  if (!sig || !isWritableSignal(sig)) return null;

  const cur = sig.peek();

  if (isFlow(cur) || isLink(cur)) {
    sig.set(createBlank());
    return { path };
  }

  if (isLiteral(cur) || isBlank(cur)) {
    sig.set(createFlow(sig, ""));
    return { path, caret: 0 };
  }

  return null;
}

type ParentValue = ListValue | TemplateValue;
type ParentSignal = WriteSignal<ParentValue>;

function getParentInfo(v: ParentValue) {
  return {
    ...(isTemplate(v) ? (v.body as ListValue) : v),
    params: isTemplate(v) ? v.params : undefined,
  };
}

function setParentInfo(list: Cell[], resultUid?: number, params?: string[]) {
  const nextList = createList(list, resultUid);
  if (params !== undefined) return createTemplate(params, nextList);
  return nextList;
}

export function withLocatedPath(
  path: CellPath,
  fn: (ctx: {
    parent: ParentSignal;
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
  const parentValue = parent.peek();
  const { cells: before, resultUid, params } = getParentInfo(parentValue)!;

  const uid = path[path.length - 1]!;
  const index = before.findIndex((c) => c.uid === uid);
  if (index < 0) return path;

  let nextPath = path;
  batch(() => {
    const { after, path: p } = fn({ parent, parentPath, before, index, child });
    nextPath = p;

    if (after !== before) {
      parent.set(setParentInfo(after, resultUid, params));
    }
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
    const nm = before[index]!.name;
    if (isWritableSignal(nm)) nm.set(name);
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
      const outerNameSig = oldCell.name;
      oldCell.name = createSignal("");

      const wrapperSig = createSignal(createList([oldCell]));
      getParentSignal(wrapperSig).value = parent;
      getParentSignal(child).value = wrapperSig;

      const wrapperCell: Cell = {
        uid: wrapperUid,
        name: outerNameSig,
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

  const { cells } = getParentInfo(wrapperSig.peek());
  if (cells.length !== 1) return null;

  const pPath = parentPath(path);
  if (!pPath) return null;

  const np = withLocatedPath(
    pPath,
    ({ parent: grandparent, parentPath: gpPath, before, index }) => {
      const innerCell = cells[0]!;
      innerCell.name = before[index]!.name;
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
    : isLink(cur)
    ? cur.source
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

  const pv = evalStructural(prevSig);
  const cv = evalStructural(curSig);
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

  const cv = evalStructural(curSig);
  const nv = evalStructural(nextSig);
  const curText = isLiteral(cv) ? String(cv.value) : "";
  const nextText = isLiteral(nv) ? String(nv.value) : "";

  let nextPathOut = path;
  batch(() => {
    setText(path, curText + nextText);
    nextPathOut = removeCell(next)?.path ?? path;
  });

  return { path: nextPathOut, caret: curText.length };
}
