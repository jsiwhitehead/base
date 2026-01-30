import { computed } from "@preact/signals-core";
import {
  type Core,
  type ItemId,
  type ViewKind,
  type Component,
  type Caret,
  type Focus,
  type Selection,
  type DomView,
  parseScalar,
} from "../core";
import {
  type NavDir,
  type NavMode,
  defaultTextNav,
  el,
  ensureTabbable,
  reconcileChildren,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  textField,
  contentField,
} from "../dom";

type NavResult = {
  focus: Focus;
  target: "label" | "content";
  caret?: Caret;
};

const caret0 = (): Caret => ({ start: 0, end: 0 });

const focusRowLabel = (
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { scopeId: tableId, id: rowId },
  target: "label",
  caret,
});

const focusCell = (
  rowId: ItemId,
  cellId: ItemId,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { scopeId: rowId, id: cellId },
  target: "content",
  caret,
});

function deriveColumns(core: Core, tableId: ItemId): string[] {
  const tableV = core.value(tableId);
  if (tableV.kind !== "item-group") return [];

  const firstRowId = tableV.itemIds[0];
  if (!firstRowId) return [];

  const rowV = core.value(firstRowId);
  if (rowV.kind !== "item-group") return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const cid of rowV.itemIds) {
    const nm = core.meta(cid).label;
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    out.push(nm);
  }
  return out;
}

type FocusedSelection = Extract<Selection, { kind: "focused" }>;
type RowLabelSelection = FocusedSelection & { target: "label" };
type CellSelection = FocusedSelection & { target: "content" };

const isFocused = (sel: Selection): sel is FocusedSelection =>
  sel.kind === "focused";

const isRowLabelSelection = (
  sel: Selection,
  tableId: ItemId,
): sel is RowLabelSelection =>
  isFocused(sel) && sel.focus.scopeId === tableId && sel.target === "label";

const isCellSelection = (
  sel: Selection,
  tableId: ItemId,
): sel is CellSelection =>
  isFocused(sel) && sel.target === "content" && sel.focus.scopeId !== tableId;

const rowIds = (core: Core, tableId: ItemId): ItemId[] => [
  ...core.childIds(tableId),
];

function tableNavMove(
  core: Core,
  tableId: ItemId,
  sel: Selection,
  dir: NavDir,
  _mode: NavMode,
): NavResult | null {
  if (!isFocused(sel)) return null;

  const cols = deriveColumns(core, tableId);
  const rows = rowIds(core, tableId);
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

    const nextCell = core.findChild(rowId, nextCol);
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

    const nextCell = core.findChild(nextRowId, col);
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

      const cid = core.findChild(rowId, firstCol);
      return cid ? focusCell(rowId, cid) : null;
    }

    return null;
  }

  if (!isCellSelection(sel, tableId)) return null;

  const rowId = sel.focus.scopeId;
  const cellId = sel.focus.id;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colLabel = core.meta(cellId).label || "";
  const colIdx = Math.max(0, cols.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowId, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowId, colIdx, 1);
  if (dir === "up") return moveCellVert(rowIdx, colIdx, -1);
  if (dir === "down") return moveCellVert(rowIdx, colIdx, 1);

  return null;
}

