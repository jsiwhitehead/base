import {
  effect,
  computed,
  signal,
  type Signal as PSignal,
} from "@preact/signals-core";

import { type ItemId, type Value, sel } from "./model";
import { type Focus, getEditableFields } from "./interact";
import { focusSignal, registerBinding, unregisterBinding } from "./inputs";

type CreateOptions = { className?: string; value?: string };

function createEl(
  tag: string,
  { className, value }: CreateOptions = {}
): HTMLElement {
  const el = document.createElement(tag);
  if (className) el.classList.add(...className.split(/\s+/).filter(Boolean));
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
  if (className) input.classList.add(...className.split(/\s+/).filter(Boolean));
  if (value != null) input.value = value;
  input.autocapitalize = "off";
  input.autocomplete = "off";
  input.autocorrect = "off" as any;
  input.spellcheck = false;
  if (input instanceof HTMLTextAreaElement) input.rows = 1;
  return input;
}

function reconcileDomChildren(
  parent: HTMLElement,
  next: (HTMLElement | null | undefined)[]
) {
  const desired = next.filter(
    (n): n is HTMLElement => n instanceof HTMLElement
  );
  desired.forEach((child, i) => {
    const current = parent.children[i];
    if (current !== child) parent.insertBefore(child, current || null);
  });
  while (parent.children.length > desired.length)
    parent.removeChild(parent.lastElementChild!);
}

function getMirrorText(text: string): string {
  if (!text) return " ";
  if (text.endsWith("\n")) return text + "\u00a0";
  return text;
}

function focusKey(f: Focus): string {
  return `${String(f.containerId)}::${String(f.id)}`;
}

class AutosizeInput {
  element: HTMLElement;
  input: HTMLInputElement | HTMLTextAreaElement;
  mirror: HTMLSpanElement;

  constructor(multiline: boolean, { className, value }: CreateOptions = {}) {
    const wrap = createEl("div", { className: "autosize" });
    if (className)
      wrap.classList.add(...className.split(/\s+/).filter(Boolean));

    const mirror = createEl("span") as HTMLSpanElement;
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
    const mt = getMirrorText(text);
    if (this.mirror.textContent !== mt) this.mirror.textContent = mt;
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
    parentId: ItemId,
    create: (childId: ItemId, focus: Focus) => View
  ) {
    this.childList = new ChildViewManager(container, parentId, create);
    this.cleanups.push(() => this.childList!.dispose());
  }

  updateChildren(ids: ItemId[]) {
    this.childList?.update(ids);
  }

  onCleanup(fn: () => void) {
    this.cleanups.push(fn);
  }

  dispose() {
    this.cleanups.toReversed().forEach((fn) => fn());
    this.cleanups = [];
  }
}

type ChildRec = { element: HTMLElement; dispose?: () => void };

class ChildViewManager {
  cache = new Map<ItemId, ChildRec>();

  constructor(
    readonly container: HTMLElement,
    readonly parentId: ItemId,
    readonly create: (childId: ItemId, focus: Focus) => View
  ) {}

  update(nextIds: ItemId[]) {
    const keep = new Set(nextIds);

    for (const [id, rec] of this.cache) {
      if (!keep.has(id)) {
        rec.dispose?.();
        this.cache.delete(id);
      }
    }

    const desired = nextIds.map((id) => {
      let rec = this.cache.get(id);
      if (!rec) {
        const v = this.create(id, { containerId: this.parentId, id });
        rec = { element: v.element, dispose: () => v.dispose() };
        this.cache.set(id, rec);
      }
      return rec.element;
    });

    reconcileDomChildren(this.container, desired);
  }

  dispose() {
    for (const rec of this.cache.values()) rec.dispose?.();
    this.cache.clear();
  }
}

type RowChildKey = ItemId | string;

type RowChild =
  | { kind: "item"; id: ItemId }
  | { kind: "slot"; key: string; create: () => HTMLElement };

class RowChildViewManager {
  cache = new Map<RowChildKey, ChildRec>();

  constructor(
    readonly container: HTMLElement,
    readonly rowId: ItemId,
    readonly createItemView: (cellId: ItemId, focus: Focus) => View
  ) {}

