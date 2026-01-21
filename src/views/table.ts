import { computed, effect } from "@preact/signals-core";
import type { Store, ItemId, Txn, Op, ViewKind } from "../store";
import type {
  Editor,
  View,
  Selection,
  Focus,
  EditorEffect,
  ViewKeyResult,
  Caret,
  NavDir,
  NavMode,
  CmdResult,
} from "../editor";
import {
  mkFocusSelection,
  caret0,
  proposeSelection,
  tryCmd,
  applyCmd,
  setIdle,
} from "../editor";
import {
  createComponent,
  el,
  reconcileChildren,
  parseScalar,
  stopEvent,
  bindTextControlKeys,
  textField,
  valueField,
  ensureTabbable,
  defaultTextNav,
  mountChildViewInto,
  type Component,
} from "../ui";
import { createChildViewForItem, viewWantsChildView } from "./index";

type NavResult = { selection: Selection; effects: EditorEffect[] };

const focusRowLabel = (
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret = caret0(),
): NavResult =>
  mkFocusSelection(
    { scopeId: tableId, id: rowId },
    { kind: "header", index: 0 },
    caret,
  );

const focusCell = (
  rowId: ItemId,
  cellId: ItemId,
  caret: Caret = caret0(),
): NavResult =>
  mkFocusSelection({ scopeId: rowId, id: cellId }, { kind: "content" }, caret);

function deriveColumns(store: Store, tableId: ItemId): string[] {
  const tableV = store.sel.value(tableId);
  if (tableV.kind !== "item-group") return [];

  const firstRowId = tableV.items[0];
  if (!firstRowId) return [];

  const rowV = store.sel.value(firstRowId);
  if (rowV.kind !== "item-group") return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const cid of rowV.items) {
    const nm = store.sel.item(cid).label;
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    out.push(nm);
  }
  return out;
}

const isFocused = (
  sel: Selection,
): sel is Extract<Selection, { kind: "focused" }> => sel.kind === "focused";

const isRowLabelSelection = (sel: Selection, tableId: ItemId): boolean =>
  isFocused(sel) &&
  sel.focus.scopeId === tableId &&
  sel.target.kind === "header" &&
  sel.target.index === 0;

const isCellSelection = (sel: Selection, tableId: ItemId): boolean =>
  isFocused(sel) &&
  sel.target.kind === "content" &&
  sel.focus.scopeId !== tableId;

const rowIds = (store: Store, tableId: ItemId): ItemId[] => {
  const v = store.sel.value(tableId);
  return v.kind === "item-group" ? v.items : [];
};

function tableNavMove(
  store: Store,
  tableId: ItemId,
  sel: Selection,
  dir: NavDir,
  _mode: NavMode,
): NavResult | null {
  if (!isFocused(sel)) return null;

  const cols = deriveColumns(store, tableId);
  const rows = rowIds(store, tableId);
  if (rows.length === 0) return null;

  const moveRowLabel = (rowId: ItemId, delta: number) => {
    const r = rows.indexOf(rowId);
    if (r < 0) return null;
    const nextRowId = rows[r + delta];
    return nextRowId ? focusRowLabel(tableId, nextRowId) : null;
  };

  const moveCellHoriz = (
    rowId: ItemId,
    colIdx: number,
    delta: number,
  ): NavResult | null => {
    const nc = colIdx + delta;
    if (nc < 0) return focusRowLabel(tableId, rowId);

    const nextCol = cols[nc];
    if (!nextCol) return null;

    const nextCell = store.sel.childByLabel(rowId, nextCol);
    return nextCell ? focusCell(rowId, nextCell) : null;
  };

  const moveCellVert = (
    rowIdx: number,
    colIdx: number,
    delta: number,
  ): NavResult | null => {
    const nextRowId = rows[rowIdx + delta];
    if (!nextRowId) return null;

    const col = cols[colIdx];
    if (!col) return null;

    const nextCell = store.sel.childByLabel(nextRowId, col);
    return nextCell
      ? focusCell(nextRowId, nextCell)
      : focusRowLabel(tableId, nextRowId);
  };

  if (isRowLabelSelection(sel, tableId)) {
    const rowId = sel.focus.id;

    if (dir === "up") return moveRowLabel(rowId, -1);
    if (dir === "down") return moveRowLabel(rowId, 1);

    if (dir === "right") {
      const firstCol = cols[0];
      if (!firstCol) return null;

      const cid = store.sel.childByLabel(rowId, firstCol);
      return cid ? focusCell(rowId, cid) : null;
    }

    return null;
  }

  if (!isCellSelection(sel, tableId)) return null;

  const rowId = sel.focus.scopeId;
  const cellId = sel.focus.id;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colLabel = store.sel.item(cellId).label || "";
  const colIdx = Math.max(0, cols.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowId, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowId, colIdx, 1);
  if (dir === "up") return moveCellVert(rowIdx, colIdx, -1);
  if (dir === "down") return moveCellVert(rowIdx, colIdx, 1);

  return null;
}

