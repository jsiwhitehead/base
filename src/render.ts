import {
  type Signal,
  signal,
  effect,
  computed,
  untracked,
} from "@preact/signals-core";

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

type ChildItem = Cell | { uid: number | string; create: () => HTMLElement };

class ChildViewManager {
  cache = new Map<
    number | string,
    { element: HTMLElement; dispose?: () => void }
  >();

  constructor(
    readonly container: HTMLElement,
    readonly parentPath: CellPath,
    readonly create: (cell: Cell, path: CellPath) => View
  ) {}

  update(nextItems: ChildItem[]) {
    const keep = new Set(nextItems.map((i) => i.uid));
    for (const [uid, rec] of this.cache) {
      if (!keep.has(uid)) {
        rec.dispose?.();
        this.cache.delete(uid);
      }
    }

    const desired = nextItems.map((item) => {
      let rec = this.cache.get(item.uid);
      if (!rec) {
        if ("child" in item) {
          rec = this.create(item, [...this.parentPath, item.uid]);
        } else {
          rec = { element: item.create() };
        }
        this.cache.set(item.uid, rec);
      }
      return rec.element;
    });

    reconcileDomChildren(this.container, desired);
  }

  dispose() {
    for (const child of this.cache.values()) child.dispose?.();
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

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    const setHover = (toTrue: boolean) => {
      untracked(() => {
        const value = childToValue(valueSig);
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
      path,
      (cell, childPath) => new StyledView(cell.child, childPath)
    );

    this.effect(() => {
      const val = toRenderValue(childToValue(valueSig));

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

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "1";

    this.element = input;

    input.addEventListener("input", () => {
      if (isWritableSignal(valueSig)) {
        const n = Number(input.value);
        if (Number.isFinite(n)) valueSig.set(createLiteral(n));
      }
    });

    this.effect(() => {
      const v = toRenderValue(childToValue(valueSig));
      const n = isLiteral(v) && typeof v.value === "number" ? v.value : 0;

      if (this.element.value !== String(n)) {
        this.element.value = String(n);
      }

      this.element.disabled = !isWritableSignal(valueSig);
    });
  }
}

class RowHeaderView extends View {
  element = createEl("div", "label");
  nameDisplayEl = createEl("div", "name");
  nameInput = new AutosizeInput("", "name");

  constructor(nameSig: WriteSignal<string>, pathKey: string) {
    super();

    this.effect(
      () => {
        const focus = focusSignal.value;
        return (
          focus.kind === "focused" &&
          focus.path.join(".") === pathKey &&
          focus.role === "name"
        );
      },
      (showNameInput) => {
        reconcileDomChildren(this.element, [
          showNameInput ? this.nameInput.element : this.nameDisplayEl,
        ]);
      }
    );

    this.effect(() => {
      const name = nameSig.get() || "";
      this.nameDisplayEl.textContent = name;
      this.nameInput.update(name);
    });
  }

  getNameInput(): HTMLInputElement {
    return this.nameInput.input;
  }
}

class RowView extends View {
  element = createEl("div", "row");
  header: RowHeaderView;

  constructor(rowCell: Cell, path: CellPath, columnsJsonSig: Signal<string>) {
    super();

    const pathKey = path.join(".");
    this.header = new RowHeaderView(rowCell.name, pathKey);

    this.initChildren(
      this.element,
      path,
      (cell, p) => new CellView(cell, p, false)
    );

    this.effect(() => {
      const cols: string[] = JSON.parse(columnsJsonSig.value);

      const v = childToValue(rowCell.child);
      const rowList = isList(v) ? v : null;

      const byName = new Map<string, Cell>();
      if (rowList) {
        for (const c of rowList.cells) {
          const n = c.name.get();
          if (n) byName.set(n, c);
        }
      }

      const items: ChildItem[] = [];
      items.push({ uid: "label", create: () => this.header.element });

      for (const name of cols) {
        const real = byName.get(name);
        if (real) {
          items.push(real);
        } else {
          items.push({ uid: name, create: () => createEl("div", "cell") });
        }
      }

      this.childList!.update(items);
    });

    registerBinding(path, {
      cell: this.element,
      value: this.element,
      name: this.header.getNameInput(),
    });

    this.effect(() => {
      const focus = focusSignal.value;
      const focused =
        focus.kind === "focused" && focus.path.join(".") === pathKey;
      const valueFocused = focused && focus.role === "value";
      this.element.classList.toggle("focused", valueFocused);
    });

    this.onCleanup(() => {
      unregisterBinding(path);
      this.header.dispose();
    });
  }
}

class TableView extends View {
  element = createEl("div", "table");
  headerRow = createEl("div", "row");
  body = createEl("div", "table-body");
  columnsJsonSig = signal("[]");

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    this.element.append(this.headerRow, this.body);
    this.headerRow.classList.add("table-header");

    this.initChildren(
      this.body,
      path,
      (cell, p) => new RowView(cell, p, this.columnsJsonSig)
    );

    this.effect(
      () => {
        const list = toRenderValue(childToValue(valueSig));
        if (!isList(list)) return [];

        const first = list.cells[0]?.child;
        if (!first) return [];

        const row = childToValue(first);
        if (!isList(row)) return [];

        return [
          ...new Set(
            row.cells.map((c) => c.name.get()).filter((x): x is string => !!x)
          ),
        ];
      },
      (cols) => {
        const cells: HTMLElement[] = [createEl("div", "label")];
        for (const name of cols) cells.push(createEl("div", "cell", name));
        reconcileDomChildren(this.headerRow, cells);
        this.columnsJsonSig.value = JSON.stringify(cols);
      }
    );

    this.effect(() => {
      const v = toRenderValue(childToValue(valueSig));
      this.updateChildren(isList(v) ? v.cells : []);
    });

    this.effect(() => {
      const focus = focusSignal.value;

      if (focus.kind !== "focused") {
        this.headerRow
          .querySelectorAll(".col-focused")
          .forEach((el) => el.classList.remove("col-focused"));
        return;
      }

      queueMicrotask(() => {
        let col = -1;

        for (const row of Array.from(this.body.children) as HTMLElement[]) {
          const kids = Array.from(row.children) as HTMLElement[];
          const idx = kids.findIndex(
            (el, i) => i > 0 && el.classList.contains("focused")
          );
          if (idx !== -1) {
            col = idx - 1;
            break;
          }
        }

        Array.from(this.headerRow.children).forEach((el, i) =>
          el.classList.toggle("col-focused", i === col + 1)
        );
      });
    });
  }
}

class BarView extends View {
  element!: HTMLElement;
  scalarEl: HTMLElement;
  listEl: HTMLElement;

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    this.scalarEl = isWritableSignal(valueSig)
      ? createTextInput("value")
      : createEl("div", "value");

    this.listEl = createEl("div", "bar");
    this.initChildren(
      this.listEl,
      path,
      (cell, childPath) => new CellView(cell, childPath)
    );

    this.effect(
      () => isList(toRenderValue(childToValue(valueSig))),
      (shouldBeList) => {
        const next = shouldBeList ? this.listEl : this.scalarEl;
        if (this.element !== next) {
          this.element?.replaceWith?.(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const v = toRenderValue(childToValue(valueSig));

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

const views: Record<string, new (c: ChildSignal, p: CellPath) => View> = {
  styled: StyledView,
  slider: SliderView,
  table: TableView,
  bar: BarView,
};

class StandardView extends View {
  element!: HTMLElement;
  scalarEl: HTMLElement;
  listEl: HTMLElement;

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    this.scalarEl = isWritableSignal(valueSig)
      ? createTextInput("value")
      : createEl("div", "value");

    this.listEl = createEl("div", "list");
    this.initChildren(
      this.listEl,
      path,
      (cell, childPath) => new CellView(cell, childPath)
    );

    this.effect(
      () => isList(toRenderValue(childToValue(valueSig))),
      (shouldBeList) => {
        const next = shouldBeList ? this.listEl : this.scalarEl;
        if (this.element !== next) {
          this.element?.replaceWith?.(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const v = toRenderValue(childToValue(valueSig));

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
    nameSig: WriteSignal<string>,
    childSig: ChildSignal,
    pathKey: string
  ) {
    super();

    this.effect(
      () => {
        const focus = focusSignal.value;
        return {
          isFlowNode: isFlow(childSig.get()),
          showNameInput:
            focus.kind === "focused" &&
            focus.path.join(".") === pathKey &&
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
      const name = nameSig.get();
      this.nameDisplayEl.textContent = name;
      this.nameInput.update(name);
    });

    this.effect(() => {
      const raw = childSig.get();
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

  constructor(cell: Cell, path: CellPath, showHeader: boolean = true) {
    super();

    const pathKey = path.join(".");
    this.header = new CellHeaderView(cell.name, cell.child, pathKey);
    this.stdView = new StandardView(cell.child, path);

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;

        return {
          hasName: cell.name.get() !== "",
          isFlow: isFlow(cell.child.get()),
          nameFocused: focusMatches && focus.role === "name",
          viewId: cell.view.get(),
        };
      },
      ({ hasName, isFlow, nameFocused, viewId }) => {
        const needHeader = showHeader && (hasName || isFlow || nameFocused);

        const ViewCtor = views[viewId] || StandardView;
        const simpleView =
          ViewCtor === StandardView ||
          ViewCtor === TableView ||
          ViewCtor === BarView;

        if (!this.view || this.view.constructor !== ViewCtor) {
          this.view?.dispose();
          this.view = new ViewCtor(cell.child, path);
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view.element,
          simpleView ? null : this.stdView.element,
        ]);

        this.element.classList.toggle("flow", isFlow);

        registerBinding(path, {
          name: this.header.getNameInput(),
          value: isFlow
            ? this.header.getCodeInput()
            : simpleView
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
      unregisterBinding(path);
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
