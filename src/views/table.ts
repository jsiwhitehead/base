import { computed } from "@preact/signals-core";

import type {
  Caret,
  Component,
  Core,
  DomView,
  Focus,
  ItemId,
  Selection,
  ViewIntent,
  ViewRegistration,
} from "../core";
import { DEFAULT_TARGET, VALUE_TARGET } from "../core";
import type { NavDir } from "../dom";
import {
  SELECT_ALL,
  bindItemFrame,
  buildItemHeader,
  caret0,
  caretEnd,
  createComponent,
  el,
  insertTextIntoActiveEditor,
  patchConn,
  setBodyClasses,
} from "../dom";

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const content = core.item(id).content;
  return content.type === "group" ? content.children : [];
};

const rowIds = (core: Core, tableId: ItemId): ItemId[] => [
  ...childrenOf(core, tableId),
];

function isRowContainerSel(
  sel: Extract<Selection, { type: "focused" }>,
  tableId: ItemId,
): boolean {
  return sel.focus.container === tableId && sel.target === DEFAULT_TARGET;
}

function isCellSel(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "focused" }>,
): boolean {
  const rowId = sel.focus.container;
  if (rowId === tableId) return false;
  if (!rows.includes(rowId)) return false;
  return childrenOf(core, rowId).includes(sel.focus.item);
}

function isCellContainerSel(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "focused" }>,
): boolean {
  return sel.target === DEFAULT_TARGET && isCellSel(core, tableId, rows, sel);
}

function isCellValueSel(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "focused" }>,
): boolean {
  return sel.target === VALUE_TARGET && isCellSel(core, tableId, rows, sel);
}

function cellColIdx(core: Core, rowId: ItemId, cellId: ItemId): number {
  return childrenOf(core, rowId).indexOf(cellId);
}

function focusRowContainer(
  tableId: ItemId,
  rowId: ItemId,
): { focus: Focus; target: string; caret: Caret } {
  return {
    focus: { container: tableId, item: rowId },
    target: DEFAULT_TARGET,
    caret: caret0(),
  };
}

function focusCellContainer(
  rowId: ItemId,
  cellId: ItemId,
): { focus: Focus; target: string; caret: Caret } {
  return {
    focus: { container: rowId, item: cellId },
    target: DEFAULT_TARGET,
    caret: caret0(),
  };
}

