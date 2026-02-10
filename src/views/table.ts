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

type Column = { id: ItemId; name: string };

function normCol(s: string): string {
  return (s ?? "").trim();
}

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

const labelOf = (core: Core, id: ItemId): string => core.item(id).label ?? "";

const rowIds = (core: Core, tableId: ItemId): ItemId[] => [
  ...childrenOf(core, tableId),
];

function headerRowId(core: Core, tableId: ItemId): ItemId | null {
  const rows = rowIds(core, tableId);
  return rows[0] ?? null;
}

function deriveColumns(core: Core, tableId: ItemId): Column[] {
  const hid = headerRowId(core, tableId);
  if (!hid) return [];
  return childrenOf(core, hid).map((cid) => ({
    id: cid,
    name: normCol(labelOf(core, cid)),
  }));
}

function findChildByLabel(
  core: Core,
  ownerId: ItemId,
  label: string,
): ItemId | null {
  const want = normCol(label);
  if (!want) return null;

  for (const childId of childrenOf(core, ownerId)) {
    const nm = normCol(labelOf(core, childId));
    if (nm === want) return childId;
  }
  return null;
}

function focusRowContainer(
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret = caret0(),
): NavResult {
  return {
    focus: { container: tableId, item: rowId },
    target: DEFAULT_TARGET,
    caret,
  };
}

function focusCellContainer(
  rowId: ItemId,
  cellId: ItemId,
  caret: Caret = caret0(),
): NavResult {
  return {
    focus: { container: rowId, item: cellId },
    target: DEFAULT_TARGET,
    caret,
  };
}

function focusCellByColumnName(
  core: Core,
  tableId: ItemId,
  rowId: ItemId,
  colName: string,
  caret: Caret = caret0(),
): NavResult {
  const cellId = findChildByLabel(core, rowId, colName);
  return cellId
    ? focusCellContainer(rowId, cellId, caret)
    : focusRowContainer(tableId, rowId, caret);
}

function isFocused(
  sel: Selection,
): sel is Extract<Selection, { kind: "focused" }> {
  return sel.kind === "focused";
}

function isRowSel(
  sel: Selection,
  tableId: ItemId,
): sel is Extract<Selection, { kind: "focused" }> & {
  focus: { container: ItemId };
} {
  return isFocused(sel) && sel.focus.container === tableId;
}

function isHeaderFocus(
  sel: Extract<Selection, { kind: "focused" }>,
  tableId: ItemId,
): boolean {
  return (
    sel.focus.container === tableId &&
    sel.focus.item === tableId &&
    sel.target.startsWith("col:")
  );
}

function headerInfo(
  cols: readonly Column[],
  sel: Selection,
  tableId: ItemId,
): { colId: ItemId; idx: number } | null {
  if (!isFocused(sel)) return null;
  if (!isHeaderFocus(sel, tableId)) return null;
  const colId = sel.target.slice("col:".length) as ItemId;
  const idx = cols.findIndex((c) => c.id === colId);
  if (idx < 0) return null;
  return { colId, idx };
}

