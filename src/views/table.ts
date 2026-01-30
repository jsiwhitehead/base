import { computed } from "@preact/signals-core";
import {
  type Core,
  type EntryId,
  type ItemRef,
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

const isEntryRef = (r: ItemRef) => r.path.length === 0;

const sameRef = (a: ItemRef, b: ItemRef) =>
  a.entryId === b.entryId &&
  a.path.length === b.path.length &&
  a.path.every((x, i) => x === b.path[i]);

const refKey = (r: ItemRef): string =>
  `${String(r.entryId)}:${r.path.length ? r.path.join(",") : ""}`;

const refFromKey = (key: string): ItemRef => {
  const i = key.indexOf(":");
  if (i === -1) return { entryId: Number(key), path: [] };
  const entryId = Number(key.slice(0, i));
  const rest = key.slice(i + 1);
  const path = rest.trim() === "" ? [] : rest.split(",").map((x) => Number(x));
  return { entryId, path };
};

const tableRefOf = (tableId: EntryId): ItemRef => ({
  entryId: tableId,
  path: [],
});

const childrenOf = (core: Core, ref: ItemRef): readonly ItemRef[] => {
  const c = core.item(ref).content;
  return c.kind === "group" ? c.children : [];
};

const labelOf = (core: Core, ref: ItemRef): string =>
  core.item(ref).label ?? "";

const focusRowLabel = (
  tableRef: ItemRef,
  rowRef: ItemRef,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { scope: tableRef, ref: rowRef },
  target: "label",
  caret,
});

const focusCell = (
  rowRef: ItemRef,
  cellRef: ItemRef,
  caret: Caret = caret0(),
): NavResult => ({
  focus: { scope: rowRef, ref: cellRef },
  target: "content",
  caret,
});