export const tableCommands = {
  setLabel(core: Core, rowId: ItemId, text: string): void {
    core.edit.setLabel(rowId, text);
  },

  setText(core: Core, cellId: ItemId, raw: string): void {
    const value = parseScalar(raw);
    core.edit.setScalar(cellId, value);
  },

  addRowAfter(core: Core, tableId: ItemId, afterRowId: ItemId | null): void {
    const rows = rowIds(core, tableId);
    const afterIdx =
      afterRowId == null ? rows.length - 1 : rows.indexOf(afterRowId);
    const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

    let rowId: ItemId = -1;
    core.commit((t) => {
      rowId = t.insert(tableId, { at, kind: "group" });
    });

    const next = focusRowLabel(tableId, rowId);
    core.focus(next.focus, next.target, { caret: next.caret });
  },

  removeRow(core: Core, tableId: ItemId, rowId: ItemId): void {
    const rows = rowIds(core, tableId);
    const idx = rows.indexOf(rowId);
    const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

    core.edit.remove(rowId);

    if (nextRow != null) {
      const next = focusRowLabel(tableId, nextRow);
      core.focus(next.focus, next.target, { caret: next.caret });
    } else {
      core.blur();
    }
  },

  addColumn(core: Core, tableId: ItemId, label: string): void {
    const name = label.trim();
    if (!name) return;

    const rows = rowIds(core, tableId);
    if (rows.length === 0) return;

    core.commit((t) => {
      for (const rowId of rows) {
        if (core.meta(rowId).storedKind !== "group") continue;
        if (core.findChild(rowId, name) != null) continue;

        const cellId = t.insert(rowId, { kind: "blank" });
        t.setLabel(cellId, name);
      }
    });
  },

  removeColumn(core: Core, tableId: ItemId, label: string): void {
    const name = label.trim();
    if (!name) return;

    const rows = rowIds(core, tableId);
    if (rows.length === 0) return;

    core.commit((t) => {
      for (const rowId of rows) {
        const cellId = core.findChild(rowId, name);
        if (cellId == null) continue;
        t.remove(cellId);
      }
    });
  },

  confirm(core: Core, tableId: ItemId, sel: Selection): void {
    if (!isFocused(sel)) return;

    if (sel.target === "label" && sel.focus.scopeId === tableId) {
      tableCommands.addRowAfter(core, tableId, sel.focus.id);
      return;
    }

    const move = tableNavMove(core, tableId, sel, "down", "step");
    if (move) {
      core.focus(move.focus, move.target, { caret: move.caret });
      return;
    }

    if (sel.target === "content") {
      tableCommands.addRowAfter(core, tableId, sel.focus.scopeId);
    }
  },
} as const;

type TableIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" };

type TableMountCtx = {
  core: Core;
  tableId: ItemId;
  navMove: (sel: Selection, dir: NavDir, mode: NavMode) => NavResult | null;
  columnsSignal: { value: string[] };
  dispatch: (intent: TableIntent) => void;
};

function mountTableHeader(mountCtx: TableMountCtx): Component {
  return createComponent((componentCtx) => {
    const headerRow = el("div", "row table-header");
    const labelCell = el("div", "label");
    headerRow.append(labelCell);

    const columnEls = new Map<string, HTMLElement>();

    const reconcileColumnsLocal = (cols: readonly string[]) => {
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
        reconcileColumnsLocal(cols);
      },
    );

    return headerRow;
  });
}

