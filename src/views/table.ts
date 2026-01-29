import { computed } from "@preact/signals-core";
import {
  type ItemId,
  type ViewKind,
  type Op,
  type Transaction,
  type Store,
  isGroupContent,
  canEditTextContent,
} from "../core/store";
import { isItemGroupValue, type Evaluator } from "../core/eval";
import {
  type Focus,
  type Caret,
  caret0,
  type Selection,
  type EditorEffect,
  withSelection,
  type Editor,
  type NavDir,
  type NavMode,
  type ViewKeyResult,
  focusSelection,
  type CmdResult,
  tryCmd,
  applyCmd,
  setIdle,
} from "../core/editor";
import {
  type Component,
  defaultTextNav,
  el,
  ensureTabbable,
  reconcileChildren,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  mountViewInto,
  parseScalar,
  textField,
  contentField,
} from "../ui/dom";
import type { DomView, Runtime, ViewFactoryArgs } from "./index";
import { createView, viewWantsChildView } from "./index";

type NavResult = { selection: Selection; effects: EditorEffect[] };

const focusRowLabel = (
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret = caret0(),
): NavResult =>
  focusSelection(
    { scopeId: tableId, id: rowId },
    { kind: "header", index: 0 },
    caret,
  );

const focusCell = (
  rowId: ItemId,
  cellId: ItemId,
  caret: Caret = caret0(),
): NavResult =>
  focusSelection({ scopeId: rowId, id: cellId }, { kind: "content" }, caret);

function deriveColumns(
  store: Store,
  evaluator: Evaluator,
  tableId: ItemId,
): string[] {
  const tableV = evaluator.value(tableId);
  if (!isItemGroupValue(tableV)) return [];

  const firstRowId = tableV.items[0];
  if (!firstRowId) return [];

  const rowV = evaluator.value(firstRowId);
  if (!isItemGroupValue(rowV)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const cid of rowV.items) {
    const nm = store.readItem(cid).label;
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    out.push(nm);
  }
  return out;
}

type FocusedSelection = Extract<Selection, { kind: "focused" }>;
type RowLabelSelection = FocusedSelection & {
  target: { kind: "header"; index: 0 };
};
type CellSelection = FocusedSelection & { target: { kind: "content" } };

const isFocused = (sel: Selection): sel is FocusedSelection =>
  sel.kind === "focused";

const isRowLabelSelection = (
  sel: Selection,
  tableId: ItemId,
): sel is RowLabelSelection =>
  isFocused(sel) &&
  sel.focus.scopeId === tableId &&
  sel.target.kind === "header" &&
  sel.target.index === 0;

const isCellSelection = (
  sel: Selection,
  tableId: ItemId,
): sel is CellSelection =>
  isFocused(sel) &&
  sel.target.kind === "content" &&
  sel.focus.scopeId !== tableId;

const rowIds = (evaluator: Evaluator, tableId: ItemId): ItemId[] =>
  evaluator.items(tableId);

function tableNavMove(
  store: Store,
  evaluator: Evaluator,
  tableId: ItemId,
  sel: Selection,
  dir: NavDir,
  _mode: NavMode,
): NavResult | null {
  if (!isFocused(sel)) return null;

  const cols = deriveColumns(store, evaluator, tableId);
  const rows = rowIds(evaluator, tableId);
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

    const nextCell = store.findChildByLabel(rowId, nextCol);
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

    const nextCell = store.findChildByLabel(nextRowId, col);
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

      const cid = store.findChildByLabel(rowId, firstCol);
      return cid ? focusCell(rowId, cid) : null;
    }

    return null;
  }

  if (!isCellSelection(sel, tableId)) return null;

  const rowId = sel.focus.scopeId;
  const cellId = sel.focus.id;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colLabel = store.readItem(cellId).label || "";
  const colIdx = Math.max(0, cols.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowId, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowId, colIdx, 1);
  if (dir === "up") return moveCellVert(rowIdx, colIdx, -1);
  if (dir === "down") return moveCellVert(rowIdx, colIdx, 1);

  return null;
}

