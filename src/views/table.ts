import { computed } from "@preact/signals-core";
import type {
  Core,
  ItemId,
  Component,
  Caret,
  Focus,
  Selection,
  DomView,
} from "../core";
import { DEFAULT_TARGET } from "../core";
import {
  type NavDir,
  type NavMode,
  type Intent,
  el,
  createComponent,
  createContent,
  textField,
  SELECT_ALL,
  caret0,
  caretAt,
  insertTextIntoActiveEditor,
  escapeLadder,
  caretFromTarget,
  reconcileChildren,
  consume,
  parseKeydownIntent,
} from "../dom";

type NavResult = { focus: Focus; target: string; caret?: Caret };

const ROW_LABEL_TARGET = "label";
const VALUE_TARGET = "value";

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

const labelOf = (core: Core, id: ItemId): string => core.item(id).label ?? "";

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
type RowSelection = FocusedSelection & { focus: { container: ItemId } };

const isFocused = (sel: Selection): sel is FocusedSelection =>
  sel.kind === "focused";

const isRowSel = (sel: Selection, tableId: ItemId): sel is RowSelection =>
  isFocused(sel) && sel.focus.container === tableId;

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

const focusRowContainer = (
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { container: tableId, item: rowId },
  target: DEFAULT_TARGET,
  caret,
});

const focusCellContainer = (
  rowId: ItemId,
  cellId: ItemId,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { container: rowId, item: cellId },
  target: DEFAULT_TARGET,
  caret,
});

function focusFirstCellValue(
  core: Core,
  tableId: ItemId,
  rowId: ItemId,
  cols: readonly string[],
): { focus: Focus; target: string; caret: Caret } | null {
  const firstCol = cols[0];
  if (!firstCol) return null;
  const cellId = findChildByLabel(core, rowId, firstCol);
  if (!cellId) return null;
  return {
    focus: { container: rowId, item: cellId },
    target: VALUE_TARGET,
    caret: SELECT_ALL,
  };
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

  const moveRow = (rowId: ItemId, delta: number) => {
    const r = rows.indexOf(rowId);
    if (r < 0) return null;
    const nextRow = rows[r + delta];
    return nextRow ? focusRowContainer(tableId, nextRow) : null;
  };

  const moveCellHoriz = (
    rowId: ItemId,
    colIdx: number,
    delta: number,
  ): NavResult | null => {
    const nc = colIdx + delta;
    if (nc < 0) return focusRowContainer(tableId, rowId);

    const nextCol = cols[nc];
    if (!nextCol) return null;

    const nextCell = findChildByLabel(core, rowId, nextCol);
    return nextCell
      ? focusCellContainer(rowId, nextCell)
      : focusRowContainer(tableId, rowId);
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
      ? focusCellContainer(nextRow, nextCell)
      : focusRowContainer(tableId, nextRow);
  };

  if (sel.focus.container === tableId) {
    const rowId = sel.focus.item;

    if (dir === "up") return moveRow(rowId, -1);
    if (dir === "down") return moveRow(rowId, 1);

    if (dir === "right") {
      const firstCol = cols[0];
      if (!firstCol) return null;
      const cid = findChildByLabel(core, rowId, firstCol);
      return cid ? focusCellContainer(rowId, cid) : null;
    }

    if (dir === "left") return null;

    return null;
  }

  const rowId = sel.focus.container;
  const cellId = sel.focus.item;

  const rowsIdx = rows.indexOf(rowId);
  if (rowsIdx < 0) return null;

  const colLabel = (labelOf(core, cellId) ?? "").trim();
  const colIdx = Math.max(0, cols.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowId, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowId, colIdx, 1);
  if (dir === "up") return moveCellVert(rowsIdx, colIdx, -1);
  if (dir === "down") return moveCellVert(rowsIdx, colIdx, 1);

  return null;
}

