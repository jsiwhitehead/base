type DomPoint = { node: Node; offset: number };
type DomSelectionPoints = {
  anchor: DomPoint;
  focus: DomPoint;
  isCollapsed: boolean;
};
type MappedSelectionPoints<T> = {
  anchor: T;
  focus: T;
  isCollapsed: boolean;
};
type MappedRange<T> = { start: T; end: T };
type MappedSelectionRange<T> = { range: Range; start: T; end: T };
type MappedSelectionSnapshot<T> = { anchor: T; focus: T };
type CollapsedCaretRectInSurface = {
  rect: DOMRect;
  surfaceEl: HTMLElement;
};
export type SuppressionFlag<T> = {
  get: () => T;
  set: (next: T) => void;
  suppressForTurn: (next: T) => void;
};

const BLOCK_NEWLINE_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);
const CE_SENTINEL_DATA_KEY = "ceSentinel";
const CE_SENTINEL_VALUE = "1";

export function createSuppressionFlag<T>(initial: T): SuppressionFlag<T> {
  let value = initial;
  let token = 0;
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
    },
    suppressForTurn: (next: T) => {
      value = next;
      token += 1;
      const localToken = token;
      setTimeout(() => {
        if (token !== localToken) return;
        value = initial;
      }, 0);
    },
  };
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function isSentinelBreak(node: Node): boolean {
  return (
    node instanceof HTMLBRElement &&
    node.dataset[CE_SENTINEL_DATA_KEY] === CE_SENTINEL_VALUE
  );
}

function logicalLenOfTextNode(node: Text): number {
  return normalizeNewlines(node.data).length;
}

function logicalLenOfNode(node: Node): number {
  if (node instanceof Text) return logicalLenOfTextNode(node);
  if (node instanceof HTMLBRElement) return isSentinelBreak(node) ? 0 : 1;
  let out = 0;
  for (let i = 0; i < node.childNodes.length; i += 1) {
    const child = node.childNodes[i];
    if (!child) continue;
    out += logicalLenOfNode(child);
  }
  return out;
}

function nodeIndexInParent(node: Node): number {
  const parent = node.parentNode;
  if (!parent) return 0;
  for (let i = 0; i < parent.childNodes.length; i += 1) {
    if (parent.childNodes[i] === node) return i;
  }
  return 0;
}

function logicalPrefixLenBeforeNode(ancestor: Node, node: Node): number | null {
  if (ancestor === node) return 0;
  if (!ancestor.contains(node)) return null;

  let acc = 0;
  let cur: Node = node;
  while (cur !== ancestor) {
    const parent = cur.parentNode;
    if (!parent) return null;
    for (let i = 0; i < parent.childNodes.length; i += 1) {
      const sib = parent.childNodes[i];
      if (!sib) continue;
      if (sib === cur) break;
      acc += logicalLenOfNode(sib);
    }
    cur = parent;
  }
  return acc;
}

function rawOffsetForLogicalInText(
  text: string,
  logicalOffset: number,
): number {
  const target = Math.max(0, logicalOffset);
  let logical = 0;
  let raw = 0;
  while (raw < text.length) {
    if (logical >= target) return raw;
    const ch = text.charAt(raw);
    if (ch === "\r") {
      if (text.charAt(raw + 1) === "\n") raw += 2;
      else raw += 1;
      logical += 1;
      continue;
    }
    raw += 1;
    logical += 1;
  }
  return text.length;
}

export function renderPlainTextToContentEditable(
  surfaceEl: HTMLElement,
  text: string,
): void {
  const normalized = normalizeNewlines(text);
  const needsSentinel = normalized === "" || normalized.endsWith("\n");
  const hasSentinel =
    surfaceEl.lastChild instanceof HTMLBRElement &&
    surfaceEl.lastChild.dataset[CE_SENTINEL_DATA_KEY] === CE_SENTINEL_VALUE;
  if (
    readPlainTextFromContentEditable(surfaceEl) === normalized &&
    (!needsSentinel || hasSentinel)
  ) {
    return;
  }

  const lines = normalized.split("\n");
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line) frag.append(document.createTextNode(line));
    if (i < lines.length - 1) frag.append(document.createElement("br"));
  }
  if (needsSentinel) {
    const sentinel = document.createElement("br");
    sentinel.dataset[CE_SENTINEL_DATA_KEY] = CE_SENTINEL_VALUE;
    frag.append(sentinel);
  }
  surfaceEl.replaceChildren(frag);
}

