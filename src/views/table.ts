import { computed } from "@preact/signals-core";

import type {
  Location,
  Intent,
  ItemId,
  ReaderForShape,
  Selection,
} from "../core";
import { defineShape, CONTENT_TEXT_TARGET, LABEL_TARGET } from "../core";
import type { Component, NavDirection, UiCore } from "../dom";
import {
  bindItemFrame,
  createComponent,
  defineShapedView,
  el,
  mountHeader,
  setBodyClasses,
} from "../dom";

const tableShape = defineShape({
  type: "group",
  children: { type: "group", nonEmpty: true, children: { type: "any" } },
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
  portals: readonly ItemId[];
  reader: TableReader;
  signals: TableSignals;
};

type CellPosition = {
  rowId: ItemId;
  rowIdx: number;
  rowReader: RowReader;
  colIdx: number;
};

function isRowItemSel(
  core: UiCore,
  sel: Extract<Selection, { type: "item" }>,
  tableId: ItemId,
): boolean {
  return core.locate(sel.anchor.item)?.parentId === tableId;
}

function isCellSel(
  core: UiCore,
  reader: TableReader,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "item" }>,
): boolean {
  return (
    resolveCellPosition(core, reader, tableId, rows, sel.anchor.item) !== null
  );
}

function isCellValueSel(
  core: UiCore,
  reader: TableReader,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "editing" }>,
): boolean {
  if (sel.target !== CONTENT_TEXT_TARGET) return false;
  return (
    resolveCellPosition(core, reader, tableId, rows, sel.location.item) !== null
  );
}

function cellColIdx(rowReader: RowReader, cellId: ItemId): number {
  return rowReader.childIds().indexOf(cellId);
}

function resolveCellPosition(
  core: UiCore,
  reader: TableReader,
  tableId: ItemId,
  rows: readonly ItemId[],
  cellId: ItemId,
): CellPosition | null {
  const rowId = core.locate(cellId)?.parentId;
  if (!rowId || rowId === tableId) return null;
  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const rowReader = reader.child(rowId);
  const colIdx = cellColIdx(rowReader, cellId);
  if (colIdx < 0) return null;

  return { rowId, rowIdx, rowReader, colIdx };
}

function resolveFocusAfterRemove(
  core: UiCore,
  removedId: ItemId,
  prefer: "prev" | "next",
  portals: readonly ItemId[],
): Location | null {
  const loc = core.locate(removedId);
  if (!loc) return null;

  const prev = loc.siblings[loc.index - 1] ?? null;
  const next = loc.siblings[loc.index + 1] ?? null;
  const sibling =
    prefer === "prev" ? (prev ?? next ?? null) : (next ?? prev ?? null);
  if (sibling) {
    return { item: sibling, portals };
  }

  return { item: loc.parentId, portals };
}

