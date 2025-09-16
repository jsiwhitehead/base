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
  getChildKey,
  renameKey,
  convertKeyValueToItem,
  resolveShallow,
} from "./data";

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
    readonly registerElement: (el: HTMLElement) => void,
    readonly onFocusSibling?: () => void
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
        if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
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
        if (focusAfter) {
          if (this.fieldRole === "key") {
            this.onFocusSibling!();
          } else {
            this.element.focus();
          }
        }
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

      nextEl.addEventListener("focus", () => {
        if (this.fieldRole === "key") {
          this.toggleEditor("input");
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
  childMountByBox = new Map<Box, BoxMount>();
  keyEditorByBox = new Map<Box, StringView>();

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = createEl("div", "block", true);
    registerElement(this.element);
  }

  mountChildIfNeeded(child: Box) {
    let mount = this.childMountByBox.get(child);
    if (!mount) {
      mount = new BoxMount(child);
      this.childMountByBox.set(child, mount);
    }
    return mount.element;
  }

  unmountAllChildrenExcept(keep?: Set<Box>) {
    for (const [childBox, mount] of Array.from(this.childMountByBox)) {
      if (keep?.has(childBox)) continue;

      if (this.element.contains(mount.element)) {
        mount.element.remove();
      }

      mount.dispose();
      this.childMountByBox.delete(childBox);
    }
  }

  update({ values, items }: BlockNode) {
    const childrenToKeep = new Set<Box>([
      ...values.map(([, v]) => v),
      ...items,
    ]);
    this.unmountAllChildrenExcept(childrenToKeep);

    const keyedValuesToKeep = new Set(values.map(([, v]) => v));
    for (const b of this.keyEditorByBox.keys()) {
      if (!keyedValuesToKeep.has(b)) this.keyEditorByBox.delete(b);
    }

    const frag = document.createDocumentFragment();

    for (const [key, childBox] of values) {
      let editor = this.keyEditorByBox.get(childBox);
      if (!editor) {
        editor = new StringView(
          "key",
          () => getChildKey(childBox) ?? "",
          (newKey) => {
            const trimmedKey = newKey.trim();
            if (trimmedKey === "") {
              convertKeyValueToItem(childBox);
            } else {
              renameKey(childBox, trimmedKey);
            }
          },
          (el) => boxByElement.set(el, childBox),
          () => {
            const mount = this.childMountByBox.get(childBox);
            if (mount) mount.focus();
          }
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
    this.element = createEl("div", "code");

    this.codeEditor = new StringView(
      "expr",
      readCode,
      applyCode,
      registerElement
    );

    this.resultMount = new ResolvedMount(
      readResolved,
      () => this.element.classList.remove("error"),
      () => this.element.classList.add("error")
    );

    this.element.append(this.codeEditor.element, this.resultMount.element);

    this.element.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.codeEditor.element.focus();
    });
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
  nodeView?: View<BlockNode | string>;
  disposeEffect: () => void;
  container: HTMLElement;

  constructor(
    readResolved: () => Resolved,
    onOk: () => void,
    onError: () => void
  ) {
    this.container = createEl("div", "result");

    const registerElement = () => {};

    const ensureKind = (
      kind: "block" | "readonly",
      build: () => View<BlockNode | string>
    ) => {
      if (!this.nodeView || this.nodeView.viewKind !== kind) {
        this.nodeView?.dispose();
        this.nodeView = build();
        this.container.replaceChildren(this.nodeView.element);
      }
    };

    this.disposeEffect = effect(() => {
      try {
        const resolved = readResolved();
        onOk();
        if (isBlock(resolved)) {
          ensureKind("block", () => new BlockView(registerElement));
          this.nodeView!.update(resolved);
        } else {
          ensureKind(
            "readonly",
            () =>
              new ReadonlyStringView(
                "value",
                registerElement,
                String(resolved.value)
              )
          );
          this.nodeView!.update(String(resolved.value));
        }
      } catch {
        onError();
        this.nodeView?.dispose();
        this.nodeView = undefined;
        this.container.replaceChildren();
      }
    });
  }

  get element() {
    return this.container;
  }

  dispose() {
    this.disposeEffect?.();
    this.nodeView?.dispose();
    this.container.replaceChildren();
  }
}

export class BoxMount {
  nodeView!: View<BlockNode | string>;
  disposeEffect: () => void;

  constructor(readonly box: Box) {
    const registerElementBox = (el: HTMLElement) => boxByElement.set(el, box);

    const ensureKind = (
      kind: "code" | "block" | "literal",
      build: () => View<BlockNode | string>
    ) => {
      if (!this.nodeView || this.nodeView.viewKind !== kind) {
        this.nodeView?.dispose();
        this.nodeView = build();
      }
    };

    this.disposeEffect = effect(() => {
      const n = this.box.value.value;

      if (isCode(n)) {
        ensureKind(
          "code",
          () =>
            new CodeView(
              () => (this.box.value.peek() as CodeNode).code,
              (next) => (this.box.value.value = { kind: "code", code: next }),
              registerElementBox,
              () => resolveShallow(this.box)
            )
        );
        this.nodeView.update(n.code);
      } else if (isBlock(n)) {
        ensureKind("block", () => new BlockView(registerElementBox));
        this.nodeView.update(n);
      } else {
        ensureKind(
          "literal",
          () =>
            new StringView(
              "value",
              () => String((this.box.value.peek() as LiteralNode).value),
              (next) => (this.box.value.value = makeLiteral(next)),
              registerElementBox
            )
        );
        this.nodeView.update(String(n.value));
      }
    });
  }

  get element() {
    return this.nodeView.element;
  }

  focus() {
    if (this.nodeView.viewKind === "code") {
      (this.nodeView as CodeView).codeEditor.element.focus();
    }
    this.nodeView.element.focus();
  }

  dispose() {
    this.disposeEffect();
    this.nodeView.dispose();
  }
}
