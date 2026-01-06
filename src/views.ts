import {
  type Signal as PSignal,
  signal,
  effect,
  computed,
  untracked,
} from "@preact/signals-core";

import {
  type GroupContent,
  type ContentSignal,
  type ItemContentSignal,
  type Item,
  type InputFieldMode,
  type Signal,
  getViewInputs,
  isSetSignal,
  createScalar,
  getViewModel,
  getViewProps,
} from "./model";
import { type ItemPath } from "./interact";
import { focusSignal, registerBinding, unregisterBinding } from "./inputs";

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

type ChildItem = Item | { uid: number | string; create: () => HTMLElement };

class ChildViewManager {
  cache = new Map<
    number | string,
    { element: HTMLElement; dispose?: () => void }
  >();

  constructor(
    readonly container: HTMLElement,
    readonly parentPath: ItemPath,
    readonly create: (item: Item, path: ItemPath) => View
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
        if ("content" in item) {
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
    parentPath: ItemPath,
    create: (item: Item, path: ItemPath) => View
  ) {
    this.childList = new ChildViewManager(container, parentPath, create);
    this.cleanups.push(() => this.childList!.dispose());
  }

  updateChildren(items: Item[]) {
    this.childList?.update(items);
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

  constructor(contentSig: ItemContentSignal, path: ItemPath) {
    super();

    const setHover = (toTrue: boolean) => {
      untracked(() => {
        const p = getViewProps(contentSig);
        p?.setFlag("hover", toTrue);
      });
    };

    this.element.addEventListener("mouseenter", () => setHover(true));
    this.element.addEventListener("mouseleave", () => setHover(false));

    this.initChildren(
      this.element,
      path,
      (item, childPath) => new StyledView(item.content, childPath)
    );

    this.effect(() => {
      const m = getViewModel(contentSig);

      this.element.style.setProperty("--lh", "1.5");

      if (m.kind !== "group") {
        this.updateChildren([]);
        this.element.classList.add("trim-half-leading");

        const text = m.text;
        if (this.element.textContent !== text) {
          this.element.textContent = text;
        }
        return;
      }

      this.element.classList.remove("trim-half-leading");

      this.updateChildren(m.items);

      const p = getViewProps(contentSig);

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

  constructor(contentSig: ItemContentSignal, path: ItemPath) {
    super();

    const input = document.createElement("input");
    input.classList.add("slider");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "1";

    this.element = input;

    input.addEventListener("input", () => {
      if (isSetSignal(contentSig)) {
        const n = Number(input.value);
        if (Number.isFinite(n)) contentSig.set(createScalar(n));
      }
    });

    this.effect(() => {
      const m = getViewModel(contentSig);
      const n = m.kind === "scalar" && m.number !== undefined ? m.number : 0;

      if (this.element.value !== String(n)) {
        this.element.value = String(n);
      }
      this.element.disabled = !(m.kind === "scalar" && m.settable);
    });
  }
}

type HeaderSlot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  mode: InputFieldMode;
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

    this.slot.commit = isSetSignal(nameSig) ? nameSig.set : () => {};

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

  constructor(rowItem: Item, path: ItemPath, columnsJsonSig: PSignal<string>) {
    super();

    const pathKey = path.join(".");
    this.header = new RowHeaderView(rowItem.name, pathKey);

    this.initChildren(
      this.element,
      path,
      (item, p) => new ItemView(item, p, false)
    );

    this.effect(() => {
      const cols: string[] = JSON.parse(columnsJsonSig.value);

      const rm = getViewModel(rowItem.content);
      const rowGroup = rm.kind === "group" ? rm : null;

      const byName = new Map<string, Item>();
      if (rowGroup) {
        for (const c of rowGroup.items) {
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
            create: () => createEl("div", { className: "item" }),
          });
        }
      }

      this.childList!.update(items);
    });

    registerBinding(path, {
      item: this.element,
      body: this.element,
      header: this.header.getHeaderSlots(),
    });

    this.effect(() => {
      const focus = focusSignal.value;
      const focused =
        focus.kind === "focused" && focus.path.join(".") === pathKey;
      const contentFocused = focused && focus.target.kind === "body";
      this.element.classList.toggle("focused", contentFocused);
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

  constructor(contentSig: ItemContentSignal, path: ItemPath) {
    super();

    this.element.append(this.headerRow, this.body);
    this.headerRow.classList.add("table-header");

    this.initChildren(
      this.body,
      path,
      (item, p) => new RowView(item, p, this.columnsJsonSig)
    );

    this.effect(
      () => {
        const m = getViewModel(contentSig);
        if (m.kind !== "group") return [];

        const first = m.items[0]?.content;
        if (!first) return [];

        const rm = getViewModel(first);
        if (rm.kind !== "group") return [];

        return [
          ...new Set(
            rm.items.map((c) => c.name.get()).filter((x): x is string => !!x)
          ),
        ];
      },
      (cols) => {
        const cells: HTMLElement[] = [createEl("div", { className: "label" })];
        for (const name of cols) {
          cells.push(createEl("div", { className: "item", value: name }));
        }
        reconcileDomChildren(this.headerRow, cells);
        this.columnsJsonSig.value = JSON.stringify(cols);
      }
    );

    this.effect(() => {
      const m = getViewModel(contentSig);
      this.updateChildren(m.kind === "group" ? m.items : []);
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
          const index = kids.findIndex(
            (el, i) => i > 0 && el.classList.contains("focused")
          );
          if (index !== -1) {
            col = index - 1;
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
  groupEl: HTMLElement;

  constructor(contentSig: ItemContentSignal, path: ItemPath) {
    super();

    if (isSetSignal(contentSig)) {
      this.scalarInput = new AutosizeInput(true, { className: "content" });
      this.scalarEl = this.scalarInput.element;
    } else {
      this.scalarEl = createEl("div", { className: "content" });
    }

    this.groupEl = createEl("div", { className: "group" });
    this.initChildren(
      this.groupEl,
      path,
      (item, childPath) => new ItemView(item, childPath)
    );

    this.effect(
      () => getViewModel(contentSig).kind === "group",
      (shouldBeGroup) => {
        const next = shouldBeGroup ? this.groupEl : this.scalarEl;
        if (this.element !== next) {
          this.element?.replaceWith?.(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const m = getViewModel(contentSig);

      if (m.kind === "group") {
        this.updateChildren(m.items);

        const kids = this.groupEl.children;
        for (const el of kids) el.classList.remove("result");

        if (m.contentItemUid !== undefined) {
          const index = m.items.findIndex((c) => c.uid === m.contentItemUid);
          kids[index]?.classList.add("result");
        }
        return;
      }

      for (const el of this.groupEl.children) el.classList.remove("result");

      if (this.scalarInput) {
        this.scalarInput.update(m.text);
        this.scalarInput.input.readOnly = !m.settable;
      } else {
        this.scalarEl.textContent = m.text;
      }

      this.scalarEl.classList.toggle("issue", m.isIssue);
    });
  }
}

class BarView extends StandardView {
  constructor(contentSig: ItemContentSignal, path: ItemPath) {
    super(contentSig, path);
    this.groupEl.classList.remove("group");
    this.groupEl.classList.add("bar");
  }
}

const views: Record<string, new (c: ItemContentSignal, p: ItemPath) => View> = {
  styled: StyledView,
  slider: SliderView,
  table: TableView,
  bar: BarView,
};

class ItemHeaderView extends View {
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

  constructor(item: Item) {
    super();

    this.effect(
      () =>
        getViewInputs(item).map((f) => ({
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
      const text = item.name.get() || "";
      this.nameInput.update(text);

      this.nameInput.input.readOnly = !isSetSignal(item.name);
      this.nameInput.input.disabled = false;
      this.nameSlot.commit = isSetSignal(item.name) ? item.name.set : () => {};
    });

    this.effect(() => {
      const eds = getViewInputs(item);
      for (let i = 0; i < eds.length; i++) {
        const rec = this.cache[i];
        if (!rec) continue;

        const f = eds[i]!;
        rec.input.update(f.get.value ?? "");

        const settable = !!f.set;
        rec.input.input.readOnly = !settable;
        rec.input.input.disabled = false;
        rec.slot.commit = settable ? (t) => f.set!(t) : () => {};
      }
    });
  }

  getHeaderSlots(): HeaderSlot[] {
    return this.slots;
  }
}

class ItemView extends View {
  element = createEl("div", { className: "item" });
  header: ItemHeaderView;
  view!: View;
  stdView?: StandardView;

  constructor(item: Item, path: ItemPath, showHeader: boolean = true) {
    super();

    const pathKey = path.join(".");

    this.header = new ItemHeaderView(item);

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;

        const nameFocused =
          focusMatches &&
          focus.target.kind === "header" &&
          focus.target.index === 0;

        const nameIsBlank = (item.name.get() || "").trim() === "";
        const hasName = !nameIsBlank;

        const hasOtherInputs = getViewInputs(item).length > 0;

        return {
          needHeader: showHeader && (hasOtherInputs || hasName || nameFocused),
          viewId: item.view.get(),
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
          this.view = new ViewCtor(item.content, path);
        }

        if (!simpleView) {
          if (!this.stdView)
            this.stdView = new StandardView(item.content, path);
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
          item: this.element,
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

        const nameIsBlank = (item.name.get() || "").trim() === "";

        return {
          focused: focusMatches,
          contentFocused: focusMatches && focus.target.kind === "body",
          hideName: nameIsBlank && !nameFocused,
        };
      },
      ({ focused, contentFocused, hideName }) => {
        this.element.classList.toggle("focused", focused);
        this.view.element.classList.toggle("focused", contentFocused);
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

export default function mountRoot(
  rootSignal: ContentSignal<GroupContent>,
  rootPath: ItemPath
) {
  return new StandardView(rootSignal, rootPath);
}
