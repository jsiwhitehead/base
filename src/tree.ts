import { batch } from "@preact/signals-core";

import {
  type ListValue,
  type TemplateValue,
  type WriteSignal,
  type CellValueSignal,
  type Cell,
  type NavLayoutContext,
  isWritableSignal,
  getParentSignal,
  getParent,
  newUid,
  createBlank,
  createList,
  createFlow,
  createSignal,
  getRenderModel,
  getRenderChildren,
  getRenderEditors,
  editParentList,
  parseScalarInput,
  getLayoutContext,
} from "./data";

/* Root */

let __dataRoot: CellValueSignal | null = null;

export function setDataRoot(root: CellValueSignal) {
  __dataRoot = root;
}

export function getDataRoot(): CellValueSignal {
  if (!__dataRoot) throw new Error("Data root not set");
  return __dataRoot;
}

/* Navigation */

export type CellPath = number[];

function cellsAlongPath(path: CellPath): Cell[] {
  const cells: Cell[] = [];
  let value: CellValueSignal = getDataRoot();

  for (const uid of path) {
    const cs = getRenderChildren(value);
    const cell = cs.find((c) => c.uid === uid);
    if (!cell) return [];
    cells.push(cell);
    value = cell.value;
  }

  return cells;
}

function childSignalAtPath(path: CellPath): CellValueSignal | null {
  if (path.length === 0) return getDataRoot();
  const cells = cellsAlongPath(path);
  const last = cells[cells.length - 1];
  return last ? last.value : null;
}

function childrenAtPath(path: CellPath): Cell[] | null {
  const value = childSignalAtPath(path);
  if (!value) return null;
  return getRenderChildren(value);
}

export function parentPath(path: CellPath): CellPath | null {
  return path.length ? path.slice(0, -1) : null;
}

export function firstChildPath(path: CellPath): CellPath | null {
  const cs = childrenAtPath(path);
  const first = cs?.[0];
  return first ? [...path, first.uid] : null;
}

export function siblingPath(path: CellPath, dir: -1 | 1): CellPath | null {
  if (path.length === 0) return null;

  const pp = parentPath(path);
  if (!pp) return null;

  const cs = childrenAtPath(pp);
  if (!cs) return null;

  const uid = path[path.length - 1]!;
  const i = cs.findIndex((e) => e.uid === uid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cs.length) return null;

  return [...pp, cs[j]!.uid];
}

type CellEditKind = "text" | "text-readonly" | "list";

type CellNavContext = {
  kind: CellEditKind | null;
  viewContext: NavLayoutContext;
  hasExtraHeaderEditors: boolean;
};

export function getCellNavContext(path: CellPath): CellNavContext {
  const cells = cellsAlongPath(path);

  const cell = cells[cells.length - 1];
  const parentCell = cells[cells.length - 2];
  const grandparentCell = cells[cells.length - 3];

  let kind: CellEditKind | null = null;
  let hasExtraHeaderEditors = false;

  if (cell) {
    const m = getRenderModel(cell.value);
    if (m.kind === "list") kind = "list";
    else kind = m.editable ? "text" : "text-readonly";

    hasExtraHeaderEditors = getRenderEditors(cell).some(
      (f) => f.get.value !== null
    );
  }

  const viewContext = getLayoutContext(parentCell, grandparentCell);

  return { kind, viewContext, hasExtraHeaderEditors };
}

function isNavStop(cell: Cell | null, value: CellValueSignal): boolean {
  const kids = getRenderChildren(value);
  if (kids.length === 0) return true;
  if (!cell) return false;
  return getRenderEditors(cell).some((f) => f.get.value !== null);
}

function collectNavStops(): CellPath[] {
  const result: CellPath[] = [];

  function walk(
    path: CellPath,
    value: CellValueSignal,
    cell: Cell | null
  ): void {
    if (isNavStop(cell, value)) {
      result.push(path);
    }

    for (const c of getRenderChildren(value)) {
      walk([...path, c.uid], c.value, c);
    }
  }

  walk([], getDataRoot(), null);
  return result;
}

