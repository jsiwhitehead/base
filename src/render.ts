import { effect } from "@preact/signals-core";

import {
  type LiteralNode,
  type BlockNode,
  type DataNode,
  type CodeNode,
  type WriteSignal,
  type ChildSignal,
  isBlank,
  isLiteral,
  isBlock,
  isCode,
  isWritableSignal,
  createBlank,
  createLiteral,
  createCode,
  childToData,
  getKeyOfChild,
  assignKey,
  removeKey,
} from "./data";
import { registerFocusable, unregisterFocusable } from "./input";

function parseAutoNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  if (!NUM_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function createEl(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.classList.add(className);
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
    this.element.textContent = initial + (this.fieldRole === "key" ? ":" : "");
    this.registerElement(this.element);
  }

  update(text: string) {
    this.element.textContent = text + (this.fieldRole === "key" ? ":" : "");
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
    const nextEl = createEl(tag, this.fieldRole);

    if (tag === "div") {
      nextEl.textContent =
        this.getText() + (this.fieldRole === "key" ? ":" : "");

      nextEl.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.toggleEditor("input");
      });

      nextEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          this.toggleEditor("input");
          return;
        }
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          this.toggleEditor("input", e.key);
          return;
        }
      });
    } else {
      const inputEl = nextEl as HTMLInputElement;

      inputEl.value = initialText ?? this.getText();

      inputEl.setAttribute("autocorrect", "off");
      inputEl.setAttribute("autocomplete", "off");
      inputEl.autocapitalize = "off";
      inputEl.spellcheck = false;

      let cancelled = false;

      inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        switch (e.key) {
          case "Enter":
          case "Tab": {
            e.preventDefault();
            e.stopPropagation();
            inputEl.blur();
            break;
          }
          case "Escape": {
            e.preventDefault();
            e.stopPropagation();
            inputEl.value = this.getText();
            cancelled = true;
            inputEl.blur();
            break;
          }
        }
      });

      inputEl.addEventListener("blur", () => {
        const doCommit = !cancelled;
        setTimeout(() => {
          if (doCommit) {
            this.commitText(inputEl.value);
          } else {
            this.onCancel?.();
          }
          this.toggleEditor("div");
        }, 0);
      });

      queueMicrotask(() => {
        inputEl.focus({ preventScroll: true });
        const len = inputEl.value.length;
        inputEl.setSelectionRange(len, len);
      });
    }

    if (this.element) this.element.replaceWith(nextEl);
    this.element = nextEl;
    this.registerElement(this.element);
  }

  update(text: string) {
    if (this.element.tagName === "DIV") {
      this.element.textContent = text + (this.fieldRole === "key" ? ":" : "");
    }
  }
}

class ReadonlyBlockView extends View<BlockNode> {
  readonly viewKind = "block";
  readonly element: HTMLElement;
  childMountBySignal = new Map<ChildSignal, SignalMount>();
  orderedChildren: ChildSignal[] = [];

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = createEl("div", "block");
    registerElement(this.element);
  }

  mountChildIfNeeded(child: ChildSignal) {
    let mount = this.childMountBySignal.get(child);
    if (!mount) {
      mount = new SignalMount(child);
      this.childMountBySignal.set(child, mount);
    }
    return mount.element;
  }

  unmountAllChildrenExcept(keep?: Set<ChildSignal>) {
    for (const [childSignal, mount] of Array.from(this.childMountBySignal)) {
      if (keep?.has(childSignal)) continue;

      if (this.element.contains(mount.element)) {
        unregisterFocusable(childSignal, mount.element);
        mount.element.remove();
      }
      mount.dispose();
      this.childMountBySignal.delete(childSignal);
    }
  }

  update(node: BlockNode) {
    const { values, items } = node;

    const childrenToKeep = new Set<ChildSignal>([
      ...values.map(([, v]) => v),
      ...items,
    ]);
    this.unmountAllChildrenExcept(childrenToKeep);

    this.orderedChildren = [...values.map(([, v]) => v), ...items];

    const frag = document.createDocumentFragment();

    for (const [key, childSignal] of values) {
      const keyLabel = new ReadonlyStringView(
        "key",
        (el) => registerFocusable(childSignal, el),
        key
      );
      frag.append(keyLabel.element, this.mountChildIfNeeded(childSignal));
    }

    for (const childSignal of items) {
      frag.append(this.mountChildIfNeeded(childSignal));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    this.element.textContent = "";
  }
}

