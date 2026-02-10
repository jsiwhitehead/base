import { computed } from "@preact/signals-core";
import type {
  ItemId,
  Core,
  Component,
  Focus,
  Caret,
  Selection,
  DomView,
  Source,
} from "../core";
import { DEFAULT_TARGET } from "../core";
import {
  type Intent,
  type NavDir,
  el,
  createComponent,
  bindUiItemShell,
  autosizeTextField,
  textField,
  caret0,
  caretAt,
  SELECT_ALL,
  consume,
  parseKeydownIntent,
  insertTextIntoActiveEditor,
  escapeLadder,
  stampBody,
} from "../dom";

const LABEL_TARGET = "label";
const VALUE_TARGET = "value";

type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

function fieldsFromSource(source: Source): SourceField[] {
  if (source.type === "derived") {
    return [
      { key: "expr", label: "=", multiline: true, text: source.expr ?? "" },
    ];
  }
  return [
    { key: "from", label: "~", multiline: false, text: source.from ?? "" },
    {
      key: "where",
      label: "where:",
      multiline: true,
      text: source.where ?? "",
    },
    {
      key: "orderBy",
      label: "orderBy:",
      multiline: true,
      text: source.orderBy ?? "",
    },
  ];
}

function patchSource(source: Source, key: string, text: string): Source {
  if (source.type === "derived") {
    if (key === "expr") return { type: "derived", expr: text };
    return source;
  }
  if (key === "from") return { ...source, from: text };
  if (key === "where") return { ...source, where: text };
  if (key === "orderBy") return { ...source, orderBy: text };
  return source;
}

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

