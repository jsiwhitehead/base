import { effect, signal } from "@preact/signals-core";
import type { Store, ItemId, Txn, Op, Value } from "../store";
import {
  type Editor,
  type Region,
  type Selection,
  type Focus,
  type FocusTarget,
  type EditorEffect,
  type Binding,
  type RegionKeyResult,
  mkFocusSelection,
} from "../editor";
import {
  el,
  on,
  textInput,
  syncValue,
  reconcileChildren,
  ChildManager,
  getEditableText,
  parseScalar,
  bindCommitTextInput,
  renderLabeledValueReadonly,
  bindReadonlyItemText,
  CleanupBag,
} from "../ui";
import { replaceMountedRegion } from "./index";
import { createSliderRegion } from "./slider";

export type TableRegionCtx = { editor: Editor };

export function createTableRegion(
  ctx: TableRegionCtx,
  tableId: ItemId,
  _tableFocus?: Focus,
): Region {
  const { editor } = ctx;
  const store = editor.store;

  const root = el("div", "region table");
  root.tabIndex = 0;

  const headerRow = el("div", "row table-header");
  const body = el("div", "table-body");
  root.append(headerRow, body);

  const columnsJsonSig = signal("[]");

  const rowMgr = new ChildManager<ItemId>(body, (rowId) => {
    return new RowView({ editor, tableId, columnsJsonSig }, rowId);
  });

  const stopColumns = effect(() => {
    const cols = deriveColumns(store, tableId);
    columnsJsonSig.value = JSON.stringify(cols);

    const cells: HTMLElement[] = [el("div", "label")];
    for (const c of cols) {
      const h = el("div", "item");
      h.textContent = c;
      cells.push(h);
    }
    reconcileChildren(headerRow, cells);
  });

  const stopRows = effect(() => {
    const v = store.sel.value(tableId);
    rowMgr.update(v.kind === "item-group" ? v.items : []);
  });

  const region: Region = {
    id: `table:${String(tableId)}`,
    root,

    onActivate() {
      const sel = editor.runtime.selection.value;
      if (sel.kind !== "idle") return;

      const rowsV = store.sel.value(tableId);
      if (rowsV.kind !== "item-group" || rowsV.items.length === 0) return;

      const firstRowId = rowsV.items[0]!;
      const res = focusRowLabel(tableId, firstRowId, 0);
      editor.setSelection(res.selection, res.effects);
    },

    onKeyDown(e): RegionKeyResult {
      const sel = editor.runtime.selection.value;
      if (sel.kind !== "focused") return;

      const mod = e.metaKey || e.ctrlKey;
      const mode = mod ? "jump" : "step";

      switch (e.key) {
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          e.stopPropagation();

          const dir =
            e.key === "ArrowUp"
              ? "up"
              : e.key === "ArrowDown"
                ? "down"
                : e.key === "ArrowLeft"
                  ? "left"
                  : "right";

          const res = tableNavMove(store, tableId, sel, dir, mode);
          if (res) editor.setSelection(res.selection, res.effects);
          return;
        }

        case "Enter": {
          e.preventDefault();
          e.stopPropagation();

          const res = tableCommands.confirm(editor, tableId, sel);
          if (res.selection)
            editor.setSelection(res.selection, res.effects ?? []);
          return;
        }

        case "Escape": {
          e.preventDefault();
          e.stopPropagation();
          editor.setSelection({ kind: "idle" }, [{ type: "CLEAR_DOM_FOCUS" }]);
          return;
        }
      }
    },

    dispose() {
      stopColumns();
      stopRows();
      rowMgr.dispose();
      root.replaceChildren();
    },
  };

  return region;
}

type CmdResult = {
  didChange: boolean;
  selection?: Selection;
  effects?: EditorEffect[];
  issue?: string;
};

