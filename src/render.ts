import { effect } from "@preact/signals-core";

import {
  type LiteralNode,
  type BlockNode,
  type Box,
  isLiteral,
  isCode,
  resolveShallow,
  makeLiteral,
  keyOfChild,
  renameChildKey,
  convertValueToItem,
} from "./data";

export const mountByBox = new WeakMap<Box, BoxMount>();

type BoxBinding = {
  box: Box;
  setEditing?: (v: boolean, focus?: boolean) => void;
};
export const bindingByElement = new WeakMap<HTMLElement, BoxBinding>();

class InlineEditor {
  element!: HTMLElement;

  constructor(
    readonly box: Box,
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
      box: this.box,
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

abstract class BoxView<T> {
  abstract readonly kind: "block" | "value";
  abstract readonly element: HTMLElement;
  abstract update(next: T): void;
  dispose(): void {}
}

class ValueView extends BoxView<string> {
  readonly kind = "value";
  editor: InlineEditor;

  constructor(readonly box: Box) {
    super();
    this.editor = new InlineEditor(
      box,
      "value",
      () => {
        const n = box.value.peek();
        return isCode(n) ? n.code.peek() : isLiteral(n) ? String(n.value) : "";
      },
      (next) => {
        const n = box.value.peek();
        if (isCode(n)) n.code.value = next;
        else box.value.value = makeLiteral(next);
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

class BlockView extends BoxView<BlockNode> {
  readonly kind = "block";
  readonly element: HTMLElement;

  attachedChildren = new Set<Box>();
  keyEditors = new Map<Box, InlineEditor>();

  constructor(readonly box: Box) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("block");
    this.element.tabIndex = 0;
    bindingByElement.set(this.element, { box });
  }

  ensureMounted(child: Box) {
    this.attachedChildren.add(child);

    const existing = mountByBox.get(child);
    if (existing) return existing.element;

    const mount = new BoxMount(child);
    mountByBox.set(child, mount);
    return mount.element;
  }

  pruneChildren(keep?: Set<Box>) {
    for (const childBox of Array.from(this.attachedChildren)) {
      if (keep?.has(childBox)) continue;

      const mount = mountByBox.get(childBox);
      if (mount) {
        mount.element.remove();
        queueMicrotask(() => {
          const current = mountByBox.get(mount.box);
          if (current === mount && !mount.element.isConnected) {
            mount.dispose();
          }
        });
      }

      this.attachedChildren.delete(childBox);
    }
  }

  update(v: BlockNode) {
    const keepChildren = new Set<Box>([...Object.values(v.values), ...v.items]);
    this.pruneChildren(keepChildren);

    const keepKeys = new Set(Object.values(v.values));
    for (const b of this.keyEditors.keys()) {
      if (!keepKeys.has(b)) this.keyEditors.delete(b);
    }

    const frag = document.createDocumentFragment();

    for (const [key, childBox] of Object.entries(v.values)) {
      let editor = this.keyEditors.get(childBox);
      if (!editor) {
        editor = new InlineEditor(
          childBox,
          "key",
          () => keyOfChild(childBox) ?? "",
          (nextKey) => {
            const trimmed = nextKey.trim();
            if (trimmed === "") {
              convertValueToItem(childBox);
            } else {
              renameChildKey(childBox, trimmed);
            }
          }
        );
        this.keyEditors.set(childBox, editor);
      }
      editor.update(key);
      frag.append(editor.element, this.ensureMounted(childBox));
    }

    for (const childBox of v.items) {
      frag.append(this.ensureMounted(childBox));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.pruneChildren();
    this.element.textContent = "";
  }
}

export class BoxMount {
  view!: BoxView<BlockNode | string>;
  stop: () => void;

  constructor(readonly box: Box) {
    this.stop = effect(() => {
      const r = resolveShallow(box);
      const nextKind = r.kind === "block" ? "block" : "value";

      if (!this.view || nextKind !== this.view.kind) {
        this.view?.dispose();
        this.view =
          nextKind === "block" ? new BlockView(box) : new ValueView(box);
      }

      if (nextKind === "block") {
        this.view.update(r as BlockNode);
      } else {
        this.view.update(String((r as LiteralNode).value));
      }
    });

    mountByBox.set(box, this);
  }

  get element() {
    return this.view.element;
  }

  dispose = () => {
    this.stop();
    this.view.dispose();
    const entry = mountByBox.get(this.box);
    if (entry === this) mountByBox.delete(this.box);
  };
}
