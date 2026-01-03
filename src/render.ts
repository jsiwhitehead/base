import {
  type Signal as PSignal,
  signal,
  effect,
  computed,
  untracked,
} from "@preact/signals-core";

import {
  type ListValue,
  type ValueSignal,
  type CellValueSignal,
  type Cell,
  type EditorFieldMode,
  type Signal,
  getRenderEditors,
  isWritableSignal,
  createScalar,
  getRenderModel,
  getRenderProps,
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
        if ("value" in item) {
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

class StyledView extends View {
  element = createEl("div", { className: "styled" });

  constructor(valueSig: CellValueSignal, path: CellPath) {
    super();

    const setHover = (toTrue: boolean) => {
      untracked(() => {
        const p = getRenderProps(valueSig);
        p?.setFlag("hover", toTrue);
      });
    };

    this.element.addEventListener("mouseenter", () => setHover(true));
    this.element.addEventListener("mouseleave", () => setHover(false));

    this.initChildren(
      this.element,
      path,
      (cell, childPath) => new StyledView(cell.value, childPath)
    );

    this.effect(() => {
      const m = getRenderModel(valueSig);

      this.element.style.setProperty("--lh", "1.5");

      if (m.kind !== "list") {
        this.updateChildren([]);
        this.element.classList.add("trim-half-leading");

        const text = m.text;
        if (this.element.textContent !== text) {
          this.element.textContent = text;
        }
        return;
      }

      this.element.classList.remove("trim-half-leading");

      this.updateChildren(m.cells);

      const p = getRenderProps(valueSig);

      const dir = (p?.text("direction") ?? "column").toLowerCase();
      const hor = (p?.text("horizontal") ?? "").toLowerCase();
      const ver = (p?.text("vertical") ?? "").toLowerCase();
      const align = (p?.text("align") ?? "").toLowerCase();

      const gap = p?.num("gap") ?? null;
      const fill = p?.text("fill") ?? null;
      const pad = p?.num("pad") ?? null;
      const round = p?.num("round") ?? null;
      const color = p?.text("color") ?? null;
      const size = p?.num("size") ?? null;

      const spacing = p?.num("spacing") ?? null;
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

  constructor(valueSig: CellValueSignal, path: CellPath) {
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
        if (Number.isFinite(n)) valueSig.set(createScalar(n));
      }
    });

    this.effect(() => {
      const m = getRenderModel(valueSig);
      const n = m.kind === "scalar" && m.number !== undefined ? m.number : 0;

      if (this.element.value !== String(n)) {
        this.element.value = String(n);
      }
      this.element.disabled = !(m.kind === "scalar" && m.editable);
    });
  }
}

type HeaderSlot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  mode: EditorFieldMode;
  commit: (text: string) => void;
};

class RowHeaderView extends View {
  element = createEl("div", { className: "label" });
  nameDisplayEl = createEl("div", { className: "name" });
  nameInput = new AutosizeInput(false, { className: "name" });

  slot: HeaderSlot = {
    el: this.nameInput.input,
    mode: "name",
    commit: () => {},
  };

  constructor(nameSig: Signal<string>, pathKey: string) {
    super();

    this.slot.commit = isWritableSignal(nameSig) ? nameSig.set : () => {};

    this.effect(
      () => {
        const focus = focusSignal.value;
        return (
          focus.kind === "focused" &&
          focus.path.join(".") === pathKey &&
          focus.target.kind === "header" &&
          focus.target.index === 0
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

  getHeaderSlots(): HeaderSlot[] {
    return [this.slot];
  }
}

class RowView extends View {
  element = createEl("div", { className: "row" });
  header: RowHeaderView;

  constructor(rowCell: Cell, path: CellPath, columnsJsonSig: PSignal<string>) {
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

      const rm = getRenderModel(rowCell.value);
      const rowList = rm.kind === "list" ? rm : null;

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
      body: this.element,
      header: this.header.getHeaderSlots(),
    });

    this.effect(() => {
      const focus = focusSignal.value;
      const focused =
        focus.kind === "focused" && focus.path.join(".") === pathKey;
      const valueFocused = focused && focus.target.kind === "body";
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

  constructor(valueSig: CellValueSignal, path: CellPath) {
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
        const m = getRenderModel(valueSig);
        if (m.kind !== "list") return [];

        const first = m.cells[0]?.value;
        if (!first) return [];

        const rm = getRenderModel(first);
        if (rm.kind !== "list") return [];

        return [
          ...new Set(
            rm.cells.map((c) => c.name.get()).filter((x): x is string => !!x)
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
      const m = getRenderModel(valueSig);
      this.updateChildren(m.kind === "list" ? m.cells : []);
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

  constructor(valueSig: CellValueSignal, path: CellPath) {
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
      () => getRenderModel(valueSig).kind === "list",
      (shouldBeList) => {
        const next = shouldBeList ? this.listEl : this.scalarEl;
        if (this.element !== next) {
          this.element?.replaceWith?.(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const m = getRenderModel(valueSig);

      if (m.kind === "list") {
        this.updateChildren(m.cells);

        const kids = this.listEl.children;
        for (const el of kids) el.classList.remove("result");

        if (m.valueCellUid !== undefined) {
          const idx = m.cells.findIndex((c) => c.uid === m.valueCellUid);
          kids[idx]?.classList.add("result");
        }
        return;
      }

      for (const el of this.listEl.children) el.classList.remove("result");

      if (this.scalarInput) {
        this.scalarInput.update(m.text);
        this.scalarInput.input.readOnly = !m.editable;
      } else {
        this.scalarEl.textContent = m.text;
      }

      this.scalarEl.classList.toggle("error", m.isError);
    });
  }
}

class BarView extends StandardView {
  constructor(valueSig: CellValueSignal, path: CellPath) {
    super(valueSig, path);
    this.listEl.classList.remove("list");
    this.listEl.classList.add("bar");
  }
}

const views: Record<string, new (c: CellValueSignal, p: CellPath) => View> = {
  styled: StyledView,
  slider: SliderView,
  table: TableView,
  bar: BarView,
};

class CellHeaderView extends View {
  element = createEl("div", { className: "header" });

  nameInput = new AutosizeInput(false, { className: "name" });
  nameSlot: HeaderSlot = {
    el: this.nameInput.input,
    mode: "name",
    commit: () => {},
  };

  cache: (
    | {
        wrap: HTMLElement;
        label: HTMLElement;
        input: AutosizeInput;
        slot: HeaderSlot;
        multiline: boolean;
      }
    | undefined
  )[] = [];

  slots: HeaderSlot[] = [this.nameSlot];

  constructor(cell: Cell) {
    super();

    this.effect(
      () =>
        getRenderEditors(cell).map((f) => ({
          mode: f.mode,
          label: f.label ?? "",
        })),
      (defs) => {
        const nodes: HTMLElement[] = [this.nameInput.element];
        const slots: HeaderSlot[] = [this.nameSlot];

        for (let i = 0; i < defs.length; i++) {
          const d = defs[i]!;
          const multiline = d.mode === "header-multi";

          let rec = this.cache[i];
          if (!rec || rec.multiline !== multiline) {
            rec?.wrap.remove();

            const wrap = createEl("div", { className: "wrap" });
            const label = createEl("span", { className: "equals" });
            const input = new AutosizeInput(multiline, { className: "code" });
            wrap.append(label, input.element);

            rec = {
              wrap,
              label,
              input,
              slot: { el: input.input, mode: d.mode, commit: () => {} },
              multiline,
            };
            this.cache[i] = rec;
          }

          rec.slot.mode = d.mode;
          rec.label.textContent = d.label;
          rec.label.style.display = d.label ? "" : "none";

          nodes.push(rec.wrap);
          slots.push(rec.slot);
        }

        for (let i = defs.length; i < this.cache.length; i++) {
          this.cache[i]?.wrap.remove();
          this.cache[i] = undefined;
        }

        reconcileDomChildren(this.element, nodes);
        this.slots = slots;
      }
    );

    this.effect(() => {
      const text = cell.name.get() || "";
      this.nameInput.update(text);

      this.nameInput.input.readOnly = !isWritableSignal(cell.name);
      this.nameInput.input.disabled = false;
      this.nameSlot.commit = isWritableSignal(cell.name)
        ? cell.name.set
        : () => {};
    });

    this.effect(() => {
      const eds = getRenderEditors(cell);
      for (let i = 0; i < eds.length; i++) {
        const rec = this.cache[i];
        if (!rec) continue;

        const f = eds[i]!;
        rec.input.update(f.get.value ?? "");

        const canEdit = !!f.set;
        rec.input.input.readOnly = !canEdit;
        rec.input.input.disabled = false;
        rec.slot.commit = canEdit ? (t) => f.set!(t) : () => {};
      }
    });
  }

  getHeaderSlots(): HeaderSlot[] {
    return this.slots;
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

    this.header = new CellHeaderView(cell);

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;

        const nameFocused =
          focusMatches &&
          focus.target.kind === "header" &&
          focus.target.index === 0;

        const nameIsBlank = (cell.name.get() || "").trim() === "";
        const hasName = !nameIsBlank;

        const hasOtherEditors = getRenderEditors(cell).length > 0;

        return {
          needHeader: showHeader && (hasOtherEditors || hasName || nameFocused),
          viewId: cell.view.get(),
        };
      },
      ({ needHeader, viewId }) => {
        const ViewCtor = views[viewId] || StandardView;
        const simpleView =
          ViewCtor === StandardView ||
          ViewCtor === TableView ||
          ViewCtor === BarView ||
          ViewCtor === SliderView;

        if (!this.view || this.view.constructor !== ViewCtor) {
          this.view?.dispose();
          this.view = new ViewCtor(cell.value, path);
        }

        if (!simpleView) {
          if (!this.stdView) this.stdView = new StandardView(cell.value, path);
        } else if (this.stdView) {
          this.stdView.dispose();
          this.stdView = undefined;
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view.element,
          !simpleView ? this.stdView!.element : null,
        ]);

        const rawBodyEl = simpleView
          ? this.view.element
          : this.stdView!.element;
        const bodyEl = (rawBodyEl as any).__textInputTarget || rawBodyEl;

        registerBinding(path, {
          cell: this.element,
          body: bodyEl,
          header: this.header.getHeaderSlots(),
        });
      }
    );

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;

        const nameFocused =
          focusMatches &&
          focus.target.kind === "header" &&
          focus.target.index === 0;

        const nameIsBlank = (cell.name.get() || "").trim() === "";

        return {
          focused: focusMatches,
          valueFocused: focusMatches && focus.target.kind === "body",
          hideName: nameIsBlank && !nameFocused,
        };
      },
      ({ focused, valueFocused, hideName }) => {
        this.element.classList.toggle("focused", focused);
        this.view.element.classList.toggle("focused", valueFocused);
        this.header.nameInput.element.classList.toggle("hidden", hideName);
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