export const tableCommands = {
  setLabel(core: Core, rowId: ItemId, text: string): void {
    core.commit((t) => t.setLabel(rowId, text));
  },

  addRowAfter(core: Core, tableId: ItemId, afterRowId: ItemId | null): void {
    const rows = rowIds(core, tableId);
    const afterIdx = afterRowId ? rows.indexOf(afterRowId) : rows.length - 1;
    const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(tableId, { at, kind: "group" });
    });

    const next = focusRowContainer(tableId, id);
    core.focus(next.focus, next.target, { caret: next.caret });
  },

  removeRow(core: Core, tableId: ItemId, rowId: ItemId): void {
    const rows = rowIds(core, tableId);
    const idx = rows.indexOf(rowId);
    const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

    core.commit((t) => t.remove(rowId));

    if (nextRow) {
      const next = focusRowContainer(tableId, nextRow);
      core.focus(next.focus, next.target, { caret: next.caret });
    } else {
      core.blur();
    }
  },

  confirm(core: Core, tableId: ItemId, sel: FocusedSelection): void {
    if (sel.focus.container === tableId) {
      tableCommands.addRowAfter(core, tableId, sel.focus.item);
      return;
    }

    if (sel.target === DEFAULT_TARGET) {
      core.focus(sel.focus, VALUE_TARGET, { caret: caretAt(1_000_000) });
      return;
    }

    const move = tableNavMove(core, tableId, sel, "down", "step");
    if (move) {
      core.focus(move.focus, move.target, { caret: move.caret });
      return;
    }

    tableCommands.addRowAfter(core, tableId, sel.focus.container);
  },
} as const;

type TableMountCtx = {
  core: Core;
  tableId: ItemId;
  columnsSignal: { value: string[] };
  dispatch: (intent: Intent) => void;
};

function mountRowMeta(args: {
  core: Core;
  tableId: ItemId;
  rowId: ItemId;
  focus: Focus;
  dispatch: (intent: Intent) => void;
}): Component {
  const { core, tableId, rowId, focus, dispatch } = args;

  return createComponent(core, (ctx) => {
    const meta = el("div", "ui-meta");
    const labelWrap = el("div", "ui-label");
    meta.append(labelWrap);

    const isEditing = computed(() => {
      const sel = core.selection();
      return (
        isRowSel(sel, tableId) &&
        sel.focus.item === rowId &&
        sel.target === ROW_LABEL_TARGET
      );
    });

    const labelComp = textField(core, {
      focus,
      target: ROW_LABEL_TARGET,
      multiline: false,
      commit: (text) => tableCommands.setLabel(core, rowId, text),
      getState: () => {
        const row = core.item(rowId);
        const canEdit = row.mode.kind !== "readonly";
        const text = row.label ?? "";
        const readOnly = !isEditing.value || !canEdit;
        return { text, readOnly, isIssue: false };
      },
      onIntent: dispatch,
    });

    labelWrap.replaceChildren(labelComp.el);
    ctx.cleanup(() => labelComp.dispose());

    return meta;
  });
}

function mountCellHost(
  mountCtx: TableMountCtx,
  rowId: ItemId,
  col: string,
): Component {
  return createComponent(mountCtx.core, (ctx) => {
    const host = el("div", "ui-table-cell");
    host.setAttribute("data-col", col);

    const slot = ctx.slot(host);

    const getCellId = () => findChildByLabel(mountCtx.core, rowId, col);

    ctx.effect(() => {
      const cellItemId = getCellId();
      if (!cellItemId) {
        slot.clear();
        return;
      }

      const focus: Focus = { container: rowId, item: cellItemId };

      ctx.target(focus, DEFAULT_TARGET, () => host);

      const wanted = mountCtx.core.view(cellItemId);
      slot.set(
        mountCtx.core.mountView({ id: cellItemId, focus, view: wanted }),
      );
    });

    ctx.on(host, "pointerdown", (e: PointerEvent) => {
      const nextCell = getCellId();
      const res = nextCell
        ? focusCellContainer(rowId, nextCell, caretFromTarget(e.target))
        : focusRowContainer(mountCtx.tableId, rowId, caretFromTarget(e.target));

      mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
      e.stopPropagation();
    });

    return host;
  });
}

function mountRowContent(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, tableId, dispatch } = mountCtx;
  const focus: Focus = { container: tableId, item: rowId };

  return createContent({ core, focus, view: "table", part: "row" }, (ctx) => {
    const rowItem = el("div", "ui-table-row");

    ctx.target(focus, DEFAULT_TARGET, () => rowItem);

    ctx.on(rowItem, "pointerdown", (e: PointerEvent) => {
      const sel = core.selection();
      if (
        isRowSel(sel, tableId) &&
        sel.focus.item === rowId &&
        sel.target === DEFAULT_TARGET
      )
        return;

      core.focus(focus, DEFAULT_TARGET, { caret: caretFromTarget(e.target) });
      e.stopPropagation();
    });

    const metaComp = mountRowMeta({
      core,
      tableId,
      rowId,
      focus,
      dispatch,
    });
    rowItem.append(metaComp.el);
    ctx.cleanup(() => metaComp.dispose());

    const cellList = ctx.list<string>(rowItem, (colName) =>
      mountCellHost(mountCtx, rowId, colName),
    );

    ctx.effect(() => {
      cellList.update(mountCtx.columnsSignal.value);
    });

    return rowItem;
  });
}

