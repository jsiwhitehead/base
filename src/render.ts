import { effect, computed } from "@preact/signals-core";

import {
  type RenderValue,
  type Value,
  type ListValue,
  type Cell,
  type WriteSignal,
  type ValueSignal,
  type ChildSignal,
  isError,
  isBlank,
  isLiteral,
  isList,
  isFunction,
  isFlow,
  isWritableSignal,
  createLiteral,
  toText,
  childToValue,
} from "./data";
import { type CellPath } from "./tree";
import { focusSignal, registerBinding, unregisterBinding } from "./input";

function createEl(tag: string, className?: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.classList.add(className);
  if (text != null) el.textContent = text;
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

  constructor(initialText: string, className?: string) {
    const wrap = createEl("div", "autosize");
    if (className) wrap.classList.add(className);

    const mirror = createEl("span");
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
    if (this.input.value !== text) this.input.value = text;
    const mirrorText = text || " ";
    if (this.mirror.textContent !== mirrorText) {
      this.mirror.textContent = mirrorText;
    }
  }
}

function toRenderValue(v: Value): RenderValue {
  if (isList(v) || isLiteral(v) || isBlank(v) || isError(v)) return v;
  if (isFunction(v)) return createLiteral("[function]");
  return createLiteral("[unknown]");
}

function reconcileDomChildren(
  parent: HTMLElement,
  next: (HTMLElement | null | undefined)[]
) {
  const desired = next.filter((el): el is HTMLElement => !!el);
  const current = [...parent.childNodes];

  desired.forEach((node, i) => {
    if (current[i] !== node) parent.insertBefore(node, current[i] ?? null);
  });

  while (parent.childNodes.length > desired.length) {
    parent.lastChild!.remove();
  }
}

class ChildViewManager {
  cache = new Map<number, View>();

  constructor(
    readonly container: HTMLElement,
    readonly parentPath: CellPath,
    readonly create: (cell: Cell, path: CellPath) => View
  ) {}

  update(nextCells: Cell[]) {
    const keep = new Set(nextCells.map((c) => c.uid));
    for (const [uid, child] of this.cache) {
      if (!keep.has(uid)) {
        child.dispose();
        this.cache.delete(uid);
      }
    }
    const frag = document.createDocumentFragment();
    for (const cell of nextCells) {
      const path = [...this.parentPath, cell.uid];
      let child = this.cache.get(cell.uid);
      if (!child) {
        child = this.create(cell, path);
        this.cache.set(cell.uid, child);
      }
      frag.append(child.element);
    }
    this.container.replaceChildren(frag);
  }

  dispose() {
    for (const child of this.cache.values()) child.dispose();
    this.cache.clear();
  }
}

abstract class View {
  abstract element: HTMLElement;
  cleanups: (() => void)[] = [];
  childList?: ChildViewManager;

  effect(fn: () => void): void;
  effect<T>(selector: () => T, run: (value: T) => void): void;
  effect<T>(arg1: (() => void) | (() => T), arg2?: (value: T) => void) {
    if (!arg2) {
      const stop = effect(arg1 as () => void);
      this.cleanups.push(stop);
      return;
    }

    const selector = arg1 as () => T;
    const jsonSig = computed(() => JSON.stringify(selector()));
    const stop = effect(() => {
      const json = jsonSig.value;
      const value = JSON.parse(json) as T;
      arg2(value);
    });
    this.cleanups.push(stop);
  }

  initChildren(
    container: HTMLElement,
    parentPath: CellPath,
    create: (cell: Cell, path: CellPath) => View
  ) {
    this.childList = new ChildViewManager(container, parentPath, create);
    this.cleanups.push(() => this.childList!.dispose());
  }

  updateChildren(cells: Cell[]) {
    this.childList?.update(cells);
  }

  onCleanup(fn: () => void) {
    this.cleanups.push(fn);
  }

  dispose() {
    this.cleanups.toReversed().forEach((fn) => fn());
    this.cleanups = [];
  }
}

class StyledView extends View {
  element = createEl("div", "styled");

  constructor(readonly valueSig: ChildSignal, readonly path: CellPath) {
    super();

    this.initChildren(
      this.element,
      this.path,
      (cell, childPath) => new StyledView(cell.child, childPath)
    );

    this.effect(() => {
      const v = toRenderValue(childToValue(this.valueSig));
      if (isList(v)) {
        this.updateChildren(v.cells.filter((c) => !c.name.get()));
        return;
      }
      this.updateChildren([]);
      this.element.textContent = isLiteral(v) ? String(v.value) : "";
    });

    this.effect(() => {
      const v = toRenderValue(childToValue(this.valueSig));
      if (isList(v)) {
        const c = v.cells.find((x) => x.name.get() === "color");
        this.element.style.color = (c && toText(childToValue(c.child))) || "";
        return;
      }
      this.element.style.color = "";
    });
  }
}

