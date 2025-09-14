import { effect } from "@preact/signals-core";

import {
  type LiteralNode,
  type BlockNode,
  type CodeNode,
  type Box,
  type Resolved,
  isBlock,
  isCode,
  makeLiteral,
  makeBox,
  keyOfChild,
  renameChildKey,
  convertValueToItem,
} from "./data";

export const mountByBox = new WeakMap<Box, BoxMount>();

export const boxByElement = new WeakMap<HTMLElement, Box>();

function isTypingChar(e: KeyboardEvent) {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

// queueMicrotask(() => {
//   const newBinding = bindingByElement.get(
//     document.activeElement as HTMLElement
//   );
//   if (
//     document.activeElement?.classList.contains("key") &&
//     newBinding?.setEditing
//   ) {
//     newBinding.setEditing(true, true);
//   }
// });

class InlineEditor {
  element!: HTMLElement;

  constructor(
    readonly fieldType: "code" | "value" | "key",
    readonly readText: () => string,
    readonly applyText: (text: string) => void,
    readonly onElementChange: (el: HTMLElement) => void
  ) {
    this.replace("div");
  }

  replace(tag: "div" | "input", initialText?: string) {
    const next = document.createElement(tag) as HTMLElement;
    next.classList.add(this.fieldType);
    next.tabIndex = 0;

    if (tag === "input") {
      const inputEl = next as HTMLInputElement;
      inputEl.value = initialText ?? this.readText();

      let canceled = false;
      let focusAfter = false;

      inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          canceled = e.key === "Escape";
          focusAfter = true;
          inputEl.blur();
        }
      });

      inputEl.addEventListener("blur", () => {
        if (!canceled) this.applyText(inputEl.value);
        this.replace("div");
        if (focusAfter) (this.element as HTMLElement).focus();
      });
    } else {
      next.textContent =
        this.readText() + (this.fieldType === "key" ? " :" : "");

      next.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.replace("input");
        this.element.focus();
      });

      next.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.replace("input");
          this.element.focus();
          return;
        }

        if (isTypingChar(e)) {
          e.preventDefault();
          e.stopPropagation();
          this.replace("input", e.key);
          this.element.focus();
        }
      });
    }

    if (this.element) this.element.replaceWith(next);
    this.element = next;

    this.onElementChange(this.element);
  }

  update(text: string) {
    if (this.element.tagName === "DIV") {
      this.element.textContent = text + (this.fieldType === "key" ? " :" : "");
    }
  }
}

abstract class BoxView<T> {
  abstract readonly kind: "code" | "block" | "literal";
  abstract readonly element: HTMLElement;
  update(_next: T) {}
  dispose() {}
}

class LiteralView extends BoxView<string> {
  readonly kind = "literal";
  editor: InlineEditor;

  constructor(readonly box: Box) {
    super();
    this.editor = new InlineEditor(
      "value",
      () => String((box.value.peek() as LiteralNode).value),
      (next) => {
        box.value.value = makeLiteral(next);
      },
      (el) => boxByElement.set(el, box)
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
    boxByElement.set(this.element, box);
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
          "key",
          () => keyOfChild(childBox) ?? "",
          (nextKey) => {
            const trimmed = nextKey.trim();
            if (trimmed === "") {
              convertValueToItem(childBox);
            } else {
              renameChildKey(childBox, trimmed);
            }
          },
          (el) => boxByElement.set(el, childBox)
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

class CodeView extends BoxView<Resolved | string> {
  readonly kind = "code";
  readonly element: HTMLElement;

  private editor: InlineEditor;
  private outputBox: Box;
  private outputMount: BoxMount;
  private stopMirror: () => void;

  constructor(readonly box: Box) {
    super();

    this.element = document.createElement("div");
    this.element.classList.add("code");
    this.element.tabIndex = 0;
    boxByElement.set(this.element, box);

    this.editor = new InlineEditor(
      "code",
      () => (box.value.peek() as CodeNode).code.peek(),
      (next) => {
        (box.value.peek() as CodeNode).code.value = next;
      },
      (el) => boxByElement.set(el, box)
    );

    this.outputBox = makeBox((box.value.peek() as CodeNode).result.peek());

    this.outputMount = new BoxMount(this.outputBox);

    this.element.append(this.editor.element, this.outputMount.element);

    this.stopMirror = effect(() => {
      const cur = box.value.value as CodeNode;
      this.editor.update(cur.code.value);
      this.outputBox.value.value = cur.result.value;
    });
  }

  dispose() {
    this.stopMirror?.();
    this.outputMount?.dispose();
    this.element.textContent = "";
  }
}

export class BoxMount {
  view!: BoxView<BlockNode | string | Resolved>;
  stop: () => void;

  constructor(readonly box: Box) {
    this.stop = effect(() => {
      const node = box.value.value;
      const nextKind = isCode(node)
        ? "code"
        : isBlock(node)
        ? "block"
        : "literal";

      if (!this.view || nextKind !== this.view.kind) {
        this.view?.dispose();
        this.view =
          nextKind === "block"
            ? new BlockView(box)
            : nextKind === "literal"
            ? new LiteralView(box)
            : new CodeView(box);
      }

      if (nextKind === "block") {
        this.view.update(node as BlockNode);
      } else if (nextKind === "literal") {
        this.view.update(String((node as LiteralNode).value));
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
