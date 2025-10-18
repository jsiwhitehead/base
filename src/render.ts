import { effect } from "@preact/signals-core";

import {
  type LiteralValue,
  type ListValue,
  type Value,
  type FlowValue,
  type ChildSignal,
  isBlank,
  isLiteral,
  isList,
  isFlow,
  isWritableSignal,
} from "./data";
import { type CellPath } from "./tree";
import { registerBinding, unregisterBinding } from "./input";

function createEl(tag: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.classList.add(className);
  return el;
}

function pathsEqual(a: CellPath, b: CellPath) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

abstract class View<T> {
  abstract readonly viewKind: "literal" | "list" | "flow";
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

class ListView extends View<ListValue> {
  readonly viewKind = "list";
  readonly element: HTMLElement;

  childMountByUid = new Map<number, SignalMount>();
  childPathByUid = new Map<number, CellPath>();
  keyLabelByUid = new Map<number, StringView>();

  constructor(readonly parentPath: CellPath, readonly parentWritable: boolean) {
    super();
    this.element = createEl("div", "list");
  }

  mountChildIfNeeded(
    uid: number,
    child: ChildSignal,
    childPath: CellPath
  ): { el: HTMLElement; focusEl: HTMLElement } {
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

    const el = mount.element;
    const focusEl = mount.view?.focusEl ?? el;
    return { el, focusEl };
  }

  ensureKeyLabel(uid: number, key: string, path: CellPath): StringView {
    const prevPath = this.childPathByUid.get(uid);
    let label = this.keyLabelByUid.get(uid)!;
    const needsRemount = !label || (prevPath && !pathsEqual(prevPath, path));

    if (needsRemount) {
      label?.element.remove();
      label = new StringView("key", key);
      this.keyLabelByUid.set(uid, label);
    } else {
      label.update(key);
    }
    return label;
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

  textGetterFor(child: ChildSignal) {
    if (!isWritableSignal(child)) return;
    return () => {
      const v = child.peek();
      if (isLiteral(v)) return String(v.value);
      if (isFlow(v)) return v.code;
      return "";
    };
  }

  update({ named, plain }: ListValue) {
    const keepUids = new Set<number>([...named, ...plain].map((x) => x.uid));
    this.unmountAllChildrenExcept(keepUids);

    const frag = document.createDocumentFragment();

    for (const { uid, key, child } of named) {
      const path: CellPath = [...this.parentPath, uid];
      const { el, focusEl } = this.mountChildIfNeeded(uid, child, path);
      const keyLabel = this.ensureKeyLabel(uid, key, path);

      registerBinding(path, {
        key: {
          el: keyLabel.element,
          getText: this.parentWritable ? () => key : undefined,
        },
        value: {
          el: focusEl,
          getText: this.textGetterFor(child),
        },
      });

      frag.append(keyLabel.element, el);
    }

    for (const { uid, child } of plain) {
      const path: CellPath = [...this.parentPath, uid];
      const { el, focusEl } = this.mountChildIfNeeded(uid, child, path);

      registerBinding(path, {
        value: {
          el: focusEl,
          keyAnchorEl: this.parentWritable ? el : undefined,
          getText: this.textGetterFor(child),
        },
      });

      frag.append(el);
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    this.unmountAllChildrenExcept();
    this.element.textContent = "";
  }
}

class FlowView extends View<string> {
  readonly viewKind = "flow";
  readonly element: HTMLElement;
  codeEl: HTMLElement;
  resultView?: View<ListValue | string>;
  disposeResultEffect?: () => void;

  constructor(
    readCode: () => string,
    readResult: () => Value,
    readonly flowPath: CellPath
  ) {
    super();
    this.element = createEl("div", "flow");

    this.codeEl = createEl("div", "expr");
    this.codeEl.textContent = readCode();
    this.element.append(this.codeEl);

    this.disposeResultEffect = effect(() => {
      try {
        const resolved = readResult();
        this.element.classList.remove("error");

        if (isList(resolved)) {
          this.ensureResultKind(
            "list",
            () => new ListView(this.flowPath, false)
          );
          (this.resultView as ListView).update(resolved);
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
          throw new Error("Cannot render a FunctionValue");
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
    kind: "list" | "literal",
    build: () => View<ListValue | string>
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
  valueView!: View<ListValue | string>;
  disposeEffect: () => void;

  constructor(readonly signal: ChildSignal, readonly path: CellPath) {
    const ensureKind = (
      kind: "flow" | "list" | "literal",
      build: () => View<ListValue | string>
    ) => {
      if (!this.valueView || this.valueView.viewKind !== kind) {
        this.valueView?.dispose();
        this.valueView = build();
      }
    };

    this.disposeEffect = effect(() => {
      const v = this.signal.get();

      if (isFlow(v)) {
        ensureKind(
          "flow",
          () =>
            new FlowView(
              () => (this.signal.peek() as FlowValue).code,
              () => (this.signal.peek() as FlowValue).result.get(),
              this.path
            )
        );
        this.valueView.update(v.code);
      } else if (isList(v)) {
        ensureKind(
          "list",
          () => new ListView(this.path, isWritableSignal(this.signal))
        );
        this.valueView.update(v);
      } else if (isLiteral(v) || isBlank(v)) {
        const text = isLiteral(v) ? String((v as LiteralValue).value) : "";
        ensureKind("literal", () => new StringView("value", text));
        this.valueView.update(text);
      } else {
        throw new Error("Cannot render a FunctionValue");
      }
    });
  }

  get element() {
    return this.valueView.element;
  }

  get view() {
    return this.valueView;
  }

  dispose() {
    this.disposeEffect();
    this.valueView?.dispose();
  }
}

export default function renderRoot(
  rootSignal: ChildSignal,
  rootPath: CellPath
) {
  const mount = new SignalMount(rootSignal, rootPath);

  registerBinding(rootPath, { value: { el: mount.view.focusEl } });

  const dispose = () => {
    unregisterBinding(rootPath);
    mount.dispose();
  };

  return { mount, dispose };
}
