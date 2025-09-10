import { Signal, effect } from "@preact/signals-core";

import {
  isBlock,
  insertEmptyNodeBefore,
  insertEmptyNodeAfter,
  removeNodeAtElement,
  wrapNodeInBlock,
  unwrapNodeFromBlock,
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

type MountCache = { mount: Mount; pending?: symbol };
export const mountCache = new WeakMap<DataNode, MountCache>();

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

    if (e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      if (e.key === "ArrowUp") {
        insertEmptyNodeBefore(active);
      } else {
        insertEmptyNodeAfter(active);
      }
      return;
    }

    const info = elInfo.get(active);
    if (
      info?.setEditing &&
      e.key.length === 1 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      info.node.value = e.key;
      info.setEditing(true);
      return;
    }

    const target = arrowTarget(active, e.key);
    if (target) {
      e.preventDefault();
      target.focus();
      return;
    }

    if (!info) return;

    if (e.key === "Enter") {
      e.preventDefault();
      if (info.setEditing) info.setEditing(true);
      else {
        if (e.shiftKey) {
          insertEmptyNodeBefore(active);
        } else {
          insertEmptyNodeAfter(active);
        }
      }
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      removeNodeAtElement(active);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey) {
        unwrapNodeFromBlock(active);
      } else {
        wrapNodeInBlock(active);
      }
      return;
    }
  };

  root.addEventListener("keydown", onKeyDown);

  mountCache.get(data)!.mount.el.focus();

  return () => {
    dispose();
    root.removeEventListener("keydown", onKeyDown);
    root.textContent = "";
  };
}

function scheduleDisposeIfUnattached(node: DataNode) {
  const entry = mountCache.get(node);
  if (!entry) return;

  entry.mount.el.remove();
  const token = Symbol("pending");
  entry.pending = token;

  queueMicrotask(() => {
    const current = mountCache.get(node);
    if (!current || current.pending !== token) return;
    current.mount.dispose();
    mountCache.delete(node);
  });
}

function mountNode(node: DataNode): Mount {
  let el!: HTMLElement;
  let mode: "block" | "value" | null = null;

  const replaceEl = (nextEl: HTMLElement, focus = false) => {
    nextEl.tabIndex = 0;
    if (el) el.replaceWith(nextEl);
    el = nextEl;
    const info: ElInfo = { node };
    if (mode === "value") info.setEditing = setEditing;
    elInfo.set(el, info);
    if (focus) el.focus();
  };

  const attached = new Set<DataNode>();
  function pruneChildren(keep?: Set<DataNode>) {
    for (const sig of Array.from(attached)) {
      if (keep?.has(sig)) continue;
      const meta = nodeMeta.get(sig);
      if (meta?.parent === node) {
        scheduleDisposeIfUnattached(sig);
      }
      attached.delete(sig);
    }
  }

  const setMode = (next: "block" | "value") => {
    if (mode === next) return;
    if (mode === "block") {
      pruneChildren();
      el.textContent = "";
    }
    mode = next;
    replaceEl(document.createElement(next === "block" ? "div" : "p"));
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
          setEditing(false);
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
          if (e.shiftKey) {
            unwrapNodeFromBlock(input);
          } else {
            wrapNodeInBlock(input);
          }
          return;
        }
      });
    } else {
      nextEl.textContent = v;
    }

    replaceEl(nextEl, focus);
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
      pruneChildren(nextSet);

      const fragment = document.createDocumentFragment();
      for (const sig of v.items) {
        nodeMeta.set(sig, { parent: node, context: nextContext });
        let childMount: Mount;
        const existing = mountCache.get(sig);
        if (existing) {
          existing.pending = undefined;
          childMount = existing.mount;
        } else {
          childMount = mountNode(sig);
          mountCache.set(sig, { mount: childMount });
        }
        fragment.appendChild(childMount.el);
        attached.add(sig);
      }
      el.appendChild(fragment);
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
    pruneChildren();
    el.textContent = "";
    const entry = mountCache.get(node);
    if (entry?.mount === self) mountCache.delete(node);
  };

  const self: Mount = {
    get el() {
      return el;
    },
    dispose,
  };

  mountCache.set(node, { mount: self });
  return self;
}