export const tableCommands = {
  commitRowLabel(
    editor: Editor,
    _tableId: ItemId,
    rowId: ItemId,
    text: string,
  ): CmdResult {
    return tryCmd(() => {
      editor.apply({
        ops: [{ kind: "patch", id: rowId, next: { label: text } }],
      });
      return { didChange: true };
    });
  },

  commitCellText(
    editor: Editor,
    _rowId: ItemId,
    cellId: ItemId,
    raw: string,
  ): CmdResult {
    return tryCmd(() => {
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
    });
  },

  addRowAfter(
    editor: Editor,
    tableId: ItemId,
    afterRowId: ItemId | null,
  ): CmdResult {
    return tryCmd(() => {
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

      const next = focusRowLabel(tableId, rowId);
      editor.apply(txn, proposeSelection(next));
      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
    });
  },

  removeRow(editor: Editor, tableId: ItemId, rowId: ItemId): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const rows = store.sel.groupItems(tableId);
      const idx = rows.indexOf(rowId);
      const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

      const next: NavResult =
        nextRow != null
          ? focusRowLabel(tableId, nextRow)
          : {
              selection: { kind: "idle" } as Selection,
              effects: [{ type: "CLEAR_DOM_FOCUS" } as EditorEffect],
            };

      const txn: Txn = {
        ops: [{ kind: "reparent", spec: { childId: rowId, toOwnerId: null } }],
      };

      editor.apply(txn, proposeSelection(next));
      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
    });
  },

  addColumn(editor: Editor, tableId: ItemId, label: string): CmdResult {
    return tryCmd(() => {
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
    });
  },

  removeColumn(editor: Editor, tableId: ItemId, label: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const name = label.trim();
      if (!name) return { didChange: false };

      const rowsV = store.sel.value(tableId);
      if (rowsV.kind !== "item-group") return { didChange: false };

      const ops: Op[] = [];
      for (const rowId of rowsV.items) {
        const cellId = store.sel.childByLabel(rowId, name);
        if (cellId == null) continue;
        ops.push({
          kind: "reparent",
          spec: { childId: cellId, toOwnerId: null },
        });
      }

      if (ops.length === 0) return { didChange: false };
      editor.apply({ ops });
      return { didChange: true };
    });
  },

  confirm(editor: Editor, tableId: ItemId, sel: Selection): CmdResult {
    if (!isFocused(sel)) return { didChange: false };

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

    return tableCommands.addRowAfter(editor, tableId, sel.focus.scopeId);
  },
} as const;

type TableMountCtx = {
  editor: Editor;
  store: Store;
  tableId: ItemId;
  navMove: (sel: Selection, dir: NavDir, mode: NavMode) => NavResult | null;
  columnsSig: { value: string[] };
};

function mountTableHeader(ctx0: TableMountCtx): Component {
  return createComponent((ctx) => {
    const headerRow = el("div", "row table-header");

    ctx.watch(() => {
      const cells: HTMLElement[] = [el("div", "label")];
      for (const c of ctx0.columnsSig.value) cells.push(el("div", "item", c));
      reconcileChildren(headerRow, cells);
    });

    return headerRow;
  });
}