export const tableCommands = {
  setLabel(editor: Editor, rowId: ItemId, text: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      editor.commit(store.op.transaction([store.op.patchLabel(rowId, text)]));
      return { didChange: true };
    });
  },

  setScalarValue(editor: Editor, cellId: ItemId, raw: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      if (!canEditTextContent(store, cellId)) return { didChange: false };

      editor.commit(
        store.op.transaction([
          store.op.patchContent(cellId, {
            kind: "scalar",
            value: parseScalar(raw),
          }),
        ]),
      );
      return { didChange: true };
    });
  },

  addRowAfter(
    editor: Editor,
    evaluator: Evaluator,
    tableId: ItemId,
    afterRowId: ItemId | null,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const rows = evaluator.items(tableId);
      const afterIdx =
        afterRowId == null ? rows.length - 1 : rows.indexOf(afterRowId);
      const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

      const rowId = store.createId();

      const txn: Transaction = store.op.transaction([
        store.op.create(store.create.group(rowId)),
        store.op.reparent({ childId: rowId, toOwnerId: tableId, toIndex: at }),
      ]);

      const next = focusRowLabel(tableId, rowId);
      editor.commit(txn, withSelection({ selection: next.selection }));
      return { didChange: true };
    });
  },

  removeRow(
    editor: Editor,
    evaluator: Evaluator,
    tableId: ItemId,
    rowId: ItemId,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const rows = evaluator.items(tableId);
      const idx = rows.indexOf(rowId);
      const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

      const idleSelection: Selection = { kind: "idle" };
      const next: NavResult =
        nextRow != null
          ? focusRowLabel(tableId, nextRow)
          : { selection: idleSelection, effects: [] };

      const txn: Transaction = store.op.transaction([store.op.detach(rowId)]);
      editor.commit(txn, withSelection({ selection: next.selection }));
      return { didChange: true };
    });
  },

  addColumn(
    editor: Editor,
    evaluator: Evaluator,
    tableId: ItemId,
    label: string,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const name = label.trim();
      if (!name) return { didChange: false };

      const rows = evaluator.items(tableId);
      if (rows.length === 0) return { didChange: false };

      const ops: Op[] = [];
      for (const rowId of rows) {
        const row = store.readItem(rowId);
        if (!isGroupContent(row.content)) continue;
        if (store.findChildByLabel(rowId, name) != null) continue;

        const cellId = store.createId();
        ops.push(store.op.create(store.create.blank(cellId)));
        ops.push(store.op.patchLabel(cellId, name));
        ops.push(
          store.op.reparent({
            childId: cellId,
            toOwnerId: rowId,
            toIndex: store.getChildren(rowId).length,
          }),
        );
      }

      if (ops.length === 0) return { didChange: false };
      editor.commit(store.op.transaction(ops));
      return { didChange: true };
    });
  },

  removeColumn(
    editor: Editor,
    evaluator: Evaluator,
    tableId: ItemId,
    label: string,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const name = label.trim();
      if (!name) return { didChange: false };

      const rows = evaluator.items(tableId);
      if (rows.length === 0) return { didChange: false };

      const ops: Op[] = [];
      for (const rowId of rows) {
        const cellId = store.findChildByLabel(rowId, name);
        if (cellId == null) continue;
        ops.push(store.op.detach(cellId));
      }

      if (ops.length === 0) return { didChange: false };
      editor.commit(store.op.transaction(ops));
      return { didChange: true };
    });
  },

  confirm(
    editor: Editor,
    evaluator: Evaluator,
    tableId: ItemId,
    sel: Selection,
  ): CmdResult {
    if (!isFocused(sel)) return { didChange: false };

    if (sel.target.kind === "header") {
      return tableCommands.addRowAfter(
        editor,
        evaluator,
        tableId,
        sel.focus.id,
      );
    }

    const move = tableNavMove(
      editor.store,
      evaluator,
      tableId,
      sel,
      "down",
      "step",
    );
    if (move) return { didChange: false, selection: move.selection };

    return tableCommands.addRowAfter(
      editor,
      evaluator,
      tableId,
      sel.focus.scopeId,
    );
  },
} as const;

type TableIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" };

type TableMountCtx = {
  runtime: Runtime;
  editor: Editor;
  evaluator: Evaluator;
  tableId: ItemId;
  navMove: (sel: Selection, dir: NavDir, mode: NavMode) => NavResult | null;
  columnsSignal: { value: string[] };
  dispatch: (intent: TableIntent) => ViewKeyResult;
};