export function readPlainTextFromContentEditable(
  surfaceEl: HTMLElement,
): string {
  let out = "";
  const walk = (node: Node): void => {
    if (node instanceof Text) {
      out += normalizeNewlines(node.data);
      return;
    }
    if (node instanceof HTMLBRElement) {
      if (node.dataset[CE_SENTINEL_DATA_KEY] === CE_SENTINEL_VALUE) return;
      out += "\n";
      return;
    }
    if (!(node instanceof HTMLElement)) return;

    const isBlock = BLOCK_NEWLINE_TAGS.has(node.tagName);
    for (let i = 0; i < node.childNodes.length; i += 1) {
      const child = node.childNodes[i];
      if (!child) continue;
      walk(child);
    }
    if (isBlock && !out.endsWith("\n")) out += "\n";
  };

  for (let i = 0; i < surfaceEl.childNodes.length; i += 1) {
    const child = surfaceEl.childNodes[i];
    if (!child) continue;
    walk(child);
  }
  const lastNode = surfaceEl.lastChild;
  if (
    out.endsWith("\n") &&
    lastNode instanceof HTMLElement &&
    BLOCK_NEWLINE_TAGS.has(lastNode.tagName)
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

export function getSurfaceFromNodeInRoot(
  rootEl: HTMLElement,
  node: Node,
  selector: string,
): HTMLElement | null {
  const elNode = node instanceof HTMLElement ? node : node.parentElement;
  const surfaceEl = elNode?.closest<HTMLElement>(selector) ?? null;
  if (!surfaceEl || !rootEl.contains(surfaceEl)) return null;
  return surfaceEl;
}

export function domPointToTextOffset(
  surfaceEl: HTMLElement,
  node: Node,
  offset: number,
): number | null {
  if (!(surfaceEl === node || surfaceEl.contains(node))) return null;

  const prefix = logicalPrefixLenBeforeNode(surfaceEl, node);
  if (prefix == null) return null;

  if (node instanceof Text) {
    const clamped = Math.max(0, Math.min(offset, node.length));
    return prefix + normalizeNewlines(node.data.slice(0, clamped)).length;
  }

  if (!(node instanceof Element || node instanceof DocumentFragment)) {
    return null;
  }

  const limit = Math.max(0, Math.min(offset, node.childNodes.length));
  let acc = prefix;
  for (let i = 0; i < limit; i += 1) {
    const child = node.childNodes[i];
    if (!child) continue;
    acc += logicalLenOfNode(child);
  }
  return acc;
}

export function textOffsetToDomPoint(
  surfaceEl: HTMLElement,
  charOffset: number,
): DomPoint {
  let remaining = Math.max(0, charOffset);

  const walker = document.createTreeWalker(
    surfaceEl,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node): number {
        if (node instanceof Text) return NodeFilter.FILTER_ACCEPT;
        if (node instanceof HTMLBRElement) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  let node: Node | null = walker.nextNode();
  while (node) {
    if (node instanceof Text) {
      const logicalLen = logicalLenOfTextNode(node);
      if (remaining <= logicalLen) {
        return {
          node,
          offset: rawOffsetForLogicalInText(node.data, remaining),
        };
      }
      remaining -= logicalLen;
      node = walker.nextNode();
      continue;
    }
    if (node instanceof HTMLBRElement) {
      if (isSentinelBreak(node)) {
        node = walker.nextNode();
        continue;
      }
      const parent = node.parentNode;
      if (!parent) {
        node = walker.nextNode();
        continue;
      }
      const idx = nodeIndexInParent(node);
      if (remaining === 0) return { node: parent, offset: idx };
      if (remaining === 1) return { node: parent, offset: idx + 1 };
      remaining -= 1;
    }
    node = walker.nextNode();
  }

  return { node: surfaceEl, offset: surfaceEl.childNodes.length };
}

export function setDomSelectionRange(
  anchor: DomPoint,
  focus?: DomPoint,
): boolean {
  const sel = window.getSelection();
  if (!sel) return false;
  const focusPoint = focus ?? anchor;
  sel.removeAllRanges();
  sel.setBaseAndExtent(
    anchor.node,
    anchor.offset,
    focusPoint.node,
    focusPoint.offset,
  );
  return true;
}

export function setDomCaret(point: DomPoint): boolean {
  return setDomSelectionRange(point, point);
}

export function setContentEditableCaret(
  surfaceEl: HTMLElement,
  offset: number,
): boolean {
  return setDomCaret(textOffsetToDomPoint(surfaceEl, offset));
}

export function getDomSelectionPointsInRoot(
  rootEl: HTMLElement,
): DomSelectionPoints | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const anchorNode = sel.anchorNode;
  const focusNode = sel.focusNode;
  if (!anchorNode || !focusNode) return null;
  if (!rootEl.contains(anchorNode) || !rootEl.contains(focusNode)) return null;
  return {
    anchor: { node: anchorNode, offset: sel.anchorOffset },
    focus: { node: focusNode, offset: sel.focusOffset },
    isCollapsed: sel.isCollapsed,
  };
}

export function getMappedSelectionPointsInRoot<T>(
  rootEl: HTMLElement,
  mapDomPoint: (point: DomPoint) => T | null,
): MappedSelectionPoints<T> | null {
  const domSel = getDomSelectionPointsInRoot(rootEl);
  if (!domSel) return null;
  const anchor = mapDomPoint(domSel.anchor);
  const focus = mapDomPoint(domSel.focus);
  if (!anchor || !focus) return null;
  return { anchor, focus, isCollapsed: domSel.isCollapsed };
}

export function getMappedSelectionSnapshotInRoot<T>(
  rootEl: HTMLElement,
  mapDomPoint: (point: DomPoint) => T | null,
): MappedSelectionSnapshot<T> | null {
  const mapped = getMappedSelectionPointsInRoot(rootEl, mapDomPoint);
  if (!mapped) return null;
  return { anchor: mapped.anchor, focus: mapped.focus };
}

export function getDomRangeInRoot(rootEl: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel?.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (
    !rootEl.contains(range.startContainer) ||
    !rootEl.contains(range.endContainer)
  )
    return null;
  return range;
}

export function getMappedSelectionRangeInRoot<T>(
  rootEl: HTMLElement,
  mapDomPoint: (point: DomPoint) => T | null,
): MappedSelectionRange<T> | null {
  const range = getDomRangeInRoot(rootEl);
  if (!range) return null;
  const mapped = getMappedRange(range, mapDomPoint);
  if (!mapped) return null;
  return { range, start: mapped.start, end: mapped.end };
}

export function getMappedRange<T>(
  range: AbstractRange,
  mapDomPoint: (point: DomPoint) => T | null,
): MappedRange<T> | null {
  const start = mapDomPoint({
    node: range.startContainer,
    offset: range.startOffset,
  });
  const end = mapDomPoint({
    node: range.endContainer,
    offset: range.endOffset,
  });
  if (!start || !end) return null;
  return { start, end };
}

export function getCollapsedCaretRectInSurface(
  rootEl: HTMLElement,
  surfaceEl: HTMLElement,
): CollapsedCaretRectInSurface | null {
  const range = getDomRangeInRoot(rootEl);
  if (!range?.collapsed) return null;
  if (
    !surfaceEl.contains(range.startContainer) &&
    range.startContainer !== surfaceEl
  ) {
    return null;
  }
  const rect =
    range.getClientRects()[0] ??
    range.getBoundingClientRect() ??
    surfaceEl.getBoundingClientRect();
  return rect ? { rect, surfaceEl } : null;
}

export function getTextNodeFromMutationRecord(
  mutation: MutationRecord,
): Text | null {
  if (
    mutation.type === "characterData" &&
    mutation.target.nodeType === Node.TEXT_NODE
  ) {
    return mutation.target as Text;
  }
  if (mutation.type !== "childList") return null;
  for (const node of mutation.addedNodes) {
    if (node instanceof HTMLBRElement) continue;
    if (node.nodeType === Node.TEXT_NODE) return node as Text;
  }
  return null;
}

export function getTextSurfaceLineRects(surfaceEl: HTMLElement): DOMRect[] {
  const range = document.createRange();
  range.selectNodeContents(surfaceEl);
  const rects = [...range.getClientRects()].filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) return rects;
  const fallback = range.getBoundingClientRect();
  return fallback.width > 0 || fallback.height > 0 ? [fallback] : [];
}

export function getDomPointFromViewport(
  rootEl: HTMLElement,
  x: number,
  y: number,
): DomPoint | null {
  const doc = rootEl.ownerDocument as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos?.offsetNode) return { node: pos.offsetNode, offset: pos.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

export function getPlainTextFromDataTransfer(
  dt: DataTransfer | null | undefined,
): string {
  return dt?.getData("text/plain") ?? "";
}

export function writePlainTextClipboard(
  e: ClipboardEvent,
  text: string,
): boolean {
  const dt = e.clipboardData;
  if (!dt) return false;
  dt.setData("text/plain", text);
  return true;
}