const tableCommands = {
  addRowAfter(core: Core, tableId: ItemId, afterRowId: ItemId | null): void {
    const rows = rowIds(core, tableId);
    const afterIdx = afterRowId ? rows.indexOf(afterRowId) : rows.length - 1;
    const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(tableId, { at });
      t.setGroup(id);
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
} as const;

type TableSignals = {
  rows: { value: ItemId[] };
  schemaRowId: { value: ItemId | null };
  colCount: { value: number };
};

type TableMountCtx = {
  core: Core;
  tableId: ItemId;
  signals: TableSignals;
  dispatch: (intent: ViewIntent) => void;
};

function buildHeader(mountCtx: TableMountCtx): Component {
  const { core, signals } = mountCtx;

  return createComponent(core, (ctx) => {
    const header = el("div", "ui-table-header");
    const headerHead = el("div", "ui-table-col ui-table-header-col");
    header.append(headerHead);

    ctx.list<number>(
      header,
      () => {
        const colCount = signals.colCount.value;
        const out: number[] = [];
        for (let i = 0; i < colCount; i++) out.push(i);
        return out;
      },
      (colIdx) =>
        createComponent(core, (colCtx) => {
          const col = el("div", "ui-table-col");

          colCtx.slot(col, () => {
            const schemaRowId = signals.schemaRowId.value;
            const cellId = schemaRowId
              ? (childrenOf(core, schemaRowId)[colIdx] ?? null)
              : null;
            if (!schemaRowId || !cellId) return null;

            const focus: Focus = { container: schemaRowId, item: cellId };

            const canEditLabel = () =>
              core.item(cellId).mode.type !== "readonly";

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

            return buildItemHeader(core, {
              focus,
              id: cellId,
              canEditLabel,
              commitLabel,
              commitConnField,
            });
          });

          return col;
        }),
    );

    return header;
  });
}

function buildDataCell(core: Core, rowId: ItemId, cellId: ItemId): Component {
  return createComponent(core, (ctx) => {
    const host = el("div", "ui-table-cell");

    const focus: Focus = { container: rowId, item: cellId };
    bindItemFrame(ctx, { core, focus }, host);

    ctx.slot(host, () => {
      const wanted = core.view(cellId);
      return core.mountView({ id: cellId, focus, view: wanted });
    });

    return host;
  });
}

function buildRowFrame(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, tableId, signals } = mountCtx;

  return createComponent(core, (ctx) => {
    const row = el("div", "ui-table-row");
    bindItemFrame(
      ctx,
      { core, focus: { container: tableId, item: rowId } },
      row,
    );

    const headerCell = el("div", "ui-table-cell ui-table-header-col");
    row.append(headerCell);

    ctx.slot(headerCell, () => {
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

      return buildItemHeader(core, {
        focus: { container: tableId, item: rowId },
        id: rowId,
        canEditLabel,
        commitLabel,
        commitConnField,
      });
    });

    ctx.list<number>(
      row,
      () => {
        const colCount = signals.colCount.value;
        const out: number[] = [];
        for (let i = 0; i < colCount; i++) out.push(i);
        return out;
      },
      (colIdx) => {
        const cellId = childrenOf(core, rowId)[colIdx] ?? null;
        if (!cellId)
          return createComponent(core, () => el("div", "ui-table-cell"));
        return buildDataCell(core, rowId, cellId);
      },
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

function tableNavMove(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  colCount: number,
  sel: Extract<Selection, { type: "focused" }>,
  dir: NavDir,
): { focus: Focus; target: string; caret: Caret } | null {
  if (rows.length === 0) return null;

  if (isRowContainerSel(sel, tableId)) {
    const rowId = sel.focus.item;
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
        colCount > 0 ? (childrenOf(core, rowId)[0] ?? null) : null;
      return firstCell ? focusCellContainer(rowId, firstCell) : null;
    }

    return null;
  }

  if (!isCellSel(core, tableId, rows, sel)) return null;

  const rowId = sel.focus.container;
  const cellId = sel.focus.item;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colIdx = cellColIdx(core, rowId, cellId);
  if (colIdx < 0) return null;

  if (dir === "left") {
    if (colIdx === 0) return focusRowContainer(tableId, rowId);
    const prev = childrenOf(core, rowId)[colIdx - 1] ?? null;
    return prev ? focusCellContainer(rowId, prev) : null;
  }

  if (dir === "right") {
    const next = childrenOf(core, rowId)[colIdx + 1] ?? null;
    return next ? focusCellContainer(rowId, next) : null;
  }

  if (dir === "up") {
    const prevRow = rows[rowIdx - 1] ?? null;
    if (!prevRow) return null;
    const prevCell = childrenOf(core, prevRow)[colIdx] ?? null;
    return prevCell ? focusCellContainer(prevRow, prevCell) : null;
  }

  const nextRow = rows[rowIdx + 1] ?? null;
  if (!nextRow) return null;
  const nextCell = childrenOf(core, nextRow)[colIdx] ?? null;
  return nextCell ? focusCellContainer(nextRow, nextCell) : null;
}

function tabMove(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  colCount: number,
  sel: Extract<Selection, { type: "focused" }>,
  shift: boolean,
): { focus: Focus; target: string; caret: Caret } | null {
  if (rows.length === 0) return null;

  const dir = shift ? -1 : 1;

  if (isRowContainerSel(sel, tableId)) {
    if (shift) return null;
    const rowId = sel.focus.item;
    const firstCell =
      colCount > 0 ? (childrenOf(core, rowId)[0] ?? null) : null;
    return firstCell ? focusCellContainer(rowId, firstCell) : null;
  }

  if (!isCellSel(core, tableId, rows, sel)) return null;

  const rowId = sel.focus.container;
  const cellId = sel.focus.item;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colIdx = cellColIdx(core, rowId, cellId);
  if (colIdx < 0) return null;

  const nextCol = colIdx + dir;

  if (nextCol >= 0 && nextCol < colCount) {
    const nextCell = childrenOf(core, rowId)[nextCol] ?? null;
    return nextCell ? focusCellContainer(rowId, nextCell) : null;
  }

  const nextRow = rows[rowIdx + dir] ?? null;
  if (!nextRow) return null;

  if (dir > 0) {
    const firstCell =
      colCount > 0 ? (childrenOf(core, nextRow)[0] ?? null) : null;
    return firstCell
      ? focusCellContainer(nextRow, firstCell)
      : focusRowContainer(tableId, nextRow);
  }

  const lastCell =
    colCount > 0 ? (childrenOf(core, nextRow)[colCount - 1] ?? null) : null;
  return lastCell
    ? focusCellContainer(nextRow, lastCell)
    : focusRowContainer(tableId, nextRow);
}

function enterMove(
  core: Core,
  rows: readonly ItemId[],
  sel: Extract<Selection, { type: "focused" }>,
): { focus: Focus; target: string; caret: Caret } | null {
  const rowId = sel.focus.container;
  const cellId = sel.focus.item;

  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const colIdx = cellColIdx(core, rowId, cellId);
  if (colIdx < 0) return null;

  const nextRow = rows[rowIdx + 1] ?? null;
  if (!nextRow) return null;

  const nextCell = childrenOf(core, nextRow)[colIdx] ?? null;
  return nextCell ? focusCellContainer(nextRow, nextCell) : null;
}

function createTableView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: tableId } = args;

  const rowsSignal = computed(() => rowIds(core, tableId));
  const schemaRowIdSignal = computed(() => rowsSignal.value[0] ?? null);
  const colCountSignal = computed(() => {
    const schemaRowId = schemaRowIdSignal.value;
    return schemaRowId ? childrenOf(core, schemaRowId).length : 0;
  });

  const signals: TableSignals = {
    rows: rowsSignal,
    schemaRowId: schemaRowIdSignal,
    colCount: colCountSignal,
  };

  const dispatch = (intent: ViewIntent): void => {
    const sel0 = core.selection();
    if (sel0.type !== "focused") return;
    const selection = sel0;

    switch (intent.type) {
      case "NAV": {
        if (selection.target !== DEFAULT_TARGET) return;
        const rows = signals.rows.value;
        const colCount = signals.colCount.value;

        const nextFocus = tableNavMove(
          core,
          tableId,
          rows,
          colCount,
          selection,
          intent.dir,
        );
        if (!nextFocus) return;
        core.focus(nextFocus.focus, nextFocus.target, {
          caret: nextFocus.caret,
        });
        return;
      }
      case "TAB": {
        if (selection.target !== DEFAULT_TARGET) return;
        const rows = signals.rows.value;
        const colCount = signals.colCount.value;

        const nextFocus = tabMove(
          core,
          tableId,
          rows,
          colCount,
          selection,
          intent.shift,
        );
        if (!nextFocus) return;
        core.focus(nextFocus.focus, nextFocus.target, {
          caret: nextFocus.caret,
        });
        return;
      }
      case "CONFIRM": {
        const rows = signals.rows.value;

        if (isRowContainerSel(selection, tableId)) {
          tableCommands.addRowAfter(core, tableId, selection.focus.item);
          return;
        }

        if (isCellContainerSel(core, tableId, rows, selection)) {
          core.focus(selection.focus, VALUE_TARGET, { caret: caretEnd() });
          return;
        }

        if (isCellValueSel(core, tableId, rows, selection)) {
          const next = enterMove(core, rows, selection);
          const dest = next ?? {
            focus: selection.focus,
            target: DEFAULT_TARGET,
            caret: caret0(),
          };
          core.focus(dest.focus, dest.target, { caret: dest.caret });
          return;
        }
        return;
      }
      case "TYPE":
        if (selection.target !== DEFAULT_TARGET) return;

        const rows = signals.rows.value;

        if (isRowContainerSel(selection, tableId)) return;

        if (isCellContainerSel(core, tableId, rows, selection)) {
          core.focus(selection.focus, VALUE_TARGET, { caret: SELECT_ALL });
          queueMicrotask(() => insertTextIntoActiveEditor(intent.char));
        }
        return;
      case "DELETE":
        return;
    }
  };

  const content = createComponent(core, (ctx) => {
    const root = el("div");
    setBodyClasses(root, "table");

    const tableFocus: Focus = args.focus ?? {
      container: tableId,
      item: tableId,
    };
    bindItemFrame(ctx, { core, focus: tableFocus }, root);

    const mountCtx: TableMountCtx = { core, tableId, signals, dispatch };
    ctx.mount(root, buildHeader(mountCtx));
    ctx.mount(root, buildBody(mountCtx));

    return root;
  });

  return {
    root: content.el,
    onIntent: dispatch,
    dispose() {
      content.dispose();
    },
  };
}

export const tableView: ViewRegistration = {
  factory: createTableView,
  constraint: {
    content: "group",
    children: { content: "group", viewLocked: true },
    shapeSync: true,
  },
};