function deriveColumns(core: Core, tableRef: ItemRef): string[] {
  const rows = childrenOf(core, tableRef);
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
type CellSelection = FocusedSelection & { target: "content" };

const isFocused = (sel: Selection): sel is FocusedSelection =>
  sel.kind === "focused";

const isRowLabelSelection = (
  sel: Selection,
  tableRef: ItemRef,
): sel is RowLabelSelection =>
  isFocused(sel) &&
  sel.target === "label" &&
  sameRef(sel.focus.scope, tableRef);

const isCellSelection = (
  sel: Selection,
  tableRef: ItemRef,
): sel is CellSelection =>
  isFocused(sel) &&
  sel.target === "content" &&
  !sameRef(sel.focus.scope, tableRef);

const rowRefs = (core: Core, tableRef: ItemRef): ItemRef[] => [
  ...childrenOf(core, tableRef),
];

function findChildByLabel(
  core: Core,
  owner: ItemRef,
  label: string,
): ItemRef | null {
  const want = label.trim();
  if (!want) return null;

  for (const child of childrenOf(core, owner)) {
    const nm = (core.item(child).label ?? "").trim();
    if (nm === want) return child;
  }
  return null;
}

function tableNavMove(
  core: Core,
  tableRef: ItemRef,
  sel: Selection,
  dir: NavDir,
  _mode: NavMode,
): NavResult | null {
  if (!isFocused(sel)) return null;

  const cols = deriveColumns(core, tableRef);
  const rows = rowRefs(core, tableRef);
  if (rows.length === 0) return null;

  const moveRowLabel = (rowRef: ItemRef, delta: number) => {
    const r = rows.findIndex((x) => sameRef(x, rowRef));
    if (r < 0) return null;
    const nextRow = rows[r + delta];
    return nextRow ? focusRowLabel(tableRef, nextRow) : null;
  };

  const moveCellHoriz = (
    rowRef: ItemRef,
    colIdx: number,
    delta: number,
  ): NavResult | null => {
    const nc = colIdx + delta;
    if (nc < 0) return focusRowLabel(tableRef, rowRef);

    const nextCol = cols[nc];
    if (!nextCol) return null;

    const nextCell = findChildByLabel(core, rowRef, nextCol);
    return nextCell ? focusCell(rowRef, nextCell) : null;
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
      : focusRowLabel(tableRef, nextRow);
  };

  if (isRowLabelSelection(sel, tableRef)) {
    const rowRef = sel.focus.ref;

    if (dir === "up") return moveRowLabel(rowRef, -1);
    if (dir === "down") return moveRowLabel(rowRef, 1);

    if (dir === "right") {
      const firstCol = cols[0];
      if (!firstCol) return null;

      const cid = findChildByLabel(core, rowRef, firstCol);
      return cid ? focusCell(rowRef, cid) : null;
    }

    return null;
  }

  if (!isCellSelection(sel, tableRef)) return null;

  const rowRef = sel.focus.scope;
  const cellRef = sel.focus.ref;

  const rowIdx = rows.findIndex((x) => sameRef(x, rowRef));
  if (rowIdx < 0) return null;

  const colLabel = (labelOf(core, cellRef) ?? "").trim();
  const colIdx = Math.max(0, cols.indexOf(colLabel));

  if (dir === "left") return moveCellHoriz(rowRef, colIdx, -1);
  if (dir === "right") return moveCellHoriz(rowRef, colIdx, 1);
  if (dir === "up") return moveCellVert(rowIdx, colIdx, -1);
  if (dir === "down") return moveCellVert(rowIdx, colIdx, 1);

  return null;
}

export const tableCommands = {
  setLabel(core: Core, rowRef: ItemRef, text: string): void {
    if (!isEntryRef(rowRef)) return;
    core.edit.setLabel(rowRef, text);
  },

  setText(core: Core, cellRef: ItemRef, raw: string): void {
    if (!isEntryRef(cellRef)) return;
    core.edit.setContentScalar(cellRef, parseScalar(raw) as any);
  },

  addRowAfter(core: Core, tableRef: ItemRef, afterRow: ItemRef | null): void {
    if (!isEntryRef(tableRef)) return;

    const rows = rowRefs(core, tableRef);
    const afterIdx = afterRow
      ? rows.findIndex((r) => sameRef(r, afterRow))
      : rows.length - 1;
    const at = afterIdx >= 0 ? afterIdx + 1 : rows.length;

    let id: EntryId = -1;
    core.commit((t) => {
      id = t.insertChild(tableRef, { at, kind: "group" });
    });

    const nextRowRef: ItemRef = { entryId: id, path: [] };
    const next = focusRowLabel(tableRef, nextRowRef);
    core.focus(next.focus, next.target, { caret: next.caret });
  },

  removeRow(core: Core, tableRef: ItemRef, rowRef: ItemRef): void {
    if (!isEntryRef(rowRef)) return;

    const rows = rowRefs(core, tableRef);
    const idx = rows.findIndex((r) => sameRef(r, rowRef));
    const nextRow = rows[idx + 1] ?? rows[idx - 1] ?? null;

    core.edit.removeEntry(rowRef.entryId);

    if (nextRow) {
      const next = focusRowLabel(tableRef, nextRow);
      core.focus(next.focus, next.target, { caret: next.caret });
    } else {
      core.blur();
    }
  },

  addColumn(core: Core, tableRef: ItemRef, label: string): void {
    const name = label.trim();
    if (!name) return;

    const rows = rowRefs(core, tableRef);
    if (!rows.length) return;

    core.commit((t) => {
      for (const rowRef of rows) {
        if (!isEntryRef(rowRef)) continue;
        if (findChildByLabel(core, rowRef, name)) continue;

        const cellId = t.insertChild(rowRef, { kind: "blank" });
        t.setLabel({ entryId: cellId, path: [] }, name);
      }
    });
  },

  removeColumn(core: Core, tableRef: ItemRef, label: string): void {
    const name = label.trim();
    if (!name) return;

    const rows = rowRefs(core, tableRef);
    if (!rows.length) return;

    core.commit((t) => {
      for (const rowRef of rows) {
        if (!isEntryRef(rowRef)) continue;
        const cell = findChildByLabel(core, rowRef, name);
        if (!cell || !isEntryRef(cell)) continue;
        t.removeEntry(cell.entryId);
      }
    });
  },

  confirm(core: Core, tableRef: ItemRef, sel: Selection): void {
    if (!isFocused(sel)) return;

    if (sel.target === "label" && sameRef(sel.focus.scope, tableRef)) {
      tableCommands.addRowAfter(core, tableRef, sel.focus.ref);
      return;
    }

    const move = tableNavMove(core, tableRef, sel, "down", "step");
    if (move) {
      core.focus(move.focus, move.target, { caret: move.caret });
      return;
    }

    if (sel.target === "content") {
      tableCommands.addRowAfter(core, tableRef, sel.focus.scope);
    }
  },
} as const;

type TableIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" };

type TableMountCtx = {
  core: Core;
  tableRef: ItemRef;
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
  tableRef: ItemRef;
  rowRef: ItemRef;
  cellRef: ItemRef;
  dispatch: (intent: TableIntent) => void;
}): Component {
  const { core, rowRef, cellRef, dispatch } = cellCtx;
  const focus: Focus = { scope: rowRef, ref: cellRef };

  return contentField({
    core,
    focus,
    ref: cellRef,
    commitText: (text) => tableCommands.setText(core, cellRef, text),
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
  rowRef: ItemRef,
  col: string,
): Component {
  return createComponent((componentCtx) => {
    const hostEl = el("div", "item cell");
    const inner = el("div");
    hostEl.append(inner);

    let cur: Component | null = null;
    let curCellKey: string | null = null;

    const setInner = (node: HTMLElement) => inner.replaceChildren(node);

    const mountMissing = () => {
      cur?.dispose();
      cur = null;
      curCellKey = null;
      setInner(el("div", "item cell issue", "[missing]"));
    };

    const mountPresent = (cellRef: ItemRef) => {
      cur?.dispose();
      cur = mountTableCellContent({
        core: mountCtx.core,
        tableRef: mountCtx.tableRef,
        rowRef,
        cellRef,
        dispatch: mountCtx.dispatch,
      });
      curCellKey = refKey(cellRef);
      setInner(cur.el);
      componentCtx.use(cur);
    };

    const getCellRef = () => findChildByLabel(mountCtx.core, rowRef, col);

    componentCtx.watch(
      () => {
        const r = getCellRef();
        return r ? refKey(r) : null;
      },
      (nextKey) => {
        if (nextKey === curCellKey) return;
        if (!nextKey) mountMissing();
        else mountPresent(refFromKey(nextKey));
      },
    );

    componentCtx.on(hostEl, "pointerdown", (e: PointerEvent) => {
      const nextCell = getCellRef();
      const res = nextCell
        ? focusCell(rowRef, nextCell)
        : focusRowLabel(mountCtx.tableRef, rowRef);
      mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
      e.stopPropagation();
    });

    return hostEl;
  });
}

function mountTableRow(mountCtx: TableMountCtx, rowRef: ItemRef): Component {
  return createComponent((componentCtx) => {
    const rowEl = el("div", "row");
    const labelCell = el("div", "label");
    const labelHost = el("div", "row-label");
    labelCell.append(labelHost);

    const cellsHost = el("div", "row-cells");
    rowEl.append(labelCell, cellsHost);

    const labelFocus: Focus = { scope: mountCtx.tableRef, ref: rowRef };

    const labelComp = textField({
      core: mountCtx.core,
      focus: labelFocus,
      target: "label",
      multiline: false,
      caret: "fromTarget",
      stopPropagation: true,
      onCommitEvents: ["input", "blur"],
      commit: (text) => tableCommands.setLabel(mountCtx.core, rowRef, text),
      getState: () => {
        const sel = mountCtx.core.selection();
        const editing =
          isRowLabelSelection(sel, mountCtx.tableRef) &&
          sameRef(sel.focus.ref, rowRef);

        const text = mountCtx.core.item(rowRef).label ?? "";
        const readOnly = !editing || !isEntryRef(rowRef);
        return { text, readOnly, isIssue: false };
      },
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => mountCtx.dispatch({ type: "NAV", dir, mode }),
          onEnter: () => {
            const first = mountCtx.columnsSignal.value[0];
            if (!first) return;

            const cell = findChildByLabel(mountCtx.core, rowRef, first);
            if (!cell) return;

            const res = focusCell(rowRef, cell);
            mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
          },
          onEscape: () => mountCtx.dispatch({ type: "CANCEL" }),
        }),
    });

    labelHost.replaceChildren(labelComp.el);
    componentCtx.use(labelComp);

    const cellList = componentCtx.list(cellsHost, (colName: string) =>
      mountTableCell(mountCtx, rowRef, colName),
    );

    componentCtx.watch(
      () => mountCtx.columnsSignal.value,
      (cols) => {
        cellList.update(cols);
      },
    );

    componentCtx.on(labelCell, "pointerdown", (e: PointerEvent) => {
      const res = focusRowLabel(mountCtx.tableRef, rowRef);
      mountCtx.core.focus(res.focus, res.target, { caret: res.caret });
      e.stopPropagation();
    });

    return rowEl;
  });
}