function mountTableCellContent(cellCtx: {
  core: Core;
  tableId: ItemId;
  rowId: ItemId;
  cellId: ItemId;
  dispatch: (intent: TableIntent) => void;
}): Component {
  const { core, rowId, cellId, dispatch } = cellCtx;
  const focus: Focus = { scopeId: rowId, id: cellId };

  const storedKind = core.meta(cellId).storedKind;
  const viewKind = core.meta(cellId).view as ViewKind;

  const shouldMountNested = viewKind != null || storedKind === "group";

  if (shouldMountNested) {
    const nested = core.mountView({ id: cellId, focus });
    return createComponent((ctx) => {
      const hostEl = el("div");
      ensureTabbable(hostEl);
      ensureTabbable(nested.el);

      ctx.use(nested);

      ctx.focusable({
        core,
        focus,
        elementFor: () => nested.el,
        targets: [
          {
            target: "content",
            getEl: () => nested.el,
            pointerHost: () => hostEl,
            caret: "zero",
            stopPropagation: true,
          },
        ],
      });

      hostEl.replaceChildren(nested.el);
      return hostEl;
    });
  }

  return contentField({
    core,
    focus,
    id: cellId,
    commitText: (text) => tableCommands.setText(core, cellId, text),
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
    const hostEl = el("div", "item cell");
    const inner = el("div");
    hostEl.append(inner);

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
        core: mountCtx.core,
        tableId: mountCtx.tableId,
        rowId,
        cellId,
        dispatch: mountCtx.dispatch,
      });
      curCellId = cellId;
      setInner(cur.el);
      componentCtx.use(cur);
    };

    const getCellId = () => mountCtx.core.findChild(rowId, col) ?? null;

    componentCtx.watch(
      () => getCellId(),
      (nextCellId) => {
        if (nextCellId === curCellId) return;
        nextCellId == null ? mountMissing() : mountPresent(nextCellId);
      },
    );

    componentCtx.on(hostEl, "pointerdown", (e: PointerEvent) => {
      const nextCellId = getCellId();
      const res =
        nextCellId == null
          ? focusRowLabel(mountCtx.tableId, rowId)
          : focusCell(rowId, nextCellId);
      mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
      e.stopPropagation();
    });

    return hostEl;
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

    const labelComp = textField({
      core: mountCtx.core,
      focus: labelFocus,
      target: "label",
      multiline: false,
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["input", "blur"],
      commit: (text) => tableCommands.setLabel(mountCtx.core, rowId, text),
      getState: () => {
        const sel = mountCtx.core.selection();
        const editing =
          isRowLabelSelection(sel, mountCtx.tableId) && sel.focus.id === rowId;
        const label = mountCtx.core.meta(rowId).label ?? "";
        return { text: label, readOnly: !editing, isIssue: false };
      },
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => mountCtx.dispatch({ type: "NAV", dir, mode }),
          onEnter: () => {
            const first = mountCtx.columnsSignal.value[0];
            if (!first) return;

            const cid = mountCtx.core.findChild(rowId, first);
            if (!cid) return;

            const res = focusCell(rowId, cid);
            mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
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
      mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
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
      () => mountCtx.core.childIds(mountCtx.tableId),
      (rows) => {
        rowList.update(rows);
      },
    );

    return body;
  });
}

export function createTableView(args: { core: Core; id: ItemId }): DomView {
  const { core, id: tableId } = args;

  const root = el("div", "view table");
  root.tabIndex = 0;

  const headerHost = el("div");
  const bodyHost = el("div");
  root.append(headerHost, bodyHost);

  const columnsSignal = computed(() => deriveColumns(core, tableId));

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    tableNavMove(core, tableId, sel, dir, mode);

  const dispatch = (intent: TableIntent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }
      case "CONFIRM": {
        tableCommands.confirm(core, tableId, sel);
        return;
      }
      case "CANCEL": {
        core.blur();
        return;
      }
    }
  };

  const mountCtx: TableMountCtx = {
    core,
    tableId,
    navMove,
    columnsSignal,
    dispatch,
  };

  const header = mountTableHeader(mountCtx);
  const body = mountTableBody(mountCtx);

  headerHost.replaceChildren(header.el);
  bodyHost.replaceChildren(body.el);

  const onKeyDown = (e: KeyboardEvent) => {
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
      dispatch({ type: "NAV", dir, mode });
      return;
    }

    if (e.key === "Enter") {
      stopEvent(e);
      dispatch({ type: "CONFIRM" });
      return;
    }

    if (e.key === "Escape") {
      stopEvent(e);
      dispatch({ type: "CANCEL" });
      return;
    }
  };

  if (core.selection().kind === "idle") {
    const rows = core.childIds(tableId);
    if (rows.length) {
      const firstRowId = rows[0]!;
      const res = focusRowLabel(tableId, firstRowId);
      core.focus(res.focus, res.target, { caret: res.caret });
    }
  }

  return {
    id: `table:${String(tableId)}`,
    root,
    onKeyDown,
    dispose() {
      header.dispose();
      body.dispose();
      root.replaceChildren();
    },
  };
}
