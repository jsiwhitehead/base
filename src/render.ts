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
} from "./data";
import { type NodePath, assignKey, removeKey } from "./tree";
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

  childMountByUid = new Map<number, SignalMount>();
  childPathByUid = new Map<number, NodePath>();

  constructor(
    readonly parentPath: NodePath,
    readonly registerSelf: boolean = true
  ) {
    super();
    this.element = createEl("div", "block");
    if (this.registerSelf) {
      registerFocusable(this.parentPath, this.element);
    }
  }

  mountChildIfNeeded(uid: number, child: ChildSignal, childPath: NodePath) {
    let mount = this.childMountByUid.get(uid);

    if (!mount || mount.signal !== child) {
      if (mount) {
        const oldPath = this.childPathByUid.get(uid)!;
        if (this.element.contains(mount.element)) {
          unregisterFocusable(oldPath);
          mount.element.remove();
        }
        mount.dispose();
      }
      mount = new SignalMount(child, childPath);
      this.childMountByUid.set(uid, mount);
      this.childPathByUid.set(uid, childPath);
    } else {
      this.childPathByUid.set(uid, childPath);
    }

    return mount.element;
  }

  unmountAllChildrenExcept(keepUids?: Set<number>) {
    for (const [uid, mount] of Array.from(this.childMountByUid)) {
      if (keepUids?.has(uid)) continue;

      const path = this.childPathByUid.get(uid)!;
      if (this.element.contains(mount.element)) {
        unregisterFocusable(path);
        mount.element.remove();
      }
      mount.dispose();
      this.childMountByUid.delete(uid);
      this.childPathByUid.delete(uid);
    }
  }

  update(node: BlockNode) {
    const { values, items } = node;

    const keepUids = new Set<number>([
      ...values.map((v) => v.uid),
      ...items.map((i) => i.uid),
    ]);
    this.unmountAllChildrenExcept(keepUids);

    const frag = document.createDocumentFragment();

    for (const v of values) {
      const childPath: NodePath = [...this.parentPath, v.uid];

      const keyLabel = new ReadonlyStringView(
        "key",
        (el) => registerFocusable(childPath, el),
        v.key
      );

      frag.append(
        keyLabel.element,
        this.mountChildIfNeeded(v.uid, v.child, childPath)
      );
    }

    for (const i of items) {
      const childPath: NodePath = [...this.parentPath, i.uid];
      frag.append(this.mountChildIfNeeded(i.uid, i.child, childPath));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    if (this.registerSelf) {
      unregisterFocusable(this.parentPath);
    }
    this.element.textContent = "";
  }
}

class BlockView extends View<BlockNode> {
  readonly viewKind = "block";
  readonly element: HTMLElement;

  childMountByUid = new Map<number, SignalMount>();
  childPathByUid = new Map<number, NodePath>();
  keyEditorByUid = new Map<number, StringView>();
  tempKeyUid: number | null = null;
  lastNode?: BlockNode;

  onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || e.shiftKey) return;

    const target = e.target as HTMLElement | null;
    if (!target || target.tagName === "INPUT") return;

    const uid = this.findUidForElement(target);
    if (uid == null) return;

    e.preventDefault();
    e.stopPropagation();
    this.openTempKeyEditor(uid);
  };

  constructor(
    readonly ownerSignal: WriteSignal<BlockNode>,
    readonly parentPath: NodePath
  ) {
    super();
    this.element = createEl("div", "block");
    registerFocusable(this.parentPath, this.element);
    this.element.addEventListener("keydown", this.onKeyDown);
  }

  findUidForElement(el: HTMLElement): number | null {
    for (const [uid, mount] of this.childMountByUid) {
      if (mount.element.contains(el)) return uid;
    }
    return null;
  }

  openTempKeyEditor(uid: number) {
    this.tempKeyUid = uid;

    const childPath: NodePath = [...this.parentPath, uid];
    const ed = this.ensureKeyEditor(uid, childPath);
    if (ed.element.tagName !== "INPUT") {
      ed.toggleEditor("input");
    }

    this.update(this.ownerSignal.peek());
  }

  ensureKeyEditor(uid: number, childPath: NodePath): StringView {
    let editor = this.keyEditorByUid.get(uid);
    if (!editor) {
      editor = new StringView(
        "key",
        () => {
          const cur = this.ownerSignal.peek();
          const v = cur.values.find((v) => v.uid === uid);
          return v ? v.key : "";
        },
        (nextKey) => {
          const trimmed = nextKey.trim();
          if (trimmed === "") {
            removeKey(childPath);
          } else {
            assignKey(childPath, trimmed);
          }
          this.tempKeyUid = null;
          if (this.lastNode) this.update(this.lastNode);
        },
        (el) => registerFocusable(childPath, el),
        () => {
          this.tempKeyUid = null;
          if (this.lastNode) this.update(this.lastNode);
        }
      );
      this.keyEditorByUid.set(uid, editor);
    }
    return editor;
  }

  mountChildIfNeeded(uid: number, child: ChildSignal, childPath: NodePath) {
    let mount = this.childMountByUid.get(uid);

    if (!mount || mount.signal !== child) {
      if (mount) {
        const oldPath = this.childPathByUid.get(uid)!;
        if (this.element.contains(mount.element)) {
          unregisterFocusable(oldPath);
          mount.element.remove();
        }
        mount.dispose();
      }
      mount = new SignalMount(child, childPath);
      this.childMountByUid.set(uid, mount);
      this.childPathByUid.set(uid, childPath);
    } else {
      this.childPathByUid.set(uid, childPath);
    }

    return mount.element;
  }

  unmountAllChildrenExcept(keepUids?: Set<number>) {
    for (const [uid, mount] of Array.from(this.childMountByUid)) {
      if (keepUids?.has(uid)) continue;

      const path = this.childPathByUid.get(uid)!;
      if (this.element.contains(mount.element)) {
        unregisterFocusable(path);
        mount.element.remove();
      }
      mount.dispose();
      this.childMountByUid.delete(uid);
      this.childPathByUid.delete(uid);
    }

    if (
      keepUids &&
      this.tempKeyUid !== null &&
      !keepUids.has(this.tempKeyUid)
    ) {
      this.tempKeyUid = null;
    }
  }

  update(node: BlockNode) {
    this.lastNode = node;
    const { values, items } = node;

    const keepUids = new Set<number>([
      ...values.map((v) => v.uid),
      ...items.map((i) => i.uid),
    ]);
    this.unmountAllChildrenExcept(keepUids);

    const frag = document.createDocumentFragment();

    for (const v of values) {
      const childPath: NodePath = [...this.parentPath, v.uid];
      const editor = this.ensureKeyEditor(v.uid, childPath);
      editor.update(v.key);
      frag.append(
        editor.element,
        this.mountChildIfNeeded(v.uid, v.child, childPath)
      );
    }

    for (const i of items) {
      const childPath: NodePath = [...this.parentPath, i.uid];
      if (this.tempKeyUid === i.uid) {
        const ed = this.ensureKeyEditor(i.uid, childPath);
        if (ed.element.tagName !== "INPUT") ed.toggleEditor("input");
        frag.append(ed.element);
      }
      frag.append(this.mountChildIfNeeded(i.uid, i.child, childPath));
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    this.tempKeyUid = null;
    unregisterFocusable(this.parentPath);
    this.element.removeEventListener("keydown", this.onKeyDown);
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
    readResult: () => DataNode,
    readonly codeNodePath: NodePath
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
        const resolved = readResult();
        this.element.classList.remove("error");

        if (isBlock(resolved)) {
          this.ensureResultKind(
            "block",
            () => new ReadonlyBlockView(this.codeNodePath, false)
          );
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

  constructor(readonly signal: ChildSignal, readonly path: NodePath) {
    const registerElementForThisNode = (el: HTMLElement) =>
      registerFocusable(this.path, el);

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
              (next) => {
                const cur = this.signal.peek() as CodeNode;
                (this.signal as WriteSignal<CodeNode>).set({
                  kind: "code",
                  code: next,
                  result: cur.result,
                });
              },
              registerElementForThisNode,
              () => (this.signal.peek() as CodeNode).result.get(),
              this.path
            )
        );
        this.nodeView.update(n.code);
      } else if (isBlock(n)) {
        if (isWritableSignal(this.signal)) {
          ensureKind(
            "block",
            () =>
              new BlockView(this.signal as WriteSignal<BlockNode>, this.path)
          );
        } else {
          ensureKind("block", () => new ReadonlyBlockView(this.path));
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
                registerElementForThisNode
              )
          );
        } else {
          ensureKind(
            "readonly",
            () =>
              new ReadonlyStringView("value", registerElementForThisNode, text)
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
    if (this.nodeView?.element) {
      unregisterFocusable(this.path);
    }
    this.disposeEffect();
    this.nodeView?.dispose();
  }
}
