import {
  type Signal,
  signal,
  effect,
  computed,
  untracked,
} from "@preact/signals-core";

import {
  type ErrorValue,
  type ListValue,
  type RenderValue,
  type Value,
  type ValueSignal,
  type ChildSignal,
  type Cell,
  isError,
  isBlank,
  isLiteral,
  isList,
  isFunction,
  isFlow,
  isLink,
  isTemplate,
  isWritableSignal,
  createBlank,
  createLiteral,
  toText,
  evalStructural,
} from "./data";
import { type CellPath } from "./tree";
import { focusSignal, registerBinding, unregisterBinding } from "./input";

type CreateOptions = {
  className?: string;
  value?: string;
};

function createEl(
  tag: string,
  { className, value }: CreateOptions = {}
): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.classList.add(className);
  if (value != null) el.textContent = value;
  return el;
}

function createTextInputEl(
  multiline: boolean,
  { className, value }: CreateOptions = {}
): HTMLInputElement | HTMLTextAreaElement {
  const input = multiline
    ? document.createElement("textarea")
    : document.createElement("input");
  if (className) input.classList.add(className);
  if (value != null) input.value = value;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.autocorrect = "off" as any;
  input.spellcheck = false;
  if (input instanceof HTMLTextAreaElement) {
    input.rows = 1;
  }
  return input;
}

function getMirrorText(text: string): string {
  if (!text) return " ";
  if (text.endsWith("\n")) return text + "\u00a0";
  return text;
}

class AutosizeInput {
  element: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  mirror: HTMLSpanElement;

  constructor(multiline: boolean, { className, value }: CreateOptions = {}) {
    const wrap = createEl("div", { className: "autosize" });
    if (className) wrap.classList.add(className);

    const mirror = createEl("span");
    mirror.setAttribute("aria-hidden", "true");
    mirror.textContent = getMirrorText(value ?? "");

    const input = createTextInputEl(multiline, { value });

    input.addEventListener("input", () => {
      mirror.textContent = getMirrorText(input.value);
    });

    wrap.append(mirror, input);

    (wrap as any).__textInputTarget = input;

    this.element = wrap;
    this.input = input;
    this.mirror = mirror;
  }

  update(text: string) {
    if (this.input.value !== text) this.input.value = text;
    const mirrorText = getMirrorText(text);
    if (this.mirror.textContent !== mirrorText) {
      this.mirror.textContent = mirrorText;
    }
  }
}

function toRenderValue(v: Value): RenderValue | ErrorValue {
  if (isList(v) || isLiteral(v) || isBlank(v) || isError(v)) return v;
  if (isFunction(v)) return createLiteral("[function]");
  return createLiteral("[unknown]");
}