function neighborNavStop(
  from: CellPath,
  dir: -1 | 1,
  blockPrefix?: CellPath
): CellPath | null {
  const leaves = collectNavStops();
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

function tableVerticalMove(from: CellPath, dir: -1 | 1): CellPath | null {
  if (from.length < 2) return null;

  const rowPath = parentPath(from);
  const nextRowPath = rowPath && siblingPath(rowPath, dir);
  if (!rowPath || !nextRowPath) return null;

  const rowCells = childrenAtPath(rowPath);
  const nextRowCells = childrenAtPath(nextRowPath);
  if (!rowCells || !nextRowCells) return null;

  const uid = from[from.length - 1]!;
  const colIndex = rowCells.findIndex((c) => c.uid === uid);
  if (colIndex === -1) return null;

  const colName = rowCells[colIndex]!.name.peek();
  if (!colName) return null;

  const target = nextRowCells.find((c) => c.name.peek() === colName);
  return target ? [...nextRowPath, target.uid] : null;
}

export function standardMove(
  path: CellPath,
  dir: "left" | "right" | "up" | "down",
  mod: boolean
): CellPath | null {
  const { kind, viewContext } = getCellNavContext(path);

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
      const node = childSignalAtPath(path) ?? getDataRoot();
      if (getRenderChildren(node).length) {
        return firstChildPath(path);
      }
      if (mod) return null;
    }

    return neighborNavStop(path, sign);
  }

  const sign: -1 | 1 = dir === "up" ? -1 : 1;

  if (viewContext === "table-cell") {
    const next = tableVerticalMove(path, sign);
    if (mod || next) return next ?? null;

    const blockPrefix = path.length > 2 ? path.slice(0, -2) : path.slice(0, 1);
    return neighborNavStop(path, sign, blockPrefix);
  }

  if (viewContext === "bar-child") {
    return mod ? null : neighborNavStop(path, sign, path.slice(0, -1));
  }

  if (mod || kind === "list") {
    return siblingPath(path, sign);
  }

  const target = neighborNavStop(path, sign);
  if (!target) return null;

  const { viewContext: targetView } = getCellNavContext(target);
  if (targetView === "table-cell" || targetView === "bar-child") {
    const rowPath = parentPath(target);
    const rowCells = rowPath && childrenAtPath(rowPath);
    const first = rowCells?.[0];
    if (!rowPath || !first) return target;
    return [...rowPath, first.uid];
  }

  return target;
}

/* Mutations */

export type TransformResult = { path: CellPath; caret?: number } | null;

export function setCellText(path: CellPath, raw: string): CellPath {
  const sig = childSignalAtPath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  sig.set(parseScalarInput(raw));
  return path;
}

export function setCellAsFlow(path: CellPath): TransformResult {
  const sig = childSignalAtPath(path);
  if (!sig || !isWritableSignal(sig)) return null;

  sig.set(createFlow(sig, ""));
  return { path, caret: 0 };
}

function editParentAtPath(
  path: CellPath,
  fn: (ctx: {
    parent: WriteSignal<ListValue | TemplateValue<ListValue>>;
    parentPath: CellPath;
    before: Cell[];
    index: number;
    valueCellUid?: number;
    params?: string[];
    child: CellValueSignal;
    uid: number;
  }) => { after: Cell[]; valueCellUid?: number; path: CellPath }
): CellPath {
  if (path.length === 0) return path;

  const child = childSignalAtPath(path);
  if (!child) return path;

  const uid = path[path.length - 1]!;
  const parentPath = path.slice(0, -1);

  let nextPath = path;

  const out = editParentList(
    child,
    uid,
    ({ parent, before, index, valueCellUid, params }) => {
      const r = fn({
        parent,
        parentPath,
        before,
        index,
        valueCellUid,
        params,
        child,
        uid,
      });
      nextPath = r.path;
      return { after: r.after, valueCellUid: r.valueCellUid };
    }
  );

  return out ? nextPath : path;
}

function makeBlankCell(value: CellValueSignal): Cell {
  return {
    uid: newUid(),
    name: createSignal(""),
    view: createSignal(""),
    value,
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

export function insertCellBefore(path: CellPath): TransformResult {
  const np = editParentAtPath(path, ({ parent, parentPath, before, index }) => {
    const value = createSignal(createBlank());
    getParentSignal(value).value = parent;

    const cell = makeBlankCell(value);
    const after = insertAt(before, index, cell);
    return { after, path: [...parentPath, cell.uid] };
  });

  return { path: np };
}

export function insertCellAfter(path: CellPath): TransformResult {
  const np = editParentAtPath(path, ({ parent, parentPath, before, index }) => {
    const value = createSignal(createBlank());
    getParentSignal(value).value = parent;

    const cell = makeBlankCell(value);
    const after = insertAt(before, index + 1, cell);
    return { after, path: [...parentPath, cell.uid] };
  });

  return { path: np };
}

export function wrapCellInList(path: CellPath): TransformResult {
  const np = editParentAtPath(
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
        value: wrapperSig,
      };

      return {
        after: replaceAt(before, index, wrapperCell),
        path: [...parentPath, wrapperUid, oldCell.uid],
      };
    }
  );

  return { path: np };
}

