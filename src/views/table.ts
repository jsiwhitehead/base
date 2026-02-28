import { computed } from "@preact/signals-core";

import type {
  Location,
  Intent,
  ItemId,
  ReaderForShape,
  Selection,
} from "../core";
import { defineShape, patchConn, VALUE_TARGET } from "../core";
import type { Component, NavDir, UiCore } from "../dom";
import {
  bindItemFrame,
  buildItemHeader,
  createComponent,
  defineShapedView,
  el,
  handleItemIntent,
  resolveFocusAfterRemove,
  setBodyClasses,
} from "../dom";

const tableShape = defineShape({
  type: "group",
  children: { type: "group", children: { type: "any" } },
  nonEmpty: true,
  alignChildren: true,
});

type TableReader = ReaderForShape<typeof tableShape>;
type RowReader = ReturnType<TableReader["child"]>;

type TableSignals = {
  rows: { value: readonly ItemId[] };
  schemaRowId: { value: ItemId };
  colCount: { value: number };
};

type TableMountCtx = {
  core: UiCore;
  tableId: ItemId;
  reader: TableReader;
  signals: TableSignals;
};

function isRowContainerSel(
  sel: Extract<Selection, { type: "item" }>,
  tableId: ItemId,
): boolean {
  return sel.anchor.container === tableId;
}

function isCellSel(
  reader: TableReader,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "item" }>,
): boolean {
  const rowId = sel.anchor.container;
  if (rowId === tableId) return false;
  if (!rows.includes(rowId)) return false;
  return reader.child(rowId).childIds().includes(sel.anchor.item);
}

function isCellValueSel(
  reader: TableReader,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "editing" }>,
): boolean {
  if (sel.target !== VALUE_TARGET) return false;
  const rowId = sel.location.container;
  if (rowId === tableId) return false;
  if (!rows.includes(rowId)) return false;
  return reader.child(rowId).childIds().includes(sel.location.item);
}

function cellColIdx(rowReader: RowReader, cellId: ItemId): number {
  return rowReader.childIds().indexOf(cellId);
}

function focusRowContainer(tableId: ItemId, rowId: ItemId): Location {
  return { container: tableId, item: rowId };
}

function focusCellContainer(rowId: ItemId, cellId: ItemId): Location {
  return { container: rowId, item: cellId };
}

