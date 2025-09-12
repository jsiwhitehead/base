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

type View<T> = {
  kind: "block" | "value";
  el: HTMLElement;
  sync(next: T): void;
  dispose(): void;
};

function createValueView(node: DataNode): View<string> {
  const editable = createEditable(
    node,
    "value",
    () => node.peek() as string,
    (next) => {
      node.value = next;
    }
  );

  return {
    kind: "value",
    get el() {
      return editable.el;
    },
    sync(text) {
      editable.sync(text);
    },
    dispose() {},
  };
}

function createBlockView(node: DataNode): View<DataBlock> {
  const root = document.createElement("div");
  root.classList.add("block");
  root.tabIndex = 0;
  elInfo.set(root, { node });

  const attached = new Set<DataNode>();
  const keyEditors = new Map<DataNode, Editable>();

  function ensureMount(child: DataNode, context: Record<string, DataNode>) {
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
  }

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

  function syncBlock(v: DataBlock) {
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

    const keepKeys = new Set(Object.values(v.values));
    for (const s of keyEditors.keys()) {
      if (!keepKeys.has(s)) keyEditors.delete(s);
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
              ([, c]) => c === sig
            )![0],
          (nextKey) => {
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

    root.replaceChildren(frag);
  }

  return {
    kind: "block",
    el: root,
    sync: syncBlock,
    dispose() {
      pruneChildren();
      root.textContent = "";
    },
  };
}

function mountNode(node: DataNode): Mount {
  let view: View<any>;

  const stop = effect(() => {
    const v = node.value;

    const wantKind: View<any>["kind"] = isBlock(v) ? "block" : "value";

    if (!view || wantKind !== view.kind) {
      view?.dispose();
      view =
        wantKind === "block" ? createBlockView(node) : createValueView(node);
    }

    view.sync(v);
  });

  const dispose = () => {
    stop();
    view.dispose();
    const entry = mountCache.get(node);
    if (entry?.mount === self) mountCache.delete(node);
  };

  const self: Mount = {
    get el() {
      return view.el;
    },
    dispose,
  };

  mountCache.set(node, { mount: self });
  return self;
}
