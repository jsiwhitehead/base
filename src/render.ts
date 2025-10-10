import { effect } from "@preact/signals-core";

import {
  type LiteralNode,
  type BlockNode,
  type DataNode,
  type CodeNode,
  type ChildSignal,
  isBlank,
  isLiteral,
  isBlock,
  isCode,
  isWritableSignal,
} from "./data";
import { type NodePath } from "./tree";
import { registerBinding, unregisterBinding } from "./input";

function createEl(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.classList.add(className);
  return node;
}

function pathsEqual(a: NodePath, b: NodePath) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

abstract class View<T> {
  abstract readonly viewKind: "literal" | "block" | "code";
  abstract readonly element: HTMLElement;
  abstract update(next: T): void;
  dispose() {}

  get focusEl(): HTMLElement {
    return this.element;
  }
}

class StringView extends View<string> {
  readonly viewKind = "literal";
  readonly element: HTMLElement;

  constructor(readonly fieldRole: "value" | "key", initialText: string) {
    super();
    this.element = createEl("div", this.fieldRole);
    this.element.textContent = this.format(initialText);
  }

  format(text: string): string {
    return this.fieldRole === "key" ? `${text}:` : text;
  }

  update(text: string) {
    this.element.textContent = this.format(text);
  }
}

class BlockView extends View<BlockNode> {
  readonly viewKind = "block";
  readonly element: HTMLElement;

  childMountByUid = new Map<number, SignalMount>();
  childPathByUid = new Map<number, NodePath>();
  keyLabelByUid = new Map<number, StringView>();

  constructor(
    readonly parentPath: NodePath,
    readonly mode: "editable" | "readonly"
  ) {
    super();
    this.element = createEl("div", "block");
  }

  mountChildIfNeeded(uid: number, child: ChildSignal, childPath: NodePath) {
    let mount = this.childMountByUid.get(uid);

    if (!mount || mount.signal !== child) {
      if (mount) {
        const oldPath = this.childPathByUid.get(uid)!;
        if (this.element.contains(mount.element)) {
          unregisterBinding(oldPath);
          mount.element.remove();
        }
        mount.dispose();
      }
      mount = new SignalMount(child, childPath);
      this.childMountByUid.set(uid, mount);
      this.childPathByUid.set(uid, childPath);
    } else {
      const prevPath = this.childPathByUid.get(uid);
      if (!prevPath || !pathsEqual(prevPath, childPath)) {
        unregisterBinding(prevPath!);
        this.childPathByUid.set(uid, childPath);
      }
    }

    return mount.element;
  }