function mountTableCellContent(ctx: {
  editor: Editor;
  store: Store;
  tableId: ItemId;
  rowId: ItemId;
  cellId: ItemId;
}): Component {
  const { editor, store, rowId, cellId, tableId } = ctx;
  const focus: Focus = { scopeId: rowId, id: cellId };
  const viewKind = store.sel.item(cellId).view as ViewKind;

  if (viewWantsChildView(viewKind)) {
    const child = createChildViewForItem({ editor }, viewKind, cellId, focus);
    if (child) {
      return createComponent((cctx) => {
        const host = el("div");
        ensureTabbable(host);

        cctx.focusable({
          editor,
          focus,
          elementFor: () => child.root,
          targets: [
            {
              target: { kind: "content" },
              getEl: () => child.root,
              pointerHost: () => host,
              caret: "zero",
              stopPropagation: true,
            },
          ],
        });

        ensureTabbable(child.root);
        cctx.using(mountChildViewInto(editor, host, child));
        return host;
      });
    }
  }

  return valueField({
    editor,
    focus,
    id: cellId,
    textKeys: (inp) =>
      bindTextControlKeys(inp, {
        nav: defaultTextNav,
        onNav: (dir, mode) => {
          const sel = editor.runtime.selection.value;
          const res = tableNavMove(store, tableId, sel, dir, mode);
          if (res) editor.setSelection(res.selection, res.effects);
        },
        onEnter: () => {
          applyCmd(
            editor,
            tableCommands.confirm(
              editor,
              tableId,
              editor.runtime.selection.value,
            ),
          );
        },
        onEscape: () => setIdle(editor),
      }),
  });
}

function mountTableCell(
  ctx0: TableMountCtx,
  rowId: ItemId,
  col: string,
): Component {
  return createComponent((cctx) => {
    const host = el("div", "item cell");
    const inner = el("div");
    host.append(inner);

    let cur: Component | null = null;
    let curCellId: ItemId | null = null;

    const setInner = (node: HTMLElement) => inner.replaceChildren(node);

    const mountMissing = () => {
      cur?.dispose();
      cur = null;
      curCellId = null;
      setInner(el("div", "item cell issue", "[missing]"));
    };

    const mountPresent = (cellId: ItemId) => {
      cur?.dispose();
      cur = mountTableCellContent({
        editor: ctx0.editor,
        store: ctx0.store,
        tableId: ctx0.tableId,
        rowId,
        cellId,
      });
      curCellId = cellId;
      setInner(cur.el);
      cctx.using(cur);
    };

    const getCellId = () => ctx0.store.sel.childByLabel(rowId, col) ?? null;

    cctx.watch(() => {
      const nextCellId = getCellId();
      if (nextCellId === curCellId) return;
      nextCellId == null ? mountMissing() : mountPresent(nextCellId);
    });

    cctx.on(host, "pointerdown", (e) => {
      const nextCellId = getCellId();
      const res =
        nextCellId == null
          ? focusRowLabel(ctx0.tableId, rowId)
          : focusCell(rowId, nextCellId);

      ctx0.editor.setSelection(res.selection, res.effects);
      e.stopPropagation();
    });

    return host;
  });
}