function mountTableHeader(mountCtx: TableMountCtx): Component {
  return createComponent((componentCtx) => {
    const headerRow = el("div", "row table-header");
    const labelCell = el("div", "label");
    headerRow.append(labelCell);

    const columnEls = new Map<string, HTMLElement>();

    const reconcileColumns = (cols: readonly string[]) => {
      const desired: HTMLElement[] = [labelCell];

      for (const col of cols) {
        let cell = columnEls.get(col);
        if (!cell) {
          cell = el("div", "item", col);
          columnEls.set(col, cell);
        } else if (cell.textContent !== col) {
          cell.textContent = col;
        }
        desired.push(cell);
      }

      reconcileChildren(headerRow, desired);

      const keep = new Set(cols);
      for (const [name, cell] of columnEls) {
        if (keep.has(name)) continue;
        cell.remove();
        columnEls.delete(name);
      }
    };

    componentCtx.watch(
      () => mountCtx.columnsSignal.value,
      (cols) => {
        reconcileColumns(cols);
      },
    );

    return headerRow;
  });
}

function mountTableCellContent(cellCtx: {
  runtime: Runtime;
  editor: Editor;
  evaluator: Evaluator;
  tableId: ItemId;
  rowId: ItemId;
  cellId: ItemId;
  dispatch: (intent: TableIntent) => ViewKeyResult;
}): Component {
  const { runtime, editor, evaluator, rowId, cellId, dispatch } = cellCtx;
  const store = editor.store;
  const focus: Focus = { scopeId: rowId, id: cellId };
  const viewKind = store.readItem(cellId).view as ViewKind;

  if (viewWantsChildView(viewKind)) {
    const child = createView(runtime, viewKind, cellId, focus);
    if (child) {
      return createComponent((componentCtx) => {
        const host = el("div");
        ensureTabbable(host);

        componentCtx.focusable({
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
        componentCtx.use(mountViewInto(editor, host, child));
        return host;
      });
    }
  }

  return contentField({
    editor,
    evaluator,
    focus,
    id: cellId,
    commitScalarText: (text) =>
      applyCmd(editor, tableCommands.setScalarValue(editor, cellId, text)),
    textKeys: (inp) =>
      bindTextControlKeys(inp, {
        nav: defaultTextNav,
        onNav: (dir, mode) => dispatch({ type: "NAV", dir, mode }),
        onEnter: () => dispatch({ type: "CONFIRM" }),
        onEscape: () => dispatch({ type: "CANCEL" }),
      }),
  });
}

function mountTableCell(
  mountCtx: TableMountCtx,
  rowId: ItemId,
  col: string,
): Component {
  return createComponent((componentCtx) => {
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
        runtime: mountCtx.runtime,
        editor: mountCtx.editor,
        evaluator: mountCtx.evaluator,
        tableId: mountCtx.tableId,
        rowId,
        cellId,
        dispatch: mountCtx.dispatch,
      });
      curCellId = cellId;
      setInner(cur.el);
      componentCtx.use(cur);
    };

    const getCellId = () =>
      mountCtx.editor.store.findChildByLabel(rowId, col) ?? null;

    componentCtx.watch(
      () => getCellId(),
      (nextCellId) => {
        if (nextCellId === curCellId) return;
        nextCellId == null ? mountMissing() : mountPresent(nextCellId);
      },
    );

    componentCtx.on(host, "pointerdown", (e: PointerEvent) => {
      const nextCellId = getCellId();
      const res =
        nextCellId == null
          ? focusRowLabel(mountCtx.tableId, rowId)
          : focusCell(rowId, nextCellId);

      mountCtx.editor.setSelection(res.selection);
      e.stopPropagation();
    });

    return host;
  });
}

