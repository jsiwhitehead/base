import { effect, computed, untracked } from "@preact/signals-core";

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
  createBlank,
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
    const desired = nextCells.map((cell) => {
      const view =
        this.cache.get(cell.uid) ??
        this.create(cell, [...this.parentPath, cell.uid]);
      this.cache.set(cell.uid, view);
      return view.element;
    });
    reconcileDomChildren(this.container, desired);
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

function readProp(list: ListValue, name: string): Value | undefined {
  const c = list.cells.find((x) => x.name.get() === name);
  return c ? childToValue(c.child) : undefined;
}
function readText(list: ListValue, name: string): string | null {
  const v = readProp(list, name);
  return v ? toText(v) : null;
}
function readNum(list: ListValue, name: string): number | null {
  const v = readProp(list, name);
  if (!v) return null;
  const n = Number(toText(v));
  return Number.isFinite(n) ? n : null;
}

class StyledView extends View {
  element = createEl("div", "styled");

  constructor(readonly valueSig: ChildSignal, readonly path: CellPath) {
    super();

    const setHover = (toTrue: boolean) => {
      untracked(() => {
        const value = childToValue(this.valueSig);
        if (!isList(value)) return;

        const hoverCell = value.cells.find((c) => c.name.get() === "hover");
        if (!hoverCell || !isWritableSignal(hoverCell.child)) return;

        hoverCell.child.set(toTrue ? createLiteral(true) : createBlank());
      });
    };

    this.element.addEventListener("mouseenter", () => setHover(true));
    this.element.addEventListener("mouseleave", () => setHover(false));

    this.initChildren(
      this.element,
      this.path,
      (cell, childPath) => new StyledView(cell.child, childPath)
    );

    this.effect(() => {
      const val = toRenderValue(childToValue(this.valueSig));

      this.element.style.setProperty("--lh", "1.5");

      if (!isList(val)) {
        this.updateChildren([]);
        this.element.classList.add("trim-half-leading");

        const text = isLiteral(val) ? String(val.value) : "";
        if (this.element.textContent !== text) {
          this.element.textContent = text;
        }
        return;
      }

      this.element.classList.remove("trim-half-leading");

      this.updateChildren(
        val.cells.filter((c) => {
          if (c.name.get()) return false;
          const v = childToValue(c.child);
          return !(isBlank(v) || isError(v));
        })
      );

      const dir = (readText(val, "direction") ?? "column").toLowerCase();
      const hor = (readText(val, "horizontal") ?? "").toLowerCase();
      const ver = (readText(val, "vertical") ?? "").toLowerCase();
      const align = (readText(val, "align") ?? "").toLowerCase();

      const gap = readNum(val, "gap");
      const fill = readText(val, "fill");
      const pad = readNum(val, "pad");
      const round = readNum(val, "round");
      const color = readText(val, "color");
      const size = readNum(val, "size");

      const spacing = readNum(val, "spacing");
      if (spacing != null) {
        this.element.style.setProperty("--lh", String(spacing));
      }

      const [main, cross] = dir === "row" ? [hor, ver] : [ver, hor];
      const map: Record<string, string> = {
        left: "flex-start",
        top: "flex-start",
        right: "flex-end",
        bottom: "flex-end",
        center: "center",
        middle: "center",
        spread: "space-between",
      };

      const s = this.element.style;
      s.display = "flex";
      s.flexDirection = dir === "row" ? "row" : "column";
      if (gap != null) s.gap = `${gap}px`;
      else s.removeProperty("gap");
      if (map[main]) s.justifyContent = map[main];
      else s.removeProperty("justify-content");
      if (map[cross]) s.alignItems = map[cross];
      else s.removeProperty("align-items");
      if (align) s.textAlign = align;
      else s.removeProperty("text-align");
      if (fill) s.backgroundColor = fill;
      else s.removeProperty("background-color");
      if (pad != null) s.padding = `${pad}px`;
      else s.removeProperty("padding");
      if (round != null) s.borderRadius = `${round}px`;
      else s.removeProperty("border-radius");
      if (color) s.color = color;
      else s.removeProperty("color");
      if (size != null) s.fontSize = `${size}px`;
      else s.removeProperty("font-size");

      this.element.classList.toggle("fill-main", main === "fill");
    });
  }
}

class SliderView extends View {
  element: HTMLInputElement;

  constructor(readonly valueSig: ChildSignal, readonly path: CellPath) {
    super();

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "1";

    this.element = input;

    input.addEventListener("input", () => {
      if (isWritableSignal(this.valueSig)) {
        const n = Number(input.value);
        if (Number.isFinite(n)) this.valueSig.set(createLiteral(n));
      }
    });

    this.effect(() => {
      const v = toRenderValue(childToValue(this.valueSig));
      const n = isLiteral(v) && typeof v.value === "number" ? v.value : 0;

      if (this.element.value !== String(n)) {
        this.element.value = String(n);
      }

      this.element.disabled = !isWritableSignal(this.valueSig);
    });
  }
}

const views: Record<string, new (c: ChildSignal, p: CellPath) => View> = {
  styled: StyledView,
  slider: SliderView,
};

class StandardView extends View {
  element!: HTMLElement;
  scalarEl: HTMLElement;
  listEl: HTMLElement;

  constructor(readonly valueSig: ChildSignal, readonly path: CellPath) {
    super();

    this.scalarEl = isWritableSignal(valueSig)
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

      if (isWritableSignal(valueSig)) {
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
  stdView: StandardView;

  constructor(readonly cell: Cell, readonly path: CellPath) {
    super();

    const pathKey = this.path.join(".");
    this.header = new CellHeaderView(this.cell.name, this.cell.child, pathKey);

    this.stdView = new StandardView(this.cell.child, this.path);

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
        };
      },
      ({ hasName, isFlow, nameFocused, viewId }) => {
        const needHeader = hasName || isFlow || nameFocused;

        const ViewCtor = views[viewId] ?? StandardView;
        const isStandard = ViewCtor === StandardView;

        if (!this.view || this.view.constructor !== ViewCtor) {
          this.view?.dispose();
          this.view = new ViewCtor(this.cell.child, this.path);
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view.element,
          isStandard ? null : this.stdView.element,
        ]);

        this.element.classList.toggle("flow", isFlow);

        registerBinding(this.path, {
          name: this.header.getNameInput(),
          value: isFlow
            ? this.header.getCodeInput()
            : isStandard
            ? this.view.element
            : this.stdView.element,
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
      this.stdView.dispose();
    });
  }
}

export default function renderRoot(
  rootSignal: ValueSignal<ListValue>,
  rootPath: CellPath
) {
  return new StandardView(rootSignal, rootPath);
}
