import { computed } from "@preact/signals-core";
import {
  type Core,
  type ItemId,
  type Component,
  type Caret,
  type Focus,
  type Selection,
  type DomView,
  DEFAULT_TARGET,
  defaultTextCaret,
} from "../core";
import {
  type NavDir,
  type NavMode,
  defaultTextNav,
  el,
  stopEvent,
  bindTextControlKeys,
  createComponent,
  textField,
  ensureTabbable,
  applyUiItemState,
  caretFromTarget,
} from "../dom";

type NavResult = { focus: Focus; target: string; caret?: Caret };

const caret0 = (): Caret => ({ start: 0, end: 0 });
const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

const ROW_LABEL_TARGET = "row:label";
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

  confirm(core: Core, tableId: ItemId, sel: Selection): void {
    if (!isFocused(sel)) return;

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

type TableIntent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM" }
  | { type: "CANCEL" };

type TableMountCtx = {
  core: Core;
  tableId: ItemId;
  columnsSignal: { value: string[] };
  dispatch: (intent: TableIntent) => void;
};

function mountRowMeta(args: {
  core: Core;
  tableId: ItemId;
  rowId: ItemId;
  focus: Focus;
  dispatch: (intent: TableIntent) => void;
}): Component {
  const { core, tableId, rowId, focus, dispatch } = args;

  return createComponent((ctx) => {
    const meta = el("div", "ui-meta");
    const labelWrap = el("div", "ui-label");
    meta.append(labelWrap);

    const labelSlot = ctx.slot(labelWrap);

    const labelComp = textField({
      multiline: false,
      commit: (text) => tableCommands.setLabel(core, rowId, text),
      getState: () => {
        const sel = core.selection();
        const editing =
          isRowSel(sel, tableId) &&
          sel.focus.item === rowId &&
          sel.target === ROW_LABEL_TARGET;
        const row = core.item(rowId);
        const canEdit = row.mode.kind !== "readonly";
        const text = row.label ?? "";
        const readOnly = !editing || !canEdit;
        return { text, readOnly, isIssue: false };
      },
      onCommitEvents: ["blur"],
      target: ROW_LABEL_TARGET,
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => dispatch({ type: "NAV", dir, mode }),
          onEnter: () => dispatch({ type: "NAV", dir: "right", mode: "step" }),
          onEscape: () =>
            core.focus(focus, DEFAULT_TARGET, { caret: caret0() }),
        }),
    });

    ensureTabbable(labelComp.focusEl);

    labelSlot.set(labelComp);
    ctx.cleanup(() => labelComp.dispose());

    ctx.target(core, focus, ROW_LABEL_TARGET, () => labelComp.focusEl, {
      caret: defaultTextCaret(),
    });

    ctx.select(core, focus, labelComp.focusEl, {
      target: ROW_LABEL_TARGET,
      caret: "fromTarget",
    });

    return meta;
  });
}

function mountCellHost(
  mountCtx: TableMountCtx,
  rowId: ItemId,
  col: string,
): Component {
  return createComponent((ctx) => {
    const host = el("div", "ui-table-cell");
    host.setAttribute("data-col", col);

    const slot = ctx.slot(host);

    const getCellId = () => findChildByLabel(mountCtx.core, rowId, col);

    ctx.effect(() => {
      const id = getCellId();
      if (!id) {
        slot.set({ el: el("div"), dispose: () => {} });
        return;
      }
      const focus: Focus = { container: rowId, item: id };
      const mounted = mountCtx.core.mountView({ id, focus });
      slot.set(mounted);
    });

    ctx.effect(() => {
      const id = getCellId();
      if (!id) return;
      const focus: Focus = { container: rowId, item: id };
      ctx.target(mountCtx.core, focus, DEFAULT_TARGET, () => host);
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

function mountRow(mountCtx: TableMountCtx, rowId: ItemId): Component {
  const { core, tableId, dispatch } = mountCtx;
  const focus: Focus = { container: tableId, item: rowId };

  return createComponent((ctx) => {
    const rowItem = el("div", "ui-item");

    ctx.target(core, focus, DEFAULT_TARGET, () => rowItem);

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

    ctx.effect(() => {
      core.selection();
      applyUiItemState(rowItem, { core, focus, view: "table", part: "row" });
    });

    ctx.on(rowItem, "pointerdown", (e: PointerEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest(".ui-table-cell"))
        return;
      const sel = core.selection();
      if (
        isRowSel(sel, tableId) &&
        sel.focus.item === rowId &&
        sel.target === DEFAULT_TARGET
      )
        return;
      const next = focusRowContainer(tableId, rowId, caretFromTarget(e.target));
      core.focus(next.focus, next.target, { caret: next.caret });
      e.stopPropagation();
    });

    return rowItem;
  });
}

function mountHeader(mountCtx: TableMountCtx): Component {
  return createComponent((ctx) => {
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

      for (let i = 0; i < desired.length; i++) {
        const next = desired[i]!;
        const cur = header.children.item(i);
        if (cur !== next) header.insertBefore(next, cur);
      }
      while (header.children.length > desired.length)
        header.lastElementChild?.remove();

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
  return createComponent((ctx) => {
    const body = el("div", "ui-table-body");

    const rows = ctx.list<ItemId>(body, (rid) => mountRow(mountCtx, rid));

    ctx.effect(() => {
      const snap = mountCtx.core.item(mountCtx.tableId);
      const c = snap.content;
      rows.update(c.kind === "group" ? [...c.children] : []);
    });

    return body;
  });
}

export function createTableView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id: tableId } = args;

  const comp = createComponent((ctx) => {
    const rootItem = el("div", "ui-item");
    ensureTabbable(rootItem);

    const columnsSignal = computed(() => deriveColumns(core, tableId));

    const dispatch = (intent: TableIntent): void => {
      const sel = core.selection();

      switch (intent.type) {
        case "NAV": {
          const res = tableNavMove(core, tableId, sel, intent.dir, intent.mode);
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

    const mountCtx: TableMountCtx = { core, tableId, columnsSignal, dispatch };

    const header = mountHeader(mountCtx);
    const body = mountBody(mountCtx);

    rootItem.replaceChildren(header.el, body.el);

    ctx.cleanup(() => header.dispose());
    ctx.cleanup(() => body.dispose());

    const tableFocus: Focus = args.focus ?? {
      container: tableId,
      item: tableId,
    };

    ctx.target(core, tableFocus, DEFAULT_TARGET, () => rootItem);

    ctx.effect(() => {
      core.selection();
      applyUiItemState(rootItem, { core, focus: tableFocus, view: "table" });
    });

    if (core.selection().kind === "idle") {
      const rows0 = childrenOf(core, tableId);
      if (rows0.length) {
        const firstRow = rows0[0]!;
        const res = focusRowContainer(tableId, firstRow);
        core.focus(res.focus, res.target, { caret: res.caret });
      }
    }

    return rootItem;
  });

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
      const sel = core.selection();
      const res = tableNavMove(core, tableId, sel, dir, mode);
      if (res) core.focus(res.focus, res.target, { caret: res.caret });
      return;
    }

    if (e.key === "Enter") {
      stopEvent(e);
      tableCommands.confirm(core, tableId, core.selection());
      return;
    }

    if (e.key === "Escape") {
      stopEvent(e);
      core.blur();
      return;
    }
  };

  return {
    id: `table:${String(tableId)}`,
    root: comp.el,
    onKeyDown,
    dispose() {
      comp.dispose();
    },
  };
}
