import { computed } from "@preact/signals-core";

import type {
  Caret,
  Component,
  Core,
  DomView,
  Focus,
  ItemId,
  Selection,
} from "../core";
import { DEFAULT_TARGET } from "../core";
import type { Intent, NavDir } from "../dom";
import {
  SELECT_ALL,
  VALUE_TARGET,
  bindUiItemShell,
  caret0,
  caretAt,
  createComponent,
  el,
  escapeLadder,
  insertTextIntoActiveEditor,
  mountItemMeta,
  patchSource,
  reconcileChildren,
  stampBody,
} from "../dom";

const childrenOf = (core: Core, id: ItemId): readonly ItemId[] => {
  const c = core.item(id).content;
  return c.kind === "group" ? c.children : [];
};

const rowIds = (core: Core, tableId: ItemId): ItemId[] => [
  ...childrenOf(core, tableId),
];

function isFocused(
  sel: Selection,
): sel is Extract<Selection, { kind: "focused" }> {
  return sel.kind === "focused";
}

function isRowContainerSel(
  sel: Extract<Selection, { kind: "focused" }>,
  tableId: ItemId,
): boolean {
  return sel.focus.container === tableId && sel.target === DEFAULT_TARGET;
}

function isCellSel(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { kind: "focused" }>,
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
  sel: Extract<Selection, { kind: "focused" }>,
): boolean {
  return sel.target === DEFAULT_TARGET && isCellSel(core, tableId, rows, sel);
}

function isCellValueSel(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  sel: Extract<Selection, { kind: "focused" }>,
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
  sig: TableSignals;
  dispatch: (intent: Intent) => void;
};

function mountHeader(mountCtx: TableMountCtx): Component {
  const { core, sig, dispatch } = mountCtx;

  return createComponent(core, (ctx) => {
    const header = el("div", "ui-table-header");

    const metaHead = el("div", "ui-table-col ui-table-meta-col");
    header.append(metaHead);

    const cache = new Map<number, Component>();

    const disposeAll = () => {
      for (const c of cache.values()) c.dispose();
      cache.clear();
    };

    const updateCols = (n: number) => {
      for (const [k, c] of cache) {
        if (k >= n) {
          c.dispose();
          cache.delete(k);
        }
      }

      const cols: HTMLElement[] = [];
      for (let colIdx = 0; colIdx < n; colIdx++) {
        let comp = cache.get(colIdx);
        if (!comp) {
          comp = createComponent(core, (ctx2) => {
            const col = el("div", "ui-table-col");
            const slot = ctx2.slot(col);

            let curRid: ItemId | null = null;
            let curCid: ItemId | null = null;

            ctx2.effect(() => {
              const rid = sig.schemaRowId.value;
              const cid = rid ? (childrenOf(core, rid)[colIdx] ?? null) : null;

              if (rid === curRid && cid === curCid) return;
              curRid = rid;
              curCid = cid;

              if (!rid || !cid) {
                slot.clear();
                return;
              }

              const focus: Focus = { container: rid, item: cid };

              const canEditLabel = () =>
                core.item(cid).mode.kind !== "readonly";

              const commitLabel = (text: string) => {
                if (!canEditLabel()) return;
                const cur = core.item(cid).label ?? "";
                if (cur === text) return;
                core.commit((t) => t.setLabel(cid, text));
              };

              const commitSourceField = (key: string, text: string) => {
                const snap = core.item(cid);
                if (snap.mode.kind !== "source") return;
                const next = patchSource(snap.mode.source, key, text);
                core.commit((t) => t.setSource(cid, next));
              };

              slot.set(
                mountItemMeta(
                  core,
                  {
                    focus,
                    id: cid,
                    dispatch,
                    canEditLabel,
                    commitLabel,
                    commitSourceField,
                  },
                  { visibility: "always" },
                ),
              );
            });

            return col;
          });

          cache.set(colIdx, comp);
        }
        cols.push(comp.el);
      }

      reconcileChildren(header, [metaHead, ...cols]);
    };

    ctx.effect(() => {
      updateCols(sig.colCount.value);
    });

    ctx.on(header, "pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
    });

    ctx.cleanup(disposeAll);

    return header;
  });
}

