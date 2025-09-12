import { effect } from "@preact/signals-core";

import type { Block, Node } from "./data";
import { isBlock, renameChildKey } from "./data";
import { onRootMouseDown, onRootDblClick, onRootKeyDown } from "./input";

type NodeContext = {
  parent: Node | null;
  scope: Record<string, Node>;
};
export const contextByNode = new WeakMap<Node, NodeContext>();

export const mountByNode = new WeakMap<Node, NodeMount>();

type NodeBinding = {
  node: Node;
  setEditing?: (v: boolean, focus?: boolean) => void;
};
export const bindingByElement = new WeakMap<HTMLElement, NodeBinding>();

export function render(data: Node, rootElement: HTMLElement): () => void {
  contextByNode.set(data, { parent: null, scope: {} });

  const { element, dispose } = new NodeMount(data);
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

class InlineEditor {
  element!: HTMLElement;

  constructor(
    readonly node: Node,
    readonly fieldType: "value" | "key",
    readonly readText: () => string,
    readonly applyText: (text: string) => void
  ) {
    this.replace("div");
  }

  replace(tag: "div" | "input") {
    const next = document.createElement(tag) as HTMLElement;
    next.classList.add(this.fieldType);
    next.tabIndex = 0;

    bindingByElement.set(next, {
      node: this.node,
      setEditing: this.setEditing.bind(this),
    });

    if (tag === "input") {
      (next as HTMLInputElement).value = this.readText();
    } else {
      next.textContent =
        this.readText() + (this.fieldType === "key" ? " :" : "");
    }

    if (this.element) this.element.replaceWith(next);
    this.element = next;
  }

  setEditing(isEditing: boolean, focus = true) {
    if (isEditing) {
      this.replace("input");

      let canceled = false;
      let focusAfter = false;

      this.element.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          canceled = e.key === "Escape";
          focusAfter = true;
          (this.element as HTMLInputElement).blur();
        }
      });

      this.element.addEventListener("blur", () => {
        if (!canceled) this.applyText((this.element as HTMLInputElement).value);
        this.replace("div");
        if (focusAfter) this.element.focus();
      });
    } else {
      this.replace("div");
    }

    if (focus) this.element.focus();
  }

  update(text: string) {
    if (this.element.tagName === "INPUT") {
      (this.element as HTMLInputElement).value = text;
    } else {
      this.element.textContent =
        this.readText() + (this.fieldType === "key" ? " :" : "");
    }
  }
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

abstract class NodeView<T> {
  abstract readonly kind: "block" | "value";
  abstract readonly element: HTMLElement;
  abstract update(next: T): void;
  dispose(): void {}
}

class ValueView extends NodeView<string> {
  readonly kind = "value";
  editor: InlineEditor;

  constructor(readonly node: Node) {
    super();
    this.editor = new InlineEditor(
      node,
      "value",
      () => node.peek() as string,
      (next) => {
        node.value = next;
      }
    );
  }

  get element() {
    return this.editor.element;
  }

  update(text: string) {
    this.editor.update(text);
  }
}

class BlockView extends NodeView<Block> {
  readonly kind = "block";
  readonly element: HTMLElement;

  attachedChildren = new Set<Node>();
  keyEditors = new Map<Node, InlineEditor>();

  constructor(readonly node: Node) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("block");
    this.element.tabIndex = 0;
    bindingByElement.set(this.element, { node });
  }

  ensureMounted(child: Node, scope: Record<string, Node>) {
    contextByNode.set(child, { parent: this.node, scope });
    this.attachedChildren.add(child);

    const existing = mountByNode.get(child);
    if (existing) return existing.element;

    const mount = new NodeMount(child);
    mountByNode.set(child, mount);
    return mount.element;
  }

  pruneChildren(keep?: Set<Node>) {
    for (const childNode of Array.from(this.attachedChildren)) {
      if (keep?.has(childNode)) continue;
      const context = contextByNode.get(childNode);
      if (context?.parent === this.node) {
        scheduleUnmountIfDetached(childNode);
      }
      this.attachedChildren.delete(childNode);
    }
  }

  update(v: Block) {
    const context = contextByNode.get(this.node)!;
    const nextScope: Record<string, Node> = {
      ...context.scope,
      ...v.values,
    };

    const keepChildren = new Set<Node>([
      ...Object.values(v.values),
      ...v.items,
    ]);
    this.pruneChildren(keepChildren);

    const keepKeys = new Set(Object.values(v.values));
    for (const s of this.keyEditors.keys()) {
      if (!keepKeys.has(s)) this.keyEditors.delete(s);
    }

    const frag = document.createDocumentFragment();

    for (const [key, childNode] of Object.entries(v.values)) {
      let editor = this.keyEditors.get(childNode);
      if (!editor) {
        editor = new InlineEditor(
          childNode,
          "key",
          () =>
            Object.entries((this.node.peek() as Block).values).find(
              ([, c]) => c === childNode
            )![0],
          (nextKey) => {
            this.node.value = renameChildKey(
              this.node,
              childNode,
              nextKey.trim()
            );
          }
        );
        this.keyEditors.set(childNode, editor);
      }
      editor.update(key);
      frag.append(editor.element, this.ensureMounted(childNode, nextScope));
    }

    for (const childNode of v.items) {
      frag.append(this.ensureMounted(childNode, nextScope));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.pruneChildren();
    this.element.textContent = "";
  }
}

class NodeMount {
  view!: NodeView<Block | string>;
  stop: () => void;

  constructor(readonly node: Node) {
    this.stop = effect(() => {
      const v = node.value;
      const nextKind = isBlock(v) ? "block" : "value";

      if (!this.view || nextKind !== this.view.kind) {
        this.view?.dispose();
        this.view =
          nextKind === "block" ? new BlockView(node) : new ValueView(node);
      }

      this.view.update(v as any);
    });

    mountByNode.set(node, this);
  }

  get element() {
    return this.view.element;
  }

  dispose = () => {
    this.stop();
    this.view.dispose();
    const entry = mountByNode.get(this.node);
    if (entry === this) mountByNode.delete(this.node);
  };
}