function safeIssue(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function focusRowLabel(tableId: ItemId, rowId: ItemId, caret = 0) {
  return mkFocusSelection(
    { containerId: tableId, id: rowId },
    { kind: "header", index: 0 },
    caret,
  );
}

function focusCell(rowId: ItemId, cellId: ItemId, caret = 0) {
  return mkFocusSelection(
    { containerId: rowId, id: cellId },
    { kind: "content" },
    caret,
  );
}

export const tableCommands = {
  commitRowLabel(
    editor: Editor,
    _tableId: ItemId,
    rowId: ItemId,
    text: string,
  ): CmdResult {
    try {
      editor.apply({
        ops: [{ kind: "patch", id: rowId, next: { label: text } }],
      });
      return { didChange: true };
    } catch (err) {
      return { didChange: false, issue: safeIssue(err) };
    }
  },

  commitCellText(
    editor: Editor,
    _rowId: ItemId,
    cellId: ItemId,
    raw: string,
  ): CmdResult {
    try {
      const store = editor.store;
      if (!store.sel.canEditScalarText(cellId)) return { didChange: false };
      editor.apply({
        ops: [
          {
            kind: "patch",
            id: cellId,
            next: { content: { kind: "scalar", value: parseScalar(raw) } },
          },
        ],
      });
      return { didChange: true };
    } catch (err) {
      return { didChange: false, issue: safeIssue(err) };
    }
  },

  addRowAfter(
    editor: Editor,
    tableId: ItemId,
    afterRowId: ItemId | null,
  ): CmdResult {
    try {
      const store = editor.store;
      const rows = store.sel.groupItems(tableId);
      const afterIdx =
        afterRowId == null ? rows.length - 1 : rows.indexOf(afterRowId);
      const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

      const rowId = store.allocId();

      const txn: Txn = {
        ops: [
          { kind: "create", item: store.make.group(rowId) },
          {
            kind: "reparent",
            spec: { childId: rowId, toOwnerId: tableId, toIndex: at },
          },
        ],
      };

      const res = focusRowLabel(tableId, rowId, 0);
      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    } catch (err) {
      return { didChange: false, issue: safeIssue(err) };
    }
  },

  removeRow(editor: Editor, tableId: ItemId, rowId: ItemId): CmdResult {
    try {
      const store = editor.store;
      const rows = store.sel.groupItems(tableId);
      const idx = rows.indexOf(rowId);

      const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

      const res =
        nextRow != null
          ? focusRowLabel(tableId, nextRow, 0)
          : {
              selection: { kind: "idle" } as Selection,
              effects: [{ type: "CLEAR_DOM_FOCUS" } as EditorEffect],
            };

      const txn: Txn = {
        ops: [{ kind: "reparent", spec: { childId: rowId, toOwnerId: null } }],
      };

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    } catch (err) {
      return { didChange: false, issue: safeIssue(err) };
    }
  },

  addColumn(editor: Editor, tableId: ItemId, label: string): CmdResult {
    try {
      const store = editor.store;
      const name = label.trim();
      if (!name) return { didChange: false };

      const rowsV = store.sel.value(tableId);
      if (rowsV.kind !== "item-group") return { didChange: false };

      const ops: Op[] = [];

      for (const rowId of rowsV.items) {
        const rowInfo = store.sel.item(rowId);
        if (rowInfo.contentKind !== "group") continue;

        if (store.sel.childByLabel(rowId, name) != null) continue;

        const cellId = store.allocId();
        ops.push({ kind: "create", item: store.make.blank(cellId) });
        ops.push({ kind: "patch", id: cellId, next: { label: name } });
        ops.push({
          kind: "reparent",
          spec: {
            childId: cellId,
            toOwnerId: rowId,
            toIndex: store.sel.groupItems(rowId).length,
          },
        });
      }

      if (ops.length === 0) return { didChange: false };

      editor.apply({ ops });
      return { didChange: true };
    } catch (err) {
      return { didChange: false, issue: safeIssue(err) };
    }
  },

  removeColumn(editor: Editor, tableId: ItemId, label: string): CmdResult {
    try {
      const store = editor.store;
      const name = label.trim();
      if (!name) return { didChange: false };

      const rowsV = store.sel.value(tableId);
      if (rowsV.kind !== "item-group") return { didChange: false };

      const ops: Op[] = [];

      for (const rowId of rowsV.items) {
        const cellId = store.sel.childByLabel(rowId, name);
        if (cellId != null)
          ops.push({
            kind: "reparent",
            spec: { childId: cellId, toOwnerId: null },
          });
      }

      if (ops.length === 0) return { didChange: false };

      editor.apply({ ops });
      return { didChange: true };
    } catch (err) {
      return { didChange: false, issue: safeIssue(err) };
    }
  },

  confirm(editor: Editor, tableId: ItemId, sel: Selection): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };

    if (sel.target.kind === "header") {
      return tableCommands.addRowAfter(editor, tableId, sel.focus.id);
    }

    const move = tableNavMove(editor.store, tableId, sel, "down", "step");
    if (move)
      return {
        didChange: false,
        selection: move.selection,
        effects: move.effects,
      };

    return tableCommands.addRowAfter(editor, tableId, sel.focus.containerId);
  },
} as const;

