import { effect } from "@preact/signals-core";

import type { Block, Node } from "./data";
import { isBlock, renameChildKey } from "./data";
import { onRootMouseDown, onRootDblClick, onRootKeyDown } from "./input";

type NodeContext = {
  parent: Node | null;
  scope: Record<string, Node>;
};
export const contextByNode = new WeakMap<Node, NodeContext>();

type MountInstance = { element: HTMLElement; dispose: () => void };
export const mountByNode = new WeakMap<Node, MountInstance>();

type NodeBinding = {
  node: Node;
  setEditing?: (v: boolean, focus?: boolean) => void;
};
export const bindingByElement = new WeakMap<HTMLElement, NodeBinding>();

export function render(data: Node, rootElement: HTMLElement): () => void {
  contextByNode.set(data, { parent: null, scope: {} });

  const { element, dispose } = mountNode(data);
  rootElement.appendChild(element);
  element.focus();

  rootElement.addEventListener("mousedown", onRootMouseDown);
  rootElement.addEventListener("dblclick", onRootDblClick);

  const onKeyDown = (e: KeyboardEvent) => onRootKeyDown(e, rootElement);
  rootElement.addEventListener("keydown", onKeyDown);

  return () => {
    dispose();
    rootElement.removeEventListener("mousedown", onRootMouseDown);
    rootElement.removeEventListener("dblclick", onRootDblClick);
    rootElement.removeEventListener("keydown", onKeyDown);
    rootElement.textContent = "";
  };
}

type InlineEditor = {
  element: HTMLElement;
  update: (text: string) => void;
  setEditing: (isEditing: boolean, focus?: boolean) => void;
};

function createEditor(
  node: Node,
  fieldType: "value" | "key",
  readText: () => string,
  applyText: (text: string) => void
): InlineEditor {
  let element!: HTMLElement;

  function replaceElement(tag: "div" | "input") {
    const next = document.createElement(tag) as HTMLElement;
    next.classList.add(fieldType);
    next.tabIndex = 0;
    bindingByElement.set(next, { node, setEditing });

    if (tag === "input") {
      (next as HTMLInputElement).value = readText();
    } else {
      (next as HTMLElement).textContent =
        readText() + (fieldType === "key" ? " :" : "");
    }

    if (element) element.replaceWith(next);
    element = next;
  }

  const setEditing = (isEditing: boolean, focus = true) => {
    if (isEditing) {
      replaceElement("input");

      let canceled = false;
      let focusAfter = false;

      element.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          canceled = e.key === "Escape";
          focusAfter = true;
          element.blur();
        }
      });

      element.addEventListener("blur", () => {
        if (!canceled) applyText((element as HTMLInputElement).value);
        replaceElement("div");
        if (focusAfter) element.focus();
      });

      if (focus) element.focus();
    } else {
      replaceElement("div");
      if (focus) element.focus();
    }
  };

  const update: InlineEditor["update"] = (text) => {
    if (element.tagName === "INPUT") {
      (element as HTMLInputElement).value = text;
    } else {
      element.textContent = readText() + (fieldType === "key" ? " :" : "");
    }
  };

  const instance: InlineEditor = {
    get element() {
      return element;
    },
    update,
    setEditing,
  };

  replaceElement("div");
  return instance;
}

function scheduleUnmountIfDetached(node: Node) {
  const entry = mountByNode.get(node);
  if (!entry) return;

  entry.element.remove();

  queueMicrotask(() => {
    const current = mountByNode.get(node);
    if (!current) return;
    if (!current.element.isConnected) {
      current.dispose();
      mountByNode.delete(node);
    }
  });
}

type NodeView<T> = {
  kind: "block" | "value";
  element: HTMLElement;
  update(next: T): void;
  dispose(): void;
};

function createValueView(node: Node): NodeView<string> {
  const editor = createEditor(
    node,
    "value",
    () => node.peek() as string,
    (next) => {
      node.value = next;
    }
  );

  return {
    kind: "value",
    get element() {
      return editor.element;
    },
    update(text) {
      editor.update(text);
    },
    dispose() {},
  };
}

function createBlockView(node: Node): NodeView<Block> {
  const container = document.createElement("div");
  container.classList.add("block");
  container.tabIndex = 0;
  bindingByElement.set(container, { node });

  const attachedChildren = new Set<Node>();
  const keyEditors = new Map<Node, InlineEditor>();

  function ensureMounted(child: Node, scope: Record<string, Node>) {
    contextByNode.set(child, { parent: node, scope });
    attachedChildren.add(child);

    const existing = mountByNode.get(child);
    if (existing) return existing.element;

    const mount = mountNode(child);
    mountByNode.set(child, mount);
    return mount.element;
  }

  function pruneChildren(keep?: Set<Node>) {
    for (const childNode of Array.from(attachedChildren)) {
      if (keep?.has(childNode)) continue;
      const context = contextByNode.get(childNode);
      if (context?.parent === node) {
        scheduleUnmountIfDetached(childNode);
      }
      attachedChildren.delete(childNode);
    }
  }

  function updateBlock(v: Block) {
    const context = contextByNode.get(node)!;
    const nextScope: Record<string, Node> = {
      ...context.scope,
      ...v.values,
    };

    const keepChildren = new Set<Node>([
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
      let editor = keyEditors.get(childNode);
      if (!editor) {
        editor = createEditor(
          childNode,
          "key",
          () =>
            Object.entries((node.peek() as Block).values).find(
              ([, c]) => c === childNode
            )![0],
          (nextKey) => {
            node.value = renameChildKey(node, childNode, nextKey.trim());
          }
        );
        keyEditors.set(childNode, editor);
      }
      editor.update(key);
      frag.append(editor.element, ensureMounted(childNode, nextScope));
    }

    for (const childNode of v.items) {
      frag.append(ensureMounted(childNode, nextScope));
    }

    container.replaceChildren(frag);
  }

  return {
    kind: "block",
    element: container,
    update: updateBlock,
    dispose() {
      pruneChildren();
      container.textContent = "";
    },
  };
}

function mountNode(node: Node): MountInstance {
  let view: NodeView<Block | string>;

  const stop = effect(() => {
    const v = node.value;

    const nextKind = isBlock(v) ? "block" : "value";

    if (!view || nextKind !== view.kind) {
      view?.dispose();
      view =
        nextKind === "block" ? createBlockView(node) : createValueView(node);
    }

    view.update(v);
  });

  const dispose = () => {
    stop();
    view.dispose();
    const entry = mountByNode.get(node);
    if (entry === instance) mountByNode.delete(node);
  };

  const instance: MountInstance = {
    get element() {
      return view.element;
    },
    dispose,
  };

  mountByNode.set(node, instance);
  return instance;
}
