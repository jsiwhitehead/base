import {
  type Signal as PSignal,
  signal,
  effect,
  computed,
} from "@preact/signals-core";

import {
  type ItemContentSignal,
  type Item,
  type InputFieldMode,
  type Signal,
  getViewInputs,
  isSetSignal,
  getViewModel,
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

type HeaderSlot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  mode: InputFieldMode;
  commit: (text: string) => void;
};

class RowHeaderView extends View {
  element = createEl("div", { className: "label" });
  labelDisplayEl = createEl("div", { className: "label" });
  labelInput = new AutosizeInput(false, { className: "label" });

  slot: HeaderSlot = {
    el: this.labelInput.input,
    mode: "label",
    commit: () => {},
  };

  constructor(labelSig: Signal<string>, pathKey: string) {
    super();

    this.slot.commit = isSetSignal(labelSig) ? labelSig.set : () => {};

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
      (showLabelInput) => {
        reconcileDomChildren(this.element, [
          showLabelInput ? this.labelInput.element : this.labelDisplayEl,
        ]);
      }
    );

    this.effect(() => {
      const label = labelSig.get() || "";
      this.labelDisplayEl.textContent = label;
      this.labelInput.update(label);
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
    this.header = new RowHeaderView(rowItem.label, pathKey);

    this.initChildren(
      this.element,
      path,
      (item, p) => new ItemView(item, p, false)
    );

    this.effect(() => {
      const cols: string[] = JSON.parse(columnsJsonSig.value);

      const rm = getViewModel(rowItem.content);
      const rowGroup = rm.kind === "group" ? rm : null;

      const byLabel = new Map<string, Item>();
      if (rowGroup) {
        for (const c of rowGroup.items) {
          const n = c.label.get();
          if (n) byLabel.set(n, c);
        }
      }

      const items: ChildItem[] = [];
      items.push({ uid: "label", create: () => this.header.element });

      for (const label of cols) {
        const real = byLabel.get(label);
        if (real) {
          items.push(real);
        } else {
          items.push({
            uid: label,
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
            rm.items.map((c) => c.label.get()).filter((x): x is string => !!x)
          ),
        ];
      },
      (cols) => {
        const cells: HTMLElement[] = [createEl("div", { className: "label" })];
        for (const label of cols) {
          cells.push(createEl("div", { className: "item", value: label }));
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
        return;
      }

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

const views: Record<string, new (c: ItemContentSignal, p: ItemPath) => View> = {
  table: TableView,
};

class ItemHeaderView extends View {
  element = createEl("div", { className: "header" });

  labelInput = new AutosizeInput(false, { className: "label" });
  labelSlot: HeaderSlot = {
    el: this.labelInput.input,
    mode: "label",
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

  slots: HeaderSlot[] = [this.labelSlot];

  constructor(item: Item) {
    super();

    this.effect(
      () =>
        getViewInputs(item).map((f) => ({
          mode: f.mode,
          label: f.label ?? "",
        })),
      (defs) => {
        const nodes: HTMLElement[] = [this.labelInput.element];
        const slots: HeaderSlot[] = [this.labelSlot];

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
      const text = item.label.get() || "";
      this.labelInput.update(text);

      this.labelInput.input.readOnly = !isSetSignal(item.label);
      this.labelInput.input.disabled = false;
      this.labelSlot.commit = isSetSignal(item.label)
        ? item.label.set
        : () => {};
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

  constructor(item: Item, path: ItemPath, showHeader: boolean = true) {
    super();

    const pathKey = path.join(".");

    this.header = new ItemHeaderView(item);

    this.effect(
      () => {
        const focus = focusSignal.value;
        const focusMatches =
          focus.kind === "focused" && focus.path.join(".") === pathKey;

        const labelFocused =
          focusMatches &&
          focus.target.kind === "header" &&
          focus.target.index === 0;

        const labelIsBlank = (item.label.get() || "").trim() === "";
        const hasLabel = !labelIsBlank;

        const hasOtherInputs = getViewInputs(item).length > 0;

        return {
          needHeader:
            showHeader && (hasOtherInputs || hasLabel || labelFocused),
          viewId: item.view.get(),
        };
      },
      ({ needHeader, viewId }) => {
        const ViewCtor = views[viewId] || StandardView;

        if (!this.view || this.view.constructor !== ViewCtor) {
          this.view?.dispose();
          this.view = new ViewCtor(item.content, path);
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view.element,
        ]);

        const rawBodyEl = this.view.element;
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

        const labelFocused =
          focusMatches &&
          focus.target.kind === "header" &&
          focus.target.index === 0;

        const labelIsBlank = (item.label.get() || "").trim() === "";

        return {
          focused: focusMatches,
          contentFocused: focusMatches && focus.target.kind === "body",
          hideLabel: labelIsBlank && !labelFocused,
        };
      },
      ({ focused, contentFocused, hideLabel }) => {
        this.element.classList.toggle("focused", focused);
        this.view.element.classList.toggle("focused", contentFocused);
        this.header.labelInput.element.classList.toggle("hidden", hideLabel);
      }
    );

    this.onCleanup(() => {
      unregisterBinding(path);
      this.header.dispose();
      this.view.dispose();
    });
  }
}

export default function mountRoot(
  rootSignal: ItemContentSignal,
  rootPath: ItemPath
) {
  return new StandardView(rootSignal, rootPath);
}