  unmountAllChildrenExcept(keepUids?: Set<number>) {
    for (const [uid, mount] of Array.from(this.childMountByUid)) {
      if (keepUids?.has(uid)) continue;

      const path = this.childPathByUid.get(uid)!;
      if (this.element.contains(mount.element)) {
        unregisterBinding(path);
        mount.element.remove();
      }
      mount.dispose();
      this.childMountByUid.delete(uid);
      this.childPathByUid.delete(uid);

      const keyView = this.keyLabelByUid.get(uid);
      if (keyView) {
        keyView.element.remove();
        this.keyLabelByUid.delete(uid);
      }
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
      const uid = v.uid;
      const childPath: NodePath = [...this.parentPath, uid];

      const prevPath = this.childPathByUid.get(uid);
      const valueContainerEl = this.mountChildIfNeeded(uid, v.child, childPath);

      let keyLabel = this.keyLabelByUid.get(uid);
      const needsRemount =
        !keyLabel || (prevPath && !pathsEqual(prevPath, childPath));

      if (needsRemount) {
        if (keyLabel) keyLabel.element.remove();
        keyLabel = new StringView("key", v.key);
        this.keyLabelByUid.set(uid, keyLabel);
      } else {
        keyLabel!.update(v.key);
      }

      const mount = this.childMountByUid.get(uid)!;
      const focusEl =
        (mount as any).view?.focusEl instanceof HTMLElement
          ? (mount as any).view.focusEl
          : valueContainerEl;

      const keyEditable =
        this.mode === "editable"
          ? {
              getText: () => v.key,
            }
          : undefined;

      let valueEditable: { getText: () => string } | undefined;
      if (this.mode === "editable" && isWritableSignal(v.child)) {
        valueEditable = {
          getText: () => {
            const cur = v.child.peek();
            if (isLiteral(cur)) return String((cur as LiteralNode).value);
            if (isCode(cur)) return (cur as CodeNode).code;
            return "";
          },
        };
      }

      registerBinding(childPath, {
        key: { el: keyLabel!.element, editable: keyEditable },
        value: { el: focusEl, editable: valueEditable },
      });

      frag.append(keyLabel!.element, valueContainerEl);
    }

    for (const i of items) {
      const childPath: NodePath = [...this.parentPath, i.uid];
      const containerEl = this.mountChildIfNeeded(i.uid, i.child, childPath);

      const mount = this.childMountByUid.get(i.uid)!;
      const focusEl =
        (mount as any).view?.focusEl instanceof HTMLElement
          ? (mount as any).view.focusEl
          : containerEl;

      let valueEditable:
        | { getText: () => string; anchorEl?: HTMLElement }
        | undefined;

      if (this.mode === "editable") {
        valueEditable = {
          getText: () => {
            const cur = i.child.peek();
            if (isLiteral(cur)) return String((cur as LiteralNode).value);
            if (isCode(cur)) return (cur as CodeNode).code;
            return "";
          },
          anchorEl: containerEl,
        };
      }

      registerBinding(childPath, {
        value: { el: focusEl, editable: valueEditable },
      });

      frag.append(containerEl);
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
  codeEl: HTMLElement;
  resultView?: View<BlockNode | string>;
  disposeResultEffect?: () => void;

  constructor(
    readCode: () => string,
    readResult: () => DataNode,
    readonly codeNodePath: NodePath
  ) {
    super();
    this.element = createEl("div", "code");

    this.codeEl = createEl("div", "expr");
    this.codeEl.textContent = readCode();
    this.element.append(this.codeEl);

    this.disposeResultEffect = effect(() => {
      try {
        const resolved = readResult();
        this.element.classList.remove("error");

        if (isBlock(resolved)) {
          this.ensureResultKind(
            "block",
            () => new BlockView(this.codeNodePath, "readonly")
          );
          (this.resultView as BlockView).update(resolved);
        } else if (isLiteral(resolved)) {
          this.ensureResultKind(
            "literal",
            () => new StringView("value", String(resolved.value))
          );
          this.resultView!.update(String(resolved.value));
        } else if (isBlank(resolved)) {
          this.ensureResultKind("literal", () => new StringView("value", ""));
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

  get focusEl(): HTMLElement {
    return this.codeEl;
  }

  ensureResultKind(
    kind: "block" | "literal",
    build: () => View<BlockNode | string>
  ) {
    if (!this.resultView || this.resultView.viewKind !== kind) {
      const next = build();
      if (this.resultView) {
        this.resultView.dispose();
        this.resultView.element.replaceWith(next.element);
      } else {
        this.codeEl.insertAdjacentElement("afterend", next.element);
      }
      this.resultView = next;
    }
  }

  update(code: string) {
    this.codeEl.textContent = code;
  }

  dispose() {
    this.disposeResultEffect?.();
    this.resultView?.dispose();
    this.element.textContent = "";
  }
}

class SignalMount {
  nodeView!: View<BlockNode | string>;
  disposeEffect: () => void;

  constructor(readonly signal: ChildSignal, readonly path: NodePath) {
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
      const n = this.signal.get();

      if (isCode(n)) {
        ensureKind(
          "code",
          () =>
            new CodeView(
              () => (this.signal.peek() as CodeNode).code,
              () => (this.signal.peek() as CodeNode).result.get(),
              this.path
            )
        );
        this.nodeView.update(n.code);
      } else if (isBlock(n)) {
        ensureKind(
          "block",
          () =>
            new BlockView(
              this.path,
              isWritableSignal(this.signal) ? "editable" : "readonly"
            )
        );
        this.nodeView.update(n);
      } else if (isLiteral(n) || isBlank(n)) {
        const text = isLiteral(n) ? String((n as LiteralNode).value) : "";
        ensureKind("literal", () => new StringView("value", text));
        this.nodeView.update(text);
      } else {
        throw new Error("Cannot render a FunctionNode");
      }
    });
  }

  get element() {
    return this.nodeView.element;
  }

  get view() {
    return this.nodeView;
  }

  dispose() {
    this.disposeEffect();
    this.nodeView?.dispose();
  }
}

export default function renderRoot(
  rootSignal: ChildSignal,
  rootPath: NodePath
) {
  const mount = new SignalMount(rootSignal, rootPath);

  registerBinding(rootPath, { value: { el: mount.view.focusEl } });

  const dispose = () => {
    unregisterBinding(rootPath);
    mount.dispose();
  };

  return { mount, dispose };
}
