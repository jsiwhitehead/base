import { Signal, effect } from "@preact/signals-core";

import {
  isBlock,
  insertEmptySiblingAfter,
  removeNodeAtElement,
  wrapNodeInBlock,
} from "./data";

export type DataBlock = {
  values: { [key: string]: DataNode };
  items: DataNode[];
};

export type DataNode = Signal<DataBlock | string>;

type NodeMeta = {
  parent: DataNode | null;
  context: Record<string, DataNode>;
};
export const nodeMeta = new WeakMap<DataNode, NodeMeta>();

type Mount = { el: HTMLElement; dispose: () => void };

type RegEntry = { mount: Mount; pending?: symbol };
const registry = new Map<DataNode, RegEntry>();

type ElInfo = {
  node: DataNode;
  setEditing?: (v: boolean, focus?: boolean) => void;
};
export const elInfo = new WeakMap<HTMLElement, ElInfo>();

export function render(data: DataNode, root: HTMLElement): () => void {
  nodeMeta.set(data, { parent: null, context: {} });

  const { el, dispose } = mountNode(data);
  root.appendChild(el);

  const arrowTarget = (a: HTMLElement, key: string): HTMLElement | null => {
    switch (key) {
      case "ArrowUp":
        return a.previousElementSibling as HTMLElement | null;
      case "ArrowDown":
        return a.nextElementSibling as HTMLElement | null;
      case "ArrowLeft":
        return a.parentElement !== root
          ? (a.parentElement as HTMLElement)
          : null;
      case "ArrowRight":
        return a.firstElementChild as HTMLElement | null;
      default:
        return null;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) return;
    if (active.tagName === "INPUT") return;

    const target = arrowTarget(active, e.key);
    if (target) {
      e.preventDefault();
      target.focus();
      return;
    }

    const info = elInfo.get(active);
    if (!info) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (info.setEditing) info.setEditing(true);
      else insertEmptySiblingAfter(active);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      removeNodeAtElement(active);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      wrapNodeInBlock(active);
      return;
    }
  };

  root.addEventListener("keydown", onKeyDown);

  return () => {
    dispose();
    root.removeEventListener("keydown", onKeyDown);
    root.textContent = "";
  };
}

function getOrCreateMountFor(node: DataNode): Mount {
  const entry = registry.get(node);
  if (entry) {
    entry.pending = undefined;
    return entry.mount;
  }
  const m = mountNode(node);
  registry.set(node, { mount: m });
  return m;
}

function detachWithNextTickGC(node: DataNode) {
  const entry = registry.get(node);
  if (!entry) return;

  entry.mount.el.remove();
  const token = Symbol("pending");
  entry.pending = token;

  queueMicrotask(() => {
    const current = registry.get(node);
    if (!current || current.pending !== token) return;
    current.mount.dispose();
    registry.delete(node);
  });
}

function mountNode(node: DataNode): Mount {
  let el!: HTMLElement;
  let mode: "block" | "value" | null = null;

  const attached = new Set<DataNode>();

  const clearChildren = () => {
    for (const sig of attached) {
      detachWithNextTickGC(sig);
    }
    attached.clear();
    el.textContent = "";
  };

  const replaceEl = (nextEl: HTMLElement, focus = false) => {
    nextEl.tabIndex = 0;
    if (el) el.replaceWith(nextEl);
    el = nextEl;
    const info: ElInfo = { node };
    if (mode === "value") info.setEditing = setEditing;
    elInfo.set(el, info);
    if (focus) el.focus();
  };

  const setEditing = (next: boolean, focus = true) => {
    const wantTag = next ? "input" : "p";
    const v = node.peek() as string;
    const nextEl = document.createElement(wantTag);

    if (wantTag === "input") {
      const input = nextEl as HTMLInputElement;
      input.value = v;
      input.addEventListener("input", () => {
        node.value = input.value;
      });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          insertEmptySiblingAfter(input);
          setEditing(false, false);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEditing(false);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          wrapNodeInBlock(input);
          return;
        }
      });
    } else {
      nextEl.textContent = v;
    }

    replaceEl(nextEl, focus);
  };

  const setMode = (next: "block" | "value") => {
    if (mode === next) return;
    if (mode === "block") clearChildren();
    mode = next;
    replaceEl(document.createElement(next === "block" ? "div" : "p"));
  };

  const stop = effect(() => {
    const v = node.value;
    if (isBlock(v)) {
      setMode("block");

      const meta = nodeMeta.get(node) ?? { parent: null, context: {} };
      const nextContext: Record<string, DataNode> = {
        ...meta.context,
        ...v.values,
      };

      const nextSet = new Set(v.items);

      for (const sig of [...attached]) {
        if (!nextSet.has(sig)) {
          detachWithNextTickGC(sig);
          attached.delete(sig);
        }
      }

      const frag = document.createDocumentFragment();
      for (const sig of v.items) {
        nodeMeta.set(sig, { parent: node, context: nextContext });
        const childMount = getOrCreateMountFor(sig);
        frag.appendChild(childMount.el);
        attached.add(sig);
      }
      el.appendChild(frag);
    } else {
      setMode("value");
      if (el.tagName === "INPUT") {
        (el as HTMLInputElement).value = v;
      } else {
        el.textContent = v;
      }
    }
  });

  const dispose = () => {
    stop();
    clearChildren();
    const entry = registry.get(node);
    if (entry?.mount === self) registry.delete(node);
  };

  const self: Mount = {
    get el() {
      return el;
    },
    dispose,
  };

  registry.set(node, { mount: self });
  return self;
}