class BlockView extends View<BlockNode> {
  readonly viewKind = "block";
  readonly element: HTMLElement;
  childMountBySignal = new Map<ChildSignal, SignalMount>();
  keyEditorBySignal = new WeakMap<ChildSignal, StringView>();
  tempKeySignal: ChildSignal | null = null;

  orderedChildren: ChildSignal[] = [];
  lastNode?: BlockNode;

  constructor(
    readonly ownerSignal: WriteSignal<BlockNode>,
    registerElement: (el: HTMLElement) => void
  ) {
    super();
    this.element = createEl("div", "block");
    registerElement(this.element);
  }

  ensureKeyEditor(sig: ChildSignal): StringView {
    let editor = this.keyEditorBySignal.get(sig);
    if (!editor) {
      editor = new StringView(
        "key",
        () => getKeyOfChild(this.ownerSignal.peek(), sig) ?? "",
        (nextKey) => {
          const trimmed = nextKey.trim();

          if (trimmed === "") {
            removeKey(sig);
          } else {
            assignKey(sig, trimmed);
          }

          this.tempKeySignal = null;
          if (this.lastNode) this.update(this.lastNode);
        },
        (el) => registerFocusable(sig, el),
        () => {
          this.tempKeySignal = null;
          if (this.lastNode) this.update(this.lastNode);
        }
      );
      this.keyEditorBySignal.set(sig, editor);
    }
    return editor;
  }

  mountChildIfNeeded(child: ChildSignal) {
    let mount = this.childMountBySignal.get(child);
    if (!mount) {
      mount = new SignalMount(child);
      this.childMountBySignal.set(child, mount);
    }
    return mount.element;
  }

  unmountAllChildrenExcept(keep?: Set<ChildSignal>) {
    for (const [childSignal, mount] of Array.from(this.childMountBySignal)) {
      if (keep?.has(childSignal)) continue;

      if (this.element.contains(mount.element)) {
        unregisterFocusable(childSignal, mount.element);
        mount.element.remove();
      }
      mount.dispose();
      this.childMountBySignal.delete(childSignal);
    }

    if (keep && this.tempKeySignal && !keep.has(this.tempKeySignal)) {
      this.tempKeySignal = null;
    }
  }

  update(node: BlockNode) {
    this.lastNode = node;
    const { values, items } = node;

    const childrenToKeep = new Set<ChildSignal>([
      ...values.map(([, v]) => v),
      ...items,
    ]);
    this.unmountAllChildrenExcept(childrenToKeep);

    this.orderedChildren = [...values.map(([, v]) => v), ...items];

    const frag = document.createDocumentFragment();

    for (const [key, childSignal] of values) {
      const editor = this.ensureKeyEditor(childSignal);
      editor.update(key);
      frag.append(editor.element, this.mountChildIfNeeded(childSignal));
    }

    for (const childSignal of items) {
      if (this.tempKeySignal === childSignal) {
        const ed = this.ensureKeyEditor(childSignal);
        if (ed.element.tagName !== "INPUT") ed.toggleEditor("input");
        frag.append(ed.element);
      }
      frag.append(this.mountChildIfNeeded(childSignal));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    this.tempKeySignal = null;
    this.element.textContent = "";
  }
}

class CodeView extends View<string> {
  readonly viewKind = "code";
  readonly element: HTMLElement;
  codeEditor: StringView;
  resultView?: View<BlockNode | string>;
  disposeResultEffect?: () => void;

