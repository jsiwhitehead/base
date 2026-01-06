import { batch } from "@preact/signals-core";

import {
  type GroupContent,
  type TemplateContent,
  type SetSignal,
  type ItemContentSignal,
  type Item,
  type NavLayoutContext,
  isSetSignal,
  getParentSignal,
  getParent,
  newUid,
  createBlank,
  createGroup,
  createDerived,
  createSignal,
  getViewModel,
  getViewChildren,
  getViewInputs,
  updateParentGroup,
  parseScalarInput,
  getLayoutContext,
} from "./model";

/* Root */

let __modelRoot: ItemContentSignal | null = null;

export function setModelRoot(root: ItemContentSignal) {
  __modelRoot = root;
}

export function getModelRoot(): ItemContentSignal {
  if (!__modelRoot) throw new Error("Model root not set");
  return __modelRoot;
}

/* Navigation */

export type ItemPath = number[];

function itemsAlongPath(path: ItemPath): Item[] {
  const items: Item[] = [];
  let content: ItemContentSignal = getModelRoot();

  for (const uid of path) {
    const kids = getViewChildren(content);
    const item = kids.find((c) => c.uid === uid);
    if (!item) return [];
    items.push(item);
    content = item.content;
  }

  return items;
}

function childSignalAtPath(path: ItemPath): ItemContentSignal | null {
  if (path.length === 0) return getModelRoot();
  const items = itemsAlongPath(path);
  const last = items[items.length - 1];
  return last ? last.content : null;
}

function childrenAtPath(path: ItemPath): Item[] | null {
  const content = childSignalAtPath(path);
  if (!content) return null;
  return getViewChildren(content);
}

export function parentPath(path: ItemPath): ItemPath | null {
  return path.length ? path.slice(0, -1) : null;
}

export function firstChildPath(path: ItemPath): ItemPath | null {
  const kids = childrenAtPath(path);
  const first = kids?.[0];
  return first ? [...path, first.uid] : null;
}

export function siblingPath(path: ItemPath, dir: -1 | 1): ItemPath | null {
  if (path.length === 0) return null;

  const pp = parentPath(path);
  if (!pp) return null;

  const kids = childrenAtPath(pp);
  if (!kids) return null;

  const uid = path[path.length - 1]!;
  const i = kids.findIndex((e) => e.uid === uid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= kids.length) return null;

  return [...pp, kids[j]!.uid];
}

type ItemUpdateKind = "text" | "text-get-only" | "group";

type ItemNavContext = {
  kind: ItemUpdateKind | null;
  viewContext: NavLayoutContext;
  hasExtraHeaderInputs: boolean;
};

export function getItemNavContext(path: ItemPath): ItemNavContext {
  const items = itemsAlongPath(path);

  const item = items[items.length - 1];
  const parentItem = items[items.length - 2];
  const grandparentItem = items[items.length - 3];

  let kind: ItemUpdateKind | null = null;
  let hasExtraHeaderInputs = false;

  if (item) {
    const m = getViewModel(item.content);
    if (m.kind === "group") kind = "group";
    else kind = m.settable ? "text" : "text-get-only";

    hasExtraHeaderInputs = getViewInputs(item).some(
      (f) => f.get.value !== null
    );
  }

  const viewContext = getLayoutContext(parentItem, grandparentItem);
  return { kind, viewContext, hasExtraHeaderInputs };
}

function isNavStop(item: Item | null, content: ItemContentSignal): boolean {
  const kids = getViewChildren(content);
  if (kids.length === 0) return true;
  if (!item) return false;
  return getViewInputs(item).some((f) => f.get.value !== null);
}

function collectNavStops(): ItemPath[] {
  const result: ItemPath[] = [];

  function walk(
    path: ItemPath,
    content: ItemContentSignal,
    item: Item | null
  ): void {
    if (isNavStop(item, content)) {
      result.push(path);
    }

    for (const c of getViewChildren(content)) {
      walk([...path, c.uid], c.content, c);
    }
  }

  walk([], getModelRoot(), null);
  return result;
}