const plan = {
  navMove(
    core: UiCore,
    reader: TableReader,
    tableId: ItemId,
    portals: readonly ItemId[],
    rows: readonly ItemId[],
    colCount: number,
    sel: Extract<Selection, { type: "item" }>,
    dir: NavDirection,
  ): Location | null {
    if (isRowItemSel(core, sel, tableId)) {
      const rowId = sel.anchor.item;
      const rowReader = reader.child(rowId);
      const rowIdx = rows.indexOf(rowId);
      if (rowIdx < 0) return null;

      if (dir === "up") {
        const prev = rows[rowIdx - 1] ?? null;
        return prev ? { item: prev, portals } : null;
      }

      if (dir === "down") {
        const next = rows[rowIdx + 1] ?? null;
        return next ? { item: next, portals } : null;
      }

      if (dir === "right") {
        const firstCell =
          colCount > 0 ? (rowReader.childIds()[0] ?? null) : null;
        return firstCell ? { item: firstCell, portals } : null;
      }

      return null;
    }

    if (!isCellSel(core, reader, tableId, rows, sel)) return null;
    const position = resolveCellPosition(
      core,
      reader,
      tableId,
      rows,
      sel.anchor.item,
    );
    if (!position) return null;
    const { rowReader, rowIdx, colIdx, rowId } = position;

    if (dir === "left") {
      if (colIdx === 0) return { item: rowId, portals };
      const prev = rowReader.childIds()[colIdx - 1] ?? null;
      return prev ? { item: prev, portals } : null;
    }

    if (dir === "right") {
      const next = rowReader.childIds()[colIdx + 1] ?? null;
      return next ? { item: next, portals } : null;
    }

    if (dir === "up") {
      const prevRow = rows[rowIdx - 1] ?? null;
      if (!prevRow) return null;
      const prevRowReader = reader.child(prevRow);
      const prevCell = prevRowReader.childIds()[colIdx] ?? null;
      return prevCell ? { item: prevCell, portals } : null;
    }

    const nextRow = rows[rowIdx + 1] ?? null;
    if (!nextRow) return null;
    const nextRowReader = reader.child(nextRow);
    const nextCell = nextRowReader.childIds()[colIdx] ?? null;
    return nextCell ? { item: nextCell, portals } : null;
  },

  tabMove(
    core: UiCore,
    reader: TableReader,
    tableId: ItemId,
    portals: readonly ItemId[],
    rows: readonly ItemId[],
    colCount: number,
    sel: Extract<Selection, { type: "item" }>,
    shift: boolean,
  ): Location | null {
    const dir = shift ? -1 : 1;

    if (isRowItemSel(core, sel, tableId)) {
      if (shift) return null;
      const rowId = sel.anchor.item;
      const rowReader = reader.child(rowId);
      const firstCell = colCount > 0 ? (rowReader.childIds()[0] ?? null) : null;
      return firstCell ? { item: firstCell, portals } : null;
    }

    if (!isCellSel(core, reader, tableId, rows, sel)) return null;
    const position = resolveCellPosition(
      core,
      reader,
      tableId,
      rows,
      sel.anchor.item,
    );
    if (!position) return null;
    const { rowReader, rowIdx, colIdx } = position;

    const nextCol = colIdx + dir;

    if (nextCol >= 0 && nextCol < colCount) {
      const nextCell = rowReader.childIds()[nextCol] ?? null;
      return nextCell ? { item: nextCell, portals } : null;
    }

    const nextRow = rows[rowIdx + dir] ?? null;
    if (!nextRow) return null;

    if (dir > 0) {
      const nextRowReader = reader.child(nextRow);
      const firstCell =
        colCount > 0 ? (nextRowReader.childIds()[0] ?? null) : null;
      return firstCell
        ? { item: firstCell, portals }
        : { item: nextRow, portals };
    }

    const nextRowReader = reader.child(nextRow);
    const lastCell =
      colCount > 0 ? (nextRowReader.childIds()[colCount - 1] ?? null) : null;
    return lastCell ? { item: lastCell, portals } : { item: nextRow, portals };
  },

  enterMove(
    core: UiCore,
    reader: TableReader,
    tableId: ItemId,
    portals: readonly ItemId[],
    rows: readonly ItemId[],
    sel: Extract<Selection, { type: "editing" }>,
  ): Location | null {
    const position = resolveCellPosition(
      core,
      reader,
      tableId,
      rows,
      sel.location.item,
    );
    if (!position) return null;
    const { rowIdx, colIdx } = position;

    const nextRow = rows[rowIdx + 1] ?? null;
    if (!nextRow) return null;

    const nextRowReader = reader.child(nextRow);
    const nextCell = nextRowReader.childIds()[colIdx] ?? null;
    return nextCell ? { item: nextCell, portals } : null;
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
    const schemaRowId = rows[0] ?? null;
    const schemaRow =
      schemaRowId != null ? core.item(schemaRowId).content : null;
    const schemaCellIds = schemaRow?.type === "group" ? schemaRow.children : [];

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(tableId, { at });
      t.setGroup(id);
      for (const schemaCellId of schemaCellIds) {
        const cellId = t.insertChild(id);
        t.setValue(cellId, null);
        const label = core.item(schemaCellId).label;
        if (label != null) t.setLabel(cellId, label);
      }
    });

    return id;
  },

  addColumnAfter(
    core: UiCore,
    rows: readonly ItemId[],
    afterColIdx: number,
    focusRowId: ItemId,
  ): ItemId | null {
    let focusedCellId: ItemId | null = null;
    core.commit((t) => {
      for (const rowId of rows) {
        const cellId = t.insertChild(rowId, { at: afterColIdx + 1 });
        t.setValue(cellId, null);
        if (rowId === focusRowId) focusedCellId = cellId;
      }
    });
    return focusedCellId;
  },

  clearCell(core: UiCore, cellId: ItemId): void {
    core.commit((t) => t.setValue(cellId, null));
  },
} as const;

function focusItem(core: UiCore, location: Location | null): void {
  if (!location) return;
  core.focus({ type: "item", location });
}

function insertRowAfterAndFocus(
  core: UiCore,
  tableId: ItemId,
  rows: readonly ItemId[],
  afterRowId: ItemId,
  portals: readonly ItemId[],
): void {
  const newId = cmd.addRowAfter(core, tableId, rows, afterRowId);
  core.focus({
    type: "item",
    location: { item: newId, portals },
  });
}

function insertColumnAfterAndFocus(
  core: UiCore,
  rows: readonly ItemId[],
  afterColIdx: number,
  focusRowId: ItemId,
  portals: readonly ItemId[],
): void {
  const newCellId = cmd.addColumnAfter(core, rows, afterColIdx, focusRowId);
  if (!newCellId) return;
  core.focus({
    type: "item",
    location: { item: newCellId, portals },
  });
}

