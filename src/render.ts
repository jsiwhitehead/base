import { effect } from "@preact/signals-core";

import {
  type BlankValue,
  type LiteralValue,
  type ListValue,
  type Value,
  type FlowValue,
  type ValueSignal,
  type Cell,
  isError,
  isLiteral,
  isList,
  isFunction,
  isFlow,
  isWritableSignal,
  createLiteral,
} from "./data";
import { type CellPath } from "./tree";
import { registerBinding, unregisterBinding } from "./input";

function createEl(tag: string, className?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.classList.add(className);
  return el;
}

function createTextInput(className?: string, value?: string): HTMLInputElement {
  const input = document.createElement("input");
  if (className) input.classList.add(className);
  if (value != null) input.value = value;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.autocorrect = "off" as any;
  input.spellcheck = false;
  return input;
}

class AutosizeInput {
  element: HTMLElement;
  input: HTMLInputElement;
  mirror: HTMLSpanElement;

  constructor(initialText: string) {
    const wrap = createEl("div", "autosize");
    const mirror = createEl("span") as HTMLSpanElement;
    mirror.setAttribute("aria-hidden", "true");
    mirror.textContent = initialText || " ";

    const input = createTextInput(undefined, initialText);
    input.addEventListener("input", () => {
      mirror.textContent = input.value || " ";
    });

    wrap.append(mirror, input);

    this.element = wrap;
    this.input = input;
    this.mirror = mirror;
  }

  update(text: string) {
    this.input.value = text;
    this.mirror.textContent = text || " ";
  }

  get focusEl() {
    return this.input;
  }
}

interface View<T extends Value> {
  element: HTMLElement;
  update(next: T): void;
  dispose(): void;
  focusEl: HTMLElement;
}

class LiteralView implements View<LiteralValue | BlankValue> {
  element: HTMLElement;
  inputEl?: HTMLInputElement;
  onInput?: (next: string) => void;

  constructor(writable: boolean) {
    if (writable) {
      const input = createTextInput("value");
      input.addEventListener("input", () => this.onInput?.(input.value));
      this.element = this.inputEl = input;
    } else {
      this.element = createEl("div", "value");
    }
  }

  setText(text: string) {
    if (this.inputEl) this.inputEl.value = text;
    else this.element.textContent = text;
  }

  update(next: LiteralValue | BlankValue) {
    if (isLiteral(next)) {
      this.setText(String(next.value));
    } else {
      this.setText("");
    }
  }

  dispose() {}

  get focusEl(): HTMLElement {
    return this.inputEl ?? this.element;
  }
}

class ListView implements View<ListValue> {
  element = createEl("div", "list");
  rows = new Map<number, CellMount>();

  constructor(readonly parentPath: CellPath) {}

  update(next: ListValue) {
    const cells = next.cells;

    const keep = new Set(cells.map((c) => c.uid));
    for (const [uid, mount] of Array.from(this.rows)) {
      if (!keep.has(uid)) {
        mount.dispose();
        this.rows.delete(uid);
      }
    }

    const frag = document.createDocumentFragment();
    for (const cell of cells) {
      const childPath = [...this.parentPath, cell.uid];
      let mount = this.rows.get(cell.uid);
      if (!mount) {
        mount = new CellMount(cell, childPath);
        this.rows.set(cell.uid, mount);
      }
      frag.append(mount.element);
    }

    this.element.replaceChildren(frag);
  }

  dispose() {
    for (const m of this.rows.values()) m.dispose();
    this.rows.clear();
  }

  get focusEl() {
    return this.element;
  }
}

class CellMount {
  element = createEl("div", "cell");

  headerEl = createEl("div", "header");
  nameInput = new AutosizeInput("");
  eqEl = createEl("span", "equals");
  codeInput = new AutosizeInput("");

  body?: ListView | LiteralView;
  stop: () => void;

  constructor(readonly cell: Cell, readonly path: CellPath) {
    this.nameInput.element.classList.add("name");
    this.codeInput.element.classList.add("code");

    this.eqEl.textContent = "=";
    this.headerEl.append(
      this.nameInput.element,
      this.eqEl,
      this.codeInput.element
    );

    this.stop = effect(() => {
      const name = this.cell.name.get();
      const raw = this.cell.child.get();
      const flow = isFlow(raw);
      const flowRaw = flow ? (raw as FlowValue) : null;
      const show = flow ? flowRaw!.result.get() : raw;

      const needHeader = name !== "" || flow;
      this.nameInput.update(name);
      this.nameInput.element.classList.toggle("hidden", name === "");
      this.codeInput.element.classList.toggle("hidden", !flow);
      this.eqEl.classList.toggle("hidden", !flow);
      if (flow) {
        this.codeInput.update(flowRaw!.code);
        this.codeInput.input.readOnly = !isWritableSignal(this.cell.child);
      }

      if (!(this.body instanceof (isList(show) ? ListView : LiteralView))) {
        this.body?.dispose();
        this.body = isList(show)
          ? new ListView(this.path)
          : new LiteralView(!flow && isWritableSignal(this.cell.child));
      }

      if (isList(show)) {
        (this.body as ListView).update(show);
      } else {
        (this.body as LiteralView).update(
          isFunction(show)
            ? createLiteral("[function]")
            : isError(show)
            ? createLiteral(`[error: ${show.message}]`)
            : show
        );
      }

      const bodyEl = this.body!.element;
      if (needHeader) {
        if (this.element.firstElementChild !== this.headerEl) {
          const curBody = this.element.firstElementChild;
          if (curBody === bodyEl) this.element.prepend(this.headerEl);
          else this.element.replaceChildren(this.headerEl, bodyEl);
        } else if (this.element.lastElementChild !== bodyEl) {
          this.element.replaceChild(bodyEl, this.element.lastElementChild!);
        }
      } else if (
        this.element.firstElementChild !== bodyEl ||
        this.element.childElementCount !== 1
      ) {
        this.element.replaceChildren(bodyEl);
      }

      this.element.classList.toggle("error", isError(show));

      const focusEl = flow ? this.codeInput.focusEl : this.body!.focusEl;
      registerBinding(this.path, {
        ...(name !== "" && { name: this.nameInput.input }),
        value: focusEl,
        cell: this.element,
      });
    });
  }

  dispose() {
    unregisterBinding(this.path);
    this.stop();
    this.body?.dispose();
  }
}

export default function renderRoot(
  rootSignal: ValueSignal<ListValue>,
  rootPath: CellPath
) {
  const listView = new ListView(rootPath);

  const stop = effect(() => {
    const list = rootSignal.get();
    listView.update(list);
  });

  return {
    element: listView.element,
    dispose() {
      stop?.();
      listView.dispose();
    },
  };
}