function mountHeader(mountCtx: TableMountCtx): Component {
  return createComponent(mountCtx.core, (ctx) => {
    const header = el("div", "ui-table-header");

    const metaSpacer = el("div", "ui-table-col ui-table-col-meta");
    header.append(metaSpacer);

    const columnEls = new Map<string, HTMLElement>();

    const reconcile = (cols: readonly string[]) => {
      const desired: HTMLElement[] = [metaSpacer];

      for (const col of cols) {
        let cell = columnEls.get(col);
        if (!cell) {
          cell = el("div", "ui-table-col", col);
          cell.setAttribute("data-col", col);
          columnEls.set(col, cell);
        } else if (cell.textContent !== col) {
          cell.textContent = col;
        }
        desired.push(cell);
      }

      reconcileChildren(header, desired);

      const keep = new Set(cols);
      for (const [name, cell] of columnEls) {
        if (keep.has(name)) continue;
        cell.remove();
        columnEls.delete(name);
      }
    };

    ctx.effect(() => {
      reconcile(mountCtx.columnsSignal.value);
    });

    return header;
  });
}

function mountBody(mountCtx: TableMountCtx): Component {
  return createComponent(mountCtx.core, (ctx) => {
    const body = el("div", "ui-table-body");

    const rows = ctx.list<ItemId>(body, (rid) =>
      mountRowContent(mountCtx, rid),
    );

    ctx.effect(() => {
      const snap = mountCtx.core.item(mountCtx.tableId);
      const c = snap.content;
      rows.update(c.kind === "group" ? [...c.children] : []);
    });

    return body;
  });
}

function mountTableContent(args: {
  core: Core;
  tableId: ItemId;
  focus: Focus;
  columnsSignal: { value: string[] };
  dispatch: (intent: Intent) => void;
}): Component {
  const { core, tableId, focus, dispatch, columnsSignal } = args;

  return createContent({ core, focus, view: "table" }, (ctx) => {
    const mountCtx: TableMountCtx = {
      core,
      tableId,
      columnsSignal,
      dispatch,
    };

    const header = mountHeader(mountCtx);
    const body = mountBody(mountCtx);

    const root = el("div");
    root.append(header.el, body.el);

    ctx.cleanup(() => header.dispose());
    ctx.cleanup(() => body.dispose());

    return root;
  });
}

export function createTableView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: tableId } = args;

  const tableFocus: Focus = args.focus ?? { container: tableId, item: tableId };
  const columnsSignal = computed(() => deriveColumns(core, tableId));

  const dispatch = (intent: Intent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "NAV": {
        const res = tableNavMove(core, tableId, sel, intent.dir, intent.mode);
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "TAB": {
        const res = tableNavMove(
          core,
          tableId,
          sel,
          intent.shift ? "left" : "right",
          "step",
        );
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "CONFIRM": {
        if (isFocused(sel) && sel.target !== DEFAULT_TARGET) {
          core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }
        if (!isFocused(sel)) return;
        tableCommands.confirm(core, tableId, sel);
        return;
      }

      case "CANCEL": {
        escapeLadder(core);
        return;
      }

      case "TYPE": {
        if (!isFocused(sel)) return;
        if (sel.target !== DEFAULT_TARGET) return;

        if (sel.focus.container === tableId) {
          const rowId = sel.focus.item;
          const next = focusFirstCellValue(
            core,
            tableId,
            rowId,
            columnsSignal.value,
          );
          if (!next) return;
          core.focus(next.focus, next.target, { caret: next.caret });
          queueMicrotask(() => insertTextIntoActiveEditor(intent.char));
          return;
        }

        core.focus(sel.focus, VALUE_TARGET, { caret: SELECT_ALL });
        queueMicrotask(() => insertTextIntoActiveEditor(intent.char));
        return;
      }

      case "DELETE_BOUNDARY": {
        return;
      }

      case "DELETE": {
        if (!isFocused(sel)) return;
        if (sel.target !== DEFAULT_TARGET) return;
        return;
      }
    }
  };

  const content = mountTableContent({
    core,
    tableId,
    focus: tableFocus,
    columnsSignal,
    dispatch,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const intent = parseKeydownIntent(e);
    if (!intent) return;
    consume(e);
    dispatch(intent);
  };

  return {
    id: `table:${String(tableId)}`,
    root: content.el,
    onKeyDown,
    dispose() {
      content.dispose();
    },
  };
}
