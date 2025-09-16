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
  assignKey,
  removeKey,
  resolveShallow,
} from "./data";
import { FocusRequestEvent, EditCommandEvent } from "./input";

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

    if (tag === "div") {
      nextEl.textContent =
        this.getText() + (this.fieldRole === "key" ? " :" : "");

      nextEl.addEventListener("editcommand", (ev: Event) => {
        const e = ev as EditCommandEvent;
        if (e.detail.kind === "begin-edit") {
          e.stopPropagation();
          this.toggleEditor("input", e.detail.seed);
          this.element.focus();
        }
      });
    } else {
      const inputEl = nextEl as HTMLInputElement;
      inputEl.value = initialText ?? this.getText();

      let refocusAfterBlur = false;
      let skipCommitOnBlur = false;

      inputEl.addEventListener("editcommand", (ev: Event) => {
        const e = ev as EditCommandEvent;
        switch (e.detail.kind) {
          case "commit": {
            e.stopPropagation();
            refocusAfterBlur = true;
            inputEl.blur();
            break;
          }
          case "cancel": {
            e.stopPropagation();
            inputEl.value = this.getText();
            skipCommitOnBlur = true;
            refocusAfterBlur = true;
            inputEl.blur();
            break;
          }
        }
      });

      inputEl.addEventListener("blur", () => {
        if (!skipCommitOnBlur) {
          this.commitText(inputEl.value);
        }
        this.toggleEditor("div");
        if (refocusAfterBlur) {
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

  currentChildren: Box[] = [];

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = createEl("div", "block", true);
    registerElement(this.element);

    this.element.addEventListener("focusrequest", (ev: Event) => {
      const e = ev as FocusRequestEvent;
      const { detail } = e;

      const stop = () => {
        e.stopPropagation();
        (e as Event).preventDefault?.();
      };

      if (detail.kind === "to") {
        const { target, role } = detail;

        if (target === boxByElement.get(this.element)) {
          stop();
          this.element.focus();
          return;
        }

        const mount = this.childMountByBox.get(target);
        if (mount) {
          stop();

          if (role === "key") {
            this.keyEditorByBox.get(target)?.element.focus();
            return;
          }

          if (role === "container") {
            this.element.focus();
            return;
          }

          mount.focus();
        }
        return;
      }

      if (detail.kind === "nav") {
        const { dir } = detail;
        const origin = e.target as HTMLElement;

        const fromBox = boxByElement.get(origin)!;
        if (!this.currentChildren.includes(fromBox)) return;

        const idx = this.currentChildren.indexOf(fromBox);
        if (idx < 0) return;

        const len = this.currentChildren.length;
        let nextIdx = idx;
        switch (dir) {
          case "first":
            nextIdx = 0;
            break;
          case "last":
            nextIdx = Math.max(0, len - 1);
            break;
          case "next":
            nextIdx = Math.min(len - 1, idx + 1);
            break;
          case "prev":
            nextIdx = Math.max(0, idx - 1);
            break;
        }

        const target = this.currentChildren[nextIdx];
        if (!target) return;

        const mount = this.childMountByBox.get(target);
        if (!mount) return;

        stop();
        mount.focus();
      }
    });
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

    this.currentChildren = [...values.map(([, v]) => v), ...items];

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
              removeKey(childBox);
            } else {
              assignKey(childBox, trimmedKey);
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
