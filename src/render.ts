import { effect } from "@preact/signals-core";

import {
  type Block,
  type Value,
  isBlock,
  keyOfChild,
  renameChildKey,
  convertValueToItem,
} from "./data";

export const mountByNode = new WeakMap<Value, NodeMount>();

type NodeBinding = {
  node: Value;
  setEditing?: (v: boolean, focus?: boolean) => void;
};
export const bindingByElement = new WeakMap<HTMLElement, NodeBinding>();

class InlineEditor {
  element!: HTMLElement;

  constructor(
    readonly node: Value,
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

  update(_text: string) {
    if (this.element.tagName === "INPUT") {
      (this.element as HTMLInputElement).value = this.readText();
    } else {
      this.element.textContent =
        this.readText() + (this.fieldType === "key" ? " :" : "");
    }
  }
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

  constructor(readonly node: Value) {
    super();
    this.editor = new InlineEditor(
      node,
      "value",
      // Assumes `node` is a signal-like value node; adapt as needed.
      () => (node as any).peek() as string,
      (next) => {
        (node as any).value = next;
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

  // We track which children *this* BlockView attached, so we can clean them up later.
  attachedChildren = new Set<Value>();
  keyEditors = new Map<Value, InlineEditor>();

  constructor(readonly node: Value) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("block");
    this.element.tabIndex = 0;
    bindingByElement.set(this.element, { node });
  }

  ensureMounted(child: Value) {
    this.attachedChildren.add(child);

    const existing = mountByNode.get(child);
    if (existing) return existing.element;

    const mount = new NodeMount(child);
    mountByNode.set(child, mount);
    return mount.element;
  }

  pruneChildren(keep?: Set<Value>) {
    for (const childNode of Array.from(this.attachedChildren)) {
      if (keep?.has(childNode)) continue;

      const mount = mountByNode.get(childNode);
      if (mount) {
        mount.element.remove();
        queueMicrotask(() => {
          const current = mountByNode.get(mount.node);
          if (current === mount && !mount.element.isConnected) {
            mount.dispose();
          }
        });
      }

      this.attachedChildren.delete(childNode);
    }
  }

  update(v: Block) {
    const keepChildren = new Set<Value>([
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
          () => keyOfChild((this.node as any).peek() as Block, childNode) ?? "",
          (nextKey) => {
            const current = (this.node as any).peek() as Block;
            const trimmed = nextKey.trim();
            if (trimmed === "") {
              (this.node as any).value = convertValueToItem(current, childNode);
            } else {
              (this.node as any).value = renameChildKey(
                current,
                childNode,
                trimmed
              );
            }
          }
        );
        this.keyEditors.set(childNode, editor);
      }
      editor.update(key);
      frag.append(editor.element, this.ensureMounted(childNode));
    }

    for (const childNode of v.items) {
      frag.append(this.ensureMounted(childNode));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.pruneChildren();
    this.element.textContent = "";
  }
}

export class NodeMount {
  view!: NodeView<Block | string>;
  stop: () => void;

  constructor(readonly node: Value) {
    this.stop = effect(() => {
      const v = (node as any).value;
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
