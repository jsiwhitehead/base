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
    readonly registerElement: (el: HTMLElement) => void,
    readonly onCancel?: () => void
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
      let cancelled = false;

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
            cancelled = true;
            refocusAfterBlur = true;
            inputEl.blur();
            break;
          }
        }
      });

      inputEl.addEventListener("blur", () => {
        if (!cancelled) {
          this.commitText(inputEl.value);
        } else {
          this.onCancel?.();
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
  keyEditorByBox = new WeakMap<Box, StringView>();
  tempKeyBox: Box | null = null;

  orderedChildren: Box[] = [];
  lastNode?: BlockNode;

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = createEl("div", "block", true);
    registerElement(this.element);

    this.element.addEventListener("focusrequest", (ev: Event) => {
      const e = ev as FocusRequestEvent;
      const stop = () => {
        e.stopPropagation();
        (e as Event).preventDefault?.();
      };

      if (e.detail.kind === "to") {
        const { targetBox, role } = e.detail;
        const mount = this.childMountByBox.get(targetBox);
        if (!mount) return;

        if (role === "key") {
          stop();
          const editor = this.ensureKeyEditor(targetBox);

          if (!getChildKey(targetBox)) {
            this.tempKeyBox = targetBox;
            if (this.lastNode) this.update(this.lastNode);
          }

          if (editor.element.tagName !== "INPUT") editor.toggleEditor("input");
          editor.element.focus();
          return;
        }

        if (role === "container") {
          this.element.focus();
          return;
        }

        mount.focus();
        return;
      }

      if (e.detail.kind === "nav") {
        const { dir } = e.detail;
        const origin = e.target as HTMLElement;
        const fromBox = boxByElement.get(origin)!;
        if (!this.orderedChildren.includes(fromBox)) return;

        const idx = this.orderedChildren.indexOf(fromBox);
        if (idx < 0) return;

        const len = this.orderedChildren.length;
        let targetIndex = idx;
        switch (dir) {
          case "first":
            targetIndex = 0;
            break;
          case "last":
            targetIndex = Math.max(0, len - 1);
            break;
          case "next":
            targetIndex = Math.min(len - 1, idx + 1);
            break;
          case "prev":
            targetIndex = Math.max(0, idx - 1);
            break;
        }

        const target = this.orderedChildren[targetIndex];
        if (!target) return;

        const mount = this.childMountByBox.get(target);
        if (!mount) return;

        stop();
        mount.focus();
      }
    });
  }

  ensureKeyEditor(box: Box): StringView {
    let editor = this.keyEditorByBox.get(box);
    if (!editor) {
      editor = new StringView(
        "key",
        () => getChildKey(box) ?? "",
        (nextKey) => {
          const trimmed = nextKey.trim();
          if (trimmed === "") removeKey(box);
          else assignKey(box, trimmed);
          this.tempKeyBox = null;
          if (this.lastNode) this.update(this.lastNode);
        },
        (el) => boxByElement.set(el, box),
        () => {
          this.tempKeyBox = null;
          if (this.lastNode) this.update(this.lastNode);
        }
      );
      this.keyEditorByBox.set(box, editor);
    }
    return editor;
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

    if (keep && this.tempKeyBox && !keep.has(this.tempKeyBox)) {
      this.tempKeyBox = null;
    }
  }

  update(node: BlockNode) {
    this.lastNode = node;
    const { values, items } = node;

    const childrenToKeep = new Set<Box>([
      ...values.map(([, v]) => v),
      ...items,
    ]);
    this.unmountAllChildrenExcept(childrenToKeep);

    this.orderedChildren = [...values.map(([, v]) => v), ...items];

    const frag = document.createDocumentFragment();

    for (const [key, childBox] of values) {
      const editor = this.ensureKeyEditor(childBox);
      editor.update(key);
      frag.append(editor.element, this.mountChildIfNeeded(childBox));
    }

    for (const childBox of items) {
      if (this.tempKeyBox === childBox) {
        const ed = this.ensureKeyEditor(childBox);
        if (ed.element.tagName !== "INPUT") ed.toggleEditor("input");
        frag.append(ed.element);
      }
      frag.append(this.mountChildIfNeeded(childBox));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    this.tempKeyBox = null;
    this.element.textContent = "";
  }
}

class CodeView extends View<string> {
  readonly viewKind = "code";
  readonly element: HTMLElement;
  resultContainer: HTMLElement;
  codeEditor: StringView;
  resultView?: View<BlockNode | string>;
  disposeResultEffect?: () => void;

  constructor(
    readCode: () => string,
    applyCode: (text: string) => void,
    registerElement: (el: HTMLElement) => void,
    readResolved: () => Resolved
  ) {
    super();
    this.element = createEl("div", "code");
    this.resultContainer = createEl("div", "result");

    this.codeEditor = new StringView(
      "expr",
      readCode,
      applyCode,
      registerElement
    );

    this.disposeResultEffect = effect(() => {
      try {
        const resolved = readResolved();
        this.resultContainer.classList.remove("error");

        if (isBlock(resolved)) {
          this.ensureResultKind("block", () => new BlockView(() => {}));
          this.resultView!.update(resolved);
        } else {
          this.ensureResultKind(
            "readonly",
            () =>
              new ReadonlyStringView("value", () => {}, String(resolved.value))
          );
          this.resultView!.update(String(resolved.value));
        }
      } catch {
        this.resultContainer.classList.add("error");
        this.resultView?.dispose();
        this.resultView = undefined;
        this.resultContainer.textContent = "";
      }
    });

    this.element.append(this.codeEditor.element, this.resultContainer);

    this.element.addEventListener("mousedown", (e) => {
      e.preventDefault();
      this.codeEditor.element.focus();
    });
  }

  ensureResultKind(
    kind: "block" | "readonly",
    build: () => View<BlockNode | string>
  ) {
    if (!this.resultView || this.resultView.viewKind !== kind) {
      this.resultView?.dispose();
      this.resultView = build();
      this.resultContainer.replaceChildren(this.resultView.element);
    }
  }

  update(code: string) {
    this.codeEditor.update(code);
  }

  dispose() {
    this.disposeResultEffect?.();
    this.resultView?.dispose();
    this.element.textContent = "";
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