function mountTableRow(mountCtx: TableMountCtx, rowId: ItemId): Component {
  return createComponent((componentCtx) => {
    const rowEl = el("div", "row");
    const labelCell = el("div", "label");
    const labelHost = el("div", "row-label");
    labelCell.append(labelHost);

    const cellsHost = el("div", "row-cells");
    rowEl.append(labelCell, cellsHost);

    const labelFocus: Focus = { scopeId: mountCtx.tableId, id: rowId };

    const store = mountCtx.editor.store;

    const labelComp = textField({
      editor: mountCtx.editor,
      focus: labelFocus,
      target: { kind: "header", index: 0 },
      multiline: false,
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["input", "blur"],
      commit: (text) =>
        applyCmd(
          mountCtx.editor,
          tableCommands.setLabel(mountCtx.editor, rowId, text),
        ),
      getState: () => {
        const sel = mountCtx.editor.runtime.selection.value;
        const editing =
          isRowLabelSelection(sel, mountCtx.tableId) && sel.focus.id === rowId;
        const label = store.readItem(rowId).label ?? "";
        return { text: label, readOnly: !editing, isIssue: false };
      },
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => mountCtx.dispatch({ type: "NAV", dir, mode }),
          onEnter: () => {
            const first = mountCtx.columnsSignal.value[0];
            if (!first) return;

            const cid = store.findChildByLabel(rowId, first);
            if (!cid) return;

            const res = focusCell(rowId, cid);
            mountCtx.editor.setSelection(res.selection);
          },
          onEscape: () => mountCtx.dispatch({ type: "CANCEL" }),
        }),
    });

    labelHost.replaceChildren(labelComp.el);
    componentCtx.use(labelComp);

    const cellList = componentCtx.list(cellsHost, (col: string) =>
      mountTableCell(mountCtx, rowId, col),
    );
    componentCtx.watch(
      () => mountCtx.columnsSignal.value,
      (cols) => {
        cellList.update(cols);
      },
    );

    componentCtx.on(labelCell, "pointerdown", (e: PointerEvent) => {
      const res = focusRowLabel(mountCtx.tableId, rowId);
      mountCtx.editor.setSelection(res.selection);
      e.stopPropagation();
    });

    return rowEl;
  });
}

function mountTableBody(mountCtx: TableMountCtx): Component {
  return createComponent((componentCtx) => {
    const body = el("div", "table-body");
    const rowList = componentCtx.list(body, (rowId: ItemId) =>
      mountTableRow(mountCtx, rowId),
    );

    componentCtx.watch(
      () => mountCtx.evaluator.items(mountCtx.tableId),
      (rows) => {
        rowList.update(rows);
      },
    );

    return body;
  });
}

export function createTableView({
  runtime,
  id: tableId,
}: ViewFactoryArgs): DomView {
  const { editor, evaluator } = runtime;
  const store = editor.store;

  const root = el("div", "view table");
  root.tabIndex = 0;

  const headerHost = el("div");
  const bodyHost = el("div");
  root.append(headerHost, bodyHost);

  const columnsSignal = computed(() =>
    deriveColumns(store, evaluator, tableId),
  );

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    tableNavMove(store, evaluator, tableId, sel, dir, mode);

  const dispatch = (intent: TableIntent): ViewKeyResult => {
    const sel = editor.runtime.selection.value;

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) editor.setSelection(res.selection);
        return;
      }
      case "CONFIRM": {
        applyCmd(
          editor,
          tableCommands.confirm(editor, evaluator, tableId, sel),
        );
        return;
      }
      case "CANCEL": {
        setIdle(editor);
        return;
      }
    }
  };

  const mountCtx: TableMountCtx = {
    runtime,
    editor,
    evaluator,
    tableId,
    navMove,
    columnsSignal,
    dispatch,
  };

  const header = mountTableHeader(mountCtx);
  const body = mountTableBody(mountCtx);

  headerHost.replaceChildren(header.el);
  bodyHost.replaceChildren(body.el);

  return {
    id: `table:${String(tableId)}`,
    root,

    normalizeTarget(_ctx2, focus, target) {
      if (target.kind !== "header") return target;
      if (target.index !== 0) return { kind: "content" };
      if (focus.scopeId !== tableId) return { kind: "content" };
      return { kind: "header", index: 0 };
    },

    onActivate() {
      const sel = editor.runtime.selection.value;
      if (sel.kind !== "idle") return;

      const rows = evaluator.items(tableId);
      if (rows.length === 0) return;

      const firstRowId = rows[0]!;
      const res = focusRowLabel(tableId, firstRowId);
      editor.setSelection(res.selection);
    },

    onKeyDown(e): ViewKeyResult {
      if (!(e instanceof KeyboardEvent)) return;

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
        return dispatch({ type: "NAV", dir, mode });
      }

      if (e.key === "Enter") {
        stopEvent(e);
        return dispatch({ type: "CONFIRM" });
      }

      if (e.key === "Escape") {
        stopEvent(e);
        return dispatch({ type: "CANCEL" });
      }
    },

    dispose() {
      header.dispose();
      body.dispose();
      root.replaceChildren();
    },
  };
}