  constructor(
    readCode: () => string,
    applyCode: (text: string) => void,
    registerElement: (el: HTMLElement) => void,
    readResolved: () => DataNode
  ) {
    super();
    this.element = createEl("div", "code");
    this.codeEditor = new StringView(
      "expr",
      readCode,
      applyCode,
      registerElement
    );
    this.element.append(this.codeEditor.element);

    this.disposeResultEffect = effect(() => {
      try {
        const resolved = readResolved();
        this.element.classList.remove("error");

        if (isBlock(resolved)) {
          this.ensureResultKind("block", () => new ReadonlyBlockView(() => {}));
          (this.resultView as ReadonlyBlockView).update(resolved);
        } else if (isLiteral(resolved)) {
          this.ensureResultKind(
            "readonly",
            () =>
              new ReadonlyStringView("value", () => {}, String(resolved.value))
          );
          this.resultView!.update(String(resolved.value));
        } else if (isBlank(resolved)) {
          this.ensureResultKind(
            "readonly",
            () => new ReadonlyStringView("value", () => {}, "")
          );
          this.resultView!.update("");
        } else {
          throw new Error("Cannot render a FunctionNode");
        }
      } catch {
        this.element.classList.add("error");
        this.resultView?.dispose();
        this.resultView?.element.remove();
        this.resultView = undefined;
      }
    });
  }

  ensureResultKind(
    kind: "block" | "readonly",
    build: () => View<BlockNode | string>
  ) {
    if (!this.resultView || this.resultView.viewKind !== kind) {
      const next = build();
      if (this.resultView) {
        this.resultView.dispose();
        this.resultView.element.replaceWith(next.element);
      } else {
        this.codeEditor.element.insertAdjacentElement("afterend", next.element);
      }
      this.resultView = next;
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

export class SignalMount {
  nodeView!: View<BlockNode | string>;
  disposeEffect: () => void;

  constructor(readonly signal: ChildSignal) {
    const registerElementSignal = (el: HTMLElement) =>
      registerFocusable(signal, el);

    const ensureKind = (
      kind: "code" | "block" | "literal" | "readonly",
      build: () => View<BlockNode | string>
    ) => {
      if (!this.nodeView || this.nodeView.viewKind !== kind) {
        this.nodeView?.dispose();
        this.nodeView = build();
      }
    };

    this.disposeEffect = effect(() => {
      const n = this.signal.get();

      if (isCode(n)) {
        ensureKind(
          "code",
          () =>
            new CodeView(
              () => (this.signal.peek() as CodeNode).code,
              (next) =>
                (this.signal as WriteSignal<CodeNode>).set(createCode(next)),
              registerElementSignal,
              () => {
                const d = childToData(this.signal);
                if (!d) throw new Error("Code produced no value");
                return d;
              }
            )
        );
        this.nodeView.update(n.code);
      } else if (isBlock(n)) {
        if (isWritableSignal(this.signal)) {
          ensureKind(
            "block",
            () =>
              new BlockView(
                this.signal as WriteSignal<BlockNode>,
                registerElementSignal
              )
          );
        } else {
          ensureKind(
            "block",
            () => new ReadonlyBlockView(registerElementSignal)
          );
        }
        this.nodeView.update(n);
      } else if (isLiteral(n) || isBlank(n)) {
        const text = isLiteral(n) ? String(n.value) : "";

        if (isWritableSignal(this.signal)) {
          ensureKind(
            "literal",
            () =>
              new StringView(
                "value",
                () => {
                  const cur = this.signal.peek();
                  return isLiteral(cur)
                    ? String((cur as LiteralNode).value)
                    : "";
                },
                (next) =>
                  (this.signal as WriteSignal<DataNode>).set(
                    next.trim() === ""
                      ? createBlank()
                      : createLiteral(parseAutoNumber(next) ?? next)
                  ),
                registerElementSignal
              )
          );
        } else {
          ensureKind(
            "readonly",
            () => new ReadonlyStringView("value", registerElementSignal, text)
          );
        }

        this.nodeView.update(text);
      } else {
        throw new Error("Cannot render a FunctionNode");
      }
    });
  }

  get element() {
    return this.nodeView.element;
  }

  dispose() {
    if (this.nodeView.element) {
      unregisterFocusable(this.signal, this.nodeView.element);
    }
    this.disposeEffect();
    this.nodeView.dispose();
  }
}