class StandardView extends View {
  element!: HTMLElement;
  scalarEl: HTMLElement;
  listEl: HTMLElement;

  constructor(
    readonly valueSig: ChildSignal,
    readonly path: CellPath,
    readonly writable: boolean
  ) {
    super();

    this.scalarEl = this.writable
      ? createTextInput("value")
      : createEl("div", "value");

    this.listEl = createEl("div", "list");
    this.initChildren(
      this.listEl,
      this.path,
      (cell, childPath) => new CellView(cell, childPath)
    );

    this.effect(
      () => isList(toRenderValue(childToValue(this.valueSig))),
      (shouldBeList) => {
        const next = shouldBeList ? this.listEl : this.scalarEl;
        if (this.element !== next) {
          this.element?.replaceWith?.(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const v = toRenderValue(childToValue(this.valueSig));

      if (isList(v)) {
        this.updateChildren(v.cells);
        return;
      }

      const isErr = v.kind === "error";
      const text =
        v.kind === "literal" ? String(v.value) : isErr ? v.message : "";

      if (this.writable) {
        (this.scalarEl as HTMLInputElement).value = text;
      } else {
        this.scalarEl.textContent = text;
      }

      this.scalarEl.classList.toggle("error", isErr);
    });
  }
}

class CellHeaderView extends View {
  element = createEl("div", "header");
  nameDisplayEl = createEl("div", "name");
  nameInput = new AutosizeInput("", "name");
  eqEl = createEl("span", "equals", "=");
  codeInput = new AutosizeInput("", "code");

  constructor(
    readonly nameSig: WriteSignal<string>,
    readonly childSig: ChildSignal,
    readonly pathKey: string
  ) {
    super();

    this.effect(
      () => {
        const focus = focusSignal.value;
        return {
          isFlowNode: isFlow(this.childSig.get()),
          showNameInput:
            focus.kind === "focused" &&
            focus.path.join(".") === this.pathKey &&
            focus.role === "name",
        };
      },
      ({ isFlowNode, showNameInput }) => {
        reconcileDomChildren(this.element, [
          showNameInput ? this.nameInput.element : this.nameDisplayEl,
          isFlowNode ? this.eqEl : null,
          isFlowNode ? this.codeInput.element : null,
        ]);
      }
    );

    this.effect(() => {
      const name = this.nameSig.get();
      this.nameDisplayEl.textContent = name;
      this.nameInput.update(name);
    });

    this.effect(() => {
      const raw = this.childSig.get();
      if (isFlow(raw)) this.codeInput.update(raw.code);
    });
  }

  getNameInput(): HTMLInputElement {
    return this.nameInput.input;
  }

  getCodeInput(): HTMLInputElement {
    return this.codeInput.input;
  }
}

class CellView extends View {
  element = createEl("div", "cell");
  header: CellHeaderView;
  view!: View;

  constructor(readonly cell: Cell, readonly path: CellPath) {
    super();

    const pathKey = this.path.join(".");

    this.header = new CellHeaderView(this.cell.name, this.cell.child, pathKey);

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;

        return {
          hasName: this.cell.name.get() !== "",
          isFlow: isFlow(this.cell.child.get()),
          nameFocused: focusMatches && focus.role === "name",
          viewId: this.cell.view.get(),
          writable: isWritableSignal(this.cell.child),
        };
      },
      ({ hasName, isFlow, nameFocused, viewId, writable }) => {
        const needHeader = hasName || isFlow || nameFocused;
        const isStyled = viewId === "styled";

        if (!(this.view instanceof (isStyled ? StyledView : StandardView))) {
          this.view?.dispose();
          this.view = isStyled
            ? new StyledView(this.cell.child, this.path)
            : new StandardView(this.cell.child, this.path, writable);
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view!.element,
        ]);

        this.element.classList.toggle("flow", isFlow);

        registerBinding(this.path, {
          name: this.header.getNameInput(),
          value: isFlow ? this.header.getCodeInput() : this.view!.element,
          cell: this.element,
        });
      }
    );

    this.effect(
      () => {
        const focus = focusSignal.value;
        const match =
          focus.kind === "focused" && focus.path.join(".") === pathKey;
        return {
          focused: match,
          valueFocused: match && focus.role === "value",
        };
      },
      ({ focused, valueFocused }) => {
        this.element.classList.toggle("focused", focused);
        this.view.element.classList.toggle("focused", valueFocused);
      }
    );

    this.onCleanup(() => {
      unregisterBinding(this.path);
      this.header.dispose();
      this.view.dispose();
    });
  }
}

export default function renderRoot(
  rootSignal: ValueSignal<ListValue>,
  rootPath: CellPath
) {
  return new StandardView(rootSignal, rootPath, false);
}
