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
  keyOfChild,
  renameChildKey,
  moveValueToItems,
  resolveShallow,
} from "./data";

export const mountByBox = new WeakMap<Box, BoxMount>();
export const boxByElement = new WeakMap<HTMLElement, Box>();

function createEl(
  tag: string,
  className?: string,
  focusable?: boolean
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.classList.add(className);
  if (focusable) node.tabIndex = 0;
  return node;
}

function isCharKey(e: KeyboardEvent) {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

abstract class View<T> {
  abstract readonly viewKind: "code" | "block" | "literal" | "readonly";
  abstract readonly element: HTMLElement;
  abstract update(next: T): void;
  dispose() {}
}

class ReadonlyStringView extends View<string> {
  readonly viewKind = "readonly";
  element: HTMLElement;

  constructor(
    readonly fieldRole: "value" | "key",
    readonly registerElement: (el: HTMLElement) => void,
    initial: string
  ) {
    super();
    this.element = createEl("div", this.fieldRole);
    this.element.textContent = initial + (this.fieldRole === "key" ? " :" : "");
    this.registerElement(this.element);
  }

  update(text: string) {
    this.element.textContent = text + (this.fieldRole === "key" ? " :" : "");
  }
}

class StringView extends View<string> {
  readonly viewKind = "literal";
  element!: HTMLElement;

  constructor(
    readonly fieldRole: "expr" | "value" | "key",
    readonly getText: () => string,
    readonly commitText: (text: string) => void,
    readonly registerElement: (el: HTMLElement) => void
  ) {
    super();
    this.toggleEditor("div");
  }

  toggleEditor(tag: "div" | "input", initialText?: string) {
    const nextEl = createEl(tag, this.fieldRole, true);

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
        this.toggleEditor("div");
        if (focusAfter) this.element.focus();
      });
    } else {
      nextEl.textContent =
        this.getText() + (this.fieldRole === "key" ? " :" : "");

      nextEl.addEventListener("mousedown", (e) => {
        if (e.detail === 2) e.preventDefault();
      });

      nextEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleEditor("input");
        this.element.focus();
      });

      nextEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.toggleEditor("input");
          this.element.focus();
          return;
        }

        if (isCharKey(e)) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleEditor("input", e.key);
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
  readonly viewKind = "block";
  readonly element: HTMLElement;

  mountedChildBoxes = new Set<Box>();
  keyEditorByBox = new Map<Box, StringView>();

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = createEl("div", "block", true);
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

class CodeView extends View<string> {
  readonly viewKind = "code";
  readonly element: HTMLElement;

  codeEditor: StringView;
  resultMount: ResolvedMount;

  constructor(
    readCode: () => string,
    applyCode: (text: string) => void,
    registerElement: (el: HTMLElement) => void,
    readResolved: () => Resolved
  ) {
    super();
    this.element = createEl("div", "code", true);
    registerElement(this.element);

    this.codeEditor = new StringView(
      "expr",
      readCode,
      applyCode,
      registerElement
    );
    this.resultMount = new ResolvedMount(readResolved);

    this.element.append(this.codeEditor.element, this.resultMount.element);
  }

  update(code: string) {
    this.codeEditor.update(code);
  }

  dispose() {
    this.resultMount.dispose();
    this.element.textContent = "";
  }
}

export class ResolvedMount {
  nodeView!: View<BlockNode | string>;
  disposeEffect: () => void;

  constructor(readResolved: () => Resolved) {
    const registerElement = () => {};

    this.disposeEffect = effect(() => {
      const resolved = readResolved();
      const nextKind = isBlock(resolved as any) ? "block" : "readonly";

      if (!this.nodeView || nextKind !== this.nodeView.viewKind) {
        const prevEl = this.nodeView?.element;
        this.nodeView?.dispose();

        this.nodeView =
          nextKind === "block"
            ? new BlockView(registerElement)
            : new ReadonlyStringView(
                "value",
                registerElement,
                String((resolved as LiteralNode).value)
              );

        if (prevEl) prevEl.replaceWith(this.nodeView.element);
      }

      if (nextKind === "block") this.nodeView.update(resolved as BlockNode);
      else this.nodeView.update(String((resolved as LiteralNode).value));
    });
  }

  get element() {
    return this.nodeView.element;
  }

  dispose() {
    this.disposeEffect();
    this.nodeView?.dispose();
  }
}

export class BoxMount {
  nodeView!: View<BlockNode | string>;
  disposeEffect: () => void;

  constructor(readonly box: Box) {
    this.disposeEffect = effect(() => {
      const currentNode = box.value.value;
      const nextKind = isCode(currentNode)
        ? "code"
        : isBlock(currentNode)
        ? "block"
        : "literal";

      const registerElementBox = (el: HTMLElement) => boxByElement.set(el, box);

      if (!this.nodeView || nextKind !== this.nodeView.viewKind) {
        this.nodeView?.dispose();
        this.nodeView =
          nextKind === "code"
            ? new CodeView(
                () => (box.value.peek() as CodeNode).code,
                (next) => {
                  box.value.value = { kind: "code", code: next };
                },
                registerElementBox,
                () => resolveShallow(box)
              )
            : nextKind === "block"
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

      if (nextKind === "code") {
        this.nodeView.update((currentNode as CodeNode).code);
      } else if (nextKind === "block") {
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

  dispose() {
    this.disposeEffect();
    this.nodeView.dispose();
    const entry = mountByBox.get(this.box);
    if (entry === this) mountByBox.delete(this.box);
  }
}
