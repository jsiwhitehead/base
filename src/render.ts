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
  createLiteral,
  createBlank,
  createCode,
  createSignal,
  childToData,
  getKeyOfChild,
  insertBefore,
  insertAfter,
  assignKey,
  removeKey,
  removeChild,
  wrapWithBlock,
  unwrapBlockIfSingleChild,
} from "./data";
import {
  FocusCommandEvent,
  StringCommandEvent,
  BlockCommandEvent,
} from "./input";

export const signalByElement = new WeakMap<HTMLElement, ChildSignal>();

function parseAutoNumber(raw: string): number | undefined {
  const t = raw.trim();
  if (t === "") return undefined;
  const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
  if (!NUM_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

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
    const nextEl = createEl(tag, this.fieldRole, true);

    if (tag === "div") {
      nextEl.textContent =
        this.getText() + (this.fieldRole === "key" ? ":" : "");

      nextEl.addEventListener("mousedown", (e) => {
        if (e.detail === 2) {
          e.preventDefault();
        }
      });

      nextEl.addEventListener("string-command", (ev: Event) => {
        const e = ev as StringCommandEvent;
        if (e.detail.kind === "begin") {
          e.stopPropagation();
          this.toggleEditor("input", e.detail.seed);
          this.element.focus();
        }
      });
    } else {
      const inputEl = nextEl as HTMLInputElement;
      inputEl.value = initialText ?? this.getText();

      inputEl.setAttribute("autocorrect", "off");
      inputEl.setAttribute("autocomplete", "off");
      inputEl.autocapitalize = "off";
      inputEl.spellcheck = false;

      let refocusAfterBlur = false;
      let cancelled = false;

      inputEl.addEventListener("string-command", (ev: Event) => {
        const e = ev as StringCommandEvent;
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
      this.element.textContent = text + (this.fieldRole === "key" ? ":" : "");
    }
  }
}

class ReadonlyBlockView extends View<BlockNode> {
  readonly viewKind = "block";
  readonly element: HTMLElement;
  childMountBySignal = new Map<ChildSignal, SignalMount>();
  orderedChildren: ChildSignal[] = [];
  lastNode?: BlockNode;

  constructor(registerElement: (el: HTMLElement) => void) {
    super();
    this.element = createEl("div", "block");
    registerElement(this.element);

    this.element.addEventListener("focus-command", (ev: Event) => {
      const e = ev as FocusCommandEvent;
      const stop = () => {
        e.stopPropagation();
        e.preventDefault?.();
      };

      if (e.detail.kind === "to") {
        const { targetSignal } = e.detail;
        const mount = this.childMountBySignal.get(targetSignal);
        if (!mount) return;
        stop();
        mount.focus();
        return;
      }

      if (e.detail.kind === "nav") {
        const { dir, from: fromSignal } = e.detail;

        if (dir === "into") {
          stop();
          this.focusFirstChild();
          return;
        }

        if (dir === "out") {
          return;
        }

        if (!this.orderedChildren.includes(fromSignal)) return;

        const idx = this.orderedChildren.indexOf(fromSignal);
        if (idx < 0) return;

        const len = this.orderedChildren.length;
        let targetIndex = idx;

        switch (dir) {
          case "next":
            targetIndex = Math.min(len - 1, idx + 1);
            break;
          case "prev":
            targetIndex = Math.max(0, idx - 1);
            break;
        }

        const target = this.orderedChildren[targetIndex];
        if (!target) return;

        const mount = this.childMountBySignal.get(target);
        if (!mount) return;

        stop();
        mount.focus();
      }
    });
  }

  focusFirstChild(): void {
    const first = this.orderedChildren[0];
    if (first) this.childMountBySignal.get(first)?.focus();
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
        mount.element.remove();
      }
      mount.dispose();
      this.childMountBySignal.delete(childSignal);
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
      const keyLabel = new ReadonlyStringView("key", () => {}, key);
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
    this.element = createEl("div", "block", true);
    registerElement(this.element);

    this.element.addEventListener("focus-command", (ev: Event) => {
      const e = ev as FocusCommandEvent;
      const stop = () => {
        e.stopPropagation();
        e.preventDefault?.();
      };

      if (e.detail.kind === "to") {
        const { targetSignal, role } = e.detail;
        const mount = this.childMountBySignal.get(targetSignal);
        if (!mount) return;

        if (role === "key") {
          stop();
          const editor = this.ensureKeyEditor(targetSignal);

          if (!getKeyOfChild(this.ownerSignal.peek(), targetSignal)) {
            this.tempKeySignal = targetSignal;
            if (this.lastNode) this.update(this.lastNode);
          }

          if (editor.element.tagName !== "INPUT") editor.toggleEditor("input");
          editor.element.focus();
          return;
        }

        stop();
        mount.focus();
        return;
      }

      if (e.detail.kind === "nav") {
        const { dir, from: fromSignal } = e.detail;

        if (dir === "into" && fromSignal === this.ownerSignal) {
          stop();
          const first = this.orderedChildren[0];
          if (!first) return;
          const mount = this.childMountBySignal.get(first);
          mount?.focus();
          return;
        }

        if (dir === "out" && this.childMountBySignal.has(fromSignal)) {
          stop();
          this.element.focus();
          return;
        }

        if (!this.orderedChildren.includes(fromSignal)) return;

        const idx = this.orderedChildren.indexOf(fromSignal);
        if (idx < 0) return;

        const len = this.orderedChildren.length;
        let targetIndex = idx;

        switch (dir) {
          case "next":
            targetIndex = Math.min(len - 1, idx + 1);
            break;
          case "prev":
            targetIndex = Math.max(0, idx - 1);
            break;
        }

        const target = this.orderedChildren[targetIndex];
        if (!target) return;

        const mount = this.childMountBySignal.get(target);
        if (!mount) return;

        stop();
        mount.focus();
      }
    });

    this.element.addEventListener("block-command", (ev: Event) => {
      const e = ev as BlockCommandEvent;
      const { kind, target } = e.detail;

      if (!this.childMountBySignal.has(target)) return;

      e.stopPropagation();

      const parentSignal = this.ownerSignal;
      const parentBlock = parentSignal.peek();

      const orderedBefore = [
        ...parentBlock.values.map(([, v]) => v),
        ...parentBlock.items,
      ];
      const idx = orderedBefore.indexOf(target);

      let nextFocus: ChildSignal | undefined;
      let updated: BlockNode = parentBlock;

      switch (kind) {
        case "insert-before": {
          const newItem = createSignal(createBlank());
          updated = insertBefore(parentBlock, target, newItem);
          nextFocus = newItem;
          break;
        }
        case "insert-after": {
          const newItem = createSignal(createBlank());
          updated = insertAfter(parentBlock, target, newItem);
          nextFocus = newItem;
          break;
        }
        case "wrap": {
          updated = wrapWithBlock(parentBlock, target);
          nextFocus = target;
          break;
        }
        case "unwrap": {
          const beforeNode = target.peek();
          updated = unwrapBlockIfSingleChild(parentBlock, target);
          if (updated !== parentBlock && isBlock(beforeNode)) {
            const { items, values } = beforeNode;
            if (values.length === 0 && items.length === 1) {
              nextFocus = items[0]!;
            }
          }
          break;
        }
        case "remove": {
          const neighbor =
            orderedBefore[idx - 1] ?? orderedBefore[idx + 1] ?? parentSignal;
          updated = removeChild(parentBlock, target);
          nextFocus = neighbor;
          break;
        }
      }

      if (updated !== parentBlock) {
        parentSignal.set(updated);
      }

      if (nextFocus) {
        this.element.dispatchEvent(
          new FocusCommandEvent({
            kind: "to",
            targetSignal: nextFocus,
            role: "auto",
          })
        );
      }
    });
  }

  ensureKeyEditor(sig: ChildSignal): StringView {
    let editor = this.keyEditorBySignal.get(sig);
    if (!editor) {
      editor = new StringView(
        "key",
        () => getKeyOfChild(this.ownerSignal.peek(), sig) ?? "",
        (nextKey) => {
          const parentBlock = this.ownerSignal.peek();

          const trimmed = nextKey.trim();
          const updated =
            trimmed === ""
              ? removeKey(parentBlock, sig)
              : assignKey(parentBlock, sig, trimmed);

          if (updated !== parentBlock) {
            this.ownerSignal.set(updated);
          }

          this.tempKeySignal = null;
          if (this.lastNode) this.update(this.lastNode);
        },
        (el) => signalByElement.set(el, sig),
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

    this.element.addEventListener("mousedown", (e) => {
      if (e.target === this.element) {
        e.preventDefault();
        this.codeEditor.element.focus();
      }
    });

    this.element.addEventListener("focus-command", (ev: Event) => {
      const e = ev as FocusCommandEvent;
      if (e.detail.kind !== "nav") return;

      if (e.detail.dir === "into") {
        if (this.resultView?.viewKind === "block") {
          e.stopPropagation();
          e.preventDefault?.();
          (this.resultView as ReadonlyBlockView).focusFirstChild();
        }
      }

      if (e.detail.dir === "out") {
        if (e.target !== this.codeEditor.element) {
          e.stopPropagation();
          e.preventDefault?.();
          this.codeEditor.element.focus();
        }
      }
    });

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
      signalByElement.set(el, signal);

    const ensureKind = (
      kind: "code" | "block" | "literal" | "readonly",
      build: () => View<BlockNode | string>
    ) => {
      if (!this.nodeView || this.nodeView.viewKind !== kind) {
        this.nodeView?.dispose();
        this.nodeView = build();
      }
    };

    const readLiteralText = () => {
      const cur = this.signal.peek();
      return isLiteral(cur) ? String((cur as LiteralNode).value) : "";
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
      } else if (isLiteral(n)) {
        if (isWritableSignal(this.signal)) {
          ensureKind(
            "literal",
            () =>
              new StringView(
                "value",
                readLiteralText,
                (next) =>
                  (this.signal as WriteSignal<DataNode>).set(
                    next.trim() === ""
                      ? createBlank()
                      : createLiteral(parseAutoNumber(next) ?? next)
                  ),
                registerElementSignal
              )
          );
          this.nodeView.update(String(n.value));
        } else {
          ensureKind(
            "readonly",
            () =>
              new ReadonlyStringView(
                "value",
                registerElementSignal,
                String((this.signal.peek() as LiteralNode).value)
              )
          );
          this.nodeView.update(String(n.value));
        }
      } else if (isBlank(n)) {
        if (isWritableSignal(this.signal)) {
          ensureKind(
            "literal",
            () =>
              new StringView(
                "value",
                readLiteralText,
                (next) =>
                  (this.signal as WriteSignal<DataNode>).set(
                    next.trim() === ""
                      ? createBlank()
                      : createLiteral(parseAutoNumber(next) ?? next)
                  ),
                registerElementSignal
              )
          );
          this.nodeView.update("");
        } else {
          ensureKind(
            "readonly",
            () => new ReadonlyStringView("value", registerElementSignal, "")
          );
          this.nodeView.update("");
        }
      } else {
        throw new Error("Cannot render a FunctionNode");
      }
    });
  }

  get element() {
    return this.nodeView.element;
  }

  focus() {
    if (this.nodeView.viewKind === "code") {
      (this.nodeView as CodeView).codeEditor.element.focus();
      return;
    }
    this.nodeView.element.focus();
  }

  dispose() {
    this.disposeEffect();
    this.nodeView.dispose();
  }
}