  update(children: RowChild[]) {
    const keys = children.map((c) => (c.kind === "item" ? c.id : c.key));
    const keep = new Set<RowChildKey>(keys);

    for (const [k, rec] of this.cache) {
      if (!keep.has(k)) {
        rec.dispose?.();
        this.cache.delete(k);
      }
    }

    const desired = children.map((c) => {
      const key: RowChildKey = c.kind === "item" ? c.id : c.key;

      let rec = this.cache.get(key);
      if (!rec) {
        if (c.kind === "item") {
          const v = this.createItemView(c.id, {
            containerId: this.rowId,
            id: c.id,
          });
          rec = { element: v.element, dispose: () => v.dispose() };
        } else {
          rec = { element: c.create() };
        }
        this.cache.set(key, rec);
      }
      return rec.element;
    });

    reconcileDomChildren(this.container, desired);
  }

  dispose() {
    for (const rec of this.cache.values()) rec.dispose?.();
    this.cache.clear();
  }
}

type HeaderSlot = {
  el: HTMLInputElement | HTMLTextAreaElement;
  mode: "label" | "content" | "header" | "header-multi";
  commit: (text: string) => void;
};

function renderValueReadonly(v: Value): HTMLElement {
  if (v.kind === "blank")
    return createEl("div", { className: "item readonly" });
  if (v.kind === "issue")
    return createEl("div", {
      className: "item readonly issue",
      value: v.message,
    });
  if (v.kind === "scalar")
    return createEl("div", {
      className: "item readonly",
      value: String(v.value),
    });

  if (v.kind === "item-group") {
    return createEl("div", {
      className: "item readonly issue",
      value: "[item-group]",
    });
  }

  const wrap = createEl("div", { className: "group readonly" });
  reconcileDomChildren(
    wrap,
    v.items.map(({ label, value }) => renderLabeledValueReadonly(label, value))
  );
  return wrap;
}