export function unwrapSingleCellList(path: CellPath): TransformResult {
  const innerChild = childSignalAtPath(path);
  if (!innerChild) return null;

  const wrapperSig = getParent(innerChild);
  if (!wrapperSig) return null;

  const cells = getRenderChildren(wrapperSig);
  if (cells.length !== 1) return null;

  const pPath = parentPath(path);
  if (!pPath) return null;

  const np = editParentAtPath(
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

function removeCellWithFocus(
  path: CellPath,
  prefer: "prev" | "next"
): TransformResult {
  const np = editParentAtPath(
    path,
    ({ parentPath, before, index, valueCellUid }) => {
      const removed = before[index]!;
      const after = removeAt(before, index);
      getParentSignal(removed.value).value = undefined;

      if (after.length === 0) {
        return { after, valueCellUid, path: parentPath };
      }

      const prev = before[index - 1]?.uid;
      const next = before[index + 1]?.uid;

      const focusUid =
        prefer === "prev"
          ? prev ?? next ?? after[0]!.uid
          : next ?? prev ?? after[0]!.uid;

      return {
        after,
        valueCellUid,
        path: [...parentPath, focusUid],
      };
    }
  );

  return { path: np };
}

export function removeCellBackward(path: CellPath): TransformResult {
  return removeCellWithFocus(path, "prev");
}

export function removeCellForward(path: CellPath): TransformResult {
  return removeCellWithFocus(path, "next");
}

export function splitCell(
  path: CellPath,
  caretStart: number,
  caretEnd: number = caretStart
): CellPath {
  const sig = childSignalAtPath(path);
  if (!sig || !isWritableSignal(sig)) return path;

  const m = getRenderModel(sig);
  const text = m.kind === "scalar" ? m.text : "";

  const len = text.length;
  const start = Math.min(Math.max(caretStart, 0), len);
  const end = Math.min(Math.max(caretEnd, 0), len);

  const left = text.slice(0, start);
  const right = text.slice(end);

  batch(() => {
    setCellText(path, left);
    const next = insertCellAfter(path)!.path;
    setCellText(next, right);
    path = next;
  });

  return path;
}

export function mergeCellWithPrev(path: CellPath): TransformResult {
  const prev = siblingPath(path, -1);
  if (!prev) return null;

  if (getCellNavContext(prev).kind !== "text") return null;
  if (getCellNavContext(path).kind !== "text") return null;

  const prevSig = childSignalAtPath(prev);
  const curSig = childSignalAtPath(path);
  if (!prevSig || !curSig) return null;

  const pv = getRenderModel(prevSig);
  const cv = getRenderModel(curSig);

  const prevText = pv.kind === "scalar" ? pv.text : "";
  const curText = cv.kind === "scalar" ? cv.text : "";

  const caret = prevText.length;

  let nextPath = prev;
  batch(() => {
    setCellText(prev, prevText + curText);
    nextPath = removeCellBackward(path)?.path ?? prev;
  });

  return { path: nextPath, caret };
}

export function mergeCellWithNext(path: CellPath): TransformResult {
  const next = siblingPath(path, 1);
  if (!next) return null;

  if (getCellNavContext(next).kind !== "text") return null;
  if (getCellNavContext(path).kind !== "text") return null;

  const curSig = childSignalAtPath(path);
  const nextSig = childSignalAtPath(next);
  if (!curSig || !nextSig) return null;

  const cv = getRenderModel(curSig);
  const nv = getRenderModel(nextSig);

  const curText = cv.kind === "scalar" ? cv.text : "";
  const nextText = nv.kind === "scalar" ? nv.text : "";

  let nextPathOut = path;
  batch(() => {
    setCellText(path, curText + nextText);
    nextPathOut = removeCellBackward(next)?.path ?? path;
  });

  return { path: nextPathOut, caret: curText.length };
}