function neighborNavStop(
  from: ItemPath,
  dir: -1 | 1,
  blockPrefix?: ItemPath
): ItemPath | null {
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

function tableVerticalMove(from: ItemPath, dir: -1 | 1): ItemPath | null {
  if (from.length < 2) return null;

  const rowPath = parentPath(from);
  const nextRowPath = rowPath && siblingPath(rowPath, dir);
  if (!rowPath || !nextRowPath) return null;

  const rowItems = childrenAtPath(rowPath);
  const nextRowItems = childrenAtPath(nextRowPath);
  if (!rowItems || !nextRowItems) return null;

  const uid = from[from.length - 1]!;
  const colIndex = rowItems.findIndex((c) => c.uid === uid);
  if (colIndex === -1) return null;

  const colName = rowItems[colIndex]!.name.peek();
  if (!colName) return null;

  const target = nextRowItems.find((c) => c.name.peek() === colName);
  return target ? [...nextRowPath, target.uid] : null;
}

export function standardMove(
  path: ItemPath,
  dir: "left" | "right" | "up" | "down",
  mod: boolean
): ItemPath | null {
  const { kind, viewContext } = getItemNavContext(path);

  if (dir === "left" || dir === "right") {
    const sign: -1 | 1 = dir === "left" ? -1 : 1;

    if (mod && (viewContext === "table-cell" || viewContext === "bar-child")) {
      if (sign === -1) {
        const left = siblingPath(path, -1);
        return left ?? parentPath(path);
      }
      return siblingPath(path, 1);
    }

    if (sign === -1 && (kind === "group" || mod)) {
      const p = parentPath(path);
      if (p && p.length) return p;
    }

    if (sign === 1) {
      const node = childSignalAtPath(path) ?? getModelRoot();
      if (getViewChildren(node).length) {
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

  if (mod || kind === "group") {
    return siblingPath(path, sign);
  }

  const target = neighborNavStop(path, sign);
  if (!target) return null;

  const { viewContext: targetView } = getItemNavContext(target);
  if (targetView === "table-cell" || targetView === "bar-child") {
    const rowPath = parentPath(target);
    const rowItems = rowPath && childrenAtPath(rowPath);
    const first = rowItems?.[0];
    if (!rowPath || !first) return target;
    return [...rowPath, first.uid];
  }

  return target;
}

/* Updates */

export type UpdateResult = { path: ItemPath; caret?: number } | null;

export function updateItemText(path: ItemPath, raw: string): ItemPath {
  const sig = childSignalAtPath(path);
  if (!sig || !isSetSignal(sig)) return path;

  sig.set(parseScalarInput(raw));
  return path;
}

export function setItemAsDerived(path: ItemPath): UpdateResult {
  const sig = childSignalAtPath(path);
  if (!sig || !isSetSignal(sig)) return null;

  sig.set(createDerived(sig, ""));
  return { path, caret: 0 };
}

function updateParentAtPath(
  path: ItemPath,
  fn: (ctx: {
    parent: SetSignal<GroupContent | TemplateContent<GroupContent>>;
    parentPath: ItemPath;
    before: Item[];
    index: number;
    contentItemUid?: number;
    params?: string[];
    child: ItemContentSignal;
    uid: number;
  }) => { after: Item[]; contentItemUid?: number; path: ItemPath }
): ItemPath {
  if (path.length === 0) return path;

  const child = childSignalAtPath(path);
  if (!child) return path;

  const uid = path[path.length - 1]!;
  const parentPath = path.slice(0, -1);

  let nextPath = path;

  const out = updateParentGroup(
    child,
    uid,
    ({ parent, before, index, contentItemUid, params }) => {
      const r = fn({
        parent,
        parentPath,
        before,
        index,
        contentItemUid,
        params,
        child,
        uid,
      });
      nextPath = r.path;
      return { after: r.after, contentItemUid: r.contentItemUid };
    }
  );

  return out ? nextPath : path;
}

function makeBlankItem(content: ItemContentSignal): Item {
  return {
    uid: newUid(),
    name: createSignal(""),
    view: createSignal(""),
    content,
  };
}

function insertAt(items: Item[], i: number, item: Item): Item[] {
  return [...items.slice(0, i), item, ...items.slice(i)];
}

function replaceAt(items: Item[], i: number, item: Item): Item[] {
  return [...items.slice(0, i), item, ...items.slice(i + 1)];
}

function removeAt(items: Item[], i: number): Item[] {
  return [...items.slice(0, i), ...items.slice(i + 1)];
}

export function addItemBefore(path: ItemPath): UpdateResult {
  const np = updateParentAtPath(
    path,
    ({ parent, parentPath, before, index }) => {
      const content = createSignal(createBlank());
      getParentSignal(content).value = parent;

      const item = makeBlankItem(content);
      const after = insertAt(before, index, item);
      return { after, path: [...parentPath, item.uid] };
    }
  );

  return { path: np };
}

export function addItemAfter(path: ItemPath): UpdateResult {
  const np = updateParentAtPath(
    path,
    ({ parent, parentPath, before, index }) => {
      const content = createSignal(createBlank());
      getParentSignal(content).value = parent;

      const item = makeBlankItem(content);
      const after = insertAt(before, index + 1, item);
      return { after, path: [...parentPath, item.uid] };
    }
  );

  return { path: np };
}

export function groupItem(path: ItemPath): UpdateResult {
  const np = updateParentAtPath(
    path,
    ({ parent, parentPath, before, index, child }) => {
      const oldItem = before[index]!;
      const wrapperUid = newUid();

      const outerNameSig = oldItem.name;
      oldItem.name = createSignal("");

      const wrapperSig = createSignal(createGroup([oldItem]));
      getParentSignal(wrapperSig).value = parent;
      getParentSignal(child).value = wrapperSig;

      const wrapperItem: Item = {
        uid: wrapperUid,
        name: outerNameSig,
        view: createSignal(""),
        content: wrapperSig,
      };

      return {
        after: replaceAt(before, index, wrapperItem),
        path: [...parentPath, wrapperUid, oldItem.uid],
      };
    }
  );

  return { path: np };
}

export function ungroupItem(path: ItemPath): UpdateResult {
  const innerChild = childSignalAtPath(path);
  if (!innerChild) return null;

  const wrapperSig = getParent(innerChild);
  if (!wrapperSig) return null;

  const items = getViewChildren(wrapperSig);
  if (items.length !== 1) return null;

  const pPath = parentPath(path);
  if (!pPath) return null;

  const np = updateParentAtPath(
    pPath,
    ({ parent: grandparent, parentPath: gpPath, before, index }) => {
      const innerItem = items[0]!;
      innerItem.name = before[index]!.name;

      getParentSignal(innerChild).value = grandparent;
      getParentSignal(wrapperSig).value = undefined;

      return {
        after: replaceAt(before, index, innerItem),
        path: [...gpPath, innerItem.uid],
      };
    }
  );

  return { path: np };
}

function removeItemDir(path: ItemPath, prefer: "prev" | "next"): UpdateResult {
  const np = updateParentAtPath(
    path,
    ({ parentPath, before, index, contentItemUid }) => {
      const removed = before[index]!;
      const after = removeAt(before, index);
      getParentSignal(removed.content).value = undefined;

      if (after.length === 0) {
        return { after, contentItemUid, path: parentPath };
      }

      const prev = before[index - 1]?.uid;
      const next = before[index + 1]?.uid;

      const focusUid =
        prefer === "prev"
          ? prev ?? next ?? after[0]!.uid
          : next ?? prev ?? after[0]!.uid;

      return {
        after,
        contentItemUid,
        path: [...parentPath, focusUid],
      };
    }
  );

  return { path: np };
}

export function removeItemBackward(path: ItemPath): UpdateResult {
  return removeItemDir(path, "prev");
}

export function removeItemForward(path: ItemPath): UpdateResult {
  return removeItemDir(path, "next");
}

export function splitItemAt(
  path: ItemPath,
  caretStart: number,
  caretEnd: number = caretStart
): ItemPath {
  const sig = childSignalAtPath(path);
  if (!sig || !isSetSignal(sig)) return path;

  const m = getViewModel(sig);
  const text = m.kind === "scalar" ? m.text : "";

  const len = text.length;
  const start = Math.min(Math.max(caretStart, 0), len);
  const end = Math.min(Math.max(caretEnd, 0), len);

  const left = text.slice(0, start);
  const right = text.slice(end);

  batch(() => {
    updateItemText(path, left);
    const next = addItemAfter(path)!.path;
    updateItemText(next, right);
    path = next;
  });

  return path;
}

export function joinWithBefore(path: ItemPath): UpdateResult {
  const prev = siblingPath(path, -1);
  if (!prev) return null;

  if (getItemNavContext(prev).kind !== "text") return null;
  if (getItemNavContext(path).kind !== "text") return null;

  const prevSig = childSignalAtPath(prev);
  const curSig = childSignalAtPath(path);
  if (!prevSig || !curSig) return null;

  const pv = getViewModel(prevSig);
  const cv = getViewModel(curSig);

  const prevText = pv.kind === "scalar" ? pv.text : "";
  const curText = cv.kind === "scalar" ? cv.text : "";

  const caret = prevText.length;

  let nextPath = prev;
  batch(() => {
    updateItemText(prev, prevText + curText);
    nextPath = removeItemBackward(path)?.path ?? prev;
  });

  return { path: nextPath, caret };
}

export function joinWithAfter(path: ItemPath): UpdateResult {
  const next = siblingPath(path, 1);
  if (!next) return null;

  if (getItemNavContext(next).kind !== "text") return null;
  if (getItemNavContext(path).kind !== "text") return null;

  const curSig = childSignalAtPath(path);
  const nextSig = childSignalAtPath(next);
  if (!curSig || !nextSig) return null;

  const cv = getViewModel(curSig);
  const nv = getViewModel(nextSig);

  const curText = cv.kind === "scalar" ? cv.text : "";
  const nextText = nv.kind === "scalar" ? nv.text : "";

  let nextPathOut = path;
  batch(() => {
    updateItemText(path, curText + nextText);
    nextPathOut = removeItemBackward(next)?.path ?? path;
  });

  return { path: nextPathOut, caret: curText.length };
}