const plan = {
  navMove(
    reader: TableReader,
    tableId: ItemId,
    rows: readonly ItemId[],
    colCount: number,
    sel: Extract<Selection, { type: "item" }>,
    dir: NavDir,
  ): Location | null {
    if (isRowContainerSel(sel, tableId)) {
      const rowId = sel.anchor.item;
      const rowReader = reader.child(rowId);
      const rowIdx = rows.indexOf(rowId);
      if (rowIdx < 0) return null;

      if (dir === "up") {
        const prev = rows[rowIdx - 1] ?? null;
        return prev ? focusRowContainer(tableId, prev) : null;
      }

      if (dir === "down") {
        const next = rows[rowIdx + 1] ?? null;
        return next ? focusRowContainer(tableId, next) : null;
      }

      if (dir === "right") {
        const firstCell =
          colCount > 0 ? (rowReader.childIds()[0] ?? null) : null;
        return firstCell ? focusCellContainer(rowId, firstCell) : null;
      }

      return null;
    }

    if (!isCellSel(reader, tableId, rows, sel)) return null;

    const rowId = sel.anchor.container;
    const cellId = sel.anchor.item;
    const rowReader = reader.child(rowId);

    const rowIdx = rows.indexOf(rowId);
    if (rowIdx < 0) return null;

    const colIdx = cellColIdx(rowReader, cellId);
    if (colIdx < 0) return null;

    if (dir === "left") {
      if (colIdx === 0) return focusRowContainer(tableId, rowId);
      const prev = rowReader.childIds()[colIdx - 1] ?? null;
      return prev ? focusCellContainer(rowId, prev) : null;
    }

    if (dir === "right") {
      const next = rowReader.childIds()[colIdx + 1] ?? null;
      return next ? focusCellContainer(rowId, next) : null;
    }

    if (dir === "up") {
      const prevRow = rows[rowIdx - 1] ?? null;
      if (!prevRow) return null;
      const prevRowReader = reader.child(prevRow);
      const prevCell = prevRowReader.childIds()[colIdx] ?? null;
      return prevCell ? focusCellContainer(prevRow, prevCell) : null;
    }

    const nextRow = rows[rowIdx + 1] ?? null;
    if (!nextRow) return null;
    const nextRowReader = reader.child(nextRow);
    const nextCell = nextRowReader.childIds()[colIdx] ?? null;
    return nextCell ? focusCellContainer(nextRow, nextCell) : null;
  },

  tabMove(
    reader: TableReader,
    tableId: ItemId,
    rows: readonly ItemId[],
    colCount: number,
    sel: Extract<Selection, { type: "item" }>,
    shift: boolean,
  ): Location | null {
    const dir = shift ? -1 : 1;

    if (isRowContainerSel(sel, tableId)) {
      if (shift) return null;
      const rowId = sel.anchor.item;
      const rowReader = reader.child(rowId);
      const firstCell = colCount > 0 ? (rowReader.childIds()[0] ?? null) : null;
      return firstCell ? focusCellContainer(rowId, firstCell) : null;
    }

    if (!isCellSel(reader, tableId, rows, sel)) return null;

    const rowId = sel.anchor.container;
    const cellId = sel.anchor.item;
    const rowReader = reader.child(rowId);

    const rowIdx = rows.indexOf(rowId);
    if (rowIdx < 0) return null;

    const colIdx = cellColIdx(rowReader, cellId);
    if (colIdx < 0) return null;

    const nextCol = colIdx + dir;

    if (nextCol >= 0 && nextCol < colCount) {
      const nextCell = rowReader.childIds()[nextCol] ?? null;
      return nextCell ? focusCellContainer(rowId, nextCell) : null;
    }

    const nextRow = rows[rowIdx + dir] ?? null;
    if (!nextRow) return null;

    if (dir > 0) {
      const nextRowReader = reader.child(nextRow);
      const firstCell =
        colCount > 0 ? (nextRowReader.childIds()[0] ?? null) : null;
      return firstCell
        ? focusCellContainer(nextRow, firstCell)
        : focusRowContainer(tableId, nextRow);
    }

    const nextRowReader = reader.child(nextRow);
    const lastCell =
      colCount > 0 ? (nextRowReader.childIds()[colCount - 1] ?? null) : null;
    return lastCell
      ? focusCellContainer(nextRow, lastCell)
      : focusRowContainer(tableId, nextRow);
  },

  enterMove(
    reader: TableReader,
    rows: readonly ItemId[],
    sel: Extract<Selection, { type: "editing" }>,
  ): Location | null {
    const rowId = sel.location.container;
    const cellId = sel.location.item;
    const rowReader = reader.child(rowId);

    const rowIdx = rows.indexOf(rowId);
    if (rowIdx < 0) return null;

    const colIdx = cellColIdx(rowReader, cellId);
    if (colIdx < 0) return null;

    const nextRow = rows[rowIdx + 1] ?? null;
    if (!nextRow) return null;

    const nextRowReader = reader.child(nextRow);
    const nextCell = nextRowReader.childIds()[colIdx] ?? null;
    return nextCell ? focusCellContainer(nextRow, nextCell) : null;
  },
} as const;

const cmd = {
  addRowAfter(
    core: UiCore,
    tableId: ItemId,
    rows: readonly ItemId[],
    afterRowId: ItemId | null,
  ): ItemId {
    const afterIdx = afterRowId ? rows.indexOf(afterRowId) : rows.length - 1;
    const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(tableId, { at });
      t.setGroup(id);
    });

    return id;
  },

  removeRow(core: UiCore, rowId: ItemId): void {
    core.commit((t) => t.remove(rowId));
  },

  clearCell(core: UiCore, cellId: ItemId): void {
    core.commit((t) => t.setValue(cellId, null));
  },
} as const;