function renderLabeledValueReadonly(
  label: string | undefined,
  v: Value
): HTMLElement {
  if (!label) return renderValueReadonly(v);

  const row = createEl("div", { className: "row readonly" });
  const lab = createEl("div", { className: "label", value: label });
  const val = renderValueReadonly(v);
  val.classList.add("item");
  reconcileDomChildren(row, [lab, val]);
  return row;
}

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

  constructor(readonly id: ItemId, readonly focusKeyStr: string) {
    super();

    this.effect(
      () => {
        sel.item(id);
        return getEditableFields(id)
          .filter((f) => f.slot === "header")
          .map((f) => ({
            key: f.key,
            label: f.label ?? "",
            multiline: !!f.multiline,
          }));
      },
      (defs) => {
        const nodes: HTMLElement[] = [this.labelInput.element];
        const slots: HeaderSlot[] = [this.labelSlot];

        for (let i = 0; i < defs.length; i++) {
          const d = defs[i]!;
          const multiline = d.multiline;

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
              slot: {
                el: input.input,
                mode: multiline ? "header-multi" : "header",
                commit: () => {},
              },
              multiline,
            };
            this.cache[i] = rec;
          }

          rec.slot.mode = multiline ? "header-multi" : "header";
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
      const f = getEditableFields(id).find((x) => x.slot === "label");
      const txt = (f?.get() ?? "") as string;

      this.labelInput.update(txt);

      const settable = !!f?.set;
      this.labelInput.input.readOnly = !settable;
      this.labelInput.input.disabled = false;

      this.labelSlot.commit = settable ? (t) => f!.set!(t) : () => {};
    });

    this.effect(() => {
      const headerFields = getEditableFields(id).filter(
        (f) => f.slot === "header"
      );

      for (let i = 0; i < headerFields.length; i++) {
        const rec = this.cache[i];
        if (!rec) continue;

        const f = headerFields[i]!;
        rec.input.update((f.get() ?? "") as string);

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

class StandardView extends View {
  element!: HTMLElement;

  scalarInput = new AutosizeInput(true, { className: "content" });
  scalarEl = this.scalarInput.element;

  groupEl = createEl("div", { className: "group" });
  valueGroupEl = createEl("div", { className: "group readonly" });

  constructor(readonly id: ItemId) {
    super();

    this.element = this.scalarEl;

    this.initChildren(
      this.groupEl,
      id,
      (childId, focus) => new ItemView(focus, true)
    );

    this.effect(
      () => sel.value(id).kind,
      (k) => {
        const next =
          k === "item-group"
            ? this.groupEl
            : k === "value-group"
            ? this.valueGroupEl
            : this.scalarEl;

        if (this.element !== next) {
          this.element.replaceWith(next);
          this.element = next;
        }
      }
    );

    this.effect(() => {
      const v = sel.value(id);

      if (v.kind === "item-group") {
        this.updateChildren(v.items);
        return;
      }

      if (v.kind === "value-group") {
        reconcileDomChildren(
          this.valueGroupEl,
          v.items.map(({ label, value }) =>
            renderLabeledValueReadonly(label, value)
          )
        );
        return;
      }

      const text =
        v.kind === "blank"
          ? ""
          : v.kind === "issue"
          ? v.message
          : v.kind === "scalar"
          ? String(v.value)
          : "[unknown]";

      const settable = sel.item(id).contentSettable;

      this.scalarInput.update(text);
      this.scalarInput.input.readOnly = !settable;

      this.scalarEl.classList.toggle("issue", v.kind === "issue");
    });
  }
}

class RowHeaderView extends View {
  element = createEl("div", { className: "label" });

  labelDisplayEl = createEl("div", { className: "label" });
  labelInput = new AutosizeInput(false, { className: "label" });

  slot: HeaderSlot = {
    el: this.labelInput.input,
    mode: "label",
    commit: () => {},
  };

  constructor(readonly rowId: ItemId, readonly rowFocus: Focus) {
    super();

    const rowKey = focusKey(rowFocus);
    this.effect(
      () => {
        const focus = focusSignal.value;
        return (
          focus.kind === "focused" &&
          focusKey(focus.focus) === rowKey &&
          focus.target.kind === "header" &&
          focus.target.index === 0
        );
      },
      (showInput) => {
        reconcileDomChildren(this.element, [
          showInput ? this.labelInput.element : this.labelDisplayEl,
        ]);
      }
    );

    this.effect(() => {
      const f = getEditableFields(rowId).find((x) => x.slot === "label");
      const txt = (f?.get() ?? "") as string;

      this.labelDisplayEl.textContent = txt;
      this.labelInput.update(txt);

      const settable = !!f?.set;
      this.labelInput.input.readOnly = !settable;
      this.labelInput.input.disabled = false;

      this.slot.commit = settable ? (t) => f!.set!(t) : () => {};
    });
  }

  getHeaderSlots(): HeaderSlot[] {
    return [this.slot];
  }
}

class RowView extends View {
  element = createEl("div", { className: "row" });

  header: RowHeaderView;
  cells: RowChildViewManager;

  constructor(
    readonly tableId: ItemId,
    readonly rowId: ItemId,
    readonly columnsJsonSig: PSignal<string>
  ) {
    super();

    const rowFocus: Focus = { containerId: tableId, id: rowId };
    this.header = new RowHeaderView(rowId, rowFocus);

    this.cells = new RowChildViewManager(
      this.element,
      rowId,
      (cellId, focus) => new ItemView(focus, false)
    );
    this.onCleanup(() => this.cells.dispose());

    this.effect(() => {
      const cols: string[] = JSON.parse(columnsJsonSig.value);

      const rowVal = sel.value(rowId);
      const byLabel = new Map<string, ItemId>();

      if (rowVal.kind === "item-group") {
        for (const cid of rowVal.items) {
          const nm = sel.item(cid).label;
          if (nm) byLabel.set(nm, cid);
        }
      }

      const items: RowChild[] = [];

      items.push({
        kind: "slot",
        key: "__rowlabel",
        create: () => this.header.element,
      });

      for (const col of cols) {
        const cid = byLabel.get(col);
        if (cid != null) {
          items.push({ kind: "item", id: cid });
        } else {
          const key = `__col:${col}`;
          items.push({
            kind: "slot",
            key,
            create: () => createEl("div", { className: "item cell" }),
          });
        }
      }

      this.cells.update(items);
    });

    registerBinding(rowFocus, {
      item: this.element,
      content: this.element,
      header: this.header.getHeaderSlots(),
    });

    const rowKey2 = focusKey(rowFocus);
    this.effect(() => {
      const focus = focusSignal.value;
      const focused =
        focus.kind === "focused" && focusKey(focus.focus) === rowKey2;
      const contentFocused = focused && focus.target.kind === "content";
      this.element.classList.toggle("focused", contentFocused);
    });

    this.onCleanup(() => {
      unregisterBinding(rowFocus);
      this.header.dispose();
    });
  }
}

class TableView extends View {
  element = createEl("div", { className: "table" });
  headerRow = createEl("div", { className: "row table-header" });
  body = createEl("div", { className: "table-body" });

  columnsJsonSig = signal("[]");

  constructor(readonly id: ItemId) {
    super();

    this.element.append(this.headerRow, this.body);

    const rowManager = new ChildViewManager(
      this.body,
      id,
      (rowId) => new RowView(id, rowId, this.columnsJsonSig)
    );
    this.onCleanup(() => rowManager.dispose());

    this.effect(
      () => {
        const v = sel.value(id);
        if (v.kind !== "item-group") return [] as string[];

        const firstRowId = v.items[0];
        if (firstRowId == null) return [] as string[];

        const rowV = sel.value(firstRowId);
        if (rowV.kind !== "item-group") return [] as string[];

        return [
          ...new Set(
            rowV.items
              .map((cid) => sel.item(cid).label)
              .filter((x): x is string => !!x)
          ),
        ];
      },
      (cols) => {
        const cells: HTMLElement[] = [createEl("div", { className: "label" })];
        for (const label of cols)
          cells.push(createEl("div", { className: "item", value: label }));
        reconcileDomChildren(this.headerRow, cells);
        this.columnsJsonSig.value = JSON.stringify(cols);
      }
    );

    this.effect(() => {
      const v = sel.value(id);
      const rows = v.kind === "item-group" ? v.items : [];
      rowManager.update(rows);
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

const views: Record<string, new (id: ItemId) => View> = {
  table: TableView,
};

class ItemView extends View {
  element = createEl("div", { className: "item" });
  header: ItemHeaderView;
  view!: View;

  constructor(readonly focus: Focus, readonly showHeader: boolean = true) {
    super();

    const id = focus.id;
    const fKey = focusKey(focus);

    this.header = new ItemHeaderView(id, fKey);

    this.effect(
      () => {
        const focusState = focusSignal.value;
        const focusMatches =
          focusState.kind === "focused" && focusKey(focusState.focus) === fKey;

        const labelFocused =
          focusMatches &&
          focusState.target.kind === "header" &&
          focusState.target.index === 0;

        const it = sel.item(id);
        const labelIsBlank = (it.label || "").trim() === "";
        const hasLabel = !labelIsBlank;

        const hasOtherInputs = getEditableFields(id).some(
          (f) => f.slot === "header"
        );

        return {
          needHeader:
            this.showHeader && (hasOtherInputs || hasLabel || labelFocused),
          viewId: it.view || "",
        };
      },
      ({ needHeader, viewId }) => {
        const ViewCtor = views[viewId] || StandardView;

        if (!this.view || this.view.constructor !== ViewCtor) {
          this.view?.dispose();
          this.view = new ViewCtor(id);
        }

        reconcileDomChildren(this.element, [
          needHeader ? this.header.element : null,
          this.view.element,
        ]);

        const raw = this.view.element;
        const contentEl = (raw as any).__textInputTarget || raw;

        registerBinding(this.focus, {
          item: this.element,
          content: contentEl,
          header: this.header.getHeaderSlots(),
        });
      }
    );

    this.effect(
      () => {
        const focusState = focusSignal.value;
        const focusMatches =
          focusState.kind === "focused" && focusKey(focusState.focus) === fKey;

        const labelFocused =
          focusMatches &&
          focusState.target.kind === "header" &&
          focusState.target.index === 0;

        const it = sel.item(id);
        const labelIsBlank = (it.label || "").trim() === "";

        return {
          focused: focusMatches,
          contentFocused: focusMatches && focusState.target.kind === "content",
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
      unregisterBinding(this.focus);
      this.header.dispose();
      this.view.dispose();
    });
  }
}

export default function mountRoot(rootId: ItemId) {
  return new ItemView({ containerId: rootId, id: rootId }, false);
}
