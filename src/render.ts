import { effect } from "@preact/signals-core";

import type { DataBlock, DataNode } from "./data";
import { isBlock, renameChildKey } from "./data";
import {
  handleRootMouseDown,
  handleRootDblClick,
  handleRootKeyDown,
} from "./input";

type NodeContext = {
  parent: DataNode | null;
  context: Record<string, DataNode>;
};
export const nodeToContext = new WeakMap<DataNode, NodeContext>();

type Mount = { el: HTMLElement; dispose: () => void };

type MountCache = { mount: Mount };
export const nodeToMount = new WeakMap<DataNode, MountCache>();

type ElementContext = {
  node: DataNode;
  setEditing?: (v: boolean, focus?: boolean) => void;
};
export const elementToNode = new WeakMap<HTMLElement, ElementContext>();

export function render(data: DataNode, root: HTMLElement): () => void {
  nodeToContext.set(data, { parent: null, context: {} });

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
  fieldType: "value" | "key",
  getText: () => string,
  commitText: (text: string) => void
): Editable {
  let el!: HTMLElement;

  function replaceEl(tag: "div" | "input") {
    const next = document.createElement(tag) as HTMLElement;
    next.classList.add(fieldType);
    next.tabIndex = 0;
    elementToNode.set(next, { node, setEditing });

    if (tag === "input") {
      (next as HTMLInputElement).value = getText();
    } else {
      (next as HTMLElement).textContent =
        getText() + (fieldType === "key" ? " :" : "");
    }

    if (el) el.replaceWith(next);
    el = next;
  }

  const setEditing = (isEditing: boolean, focus = true) => {
    if (isEditing) {
      replaceEl("input");
      const input = el as HTMLInputElement;

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
        replaceEl("div");
        if (focusAfter) el.focus();
      });

      if (focus) input.focus();
    } else {
      replaceEl("div");
      if (focus) el.focus();
    }
  };

  const sync: Editable["sync"] = (text) => {
    if (el.tagName === "INPUT") {
      (el as HTMLInputElement).value = text;
    } else {
      el.textContent = getText() + (fieldType === "key" ? " :" : "");
    }
  };

  const api: Editable = {
    get el() {
      return el;
    },
    sync,
  };

  replaceEl("div");
  return api;
}

function scheduleDisposeIfUnattached(node: DataNode) {
  const entry = nodeToMount.get(node);
  if (!entry) return;

  entry.mount.el.remove();

  queueMicrotask(() => {
    const current = nodeToMount.get(node);
    if (!current) return;
    if (!current.mount.el.isConnected) {
      current.mount.dispose();
      nodeToMount.delete(node);
    }
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
  elementToNode.set(root, { node });

  const attachedChildren = new Set<DataNode>();
  const keyEditors = new Map<DataNode, Editable>();

  function ensureMounted(child: DataNode, context: Record<string, DataNode>) {
    nodeToContext.set(child, { parent: node, context });
    attachedChildren.add(child);

    const existing = nodeToMount.get(child);
    if (existing) return existing.mount.el;

    const mount = mountNode(child);
    nodeToMount.set(child, { mount });
    return mount.el;
  }

  function pruneChildren(keep?: Set<DataNode>) {
    for (const childNode of Array.from(attachedChildren)) {
      if (keep?.has(childNode)) continue;
      const meta = nodeToContext.get(childNode);
      if (meta?.parent === node) {
        scheduleDisposeIfUnattached(childNode);
      }
      attachedChildren.delete(childNode);
    }
  }

  function syncBlock(v: DataBlock) {
    const meta = nodeToContext.get(node) ?? { parent: null, context: {} };
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

    for (const [key, childNode] of Object.entries(v.values)) {
      let ed = keyEditors.get(childNode);
      if (!ed) {
        ed = createEditable(
          childNode,
          "key",
          () =>
            Object.entries((node.peek() as DataBlock).values).find(
              ([, c]) => c === childNode
            )![0],
          (nextKey) => {
            node.value = renameChildKey(node, childNode, nextKey.trim());
          }
        );
        keyEditors.set(childNode, ed);
      }
      ed.sync(key);
      frag.append(ed.el, ensureMounted(childNode, nextContext));
    }

    for (const childNode of v.items) {
      frag.append(ensureMounted(childNode, nextContext));
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

    const nextKind: View<any>["kind"] = isBlock(v) ? "block" : "value";

    if (!view || nextKind !== view.kind) {
      view?.dispose();
      view =
        nextKind === "block" ? createBlockView(node) : createValueView(node);
    }

    view.sync(v);
  });

  const dispose = () => {
    stop();
    view.dispose();
    const entry = nodeToMount.get(node);
    if (entry?.mount === self) nodeToMount.delete(node);
  };

  const self: Mount = {
    get el() {
      return view.el;
    },
    dispose,
  };

  nodeToMount.set(node, { mount: self });
  return self;
}