type NavDir = "left" | "right" | "up" | "down";
type NavMode = "step" | "jump";

function deriveColumns(store: Store, tableId: ItemId): string[] {
  const v = store.sel.value(tableId);
  if (v.kind !== "item-group") return [];

  const firstRowId = v.items[0];
  if (firstRowId == null) return [];

  const rowV = store.sel.value(firstRowId);
  if (rowV.kind !== "item-group") return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const cid of rowV.items) {
    const nm = store.sel.item(cid).label;
    if (nm && !seen.has(nm)) {
      seen.add(nm);
      out.push(nm);
    }
  }
  return out;
}

function isRowLabelSelection(sel: Selection, tableId: ItemId): boolean {
  return (
    sel.kind === "focused" &&
    sel.focus.containerId === tableId &&
    sel.target.kind === "header" &&
    sel.target.index === 0
  );
}

function isCellSelection(sel: Selection, tableId: ItemId): boolean {
  return (
    sel.kind === "focused" &&
    sel.target.kind === "content" &&
    sel.focus.containerId !== tableId
  );
}

function rowIds(store: Store, tableId: ItemId): ItemId[] {
  const v = store.sel.value(tableId);
  return v.kind === "item-group" ? v.items : [];
}

function cellIdByColumn(
  store: Store,
  rowId: ItemId,
  col: string,
): ItemId | null {
  return store.sel.childByLabel(rowId, col);
}

function tableNavMove(
  store: Store,
  tableId: ItemId,
  sel: Selection,
  dir: NavDir,
  mode: NavMode,
): { selection: Selection; effects: EditorEffect[] } | null {
  if (sel.kind !== "focused") return null;

  const cols = deriveColumns(store, tableId);
  const rows = rowIds(store, tableId);
  if (rows.length === 0) return null;

  if (isRowLabelSelection(sel, tableId)) {
    const rowId = sel.focus.id;
    const r = rows.indexOf(rowId);
    if (r < 0) return null;

    if (dir === "up" || dir === "down") {
      const nr = r + (dir === "up" ? -1 : 1);
      const nextRowId = rows[nr];
      if (nextRowId == null) return null;
      const res = focusRowLabel(tableId, nextRowId, 0);
      return { selection: res.selection, effects: res.effects };
    }

    if (dir === "right") {
      const firstCol = cols[0];
      if (!firstCol) return null;
      const cid = cellIdByColumn(store, rowId, firstCol);
      if (!cid) return null;
      const res = focusCell(rowId, cid, 0);
      return { selection: res.selection, effects: res.effects };
    }

    void mode;
    return null;
  }

  if (!isCellSelection(sel, tableId)) return null;

  const rowId = sel.focus.containerId;
  const cellId = sel.focus.id;

  const r = rows.indexOf(rowId);
  if (r < 0) return null;

  const colLabel = store.sel.item(cellId).label || "";
  const c = cols.indexOf(colLabel);
  const colIdx = c >= 0 ? c : 0;

  if (dir === "left" || dir === "right") {
    const nc = colIdx + (dir === "left" ? -1 : 1);

    if (nc < 0) {
      const res = focusRowLabel(tableId, rowId, 0);
      return { selection: res.selection, effects: res.effects };
    }

    const nextCol = cols[nc];
    if (!nextCol) return null;

    const nextCell = cellIdByColumn(store, rowId, nextCol);
    if (!nextCell) return null;

    const res = focusCell(rowId, nextCell, 0);
    return { selection: res.selection, effects: res.effects };
  }

  if (dir === "up" || dir === "down") {
    const nr = r + (dir === "up" ? -1 : 1);
    const nextRowId = rows[nr];
    if (!nextRowId) return null;

    const col = cols[colIdx];
    if (!col) return null;

    const nextCell = cellIdByColumn(store, nextRowId, col);
    if (!nextCell) {
      const res = focusRowLabel(tableId, nextRowId, 0);
      return { selection: res.selection, effects: res.effects };
    }

    const res = focusCell(nextRowId, nextCell, 0);
    return { selection: res.selection, effects: res.effects };
  }

  void mode;
  return null;
}

