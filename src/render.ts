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
  moveValueToItems,
  resolveShallow,
} from "./data";

export const mountByBox = new WeakMap<Box, BoxMount>();
export const boxByElement = new WeakMap<HTMLElement, Box>();

function isTypingChar(e: KeyboardEvent) {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

abstract class View<T> {
  abstract readonly nodeKind: "code" | "block" | "literal";
  abstract readonly element: HTMLElement;
  abstract update(next: T): void;
  dispose() {}
}

class StringView extends View<string> {
  readonly nodeKind = "literal";
  element!: HTMLElement;

  constructor(
    readonly fieldRole: "code" | "value" | "key",
    readonly getText: () => string,
    readonly commitText: (text: string) => void,
    readonly registerElement: (el: HTMLElement) => void
  ) {
    super();
    this.switchElement("div");
  }

  switchElement(tag: "div" | "input", initialText?: string) {
    const nextEl = document.createElement(tag) as HTMLElement;
    nextEl.classList.add(this.fieldRole);
    nextEl.tabIndex = 0;

    if (tag === "input") {
      const inputEl = nextEl as HTMLInputElement;
      inputEl.value = initialText ?? this.getText();

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
        if (!canceled) this.commitText(inputEl.value);
        this.switchElement("div");
        if (focusAfter) this.element.focus();
      });
    } else {
      nextEl.textContent =
        this.getText() + (this.fieldRole === "key" ? " :" : "");

      nextEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.switchElement("input");
        this.element.focus();
      });

      nextEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.switchElement("input");
          this.element.focus();
          return;
        }

        if (isTypingChar(e)) {
          e.preventDefault();
          e.stopPropagation();
          this.switchElement("input", e.key);
          this.element.focus();
        }
      });
    }

    if (this.element) this.element.replaceWith(nextEl);
    this.element = nextEl;

    this.registerElement(this.element);
  }

  update(text: string) {
    if (this.element.tagName === "DIV") {
      this.element.textContent = text + (this.fieldRole === "key" ? " :" : "");
    }
  }
}

class BlockView extends View<BlockNode> {
  readonly nodeKind = "block";
  readonly element: HTMLElement;

  mountedChildBoxes = new Set<Box>();
  keyEditorByBox = new Map<Box, StringView>();

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("block");
    this.element.tabIndex = 0;
    registerElement(this.element);
  }

  mountChildIfNeeded(child: Box) {
    this.mountedChildBoxes.add(child);
    const existing = mountByBox.get(child);
    if (existing) return existing.element;
    const mount = new BoxMount(child);
    mountByBox.set(child, mount);
    return mount.element;
  }

  unmountAllChildrenExcept(keep?: Set<Box>) {
    for (const childBox of Array.from(this.mountedChildBoxes)) {
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

      this.mountedChildBoxes.delete(childBox);
    }
  }

  update({ values, items }: BlockNode) {
    const childrenToKeep = new Set<Box>([...Object.values(values), ...items]);
    this.unmountAllChildrenExcept(childrenToKeep);

    const keyedValuesToKeep = new Set(Object.values(values));
    for (const b of this.keyEditorByBox.keys()) {
      if (!keyedValuesToKeep.has(b)) this.keyEditorByBox.delete(b);
    }

    const frag = document.createDocumentFragment();

    for (const [key, childBox] of Object.entries(values)) {
      let editor = this.keyEditorByBox.get(childBox);
      if (!editor) {
        editor = new StringView(
          "key",
          () => keyOfChild(childBox) ?? "",
          (newKey) => {
            const trimmedKey = newKey.trim();
            if (trimmedKey === "") {
              moveValueToItems(childBox);
            } else {
              renameChildKey(childBox, trimmedKey);
            }
          },
          (el) => boxByElement.set(el, childBox)
        );
        this.keyEditorByBox.set(childBox, editor);
      }
      editor.update(key);
      frag.append(editor.element, this.mountChildIfNeeded(childBox));
    }

    for (const childBox of items) {
      frag.append(this.mountChildIfNeeded(childBox));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    this.element.textContent = "";
  }
}

type CodeUpdate = { code: string; resolved: Resolved };

class CodeView extends View<CodeUpdate> {
  readonly nodeKind = "code";
  readonly element: HTMLElement;

  codeEditor: StringView;
  resultValueBox: Box;
  resultBoxMount: BoxMount;

  constructor(
    readCode: () => string,
    applyCode: (text: string) => void,
    registerElement: (el: HTMLElement) => void,
    initialResolved: Resolved
  ) {
    super();
    this.element = document.createElement("div");
    this.element.classList.add("code");
    this.element.tabIndex = 0;
    registerElement(this.element);

    this.codeEditor = new StringView(
      "code",
      readCode,
      applyCode,
      registerElement
    );

    this.resultValueBox = makeBox(initialResolved);
    this.resultBoxMount = new BoxMount(this.resultValueBox);

    this.element.append(this.codeEditor.element, this.resultBoxMount.element);
  }

  update({ code, resolved }: CodeUpdate) {
    this.codeEditor.update(code);
    this.resultValueBox.value.value = resolved;
  }

  dispose() {
    this.resultBoxMount.dispose();
    this.element.textContent = "";
  }
}

export class BoxMount {
  nodeView!: View<CodeUpdate | BlockNode | string>;
  stopEffect: () => void;

  constructor(readonly box: Box) {
    this.stopEffect = effect(() => {
      const currentNode = box.value.value;
      const nextNodeKind = isCode(currentNode)
        ? "code"
        : isBlock(currentNode)
        ? "block"
        : "literal";

      const registerElementBox = (el: HTMLElement) => boxByElement.set(el, box);

      if (!this.nodeView || nextNodeKind !== this.nodeView.nodeKind) {
        this.nodeView?.dispose();
        this.nodeView =
          nextNodeKind === "code"
            ? new CodeView(
                () => (box.value.peek() as CodeNode).code,
                (next) => {
                  box.value.value = { kind: "code", code: next };
                },
                registerElementBox,
                resolveShallow(box)
              )
            : nextNodeKind === "block"
            ? new BlockView(registerElementBox)
            : new StringView(
                "value",
                () => String((box.value.peek() as LiteralNode).value),
                (next) => {
                  box.value.value = makeLiteral(next);
                },
                registerElementBox
              );
      }

      if (nextNodeKind === "code") {
        this.nodeView.update({
          code: (currentNode as CodeNode).code,
          resolved: resolveShallow(box),
        });
      } else if (nextNodeKind === "block") {
        this.nodeView.update(currentNode as BlockNode);
      } else {
        this.nodeView.update(String((currentNode as LiteralNode).value));
      }
    });

    mountByBox.set(box, this);
  }

  get element() {
    return this.nodeView.element;
  }

  dispose = () => {
    this.stopEffect();
    this.nodeView.dispose();
    const entry = mountByBox.get(this.box);
    if (entry === this) mountByBox.delete(this.box);
  };
}