function buildHeader(mountCtx: TableMountCtx): Component {
  const { core, reader, signals } = mountCtx;

  return createComponent(core, (ctx) => {
    const header = el("div", "ui-table-header");
    const headerHead = el("div", "ui-table-cell ui-table-first");
    header.append(headerHead);

    ctx.list<ItemId>(
      header,
      () => reader.child(signals.schemaRowId.value).childIds(),
      (cellId) =>
        createComponent(core, (colCtx) => {
          const col = el("div", "ui-table-cell");
          const schemaRowId = signals.schemaRowId.value;
          const focus: Location = { container: schemaRowId, item: cellId };

          const canEditLabel = () => core.item(cellId).mode.type !== "readonly";

          const commitLabel = (text: string) => {
            if (!canEditLabel()) return;
            const cur = core.item(cellId).label ?? "";
            if (cur === text) return;
            core.commit((t) => t.setLabel(cellId, text));
          };

          const commitConnField = (key: string, text: string) => {
            const snap = core.item(cellId);
            if (snap.mode.type !== "connected") return;
            const next = patchConn(snap.mode.conn, key, text);
            core.commit((t) => t.setConnected(cellId, next));
          };

          colCtx.mount(
            col,
            buildItemHeader(core, {
              focus,
              id: cellId,
              canEditLabel,
              commitLabel,
              commitConnField,
            }),
          );

          return col;
        }),
    );

    return header;
  });
}

function buildDataCell(core: UiCore, rowId: ItemId, cellId: ItemId): Component {
  return createComponent(core, (ctx) => {
    const host = el("div", "ui-table-cell");
    host.dataset.dragSlot = "true";

    const focus: Location = { container: rowId, item: cellId };
    bindItemFrame(ctx, { core, focus }, host);

    ctx.slot(host, () => {
      return core.mountView({ id: cellId, containerId: rowId });
    });

    return host;
  });
}

function buildRowFrame(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, tableId, reader, signals } = mountCtx;
  const rowReader = reader.child(rowId);

  return createComponent(core, (ctx) => {
    const row = el("div", "ui-table-row");
    bindItemFrame(
      ctx,
      { core, focus: { container: tableId, item: rowId } },
      row,
    );

    const headerCell = el("div", "ui-table-cell ui-table-first");
    row.append(headerCell);

    const canEditLabel = () => core.item(rowId).mode.type !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel()) return;
      const cur = core.item(rowId).label ?? "";
      if (cur === text) return;
      core.commit((t) => t.setLabel(rowId, text));
    };

    const commitConnField = (key: string, text: string) => {
      const snap = core.item(rowId);
      if (snap.mode.type !== "connected") return;
      const next = patchConn(snap.mode.conn, key, text);
      core.commit((t) => t.setConnected(rowId, next));
    };

    ctx.mount(
      headerCell,
      buildItemHeader(core, {
        focus: { container: tableId, item: rowId },
        id: rowId,
        canEditLabel,
        commitLabel,
        commitConnField,
      }),
    );

    ctx.list<ItemId>(
      row,
      () => rowReader.childIds().slice(0, signals.colCount.value),
      (cellId) => buildDataCell(core, rowId, cellId),
    );

    return row;
  });
}

function buildBody(mountCtx: TableMountCtx): Component {
  const { core, signals } = mountCtx;

  return createComponent(core, (ctx) => {
    const body = el("div", "ui-table-body");

    ctx.list<ItemId>(
      body,
      () => signals.rows.value,
      (rid) => buildRowFrame(mountCtx, rid),
    );

    return body;
  });
}