function isRowLabelSel(
  sel: Extract<Selection, { kind: "focused" }>,
  tableId: ItemId,
): boolean {
  return sel.focus.container === tableId && sel.target === LABEL_TARGET;
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

function cellColIdx(core: Core, rowId: ItemId, cellId: ItemId): number {
  return childrenOf(core, rowId).indexOf(cellId);
}

function focusRowLabel(
  tableId: ItemId,
  rowId: ItemId,
  caret: Caret,
): { focus: Focus; target: string; caret: Caret } {
  return {
    focus: { container: tableId, item: rowId },
    target: LABEL_TARGET,
    caret,
  };
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

export const tableCommands = {
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
} as const;

function mountItemMeta(
  core: Core,
  focus: Focus,
  id: ItemId,
  dispatch: (i: Intent) => void,
): Component {
  return createComponent(core, (ctx) => {
    const meta = el("div", "ui-meta");

    const labelWrap = el("div", "ui-meta-label");
    const sourceWrap = el("div", "ui-meta-source");
    meta.append(labelWrap, sourceWrap);

    const canEditLabel = () => core.item(id).mode.kind !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel()) return;
      const cur = core.item(id).label ?? "";
      if (cur === text) return;
      core.commit((t) => t.setLabel(id, text));
    };

    const labelComp = autosizeTextField(core, {
      focus,
      target: LABEL_TARGET,
      yieldNav: false,
      commit: commitLabel,
      getState: () => {
        const snap = core.item(id);
        return {
          text: snap.label ?? "",
          readOnly: !canEditLabel(),
          isIssue: false,
        };
      },
      onIntent: dispatch,
    });

    labelWrap.replaceChildren(labelComp.el);
    ctx.cleanup(() => labelComp.dispose());

    const rows = ctx.list<string>(sourceWrap, (key) =>
      createComponent(core, (ctx2) => {
        const row = el("div", "ui-meta-source-row");
        const keyEl = el("div", "ui-meta-source-key");
        const valEl = el("div", "ui-meta-source-val");
        row.append(keyEl, valEl);

        const tkey = `source:${key}`;

        const specForKey = (): SourceField | null => {
          const snap = core.item(id);
          if (snap.mode.kind !== "source") return null;
          return (
            fieldsFromSource(snap.mode.source).find((f) => f.key === key) ??
            null
          );
        };

        const commitField = (text: string) => {
          const snap = core.item(id);
          if (snap.mode.kind !== "source") return;
          const next = patchSource(snap.mode.source, key, text);
          core.commit((t) => t.setSource(id, next));
        };

        const fc = textField(core, {
          focus,
          target: tkey,
          multiline: specForKey()?.multiline ?? true,
          commit: commitField,
          getState: () => {
            const snap = core.item(id);
            if (snap.mode.kind !== "source")
              return { text: "", readOnly: true, isIssue: false };
            const txt =
              fieldsFromSource(snap.mode.source).find((x) => x.key === key)
                ?.text ?? "";
            return { text: txt, readOnly: false, isIssue: false };
          },
          onIntent: dispatch,
        });

        valEl.replaceChildren(fc.el);
        ctx2.cleanup(() => fc.dispose());

        ctx2.effect(() => {
          keyEl.textContent = specForKey()?.label ?? "";
        });

        return row;
      }),
    );

    const fieldsSignal = computed(() => {
      const snap = core.item(id);
      return snap.mode.kind === "source"
        ? fieldsFromSource(snap.mode.source)
        : [];
    });

    ctx.effect(() => {
      rows.update(fieldsSignal.value.map((f) => f.key));
    });

    return meta;
  });
}

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

    const metaHead = el("div", "ui-table-col ui-table-col-meta");
    header.append(metaHead);

    const colsHost = el("div", "ui-table-cols");
    header.append(colsHost);

    const cols = ctx.list<number>(colsHost, (colIdx) =>
      createComponent(core, (ctx2) => {
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

          slot.set(
            mountItemMeta(core, { container: rid, item: cid }, cid, dispatch),
          );
        });

        return col;
      }),
    );

    ctx.effect(() => {
      const n = sig.colCount.value;
      cols.update(Array.from({ length: n }, (_, i) => i));
    });

    ctx.on(header, "pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
    });

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

    const metaCell = el("div", "ui-table-cell ui-table-cell-meta");
    row.append(metaCell);

    const meta = mountItemMeta(
      core,
      { container: tableId, item: rowId },
      rowId,
      dispatch,
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
      return focusRowLabel(tableId, rowId, caretAt(1_000_000));
    }

    return null;
  }

  if (isRowLabelSel(sel, tableId)) {
    const rowId = sel.focus.item;
    const rowIdx = rows.indexOf(rowId);
    if (rowIdx < 0) return null;

    if (dir === "up") {
      const prev = rows[rowIdx - 1] ?? null;
      return prev ? focusRowLabel(tableId, prev, caretAt(1_000_000)) : null;
    }

    if (dir === "down") {
      const next = rows[rowIdx + 1] ?? null;
      return next ? focusRowLabel(tableId, next, caretAt(1_000_000)) : null;
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
    if (colIdx === 0) return focusRowLabel(tableId, rowId, caretAt(1_000_000));
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
    const rowId = sel.focus.item;
    return shift ? null : focusRowLabel(tableId, rowId, caretAt(1_000_000));
  }

  if (isRowLabelSel(sel, tableId)) {
    const rowId = sel.focus.item;
    if (shift) return focusRowContainer(tableId, rowId);
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

  if (dir > 0) return focusRowLabel(tableId, nextRow, caretAt(1_000_000));

  const lastCell =
    ncols > 0 ? (childrenOf(core, nextRow)[ncols - 1] ?? null) : null;
  return lastCell
    ? focusCellContainer(nextRow, lastCell)
    : focusRowLabel(tableId, nextRow, caretAt(1_000_000));
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
        const res = tableNavMove(core, tableId, rows, ncols, sel0, intent.dir);
        if (!res) return;

        if (sel0.target !== DEFAULT_TARGET && res.target === DEFAULT_TARGET) {
          core.focus(res.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }

      case "TAB": {
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

        if (isCellSel(core, tableId, rows, sel0)) {
          if (sel0.target === DEFAULT_TARGET) {
            core.focus(sel0.focus, VALUE_TARGET, { caret: caretAt(1_000_000) });
            return;
          }
          core.focus(sel0.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        if (isRowLabelSel(sel0, tableId)) {
          core.focus(sel0.focus, DEFAULT_TARGET, { caret: caret0() });
          return;
        }

        return;
      }

      case "TYPE": {
        if (sel0.target !== DEFAULT_TARGET) return;

        if (isRowContainerSel(sel0, tableId)) {
          return;
        }

        if (isCellSel(core, tableId, rows, sel0)) {
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