function reconcileDomChildren(
  parent: HTMLElement,
  next: (HTMLElement | null | undefined)[]
) {
  const desired = next.filter(
    (node): node is HTMLElement => node instanceof HTMLElement
  );

  desired.forEach((child, i) => {
    const current = parent.children[i];
    if (current !== child) {
      parent.insertBefore(child, current || null);
    }
  });

  while (parent.children.length > desired.length) {
    parent.removeChild(parent.lastElementChild!);
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
  return c ? evalStructural(c.child) : undefined;
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
  element = createEl("div", { className: "styled" });

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    const setHover = (toTrue: boolean) => {
      untracked(() => {
        const value = evalStructural(valueSig);
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
      const val = toRenderValue(evalStructural(valueSig));

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
          const v = evalStructural(c.child);
          if (isBlank(v) || isError(v)) return false;
          if (isLiteral(v) && typeof v.value === "string") {
            if (v.value.trim() === "") return false;
          }
          return true;
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
    input.classList.add("slider");
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
      const v = toRenderValue(evalStructural(valueSig));
      const n = isLiteral(v) && typeof v.value === "number" ? v.value : 0;

      if (this.element.value !== String(n)) {
        this.element.value = String(n);
      }

      this.element.disabled = !isWritableSignal(valueSig);
    });
  }
}

class RowHeaderView extends View {
  element = createEl("div", { className: "label" });
  nameDisplayEl = createEl("div", { className: "name" });
  nameInput = new AutosizeInput(false, { className: "name" });

  constructor(nameSig: ValueSignal<string>, pathKey: string) {
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

  getNameInput(): HTMLInputElement | HTMLTextAreaElement {
    return this.nameInput.input;
  }
}

class RowView extends View {
  element = createEl("div", { className: "row" });
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

      const v = evalStructural(rowCell.child);
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
          items.push({
            uid: name,
            create: () => createEl("div", { className: "cell" }),
          });
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
  element = createEl("div", { className: "table" });
  headerRow = createEl("div", { className: "row" });
  body = createEl("div", { className: "table-body" });
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
        const list = toRenderValue(evalStructural(valueSig));
        if (!isList(list)) return [];

        const first = list.cells[0]?.child;
        if (!first) return [];

        const row = evalStructural(first);
        if (!isList(row)) return [];

        return [
          ...new Set(
            row.cells.map((c) => c.name.get()).filter((x): x is string => !!x)
          ),
        ];
      },
      (cols) => {
        const cells: HTMLElement[] = [createEl("div", { className: "label" })];
        for (const name of cols) {
          cells.push(createEl("div", { className: "cell", value: name }));
        }
        reconcileDomChildren(this.headerRow, cells);
        this.columnsJsonSig.value = JSON.stringify(cols);
      }
    );

    this.effect(() => {
      const v = toRenderValue(evalStructural(valueSig));
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

class StandardView extends View {
  element!: HTMLElement;
  scalarInput?: AutosizeInput;
  scalarEl: HTMLElement;
  listEl: HTMLElement;

  constructor(valueSig: ChildSignal, path: CellPath) {
    super();

    if (isWritableSignal(valueSig)) {
      this.scalarInput = new AutosizeInput(true, { className: "value" });
      this.scalarEl = this.scalarInput.element;
    } else {
      this.scalarEl = createEl("div", { className: "value" });
    }

    this.listEl = createEl("div", { className: "list" });
    this.initChildren(
      this.listEl,
      path,
      (cell, childPath) => new CellView(cell, childPath)
    );

    this.effect(
      () => isList(toRenderValue(evalStructural(valueSig))),
      (shouldBeList) => {
        const next = shouldBeList ? this.listEl : this.scalarEl;
        if (this.element !== next) {
          this.element?.replaceWith?.(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const v = toRenderValue(evalStructural(valueSig));

      if (isList(v)) {
        this.updateChildren(v.cells);

        const kids = this.listEl.children;
        for (const el of kids) el.classList.remove("result");
        kids[v.cells.findIndex((c) => c.uid === v.resultUid)]?.classList.add(
          "result"
        );

        return;
      }

      for (const el of this.listEl.children) {
        el.classList.remove("result");
      }

      const isErr = v.kind === "error";
      const text =
        v.kind === "literal" ? String(v.value) : isErr ? v.message : "";

      if (this.scalarInput) {
        this.scalarInput.update(text);
      } else {
        this.scalarEl.textContent = text;
      }

      this.scalarEl.classList.toggle("error", isErr);
    });
  }
}

class BarView extends StandardView {
  constructor(valueSig: ChildSignal, path: CellPath) {
    super(valueSig, path);
    this.listEl.classList.remove("list");
    this.listEl.classList.add("bar");
  }
}

const views: Record<string, new (c: ChildSignal, p: CellPath) => View> = {
  styled: StyledView,
  slider: SliderView,
  table: TableView,
  bar: BarView,
};

class CellHeaderView extends View {
  element = createEl("div", { className: "header" });

  nameInput = new AutosizeInput(false, { className: "name" });

  flowWrapEl = createEl("div", { className: "wrap" });
  flowEqualsEl = createEl("span", { className: "equals", value: "=" });
  flowCodeInput = new AutosizeInput(true, { className: "code" });

  sourceWrapEl = createEl("div", { className: "wrap" });
  sourceTildeEl = createEl("span", { className: "equals", value: "~" });
  sourceCodeInput = new AutosizeInput(false, { className: "code" });

  filterWrapEl = createEl("div", { className: "wrap" });
  filterLabelEl = createEl("span", { className: "equals", value: "filter:" });
  filterCodeInput = new AutosizeInput(true, { className: "code" });

  templateWrapEl = createEl("div", { className: "wrap" });
  templateLabelEl = createEl("span", { className: "equals", value: "=>" });
  templateParamInput = new AutosizeInput(false, { className: "code" });

  constructor(
    nameSig: ValueSignal<string>,
    childSig: ChildSignal,
    pathKey: string
  ) {
    super();

    this.flowWrapEl.append(this.flowEqualsEl, this.flowCodeInput.element);
    this.sourceWrapEl.append(this.sourceTildeEl, this.sourceCodeInput.element);
    this.filterWrapEl.append(this.filterLabelEl, this.filterCodeInput.element);
    this.templateWrapEl.append(
      this.templateParamInput.element,
      this.templateLabelEl
    );

    this.effect(
      () => {
        const focused = focusSignal.value;
        const nameFocused =
          focused.kind === "focused" &&
          focused.role === "name" &&
          focused.path.join(".") === pathKey;
        const child = childSig.get();
        return {
          isFlowNode: isFlow(child),
          isLinkNode: isLink(child),
          isTemplateNode: isTemplate(child),
          nameVisible: !!nameSig.get() || nameFocused,
        };
      },
      ({ isFlowNode, isLinkNode, isTemplateNode, nameVisible }) => {
        reconcileDomChildren(this.element, [
          nameVisible ? this.nameInput.element : null,
          isTemplateNode ? this.templateWrapEl : null,
          isFlowNode ? this.flowWrapEl : null,
          ...(isLinkNode ? [this.sourceWrapEl, this.filterWrapEl] : []),
        ]);
      }
    );

    this.effect(() => {
      this.nameInput.update(nameSig.get());
    });

    this.effect(() => {
      const v = childSig.get();
      if (isFlow(v)) {
        this.flowCodeInput.update(v.code);
      } else if (isLink(v)) {
        this.sourceCodeInput.update(v.source);
        this.filterCodeInput.update(v.filter);
      } else if (isTemplate(v)) {
        this.templateParamInput.update(v.param);
      }
    });
  }

  getNameInput() {
    return this.nameInput.input;
  }

  getFlowCodeInput() {
    return this.flowCodeInput.input;
  }

  getLinkSourceInput() {
    return this.sourceCodeInput.input;
  }

  getLinkFilterInput() {
    return this.filterCodeInput.input;
  }

  getTemplateParamInput() {
    return this.templateParamInput.input;
  }
}

class CellView extends View {
  element = createEl("div", { className: "cell" });
  header: CellHeaderView;
  view!: View;
  stdView?: StandardView;

  constructor(cell: Cell, path: CellPath, showHeader: boolean = true) {
    super();

    const pathKey = path.join(".");
    this.header = new CellHeaderView(cell.name, cell.child, pathKey);

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;
        const child = cell.child.get();
        return {
          hasName: cell.name.get() !== "",
          nameFocused: focusMatches && focus.role === "name",
          isFlow: isFlow(child),
          isLink: isLink(child),
          isTemplate: isTemplate(child),
          viewId: cell.view.get(),
        };
      },
      ({ hasName, nameFocused, isFlow, isLink, isTemplate, viewId }) => {
        const needHeader =
          showHeader &&
          (hasName || isFlow || isLink || isTemplate || nameFocused);

        const ViewCtor = views[viewId] || StandardView;
        const simpleView =
          ViewCtor === StandardView ||
          ViewCtor === TableView ||
          ViewCtor === BarView ||
          ViewCtor === SliderView;

        if (!this.view || this.view.constructor !== ViewCtor) {
          this.view?.dispose();
          this.view = new ViewCtor(cell.child, path);
        }

        if (!simpleView) {
          if (!this.stdView) {
            this.stdView = new StandardView(cell.child, path);
          }
        } else if (this.stdView) {
          this.stdView.dispose();
          this.stdView = undefined;
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view.element,
          !simpleView ? this.stdView!.element : null,
        ]);

        this.element.classList.toggle("flow", isFlow || isLink);

        const valueEl = isFlow
          ? this.header.getFlowCodeInput()
          : isLink
          ? this.header.getLinkSourceInput()
          : simpleView
          ? this.view.element
          : this.stdView!.element;
        registerBinding(path, {
          name: this.header.getNameInput(),
          value: (valueEl as any).__textInputTarget || valueEl,
          filter: isLink ? this.header.getLinkFilterInput() : undefined,
          param: isTemplate ? this.header.getTemplateParamInput() : undefined,
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
      this.stdView?.dispose();
    });
  }
}

export default function renderRoot(
  rootSignal: ValueSignal<ListValue>,
  rootPath: CellPath
) {
  return new StandardView(rootSignal, rootPath);
}