export const tableView = defineShapedView(
  tableShape,
  ({ core, id: tableId, reader: tableReader }) => {
    const rowsSignal = computed(() => tableReader.childIds());
    const schemaRowIdSignal = computed(() => rowsSignal.value[0]);
    const colCountSignal = computed(
      () => tableReader.child(schemaRowIdSignal.value).childIds().length,
    );

    const signals: TableSignals = {
      rows: rowsSignal,
      schemaRowId: schemaRowIdSignal,
      colCount: colCountSignal,
    };

    const onIntent = (intent: Intent): void => {
      const selection = core.selection();

      if (selection.type === "editing") {
        if (intent.type === "CONFIRM") {
          const rows = signals.rows.value;
          if (isCellValueSel(tableReader, tableId, rows, selection)) {
            const next = plan.enterMove(tableReader, rows, selection);
            if (next) {
              core.focus({ type: "item", location: next });
            } else {
              core.focus({ type: "item", location: selection.location });
            }
            return;
          }
          core.focus({ type: "item", location: selection.location });
          return;
        }
        return;
      }

      if (selection.type !== "item") return;

      switch (intent.type) {
        case "NAV": {
          if (intent.dir === "left" && isRowContainerSel(selection, tableId)) {
            const parentLoc = core.locate(tableId);
            if (!parentLoc) {
              core.focus({
                type: "item",
                location: { container: tableId, item: tableId },
              });
              return;
            }
            core.focus({
              type: "item",
              location: { container: parentLoc.parentId, item: tableId },
            });
            return;
          }

          const rows = signals.rows.value;
          const colCount = signals.colCount.value;
          const nextFocus = plan.navMove(
            tableReader,
            tableId,
            rows,
            colCount,
            selection,
            intent.dir,
          );
          if (!nextFocus) return;
          core.focus({ type: "item", location: nextFocus });
          return;
        }
        case "TAB": {
          const rows = signals.rows.value;
          const colCount = signals.colCount.value;
          const nextFocus = plan.tabMove(
            tableReader,
            tableId,
            rows,
            colCount,
            selection,
            intent.shift,
          );
          if (!nextFocus) return;
          core.focus({ type: "item", location: nextFocus });
          return;
        }
        case "CONFIRM": {
          const rows = signals.rows.value;
          if (isRowContainerSel(selection, tableId)) {
            const newId = cmd.addRowAfter(
              core,
              tableId,
              rows,
              selection.anchor.item,
            );
            core.focus({
              type: "item",
              location: { container: tableId, item: newId },
            });
            return;
          }
          if (!isCellSel(tableReader, tableId, rows, selection)) return;
          handleItemIntent({ core, sel: selection, intent });
          return;
        }
        case "TYPE": {
          const rows = signals.rows.value;
          if (!isCellSel(tableReader, tableId, rows, selection)) return;
          handleItemIntent({ core, sel: selection, intent });
          return;
        }
        case "DELETE": {
          if (isRowContainerSel(selection, tableId)) {
            const rows = signals.rows.value;
            const removingTable = rows.length === 1;
            const removeId = removingTable ? tableId : selection.anchor.item;
            const nextFocus = resolveFocusAfterRemove(core, removeId, "next");
            core.commit((t) => t.remove(removeId));
            if (nextFocus) {
              core.focus({ type: "item", location: nextFocus.focus });
            } else {
              core.focus({ type: "idle" });
            }
            return;
          }
          const rows = signals.rows.value;
          if (!isCellSel(tableReader, tableId, rows, selection)) return;
          cmd.clearCell(core, selection.anchor.item);
          return;
        }
      }
    };

    const body = createComponent(core, (ctx) => {
      const root = el("div");
      setBodyClasses(root, "table");

      const inner = el("div", "ui-table-inner");
      root.append(inner);

      const mountCtx: TableMountCtx = {
        core,
        tableId,
        reader: tableReader,
        signals,
      };
      ctx.mount(inner, buildHeader(mountCtx));
      ctx.mount(inner, buildBody(mountCtx));

      return root;
    });

    return { onIntent, body };
  },
);