type RowCtx = {
  editor: Editor;
  tableId: ItemId;
  columnsJsonSig: ReturnType<typeof signal>;
};

class RowView {
  element: HTMLElement;

  private headerCell = el("div", "label");
  private labelDisplay = el("div", "label");
  private labelInput = textInput(false);

  private cellsHost = el("div", "row-cells");

  private cellMgr: RowCellManager | null = null;
  private cleanup = new CleanupBag();
  private binding: Binding;

  constructor(
    private ctx: RowCtx,
    private rowId: ItemId,
  ) {
    this.element = el("div", "row");

    this.headerCell.append(this.labelDisplay, this.labelInput);
    this.element.append(this.headerCell, this.cellsHost);

    const rowFocus: Focus = { containerId: ctx.tableId, id: rowId };

    this.binding = {
      focus: rowFocus,
      elementFor: (target: FocusTarget) =>
        target.kind === "header" ? this.labelInput : this.element,
      setCaret: (pos: number) => {
        this.labelInput.setSelectionRange(pos, pos);
      },
      getTextLength: () => this.labelInput.value.length,
    };

    this.ctx.editor.runtime.registerBinding(this.binding);
    this.cleanup.add(() => this.ctx.editor.runtime.unregisterBinding(rowFocus));

    this.labelInput.classList.add("hidden");

    this.cleanup.add(
      on(this.headerCell, "mousedown", (e) => {
        const res = focusRowLabel(this.ctx.tableId, this.rowId, 0);
        this.ctx.editor.setSelection(res.selection, res.effects);
        e.stopPropagation();
      }),
    );

    this.cleanup.add(
      bindCommitTextInput(this.labelInput, {
        commit: (text) => {
          tableCommands.commitRowLabel(
            this.ctx.editor,
            this.ctx.tableId,
            this.rowId,
            text,
          );
        },
      }),
    );

    this.cleanup.add(
      on(this.labelInput, "keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          const cols = JSON.parse(this.ctx.columnsJsonSig.value) as string[];
          const first = cols[0];
          if (!first) return;
          const cid = cellIdByColumn(this.ctx.editor.store, this.rowId, first);
          if (!cid) return;
          const res = focusCell(this.rowId, cid, 0);
          this.ctx.editor.setSelection(res.selection, res.effects);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          const res = focusRowLabel(this.ctx.tableId, this.rowId, 0);
          this.ctx.editor.setSelection(res.selection, res.effects);
        }
      }),
    );

    this.cleanup.add(
      effect(() => {
        const store = this.ctx.editor.store;
        const { tableId } = this.ctx;

        const label = store.sel.item(this.rowId).label ?? "";

        const sel = this.ctx.editor.runtime.selection.value;
        const showInput =
          isRowLabelSelection(sel, tableId) &&
          sel.kind === "focused" &&
          sel.focus.id === this.rowId;

        this.labelInput.classList.toggle("hidden", !showInput);
        this.labelDisplay.classList.toggle("hidden", showInput);

        this.labelDisplay.textContent = label;
        syncValue(this.labelInput, label);

        const cols = JSON.parse(this.ctx.columnsJsonSig.value) as string[];
        this.reconcileCells(cols);
      }),
    );
  }

  dispose() {
    this.cellMgr?.dispose();
    this.cellMgr = null;

    this.cleanup.run();
    this.element.replaceChildren();
  }

  private reconcileCells(cols: string[]) {
    this.cellMgr ??= new RowCellManager(this.ctx, this.rowId, this.cellsHost);
    this.cellMgr.update(cols);
  }
}

