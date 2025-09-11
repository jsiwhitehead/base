import { effect } from "@preact/signals-core";

import type { DataBlock, DataNode } from "./data";
import { isBlock, renameChildKey } from "./data";
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

type Editable = {
  el: HTMLElement;
  sync: (text: string) => void;
};

function createEditable(
  node: DataNode,
  type: "value" | "key",
  getText: () => string,
  commitText: (next: string) => void
): Editable {
  let el!: HTMLElement;

  function renderStatic(focusAfter?: boolean) {
    const prev = el;
    const next = document.createElement("div");
    next.classList.add(type);
    next.tabIndex = 0;
    next.textContent = getText() + (type === "key" ? " :" : "");
    elInfo.set(next, { node, setEditing });

    if (prev) prev.replaceWith(next);
    if (focusAfter) next.focus();
    el = next;
    return next;
  }

  const setEditing = (next: boolean, focus = true) => {
    if (next) {
      const input = document.createElement("input");
      input.classList.add(type);
      input.value = getText();
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
        if (!canceled) commitText(input.value);
        renderStatic(focusAfter);
      });

      elInfo.set(input, { node, setEditing });
      const prev = el;
      if (prev && prev.isConnected) prev.replaceWith(input);
      if (focus) input.focus();
      el = input;
    } else {
      renderStatic(focus);
    }
  };

  const sync: Editable["sync"] = (text) => {
    if (el.tagName === "INPUT") {
      (el as HTMLInputElement).value = text;
    } else {
      el.textContent = text + (type === "key" ? " :" : "");
    }
  };

  const api: Editable = {
    get el() {
      return el;
    },
    sync,
  };

  el = renderStatic();
  return api;
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
    elInfo.set(el, { node });
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

  let valueEditable: Editable | null = null;

  const ensureValueEditable = () => {
    if (valueEditable) return valueEditable;
    const editable = createEditable(
      node,
      "value",
      () => (node.peek() as string) ?? "",
      (nextVal) => {
        node.value = nextVal;
      }
    );
    valueEditable = editable;
    return editable;
  };

  const keyEditors = new Map<DataNode, Editable>();

  const stop = effect(() => {
    const v = node.value;
    if (isBlock(v)) {
      setMode("block");

      const meta = nodeMeta.get(node) ?? { parent: null, context: {} };
      const nextContext: Record<string, DataNode> = {
        ...meta.context,
        ...v.values,
      };

      const keepChildren = new Set<DataNode>([
        ...Object.values(v.values),
        ...v.items,
      ]);
      pruneChildren(keepChildren);
      const keep = new Set(Object.values(v.values));
      for (const sig of keyEditors.keys()) {
        if (!keep.has(sig)) keyEditors.delete(sig);
      }

      const frag = document.createDocumentFragment();
      for (const [key, sig] of Object.entries(v.values)) {
        let ed = keyEditors.get(sig);
        if (!ed) {
          ed = createEditable(
            sig,
            "key",
            () =>
              Object.entries((node.peek() as DataBlock).values).find(
                ([, child]) => child === sig
              )?.[0]!,
            (nextKey: string) => {
              node.value = renameChildKey(node, sig, nextKey.trim());
            }
          );
          keyEditors.set(sig, ed);
        }
        ed.sync(key);

        frag.append(ed.el, ensureMount(sig, nextContext));
      }
      for (const sig of v.items) {
        frag.append(ensureMount(sig, nextContext));
      }
      el.replaceChildren(frag);
      valueEditable = null;
    } else {
      setMode("value");
      ensureValueEditable().sync(v);
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
      return valueEditable?.el || el;
    },
    dispose,
  };

  mountCache.set(node, { mount: self });
  return self;
}