function buildHeader(mountCtx: TableMountCtx): Component {
  const { core, portals, reader, signals } = mountCtx;

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
          const location: Location = { item: cellId, portals };
          mountHeader(colCtx, {
            core,
            host: col,
            location,
            id: cellId,
            visibility: "always",
            onCommitLabel: (text) => {
              const colIdx = cellColIdx(
                reader.child(signals.schemaRowId.value),
                cellId,
              );
              core.commit((t) => {
                t.setLabel(cellId, text);
                for (const rowId of signals.rows.value) {
                  if (rowId === signals.schemaRowId.value) continue;
                  const rowCellId = reader.child(rowId).childIds()[colIdx];
                  if (rowCellId) t.setLabel(rowCellId, text);
                }
              });
            },
          });

          return col;
        }),
    );

    return header;
  });
}

function buildDataCell(
  core: UiCore,
  portals: readonly ItemId[],
  cellId: ItemId,
): Component {
  return createComponent(core, (ctx) => {
    const host = el("div", "ui-table-cell");
    host.dataset.drag = "slot";

    const location: Location = { item: cellId, portals };
    bindItemFrame(ctx, { core, location }, host);

    ctx.slot(host, () => {
      return core.mountView({ id: cellId, portals, view: core.view(cellId) });
    });

    return host;
  });
}