class RowCellManager {
  private cache = new Map<string, CellView>();

  constructor(
    private ctx: RowCtx,
    private rowId: ItemId,
    private host: HTMLElement,
  ) {}

  update(cols: string[]) {
    const keep = new Set(cols);

    for (const [col, view] of this.cache) {
      if (!keep.has(col)) {
        view.dispose();
        this.cache.delete(col);
      }
    }

    const desired: HTMLElement[] = [];
    for (const col of cols) {
      let v = this.cache.get(col);
      if (!v) {
        v = new CellView(this.ctx, this.rowId, col);
        this.cache.set(col, v);
      }
      desired.push(v.element);
    }

    reconcileChildren(this.host, desired);
  }

  dispose() {
    for (const v of this.cache.values()) v.dispose();
    this.cache.clear();
  }
}

class CellView {
  element: HTMLElement;

  private inputEl = textInput(true);
  private readonlyEl = el("div", "item readonly");
  private groupEl = el("div", "group");
  private valueGroupEl = el("div", "group readonly");

  private mounted: ReturnType<typeof replaceMountedRegion> | null = null;
  private childMgr: ChildManager<ItemId> | null = null;

  private boundFocus: Focus | null = null;
  private binding: Binding | null = null;
  private currentContentEl: HTMLElement = this.inputEl;

  private cleanup = new CleanupBag();
  private readonlyStop: (() => void) | null = null;

  constructor(
    private ctx: RowCtx,
    private rowId: ItemId,
    private col: string,
  ) {
    this.element = el("div", "item cell");
    this.element.append(this.inputEl);
    this.inputEl.classList.add("content");

    this.cleanup.add(
      bindCommitTextInput(this.inputEl, {
        commit: (text) => {
          const curCellId = cellIdByColumn(
            this.ctx.editor.store,
            this.rowId,
            this.col,
          );
          if (!curCellId) return;
          tableCommands.commitCellText(
            this.ctx.editor,
            this.rowId,
            curCellId,
            text,
          );
        },
      }),
    );

    this.cleanup.add(
      on(this.inputEl, "keydown", (e: KeyboardEvent) => {
        const mod = e.metaKey || e.ctrlKey;

        const caret = this.inputEl.selectionStart ?? 0;
        const end = this.inputEl.selectionEnd ?? caret;
        const len = this.inputEl.value.length;

        const dir =
          e.key === "ArrowUp"
            ? "up"
            : e.key === "ArrowDown"
              ? "down"
              : e.key === "ArrowLeft"
                ? "left"
                : e.key === "ArrowRight"
                  ? "right"
                  : null;

        if (!dir) return;

        const atStart = caret === 0 && end === 0;
        const atEnd = caret === len && end === len;

        const boundary =
          mod ||
          (dir === "left" && atStart) ||
          (dir === "right" && atEnd) ||
          dir === "up" ||
          dir === "down";

        if (!boundary) return;

        e.preventDefault();
        e.stopPropagation();

        const sel = this.ctx.editor.runtime.selection.value;
        const res = tableNavMove(
          this.ctx.editor.store,
          this.ctx.tableId,
          sel,
          dir as any,
          mod ? "jump" : "step",
        );
        if (res) this.ctx.editor.setSelection(res.selection, res.effects);
      }),
    );

    this.cleanup.add(
      effect(() => {
        const store = this.ctx.editor.store;
        const cellId = cellIdByColumn(store, this.rowId, this.col);

        if (!cellId) {
          this.unmountChildRegion();
          this.unbind();
          this.stopReadonly();
          this.element.replaceChildren(el("div", "item cell"));
          return;
        }

        const it = store.sel.item(cellId);
        const v = store.sel.value(cellId);

        if (it.view === "slider") {
          this.stopReadonly();
          this.mountChildRegion(cellId);
          this.reconcileBinding(cellId, this.mounted!.region.root);
          return;
        }

        this.unmountChildRegion();

        const mode =
          v.kind === "item-group"
            ? "item-group"
            : v.kind === "value-group"
              ? "value-group"
              : store.sel.canEditScalarText(cellId)
                ? "text"
                : "readonly-text";

        if (mode === "item-group") {
          this.stopReadonly();
          const wrap = this.groupEl;
          this.element.replaceChildren(wrap);

          if (!this.childMgr) {
            this.childMgr = new ChildManager<ItemId>(wrap, (id) => {
              const d = el("div", "item readonly");
              const stop = bindReadonlyItemText(d, this.ctx.editor.store, id);
              return {
                element: d,
                dispose() {
                  stop();
                  d.replaceChildren();
                },
              };
            });
          } else {
            this.childMgr.setContainer(wrap);
          }

          this.childMgr.update(v.kind === "item-group" ? v.items : []);
          this.reconcileBinding(cellId, wrap);
          return;
        }

        if (mode === "value-group") {
          this.stopReadonly();
          const wrap = this.valueGroupEl;
          wrap.replaceChildren();
          if (v.kind === "value-group") {
            for (const it2 of v.items)
              wrap.append(renderLabeledValueReadonly(it2.label, it2.value));
          }
          this.element.replaceChildren(wrap);
          this.reconcileBinding(cellId, wrap);
          return;
        }

        if (mode === "readonly-text") {
          const wrap = this.readonlyEl;
          wrap.classList.toggle("issue", v.kind === "issue");
          this.element.replaceChildren(wrap);
          this.reconcileBinding(cellId, wrap);

          this.stopReadonly();
          this.readonlyStop = bindReadonlyItemText(
            wrap,
            this.ctx.editor.store,
            cellId,
          );
          return;
        }

        this.stopReadonly();

        const editable = getEditableText(store, cellId);
        this.inputEl.readOnly = editable.kind !== "editable";
        syncValue(this.inputEl, editable.text);
        this.inputEl.classList.toggle("issue", v.kind === "issue");

        this.element.replaceChildren(this.inputEl);
        this.reconcileBinding(cellId, this.inputEl);
      }),
    );
  }

