import { effect } from "@preact/signals-core";

import type { DataNode } from "./data";
import { isBlock } from "./data";
import {
  handleRootMouseDown,
  handleRootDblClick,
  handleRootKeyDown,
} from "./input";

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
  el.focus();

  root.addEventListener("mousedown", handleRootMouseDown);
  root.addEventListener("dblclick", handleRootDblClick);

  const onKeyDown = (e: KeyboardEvent) => handleRootKeyDown(e, root);
  root.addEventListener("keydown", onKeyDown);

  return () => {
    dispose();
    root.removeEventListener("mousedown", handleRootMouseDown);
    root.removeEventListener("dblclick", handleRootDblClick);
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

  const ensureMount = (
    child: DataNode,
    context: Record<string, DataNode>
  ): HTMLElement => {
    nodeMeta.set(child, { parent: node, context });
    attached.add(child);

    const existing = mountCache.get(child);
    if (existing) {
      existing.pending = undefined;
      return existing.mount.el;
    }

    const mount = mountNode(child);
    mountCache.set(child, { mount });
    return mount.el;
  };

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
    replaceEl(document.createElement("div"));
    el.classList.add(next);
  };

  const setEditing = (next: boolean, focus = true) => {
    const wantTag = next ? "input" : "div";
    const v = node.peek() as string;
    const nextEl = document.createElement(wantTag);
    nextEl.classList.add("value");

    if (wantTag === "input") {
      const input = nextEl as HTMLInputElement;
      input.value = v;
      let canceled = false;
      let focusAfter = false;
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          canceled = e.key === "Escape";
          focusAfter = true;
          input.blur();
        }
      });
      input.addEventListener("blur", () => {
        if (!canceled) node.value = input.value;
        setEditing(false, focusAfter);
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

      const nextSet = new Set<DataNode>([
        ...Object.values(v.values),
        ...v.items,
      ]);
      pruneChildren(nextSet);

      const frag = document.createDocumentFragment();
      for (const [key, sig] of Object.entries(v.values)) {
        const labelDiv = document.createElement("span");
        labelDiv.classList.add("key");
        labelDiv.textContent = key + " :";
        frag.append(labelDiv, ensureMount(sig, nextContext));
      }
      for (const sig of v.items) {
        frag.append(ensureMount(sig, nextContext));
      }
      el.replaceChildren(frag);
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