function mountTableBody(mountCtx: TableMountCtx): Component {
  return createComponent((componentCtx) => {
    const body = el("div", "table-body");
    const rowList = componentCtx.list(body, (key: string) =>
      mountTableRow(mountCtx, refFromKey(key)),
    );

    componentCtx.watch(
      () => childrenOf(mountCtx.core, mountCtx.tableRef).map(refKey),
      (rows) => {
        rowList.update(rows);
      },
    );

    return body;
  });
}

export function createTableView(args: {
  core: Core;
  id: EntryId;
  focus?: Focus;
}): DomView {
  const { core, id } = args;

  const tableRef = tableRefOf(id);

  const root = el("div", "view table");
  root.tabIndex = 0;

  const headerHost = el("div");
  const bodyHost = el("div");
  root.append(headerHost, bodyHost);

  const columnsSignal = computed(() => deriveColumns(core, tableRef));

  const navMove = (sel: Selection, dir: NavDir, mode: NavMode) =>
    tableNavMove(core, tableRef, sel, dir, mode);

  const dispatch = (intent: TableIntent): void => {
    const sel = core.selection();

    switch (intent.type) {
      case "NAV": {
        const res = navMove(sel, intent.dir, intent.mode);
        if (res) core.focus(res.focus, res.target, { caret: res.caret });
        return;
      }
      case "CONFIRM":
        tableCommands.confirm(core, tableRef, sel);
        return;
      case "CANCEL":
        core.blur();
        return;
    }
  };

  const mountCtx: TableMountCtx = {
    core,
    tableRef,
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
    const rows = childrenOf(core, tableRef);
    if (rows.length) {
      const firstRow = rows[0]!;
      const res = focusRowLabel(tableRef, firstRow);
      core.focus(res.focus, res.target, { caret: res.caret });
    }
  }

  return {
    id: `table:${String(id)}`,
    root,
    onKeyDown,
    dispose() {
      header.dispose();
      body.dispose();
      root.replaceChildren();
    },
  };
}