function buildRowFrame(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, portals, reader, signals } = mountCtx;
  const rowReader = reader.child(rowId);

  return createComponent(core, (ctx) => {
    const row = el("div", "ui-table-row");
    bindItemFrame(ctx, { core, location: { item: rowId, portals } }, row);

    const headerCell = el("div", "ui-table-cell ui-table-first");
    headerCell.dataset.drag = "reorder";
    row.append(headerCell);
    mountHeader(ctx, {
      core,
      host: headerCell,
      location: { item: rowId, portals },
      id: rowId,
      visibility: "always",
    });

    ctx.list<ItemId>(
      row,
      () => rowReader.childIds().slice(0, signals.colCount.value),
      (cellId) => buildDataCell(core, portals, cellId),
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
  ({ core, id: tableId, location, reader: tableReader }) => {
    const rootPortals = location.portals;
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

    const schemaCell = (cellId: ItemId): ItemId | null => {
      const rowId = core.locate(cellId)?.parentId;
      if (!rowId) return null;
      const colIdx = cellColIdx(tableReader.child(rowId), cellId);
      return (
        tableReader.child(signals.schemaRowId.value).childIds()[colIdx] ?? null
      );
    };

    const focusSchemaLabel = (cellId: ItemId): void => {
      const target = schemaCell(cellId);
      if (!target) return;
      core.focus(
        {
          type: "editing",
          location: { item: target, portals: rootPortals },
          target: LABEL_TARGET,
        },
        { caret: "end" },
      );
    };

    const handleItemNav = (
      selection: Extract<Selection, { type: "item" }>,
      dir: NavDirection,
    ): void => {
      if (dir === "left" && isRowItemSel(core, selection, tableId)) {
        core.focus({
          type: "item",
          location: { item: tableId, portals: rootPortals },
        });
        return;
      }

      const rows = signals.rows.value;
      const colCount = signals.colCount.value;
      const nextFocus = plan.navMove(
        core,
        tableReader,
        tableId,
        rootPortals,
        rows,
        colCount,
        selection,
        dir,
      );
      focusItem(core, nextFocus);
    };

    const handleItemDelete = (
      selection: Extract<Selection, { type: "item" }>,
      dir: "backward" | "forward",
    ): void => {
      if (isRowItemSel(core, selection, tableId)) {
        const rows = signals.rows.value;
        const removingTable = rows.length === 1;
        const removeId = removingTable ? tableId : selection.anchor.item;
        const nextFocus = resolveFocusAfterRemove(
          core,
          removeId,
          dir === "backward" ? "prev" : "next",
          rootPortals,
        );
        core.commit((t) => t.remove(removeId));
        if (nextFocus) {
          core.focus({ type: "item", location: nextFocus });
        } else {
          core.focus({ type: "idle" });
        }
        return;
      }
      const rows = signals.rows.value;
      if (!isCellSel(core, tableReader, tableId, rows, selection)) return;
      core.commit((t) => t.setValue(selection.anchor.item, null));
    };

    const onIntent = (intent: Intent): void => {
      const selection = core.selection();

      if (selection.type === "editing") {
        if (intent.type === "ENTER") {
          const rows = signals.rows.value;
          if (isCellValueSel(core, tableReader, tableId, rows, selection)) {
            const next = plan.enterMove(
              core,
              tableReader,
              tableId,
              rootPortals,
              rows,
              selection,
            );
            focusItem(core, next ?? selection.location);
            return;
          }
          core.focus({ type: "item", location: selection.location });
          return;
        }
        if (intent.type === "NAV") {
          const rows = signals.rows.value;
          if (!isCellValueSel(core, tableReader, tableId, rows, selection)) {
            return;
          }
          const colCount = signals.colCount.value;
          const nextFocus = plan.navMove(
            core,
            tableReader,
            tableId,
            rootPortals,
            rows,
            colCount,
            {
              type: "item",
              anchor: selection.location,
              head: selection.location,
            },
            intent.dir,
          );
          focusItem(core, nextFocus);
          return;
        }
        if (intent.type === "DELETE") {
          const rows = signals.rows.value;
          if (isCellValueSel(core, tableReader, tableId, rows, selection)) {
            return;
          }
        }
        if (intent.type === "LABEL") {
          const rows = signals.rows.value;
          if (isCellValueSel(core, tableReader, tableId, rows, selection)) {
            focusSchemaLabel(selection.location.item);
          }
          return;
        }
        return;
      }

      if (selection.type !== "item") return;

      switch (intent.type) {
        case "NAV": {
          handleItemNav(selection, intent.dir);
          return;
        }
        case "ENTER": {
          const rows = signals.rows.value;
          if (isRowItemSel(core, selection, tableId)) {
            insertRowAfterAndFocus(
              core,
              tableId,
              rows,
              selection.anchor.item,
              rootPortals,
            );
            return;
          }
          return;
        }
        case "LABEL": {
          const rows = signals.rows.value;
          if (isCellSel(core, tableReader, tableId, rows, selection)) {
            focusSchemaLabel(selection.anchor.item);
          }
          return;
        }
        case "INSERT": {
          const rows = signals.rows.value;
          const cellPosition = resolveCellPosition(
            core,
            tableReader,
            tableId,
            rows,
            selection.anchor.item,
          );
          const selectedRowId = isRowItemSel(core, selection, tableId)
            ? selection.anchor.item
            : cellPosition?.rowId;
          if (!selectedRowId) return;

          if (intent.scope === "after-parent") {
            insertColumnAfterAndFocus(
              core,
              rows,
              cellPosition ? cellPosition.colIdx : signals.colCount.value - 1,
              selectedRowId,
              rootPortals,
            );
            return;
          }

          insertRowAfterAndFocus(
            core,
            tableId,
            rows,
            selectedRowId,
            rootPortals,
          );
          return;
        }
        case "TYPE":
          return;
        case "DELETE": {
          handleItemDelete(selection, intent.dir);
          return;
        }
      }
    };

    const bodyRoot = createComponent(core, (ctx) => {
      const root = el("div");
      setBodyClasses(root, "table");

      ctx.on(root, "keydown", (e: KeyboardEvent) => {
        if (e.defaultPrevented) return;
        const selection = core.selection();
        if (selection.type !== "item") return;

        const rows = signals.rows.value;
        if (
          !isRowItemSel(core, selection, tableId) &&
          !isCellSel(core, tableReader, tableId, rows, selection)
        ) {
          return;
        }

        if (
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          (e.key === "ArrowLeft" ||
            e.key === "ArrowRight" ||
            e.key === "ArrowUp" ||
            e.key === "ArrowDown")
        ) {
          const dir =
            e.key === "ArrowLeft"
              ? "left"
              : e.key === "ArrowRight"
                ? "right"
                : e.key === "ArrowUp"
                  ? "up"
                  : "down";
          e.preventDefault();
          e.stopPropagation();
          handleItemNav(selection, dir);
          return;
        }

        if (
          !e.shiftKey &&
          !e.altKey &&
          !e.metaKey &&
          !e.ctrlKey &&
          (e.key === "Backspace" || e.key === "Delete")
        ) {
          e.preventDefault();
          e.stopPropagation();
          handleItemDelete(
            selection,
            e.key === "Backspace" ? "backward" : "forward",
          );
          return;
        }

        if (e.key !== "Tab") return;

        e.preventDefault();
        e.stopPropagation();

        const nextFocus = plan.tabMove(
          core,
          tableReader,
          tableId,
          rootPortals,
          rows,
          signals.colCount.value,
          selection,
          e.shiftKey,
        );
        if (!nextFocus) return;
        focusItem(core, nextFocus);
      });

      const inner = el("div", "ui-table-inner");
      root.append(inner);

      const mountCtx: TableMountCtx = {
        core,
        tableId,
        portals: rootPortals,
        reader: tableReader,
        signals,
      };
      ctx.mount(inner, buildHeader(mountCtx));
      ctx.mount(inner, buildBody(mountCtx));

      return root;
    });

    return { onIntent, bodyRoot };
  },
);