  dispose() {
    this.unmountChildRegion();
    this.childMgr?.dispose();
    this.childMgr = null;
    this.unbind();
    this.stopReadonly();

    this.cleanup.run();
    this.element.replaceChildren();
  }

  private stopReadonly() {
    this.readonlyStop?.();
    this.readonlyStop = null;
  }

  private reconcileBinding(cellId: ItemId, contentEl: HTMLElement) {
    const focus: Focus = { containerId: this.rowId, id: cellId };

    if (
      this.boundFocus &&
      (this.boundFocus.containerId !== focus.containerId ||
        this.boundFocus.id !== focus.id)
    ) {
      this.unbind();
    }

    this.boundFocus = focus;
    this.currentContentEl = contentEl;

    if (!this.binding) {
      this.binding = {
        focus,
        elementFor: () => this.currentContentEl,
        setCaret: (pos: number) => {
          const el2 = this.currentContentEl;
          if (
            el2 instanceof HTMLInputElement ||
            el2 instanceof HTMLTextAreaElement
          ) {
            el2.setSelectionRange(pos, pos);
          }
        },
        getTextLength: () => {
          const el2 = this.currentContentEl;
          if (
            el2 instanceof HTMLInputElement ||
            el2 instanceof HTMLTextAreaElement
          )
            return el2.value.length;
          return 0;
        },
      };
    } else {
      this.binding.focus = focus;
    }

    this.ctx.editor.runtime.registerBinding(this.binding);
  }

  private unbind() {
    if (!this.boundFocus) return;
    this.ctx.editor.runtime.unregisterBinding(this.boundFocus);
    this.boundFocus = null;
    this.binding = null;
  }

  private mountChildRegion(cellId: ItemId) {
    const focus: Focus = { containerId: this.rowId, id: cellId };
    const region = createSliderRegion(
      { editor: this.ctx.editor },
      cellId,
      focus,
    );

    this.mounted = replaceMountedRegion(
      this.ctx.editor.runtime,
      this.element,
      this.mounted,
      region,
    );
    if (this.mounted) this.element.replaceChildren(this.mounted.region.root);
  }

  private unmountChildRegion() {
    if (!this.mounted) return;
    this.mounted.unmount();
    this.mounted = null;
  }
}