function mountDataCell(core: Core, rowId: ItemId, cellId: ItemId): Component {
  return createComponent(core, (ctx) => {
    const host = el("div", "ui-table-cell");

    const focus: Focus = { container: rowId, item: cellId };
    bindUiItemShell(ctx, { core, focus }, host);

    const body = core.mountView({ id: cellId, focus, view: core.view(cellId) });
    host.replaceChildren(body.el);
    ctx.cleanup(() => body.dispose());

    return host;
  });
}

function mountRowShell(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, tableId, sig, dispatch } = mountCtx;

  return createComponent(core, (ctx) => {
    const row = el("div", "ui-table-row");
    bindUiItemShell(
      ctx,
      { core, focus: { container: tableId, item: rowId } },
      row,
    );

    const metaCell = el("div", "ui-table-cell ui-table-meta-col");
    row.append(metaCell);

    const canEditLabel = () => core.item(rowId).mode.kind !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel()) return;
      const cur = core.item(rowId).label ?? "";
      if (cur === text) return;
      core.commit((t) => t.setLabel(rowId, text));
    };

    const commitSourceField = (key: string, text: string) => {
      const snap = core.item(rowId);
      if (snap.mode.kind !== "source") return;
      const next = patchSource(snap.mode.source, key, text);
      core.commit((t) => t.setSource(rowId, next));
    };

    const meta = mountItemMeta(
      core,
      {
        focus: { container: tableId, item: rowId },
        id: rowId,
        dispatch,
        canEditLabel,
        commitLabel,
        commitSourceField,
      },
      { visibility: "always" },
    );

    metaCell.replaceChildren(meta.el);
    ctx.cleanup(() => meta.dispose());

    const cellsHost = el("div", "ui-table-cells");
    row.append(cellsHost);

    const cells = ctx.list<string>(cellsHost, (key) => {
      const idx = key.indexOf("\u001f");
      const cellId = (idx >= 0 ? key.slice(idx + 1) : "") as ItemId;
      return mountDataCell(core, rowId, cellId);
    });

    ctx.effect(() => {
      const n = sig.colCount.value;
      const rowCells = childrenOf(core, rowId);
      const keys: string[] = [];
      for (let i = 0; i < n; i++) {
        const cid = rowCells[i];
        if (!cid) continue;
        keys.push(`${i}\u001f${cid}`);
      }
      cells.update(keys);
    });

    return row;
  });
}

function mountBody(mountCtx: TableMountCtx): Component {
  const { sig } = mountCtx;

  return createComponent(mountCtx.core, (ctx) => {
    const body = el("div", "ui-table-body");

    const rowsHost = el("div", "ui-table-rows");
    body.append(rowsHost);

    const rows = ctx.list<ItemId>(rowsHost, (rid) =>
      mountRowShell(mountCtx, rid),
    );

    ctx.effect(() => {
      rows.update(sig.rows.value);
    });

    return body;
  });
}