function tableNavMove(
  core: Core,
  tableId: ItemId,
  sel: Selection,
  dir: NavDir,
  _mode: NavMode,
  cols: readonly Column[],
): NavResult | null {
  if (!isFocused(sel)) return null;

  const rows = rowIds(core, tableId);
  if (rows.length === 0) return null;

  const colNames = cols.map((c) => c.name);

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

    const nextCol = colNames[nc];
    if (nextCol == null) return null;

    const nextCell = nextCol ? findChildByLabel(core, rowId, nextCol) : null;
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

    const col = colNames[colIdx];
    if (col == null) return null;

    const nextCell = col ? findChildByLabel(core, nextRow, col) : null;
    return nextCell
      ? focusCellContainer(nextRow, nextCell)
      : focusRowContainer(tableId, nextRow);
  };

  if (sel.focus.container === tableId) {
    const rowId = sel.focus.item;

    if (dir === "up") return moveRow(rowId, -1);
    if (dir === "down") return moveRow(rowId, 1);

    if (dir === "right") {
      const firstCol = colNames[0] ?? null;
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

  const colLabel = normCol(labelOf(core, cellId));
  const colIdx = Math.max(0, colNames.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowId, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowId, colIdx, 1);

  if (dir === "up") {
    if (rowsIdx === 1) {
      const headerCol = cols[colIdx]?.id ?? null;
      if (!headerCol) return null;
      return {
        focus: { container: tableId, item: tableId },
        target: `col:${headerCol}`,
      };
    }
    return moveCellVert(rowsIdx, colIdx, -1);
  }

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

    core.focus({ container: tableId, item: id }, DEFAULT_TARGET, {
      caret: caret0(),
    });
  },

  removeRow(core: Core, tableId: ItemId, rowId: ItemId): void {
    const rows = rowIds(core, tableId);
    const idx = rows.indexOf(rowId);
    const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

    core.commit((t) => t.remove(rowId));

    if (nextRow)
      core.focus({ container: tableId, item: nextRow }, DEFAULT_TARGET, {
        caret: caret0(),
      });
    else core.blur();
  },

  renameColumn(core: Core, tableId: ItemId, colId: ItemId, to: string): void {
    void tableId;

    const b = normCol(to);
    if (!b) return;

    core.commit((t) => {
      t.setLabel(colId, b);
    });
  },

  confirm(
    core: Core,
    tableId: ItemId,
    sel: Extract<Selection, { kind: "focused" }>,
  ): void {
    if (sel.focus.container === tableId) {
      tableCommands.addRowAfter(core, tableId, sel.focus.item);
      return;
    }

    if (sel.target === DEFAULT_TARGET) {
      core.focus(sel.focus, VALUE_TARGET, { caret: caretAt(1_000_000) });
      return;
    }

    const cols = deriveColumns(core, tableId);
    const move = tableNavMove(core, tableId, sel, "down", "step", cols);
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
  columnsSignal: { value: Column[] };
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
  colId: ItemId,
): Component {
  return createComponent(mountCtx.core, (ctx) => {
    const host = el("div", "ui-table-cell");

    const slot = ctx.slot(host);

    const colName = () => {
      const c = mountCtx.columnsSignal.value.find((x) => x.id === colId);
      return c?.name ?? "";
    };

    const getCellId = () => {
      const nm = colName();
      return nm ? findChildByLabel(mountCtx.core, rowId, nm) : null;
    };

    ctx.effect(() => {
      host.setAttribute("data-col", colName());
    });

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

    const metaComp = mountRowMeta({ core, tableId, rowId, focus, dispatch });
    rowItem.append(metaComp.el);
    ctx.cleanup(() => metaComp.dispose());

    const cellList = ctx.list<ItemId>(rowItem, (cid) =>
      mountCellHost(mountCtx, rowId, cid),
    );

    ctx.effect(() => {
      cellList.update(mountCtx.columnsSignal.value.map((c) => c.id));
    });

    return rowItem;
  });
}

function mountHeader(mountCtx: TableMountCtx): Component {
  return createComponent(mountCtx.core, (ctx) => {
    const header = el("div", "ui-table-header");

    const metaSpacer = el("div", "ui-table-col ui-table-col-meta");
    header.append(metaSpacer);

    const columnEls = new Map<ItemId, HTMLElement>();

    const reconcile = (cols: readonly Column[]) => {
      const desired: HTMLElement[] = [metaSpacer];

      for (const col of cols) {
        let cell = columnEls.get(col.id);
        if (!cell) {
          cell = el("div", "ui-table-col");
          cell.setAttribute("data-col", col.name);

          const wrap = el("div", "ui-table-col-label");
          const headerFocus: Focus = {
            container: mountCtx.tableId,
            item: mountCtx.tableId,
          };
          const target = `col:${col.id}`;

          const fc = textField(mountCtx.core, {
            focus: headerFocus,
            target,
            multiline: false,
            commit: (text) =>
              tableCommands.renameColumn(
                mountCtx.core,
                mountCtx.tableId,
                col.id,
                text,
              ),
            getState: () => {
              const exists = mountCtx.columnsSignal.value.some(
                (c) => c.id === col.id,
              );
              const text = labelOf(mountCtx.core, col.id);
              return { text, readOnly: !exists, isIssue: false };
            },
            onIntent: mountCtx.dispatch,
          });

          wrap.replaceChildren(fc.el);
          ctx.cleanup(() => fc.dispose());

          cell.append(wrap);
          columnEls.set(col.id, cell);
        } else {
          cell.setAttribute("data-col", col.name);
        }

        desired.push(cell);
      }

      reconcileChildren(header, desired);

      const keep = new Set(cols.map((c) => c.id));
      for (const [id, cell] of columnEls) {
        if (keep.has(id)) continue;
        cell.remove();
        columnEls.delete(id);
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
  columnsSignal: { value: Column[] };
  dispatch: (intent: Intent) => void;
}): Component {
  const { core, tableId, focus, dispatch, columnsSignal } = args;

  return createContent({ core, focus, view: "table" }, (ctx) => {
    const mountCtx: TableMountCtx = { core, tableId, columnsSignal, dispatch };

    const header = mountHeader(mountCtx);
    const body = mountBody(mountCtx);

    const root = el("div");
    root.append(header.el, body.el);

    ctx.cleanup(() => header.dispose());
    ctx.cleanup(() => body.dispose());

    return root;
  });
}

function focusHeaderCol(
  tableId: ItemId,
  colId: ItemId,
): { focus: Focus; target: string; caret: Caret } {
  return {
    focus: { container: tableId, item: tableId },
    target: `col:${colId}`,
    caret: caretAt(1_000_000),
  };
}

function focusFirstBodyCellInColumn(
  core: Core,
  tableId: ItemId,
  colName: string,
): NavResult | null {
  const rows = rowIds(core, tableId);
  const firstBodyRow = rows[1] ?? null;
  if (!firstBodyRow) return null;
  return focusCellByColumnName(core, tableId, firstBodyRow, colName, caret0());
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
    const cols = columnsSignal.value;
    const hdr = headerInfo(cols, sel, tableId);

    switch (intent.type) {
      case "TAB": {
        if (!isFocused(sel)) return;

        if (hdr) {
          const next = cols[hdr.idx + (intent.shift ? -1 : 1)] ?? null;
          if (!next) return;
          const dst = focusHeaderCol(tableId, next.id);
          core.focus(dst.focus, dst.target, { caret: dst.caret });
          return;
        }

        const res = tableNavMove(
          core,
          tableId,
          sel,
          intent.shift ? "left" : "right",
          "step",
          cols,
        );
        if (!res) return;
        core.focus(res.focus, DEFAULT_TARGET, { caret: caret0() });
        return;
      }

      case "NAV": {
        if (!isFocused(sel)) return;

        if (hdr) {
          if (intent.dir === "left" || intent.dir === "right") {
            const next =
              cols[hdr.idx + (intent.dir === "left" ? -1 : 1)] ?? null;
            if (!next) return;
            const dst = focusHeaderCol(tableId, next.id);
            core.focus(dst.focus, dst.target, { caret: dst.caret });
            return;
          }

          if (intent.dir === "down") {
            const colName = cols[hdr.idx]?.name ?? "";
            const move = focusFirstBodyCellInColumn(core, tableId, colName);
            if (!move) return;
            core.focus(move.focus, DEFAULT_TARGET, { caret: caret0() });
            return;
          }

          return;
        }

        const res = tableNavMove(
          core,
          tableId,
          sel,
          intent.dir,
          intent.mode,
          cols,
        );
        if (!res) return;

        if (sel.target !== DEFAULT_TARGET) {
          core.focus(res.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "CONFIRM": {
        if (!isFocused(sel)) return;

        if (hdr) {
          const colName = cols[hdr.idx]?.name ?? "";
          const move = focusFirstBodyCellInColumn(core, tableId, colName);
          if (!move) return;
          core.focus(move.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        if (sel.target === DEFAULT_TARGET) {
          tableCommands.confirm(core, tableId, sel);
          return;
        }

        const move = tableNavMove(core, tableId, sel, "down", "step", cols);
        if (move) {
          core.focus(move.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
        return;
      }

      case "CANCEL": {
        escapeLadder(core);
        return;
      }

      case "TYPE": {
        if (hdr) return;
        if (!isFocused(sel)) return;
        if (sel.target !== DEFAULT_TARGET) return;

        if (sel.focus.container === tableId) {
          const rowId = sel.focus.item;
          const firstCol = cols[0];
          if (!firstCol) return;

          const cellId = firstCol.name
            ? findChildByLabel(core, rowId, firstCol.name)
            : null;
          if (!cellId) return;

          core.focus({ container: rowId, item: cellId }, VALUE_TARGET, {
            caret: SELECT_ALL,
          });
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
