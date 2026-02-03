import { computed } from "@preact/signals-core";
import {
  type Core,
  type ItemId,
  type Component,
  type Caret,
  type Focus,
  type Selection,
  type DomView,
  parseScalar,
  DEFAULT_TARGET,
} from "../core";
import {
  type NavDir,
  type NavMode,
  defaultTextNav,
  el,
  reconcileChildren,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  textField,
  contentField,
  ensureTabbable,
  setData,
  setDataBool,
} from "../dom";

type NavResult = {
  focus: Focus;
  target: "label" | typeof DEFAULT_TARGET;
  caret?: Caret;
};

const caret0 = (): Caret => ({ start: 0, end: 0 });

function caretFromTarget(t: EventTarget | null): Caret {
  const el0 = t instanceof HTMLElement ? t : null;
  if (el0 instanceof HTMLInputElement || el0 instanceof HTMLTextAreaElement) {
    const start = el0.selectionStart ?? 0;
    const end = el0.selectionEnd ?? start;
    return { start, end };
  }
  return caret0();
}

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

const labelOf = (core: Core, id: ItemId): string => core.item(id).label ?? "";

const focusRowLabel = (
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { container: tableId, item: rowId },
  target: "label",
  caret,
});

const focusCell = (
  rowId: ItemId,
  cellId: ItemId,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { container: rowId, item: cellId },
  target: DEFAULT_TARGET,
  caret,
});

function deriveColumns(core: Core, tableId: ItemId): string[] {
  const rows = childrenOf(core, tableId);
  const firstRow = rows[0];
  if (!firstRow) return [];

  const rowChildren = childrenOf(core, firstRow);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const c of rowChildren) {
    const nm = (labelOf(core, c) ?? "").trim();
    if (!nm || seen.has(nm)) continue;
    seen.add(nm);
    out.push(nm);
  }

  return out;
}

type FocusedSelection = Extract<Selection, { kind: "focused" }>;
type RowLabelSelection = FocusedSelection & { target: "label" };
type CellSelection = FocusedSelection & { target: typeof DEFAULT_TARGET };

const isFocused = (sel: Selection): sel is FocusedSelection =>
  sel.kind === "focused";

const isRowLabelSelection = (
  sel: Selection,
  tableId: ItemId,
): sel is RowLabelSelection =>
  isFocused(sel) && sel.target === "label" && sel.focus.container === tableId;

const isCellSelection = (
  sel: Selection,
  tableId: ItemId,
): sel is CellSelection =>
  isFocused(sel) &&
  sel.target === DEFAULT_TARGET &&
  sel.focus.container !== tableId;

const rowIds = (core: Core, tableId: ItemId): ItemId[] => [
  ...childrenOf(core, tableId),
];

function findChildByLabel(
  core: Core,
  ownerId: ItemId,
  label: string,
): ItemId | null {
  const want = label.trim();
  if (!want) return null;

  for (const childId of childrenOf(core, ownerId)) {
    const nm = (core.item(childId).label ?? "").trim();
    if (nm === want) return childId;
  }
  return null;
}

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
    const nextRow = rows[r + delta];
    return nextRow ? focusRowLabel(tableId, nextRow) : null;
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

    const nextCell = findChildByLabel(core, rowId, nextCol);
    return nextCell ? focusCell(rowId, nextCell) : null;
  };

  const moveCellVert = (
    rowIdx: number,
    colIdx: number,
    delta: number,
  ): NavResult | null => {
    const nextRow = rows[rowIdx + delta];
    if (!nextRow) return null;

    const col = cols[colIdx];
    if (!col) return null;

    const nextCell = findChildByLabel(core, nextRow, col);
    return nextCell
      ? focusCell(nextRow, nextCell)
      : focusRowLabel(tableId, nextRow);
  };

  if (isRowLabelSelection(sel, tableId)) {
    const rowId = sel.focus.item;

    if (dir === "up") return moveRowLabel(rowId, -1);
    if (dir === "down") return moveRowLabel(rowId, 1);

    if (dir === "right") {
      const firstCol = cols[0];
      if (!firstCol) return null;

      const cid = findChildByLabel(core, rowId, firstCol);
      return cid ? focusCell(rowId, cid) : null;
    }

    return null;
  }

  if (!isCellSelection(sel, tableId)) return null;

  const rowId = sel.focus.container;
  const cellId = sel.focus.item;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colLabel = (labelOf(core, cellId) ?? "").trim();
  const colIdx = Math.max(0, cols.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowId, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowId, colIdx, 1);
  if (dir === "up") return moveCellVert(rowIdx, colIdx, -1);
  if (dir === "down") return moveCellVert(rowIdx, colIdx, 1);

  return null;
}