function tableNavMove(
  core: Core,
  tableId: ItemId,
  rows: readonly ItemId[],
  ncols: number,
  sel: Extract<Selection, { kind: "focused" }>,
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
      const firstCell = ncols > 0 ? (childrenOf(core, rowId)[0] ?? null) : null;
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
  ncols: number,
  sel: Extract<Selection, { kind: "focused" }>,
  shift: boolean,
): { focus: Focus; target: string; caret: Caret } | null {
  if (rows.length === 0) return null;

  const dir = shift ? -1 : 1;

  if (isRowContainerSel(sel, tableId)) {
    if (shift) return null;
    const rowId = sel.focus.item;
    const firstCell = ncols > 0 ? (childrenOf(core, rowId)[0] ?? null) : null;
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

  if (nextCol >= 0 && nextCol < ncols) {
    const nextCell = childrenOf(core, rowId)[nextCol] ?? null;
    return nextCell ? focusCellContainer(rowId, nextCell) : null;
  }

  const nextRow = rows[rowIdx + dir] ?? null;
  if (!nextRow) return null;

  if (dir > 0) {
    const firstCell = ncols > 0 ? (childrenOf(core, nextRow)[0] ?? null) : null;
    return firstCell
      ? focusCellContainer(nextRow, firstCell)
      : focusRowContainer(tableId, nextRow);
  }

  const lastCell =
    ncols > 0 ? (childrenOf(core, nextRow)[ncols - 1] ?? null) : null;
  return lastCell
    ? focusCellContainer(nextRow, lastCell)
    : focusRowContainer(tableId, nextRow);
}

function enterMove(
  core: Core,
  rows: readonly ItemId[],
  sel: Extract<Selection, { kind: "focused" }>,
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

export function createTableView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: tableId } = args;

  const rowsSignal = computed(() => rowIds(core, tableId));
  const schemaRowIdSignal = computed(() => rowsSignal.value[0] ?? null);
  const colCountSignal = computed(() => {
    const rid = schemaRowIdSignal.value;
    return rid ? childrenOf(core, rid).length : 0;
  });

  const sig: TableSignals = {
    rows: rowsSignal,
    schemaRowId: schemaRowIdSignal,
    colCount: colCountSignal,
  };

  const dispatch = (intent: Intent): void => {
    const sel0 = core.selection();

    if (intent.type === "CANCEL") {
      escapeLadder(core);
      return;
    }

    if (!isFocused(sel0)) return;

    const rows = sig.rows.value;
    const ncols = sig.colCount.value;

    switch (intent.type) {
      case "NAV": {
        if (sel0.target !== DEFAULT_TARGET) return;
        const res = tableNavMove(core, tableId, rows, ncols, sel0, intent.dir);
        if (!res) return;
        core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "TAB": {
        if (sel0.target !== DEFAULT_TARGET) return;
        const res = tabMove(core, tableId, rows, ncols, sel0, intent.shift);
        if (!res) return;
        core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "CONFIRM": {
        if (isRowContainerSel(sel0, tableId)) {
          tableCommands.addRowAfter(core, tableId, sel0.focus.item);
          return;
        }

        if (isCellContainerSel(core, tableId, rows, sel0)) {
          core.focus(sel0.focus, VALUE_TARGET, { caret: caretAt(1_000_000) });
          return;
        }

        if (isCellValueSel(core, tableId, rows, sel0)) {
          const next = enterMove(core, rows, sel0);
          const dest = next ?? {
            focus: sel0.focus,
            target: DEFAULT_TARGET,
            caret: caret0(),
          };
          core.focus(dest.focus, dest.target, { caret: dest.caret });
          return;
        }

        return;
      }

      case "TYPE": {
        if (sel0.target !== DEFAULT_TARGET) return;
        if (isRowContainerSel(sel0, tableId)) return;

        if (isCellContainerSel(core, tableId, rows, sel0)) {
          core.focus(sel0.focus, VALUE_TARGET, { caret: SELECT_ALL });
          queueMicrotask(() => insertTextIntoActiveEditor(intent.char));
          return;
        }

        return;
      }

      case "DELETE":
      case "DELETE_BOUNDARY":
        return;
    }
  };

  const content = createComponent(core, (ctx) => {
    const root = el("div");
    stampBody(root, "table");

    const tableFocus: Focus = args.focus ?? {
      container: tableId,
      item: tableId,
    };
    bindUiItemShell(ctx, { core, focus: tableFocus }, root);

    const mountCtx: TableMountCtx = { core, tableId, sig, dispatch };

    const header = mountHeader(mountCtx);
    const body = mountBody(mountCtx);

    root.append(header.el, body.el);

    ctx.cleanup(() => header.dispose());
    ctx.cleanup(() => body.dispose());

    return root;
  });

  return {
    id: `table:${String(tableId)}`,
    root: content.el,
    onIntent: dispatch,
    dispose() {
      content.dispose();
    },
  };
}