function mountTableRow(ctx0: TableMountCtx, rowId: ItemId): Component {
  return createComponent((cctx) => {
    const rowEl = el("div", "row");
    const labelCell = el("div", "label");
    const labelHost = el("div", "row-label");
    labelCell.append(labelHost);

    const cellsHost = el("div", "row-cells");
    rowEl.append(labelCell, cellsHost);

    const labelFocus: Focus = { scopeId: ctx0.tableId, id: rowId };

    const labelComp = textField({
      editor: ctx0.editor,
      focus: labelFocus,
      target: { kind: "header", index: 0 },
      multiline: false,
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["input", "blur"],
      commit: (text) =>
        tableCommands.commitRowLabel(ctx0.editor, ctx0.tableId, rowId, text),
      getState: () => {
        const sel = ctx0.editor.runtime.selection.value;
        const editing =
          isRowLabelSelection(sel, ctx0.tableId) &&
          isFocused(sel) &&
          sel.focus.id === rowId;
        const label = ctx0.store.sel.item(rowId).label ?? "";
        return { text: label, readOnly: !editing, isIssue: false };
      },
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => {
            const sel2 = ctx0.editor.runtime.selection.value;
            const res = tableNavMove(ctx0.store, ctx0.tableId, sel2, dir, mode);
            if (res) ctx0.editor.setSelection(res.selection, res.effects);
          },
          onEnter: () => {
            const first = ctx0.columnsSig.value[0];
            if (!first) return;

            const cid = ctx0.store.sel.childByLabel(rowId, first);
            if (!cid) return;

            const res = focusCell(rowId, cid);
            ctx0.editor.setSelection(res.selection, res.effects);
          },
          onEscape: () => setIdle(ctx0.editor),
        }),
    });

    labelHost.replaceChildren(labelComp.el);
    cctx.using(labelComp);

    const cellList = cctx.list(cellsHost, (col: string) =>
      mountTableCell(ctx0, rowId, col),
    );
    cctx.watch(() => cellList.update(ctx0.columnsSig.value));

    cctx.on(labelCell, "pointerdown", (e) => {
      const res = focusRowLabel(ctx0.tableId, rowId);
      ctx0.editor.setSelection(res.selection, res.effects);
      e.stopPropagation();
    });

    return rowEl;
  });
}

function mountTableBody(ctx0: TableMountCtx): Component {
  return createComponent((ctx) => {
    const body = el("div", "table-body");
    const rowList = ctx.list(body, (rowId: ItemId) =>
      mountTableRow(ctx0, rowId),
    );

    ctx.watch(() => {
      const v = ctx0.store.sel.value(ctx0.tableId);
      rowList.update(v.kind === "item-group" ? v.items : []);
    });

    return body;
  });
}

export type TableViewCtx = { editor: Editor };

export function createTableView(
  ctx: TableViewCtx,
  tableId: ItemId,
  _tableFocus?: Focus,
): View {
  const { editor } = ctx;
  const store = editor.store;

  const root = el("div", "view table");
  root.tabIndex = 0;

  const headerHost = el("div");
  const bodyHost = el("div");
  root.append(headerHost, bodyHost);

  const columnsSig = computed(() => deriveColumns(store, tableId));

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    tableNavMove(store, tableId, sel, dir, mode);

  const mountCtx: TableMountCtx = {
    editor,
    store,
    tableId,
    navMove,
    columnsSig,
  };

  const header = mountTableHeader(mountCtx);
  const body = mountTableBody(mountCtx);

  headerHost.replaceChildren(header.el);
  bodyHost.replaceChildren(body.el);

  const stopHeader = effect(() => headerHost.replaceChildren(header.el));
  const stopBody = effect(() => bodyHost.replaceChildren(body.el));

  return {
    id: `table:${String(tableId)}`,
    root,

    onActivate() {
      const sel = editor.runtime.selection.value;
      if (sel.kind !== "idle") return;

      const rowsV = store.sel.value(tableId);
      if (rowsV.kind !== "item-group" || rowsV.items.length === 0) return;

      const firstRowId = rowsV.items[0]!;
      const res = focusRowLabel(tableId, firstRowId);
      editor.setSelection(res.selection, res.effects);
    },

    onKeyDown(e): ViewKeyResult {
      const sel = editor.runtime.selection.value;
      if (!isFocused(sel)) return;

      const mode: NavMode = e.metaKey || e.ctrlKey ? "jump" : "step";

      const arrowDir: Record<string, NavDir | undefined> = {
        ArrowUp: "up",
        ArrowDown: "down",
        ArrowLeft: "left",
        ArrowRight: "right",
      };

      const dir = arrowDir[e.key];
      if (dir) {
        stopEvent(e);
        const res = navMove(sel, dir, mode);
        if (res) editor.setSelection(res.selection, res.effects);
        return;
      }

      if (e.key === "Enter") {
        stopEvent(e);
        applyCmd(editor, tableCommands.confirm(editor, tableId, sel));
        return;
      }

      if (e.key === "Escape") {
        stopEvent(e);
        setIdle(editor);
        return;
      }
    },

    dispose() {
      stopHeader();
      stopBody();
      header.dispose();
      body.dispose();
      root.replaceChildren();
    },
  };
}