export const tableCommands = {
  setLabel(core: Core, rowId: ItemId, text: string): void {
    core.commit((t) => t.setLabel(rowId, text));
  },

  setText(core: Core, cellId: ItemId, raw: string): void {
    core.commit((t) => t.setScalar(cellId, parseScalar(raw)));
  },

  addRowAfter(core: Core, tableId: ItemId, afterRowId: ItemId | null): void {
    const rows = rowIds(core, tableId);
    const afterIdx = afterRowId ? rows.indexOf(afterRowId) : rows.length - 1;
    const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(tableId, { at, kind: "group" });
    });

    const next = focusRowLabel(tableId, id);
    core.focus(next.focus, next.target, { caret: next.caret });
  },

  removeRow(core: Core, tableId: ItemId, rowId: ItemId): void {
    const rows = rowIds(core, tableId);
    const idx = rows.indexOf(rowId);
    const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

    core.commit((t) => t.remove(rowId));

    if (nextRow) {
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
    if (!rows.length) return;

    core.commit((t) => {
      for (const rowId of rows) {
        const row = core.item(rowId);
        if (row.mode.kind !== "direct" || row.content.kind !== "group")
          continue;
        if (findChildByLabel(core, rowId, name)) continue;

        const cellId = t.insertChild(rowId, { kind: "blank" });
        t.setLabel(cellId, name);
      }
    });
  },

  removeColumn(core: Core, tableId: ItemId, label: string): void {
    const name = label.trim();
    if (!name) return;

    const rows = rowIds(core, tableId);
    if (!rows.length) return;

    core.commit((t) => {
      for (const rowId of rows) {
        const row = core.item(rowId);
        if (row.mode.kind !== "direct" || row.content.kind !== "group")
          continue;

        const cell = findChildByLabel(core, rowId, name);
        if (!cell) continue;
        t.remove(cell);
      }
    });
  },

  confirm(core: Core, tableId: ItemId, sel: Selection): void {
    if (!isFocused(sel)) return;

    if (sel.target === "label" && sel.focus.container === tableId) {
      tableCommands.addRowAfter(core, tableId, sel.focus.item);
      return;
    }

    const move = tableNavMove(core, tableId, sel, "down", "step");
    if (move) {
      core.focus(move.focus, move.target, { caret: move.caret });
      return;
    }

    if (sel.target === DEFAULT_TARGET) {
      tableCommands.addRowAfter(core, tableId, sel.focus.container);
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

function applyItemDatasets(
  root: HTMLElement,
  core: Core,
  focus: Focus,
  view: string,
  rule: string,
): void {
  const snap = core.item(focus.item);

  const sel = core.selection();
  const focused =
    sel.kind === "focused" &&
    sel.focus.item === focus.item &&
    sel.focus.container === focus.container;

  setData(root, "item", focus.item);
  setData(root, "container", focus.container);
  setData(root, "view", view);
  setData(root, "rule", rule);
  setData(root, "kind", snap.content.kind);
  setData(root, "mode", snap.mode.kind);
  setDataBool(root, "focused", focused);
}

function mountRowLabelCell(mountCtx: TableMountCtx, rowId: ItemId): Component {
  return createComponent((componentCtx) => {
    const hostEl = el("div", "ui-cell ui-row-label");

    const labelFocus: Focus = { container: mountCtx.tableId, item: rowId };

    const labelComp = textField({
      multiline: false,
      commit: (text) => tableCommands.setLabel(mountCtx.core, rowId, text),
      getState: () => {
        const sel = mountCtx.core.selection();
        const editing =
          isRowLabelSelection(sel, mountCtx.tableId) &&
          sel.focus.item === rowId;

        const row = mountCtx.core.item(rowId);
        const canEdit = row.mode.kind !== "readonly";

        const text = row.label ?? "";
        const readOnly = !editing || !canEdit;
        return { text, readOnly, isIssue: false };
      },
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => mountCtx.dispatch({ type: "NAV", dir, mode }),
          onEnter: () => {
            const first = mountCtx.columnsSignal.value[0];
            if (!first) return;

            const cell = findChildByLabel(mountCtx.core, rowId, first);
            if (!cell) return;

            const res = focusCell(rowId, cell);
            mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
          },
          onEscape: () => mountCtx.dispatch({ type: "CANCEL" }),
        }),
    });

    const scope = componentCtx.focus(mountCtx.core, labelFocus, {
      default: () => labelComp.focusEl,
    });
    scope.elementFor("label", () => labelComp.focusEl);
    scope.selectOn(labelComp.focusEl, { target: "label", caret: "fromTarget" });
    scope.selectOn(hostEl, { target: "label", caret: "fromTarget" });

    hostEl.replaceChildren(labelComp.el);
    componentCtx.use(labelComp);

    return hostEl;
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
  const focus: Focus = { container: rowId, item: cellId };

  return createComponent((ctx) => {
    const wrap = el("div");

    const inner = contentField({
      core,
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

    const scope = ctx.focus(core, focus, { default: () => inner.focusEl });
    scope.elementFor(DEFAULT_TARGET, () => inner.focusEl);
    scope.selectOn(inner.focusEl as HTMLElement, {
      target: DEFAULT_TARGET,
      caret: "fromTarget",
    });

    wrap.replaceChildren(inner.el);
    ctx.use(inner);

    return wrap;
  });
}

function mountTableCell(
  mountCtx: TableMountCtx,
  rowId: ItemId,
  col: string,
): Component {
  return createComponent((componentCtx) => {
    const hostEl = el("div", "ui-cell ui-cell-data");

    let cur: Component | null = null;
    let curCellId: ItemId | null = null;

    const mountMissing = () => {
      cur?.dispose();
      cur = null;
      curCellId = null;
      hostEl.replaceChildren(el("div", "ui-missing", ""));
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
      hostEl.replaceChildren(cur.el);
      componentCtx.use(cur);
    };

    const getCellId = () => findChildByLabel(mountCtx.core, rowId, col);

    componentCtx.watch(
      () => getCellId(),
      (nextId) => {
        if (nextId === curCellId) return;
        if (!nextId) mountMissing();
        else mountPresent(nextId);
      },
    );

    componentCtx.on(hostEl, "pointerdown", (e: PointerEvent) => {
      const nextCell = getCellId();
      const res = nextCell
        ? focusCell(rowId, nextCell, caretFromTarget(e.target))
        : focusRowLabel(mountCtx.tableId, rowId, caretFromTarget(e.target));
      mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
      e.stopPropagation();
    });

    return hostEl;
  });
}

function mountTableHeader(mountCtx: TableMountCtx): Component {
  return createComponent((componentCtx) => {
    const headerRow = el("div", "ui-table-header");
    const labelCell = el("div", "ui-cell ui-col-label");
    headerRow.append(labelCell);

    const columnEls = new Map<string, HTMLElement>();

    const reconcileColumnsLocal = (cols: readonly string[]) => {
      const desired: HTMLElement[] = [labelCell];

      for (const col of cols) {
        let cell = columnEls.get(col);
        if (!cell) {
          cell = el("div", "ui-cell ui-col", col);
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

function mountTableRow(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, tableId } = mountCtx;
  const rowFocus: Focus = { container: tableId, item: rowId };

  return createComponent((componentCtx) => {
    const rowEl = el("div", "ui-item ui-table-row");
    const rowLabelCell = mountRowLabelCell(mountCtx, rowId);
    rowEl.append(rowLabelCell.el);
    componentCtx.use(rowLabelCell);

    componentCtx.watch(
      () => {
        applyItemDatasets(rowEl, core, rowFocus, "table", "row");
        return mountCtx.columnsSignal.value;
      },
      (cols) => {
        for (const col of cols) {
          if (rowEl.querySelector(`[data-col="${CSS.escape(col)}"]`)) continue;
        }
      },
    );

    const cellList = componentCtx.list(rowEl, (colName: string) => {
      if (colName === "__label__") {
        return { el: document.createElement("div"), dispose() {} };
      }
      const c = mountTableCell(mountCtx, rowId, colName);
      (c.el as HTMLElement).setAttribute("data-col", colName);
      return c;
    });

    componentCtx.watch(
      () => ["__label__", ...mountCtx.columnsSignal.value],
      (cols) => {
        const desired = ["__label__", ...mountCtx.columnsSignal.value];
        cellList.update(desired);
        const first = rowEl.firstElementChild;
        if (first !== rowLabelCell.el)
          rowEl.insertBefore(rowLabelCell.el, first);
        for (const el0 of Array.from(rowEl.children)) {
          if (el0 === rowLabelCell.el) continue;
          const col = (el0 as HTMLElement).getAttribute("data-col");
          if (!col) continue;
          (el0 as HTMLElement).classList.add("ui-cell", "ui-cell-data");
        }
      },
    );

    componentCtx.on(rowEl, "pointerdown", (e: PointerEvent) => {
      const sel = core.selection();
      if (isRowLabelSelection(sel, tableId) && sel.focus.item === rowId) return;
      const next = focusRowLabel(tableId, rowId, caretFromTarget(e.target));
      core.focus(next.focus, next.target, { caret: next.caret });
      e.stopPropagation();
    });

    return rowEl;
  });
}

function mountTableBody(mountCtx: TableMountCtx): Component {
  return createComponent((componentCtx) => {
    const body = el("div", "ui-table-body");
    const rowList = componentCtx.list(body, (rowId: string) =>
      mountTableRow(mountCtx, rowId),
    );

    componentCtx.watch(
      () => {
        const snap = mountCtx.core.item(mountCtx.tableId);
        const c = snap.content;
        return c.kind === "group" ? [...c.children] : [];
      },
      (rows) => {
        rowList.update(rows);
      },
    );

    return body;
  });
}

export function createTableView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: tableId } = args;

  const root = el("div", "ui-item ui-table-root");
  ensureTabbable(root);

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
      case "CONFIRM":
        tableCommands.confirm(core, tableId, sel);
        return;
      case "CANCEL":
        core.blur();
        return;
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
    const rows = childrenOf(core, tableId);
    if (rows.length) {
      const firstRow = rows[0]!;
      const res = focusRowLabel(tableId, firstRow);
      core.focus(res.focus, res.target, { caret: res.caret });
    }
  }

  const tableFocus: Focus = args.focus ?? { container: tableId, item: tableId };

  const applyRootDatasets = () => {
    const sel = core.selection();
    const focused =
      sel.kind === "focused" &&
      sel.focus.item === tableId &&
      sel.focus.container === tableId;

    const snap = core.item(tableId);

    setData(root, "item", tableId);
    setData(root, "container", tableId);
    setData(root, "view", "table");
    setData(root, "rule", "table");
    setData(root, "kind", snap.content.kind);
    setData(root, "mode", snap.mode.kind);
    setDataBool(root, "focused", focused);
  };

  applyRootDatasets();

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
