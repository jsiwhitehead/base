import { computed } from "@preact/signals-core";
import {
  type Core,
  type ItemId,
  type Component,
  type Caret,
  type Focus,
  type Selection,
  type DomView,
  type Source,
  parseScalar,
  DEFAULT_TARGET,
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
  autosizeTextField,
  scalarField,
  ensureTabbable,
  applyUiItemState,
  type FocusScope,
  setData,
  on,
} from "../dom";

type NavResult = {
  focus: Focus;
  target: string;
  caret?: Caret;
};

type SourceField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

const caret0 = (): Caret => ({ start: 0, end: 0 });
const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

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

export const tableCommands = {
  setLabel(core: Core, rowId: ItemId, text: string): void {
    core.commit((t) => t.setLabel(rowId, text));
  },

  setText(core: Core, cellId: ItemId, raw: string): void {
    core.commit((t) => t.setScalar(cellId, parseScalar(raw)));
  },

  setSource(core: Core, cellId: ItemId, next: Source): void {
    core.commit((t) => t.setSource(cellId, next));
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
  columnsSignal: { value: string[] };
  dispatch: (intent: TableIntent) => void;
};

function mountCellMeta(args: {
  core: Core;
  cellId: ItemId;
  focus: Focus;
  scope: FocusScope;
  dispatch: (intent: TableIntent) => void;
}): Component {
  const { core, cellId, focus, scope } = args;

  return createComponent((ctx) => {
    const meta = el("div", "ui-meta");
    const labelWrap = el("div", "ui-label");
    const sourceWrap = el("div", "ui-source");
    meta.append(labelWrap, sourceWrap);

    const toContent = () =>
      core.focus(focus, DEFAULT_TARGET, { caret: caret0() });

    const canEditLabel = core.item(cellId).mode.kind !== "readonly";

    const commitLabel = (text: string) => {
      if (!canEditLabel) return;
      const cur = core.item(cellId).label ?? "";
      if (cur === text) return;
      core.commit((t) => t.setLabel(cellId, text));
    };

    const labelComp = autosizeTextField({
      commit: commitLabel,
      getState: () => {
        const snap = core.item(cellId);
        return {
          text: snap.label ?? "",
          readOnly: !canEditLabel,
          isIssue: false,
        };
      },
      onCommitEvents: ["blur"],
      wrapClassName: "autosize",
      target: "label",
      textKeys: (inp) => {
        const inputEl = inp as HTMLInputElement;
        const handler = (e: KeyboardEvent) => {
          if (e.key === " ") {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            if (e.key === "Enter") commitLabel(inputEl.value);
            toContent();
          }
        };
        return on(inputEl, "keydown", handler);
      },
    });

    labelWrap.replaceChildren(labelComp.el);
    ctx.use(labelComp);

    scope.elementFor("label", () => labelComp.focusEl);
    scope.selectOn(labelComp.focusEl, { target: "label", caret: "fromTarget" });

    const fieldEls: HTMLElement[] = [];

    const mountFields = (fields: readonly SourceField[]) => {
      sourceWrap.replaceChildren();
      fieldEls.length = 0;

      for (const f of fields) {
        const row = el("div", "ui-source-field");
        const fieldLabel = el("div", "ui-source-key", f.label);
        const fieldValue = el("div", "ui-source-val");
        row.append(fieldLabel, fieldValue);
        sourceWrap.append(row);
        fieldEls.push(row);

        const commitField = (text: string) => {
          const it = core.item(cellId);
          if (it.mode.kind !== "source") return;
          const next = patchSource(it.mode.source, f.key, text);
          tableCommands.setSource(core, cellId, next);
        };

        const tkey = `source:${f.key}`;

        const fc = textField({
          multiline: f.multiline,
          commit: commitField,
          getState: () => {
            const snap = core.item(cellId);
            if (snap.mode.kind !== "source")
              return { text: "", readOnly: true, isIssue: false };
            const text =
              fieldsFromSource(snap.mode.source).find((x) => x.key === f.key)
                ?.text ?? "";
            return { text, readOnly: false, isIssue: false };
          },
          onCommitEvents: ["blur"],
          target: tkey,
          textKeys: (inp) =>
            bindTextControlKeys(inp, {
              nav: { yieldUpDown: "always", yieldLeftRight: "always" },
              onNav: (dir) => {
                if (dir === "left" || dir === "right")
                  args.dispatch({ type: "NAV", dir, mode: "step" });
              },
              onEnter: () => commitField((inp as any).value),
              onEscape: () => toContent(),
            }),
        });

        fieldValue.replaceChildren(fc.el);
        ctx.use(fc);

        scope.elementFor(tkey, () => fc.focusEl);
        scope.selectOn(fc.focusEl, { target: tkey, caret: "fromTarget" });
      }
    };

    ctx.watch(
      () => {
        const snap = core.item(cellId);
        const label = (snap.label ?? "").trim();
        const fields =
          snap.mode.kind === "source" ? fieldsFromSource(snap.mode.source) : [];
        const sel = core.selection();
        const labelFocused =
          sel.kind === "focused" &&
          sel.focus.item === focus.item &&
          sel.focus.container === focus.container &&
          sel.target === "label";

        const needMeta = label !== "" || fields.length > 0 || labelFocused;

        return { needMeta, fields };
      },
      ({ needMeta, fields }) => {
        if (!needMeta) {
          meta.replaceChildren();
          meta.append(labelWrap, sourceWrap);
          sourceWrap.replaceChildren();
          return;
        }
        if (!meta.contains(labelWrap)) meta.append(labelWrap);
        if (!meta.contains(sourceWrap)) meta.append(sourceWrap);
        mountFields(fields);
      },
    );

    return meta;
  });
}

function mountTableCellItem(
  mountCtx: TableMountCtx,
  rowId: ItemId,
  cellId: ItemId,
): Component {
  const { core, dispatch } = mountCtx;

  return createComponent((ctx) => {
    const focus: Focus = { container: rowId, item: cellId };

    const root = el("div", "ui-item");
    const metaHost = el("div");
    const bodyHost = el("div");
    root.append(metaHost, bodyHost);

    const metaSlot = ctx.slot(metaHost);
    const bodySlot = ctx.slot(bodyHost);

    let surface: HTMLElement | null = bodyHost;

    const scope = ctx.focus(core, focus, {
      default: () => surface ?? bodyHost,
    });
    scope.elementFor(DEFAULT_TARGET, () => surface);
    scope.selectOn(root, { target: DEFAULT_TARGET, caret: "zero" });

    const body = scalarField({
      core,
      id: cellId,
      target: DEFAULT_TARGET,
      multiline: true,
      commitText: (text) => tableCommands.setText(core, cellId, text),
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => dispatch({ type: "NAV", dir, mode }),
          onEnter: () => dispatch({ type: "CONFIRM" }),
          onEscape: () => dispatch({ type: "CANCEL" }),
        }),
    });

    surface = body.focusEl;

    scope.selectOn(body.focusEl as HTMLElement, {
      target: DEFAULT_TARGET,
      caret: "fromTarget",
    });

    bodySlot.set(body);
    ctx.use(body);

    ctx.watch(
      () => core.selection(),
      () => {
        applyUiItemState(root, { core, focus, view: "table", part: "cell" });
      },
    );

    ctx.watch(
      () => {
        const snap = core.item(cellId);
        const label = (snap.label ?? "").trim();
        const fields =
          snap.mode.kind === "source" ? fieldsFromSource(snap.mode.source) : [];
        const sel = core.selection();
        const labelFocused =
          sel.kind === "focused" &&
          sel.focus.item === focus.item &&
          sel.focus.container === focus.container &&
          sel.target === "label";

        const needMeta = label !== "" || fields.length > 0 || labelFocused;
        return { needMeta, fields };
      },
      ({ needMeta }) => {
        if (!needMeta) {
          metaSlot.set(null);
          metaHost.replaceChildren();
          metaHost.className = "";
          return;
        }
        metaSlot.set(mountCellMeta({ core, cellId, focus, scope, dispatch }));
        metaHost.className = "ui-meta-host";
      },
    );

    return root;
  });
}

function mountCellHost(
  mountCtx: TableMountCtx,
  rowId: ItemId,
  col: string,
): Component {
  return createComponent((ctx) => {
    const host = el("div", "ui-td");
    (host as HTMLElement).setAttribute("data-col", col);

    const slot = ctx.slot(host);

    let cur: Component | null = null;
    let curId: ItemId | null = null;

    const setCur = (next: Component | null, id: ItemId | null) => {
      if (cur === next && curId === id) return;
      cur?.dispose();
      cur = next;
      curId = id;
      slot.set(next);
    };

    const getCellId = () => findChildByLabel(mountCtx.core, rowId, col);

    ctx.watch(
      () => getCellId(),
      (id) => {
        if (!id) {
          setCur({ el: el("div", "ui-missing", ""), dispose: () => {} }, null);
          return;
        }

        const focus: Focus = { container: rowId, item: id };
        const mounted = mountCtx.core.mountView({
          id,
          focus,
          continueAs: "table",
        });

        if (mounted) {
          setCur(mounted, id);
          return;
        }

        setCur(mountTableCellItem(mountCtx, rowId, id), id);
      },
    );

    ctx.on(host, "pointerdown", (e: PointerEvent) => {
      const nextCell = getCellId();
      const res = nextCell
        ? focusCell(rowId, nextCell, caretFromTarget(e.target))
        : focusRowLabel(mountCtx.tableId, rowId, caretFromTarget(e.target));
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
    const rowWrap = el("div", "ui-tr");

    const rowItem = el("div", "ui-item");
    rowWrap.append(rowItem);

    const labelTd = el("div", "ui-td ui-td-label");
    const cellsWrap = el("div", "ui-tr-cells");
    rowItem.append(labelTd, cellsWrap);

    const labelComp = textField({
      multiline: false,
      commit: (text) => tableCommands.setLabel(core, rowId, text),
      getState: () => {
        const sel = core.selection();
        const editing =
          isRowLabelSelection(sel, tableId) && sel.focus.item === rowId;

        const row = core.item(rowId);
        const canEdit = row.mode.kind !== "readonly";

        const text = row.label ?? "";
        const readOnly = !editing || !canEdit;
        return { text, readOnly, isIssue: false };
      },
      onCommitEvents: ["blur"],
      target: "label",
      textKeys: (inp) =>
        bindTextControlKeys(inp, {
          nav: defaultTextNav,
          onNav: (dir, mode) => dispatch({ type: "NAV", dir, mode }),
          onEnter: () => {
            const first = mountCtx.columnsSignal.value[0];
            if (!first) return;

            const cell = findChildByLabel(core, rowId, first);
            if (!cell) return;

            const res = focusCell(rowId, cell);
            core.focus(res.focus, res.target, { caret: res.caret });
          },
          onEscape: () => dispatch({ type: "CANCEL" }),
        }),
    });

    const scope = ctx.focus(core, focus, { default: () => labelComp.focusEl });
    scope.elementFor("label", () => labelComp.focusEl);
    scope.selectOn(labelComp.focusEl, { target: "label", caret: "fromTarget" });
    scope.selectOn(rowItem, { target: "label", caret: "fromTarget" });

    labelTd.replaceChildren(labelComp.el);
    ctx.use(labelComp);

    const cellList = ctx.list(cellsWrap, (colName: string) =>
      mountCellHost(mountCtx, rowId, colName),
    );

    ctx.watch(
      () => core.selection(),
      () => {
        applyUiItemState(rowItem, { core, focus, view: "table", part: "row" });
      },
    );

    ctx.watch(
      () => mountCtx.columnsSignal.value,
      (cols) => {
        cellList.update(cols);
      },
    );

    ctx.on(rowItem, "pointerdown", (e: PointerEvent) => {
      const sel = core.selection();
      if (isRowLabelSelection(sel, tableId) && sel.focus.item === rowId) return;
      const next = focusRowLabel(tableId, rowId, caretFromTarget(e.target));
      core.focus(next.focus, next.target, { caret: next.caret });
      e.stopPropagation();
    });

    return rowWrap;
  });
}

function mountHeader(mountCtx: TableMountCtx): Component {
  return createComponent((ctx) => {
    const header = el("div", "ui-table-header");

    const labelTd = el("div", "ui-td ui-td-label");
    header.append(labelTd);

    const columnEls = new Map<string, HTMLElement>();

    const reconcile = (cols: readonly string[]) => {
      const desired: HTMLElement[] = [labelTd];

      for (const col of cols) {
        let cell = columnEls.get(col);
        if (!cell) {
          cell = el("div", "ui-td ui-col", col);
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

    ctx.watch(
      () => mountCtx.columnsSignal.value,
      (cols) => reconcile(cols),
    );

    return header;
  });
}

function mountBody(mountCtx: TableMountCtx): Component {
  return createComponent((ctx) => {
    const body = el("div", "ui-table-body");

    const rows = ctx.list(body, (rowId: string) => mountRow(mountCtx, rowId));

    ctx.watch(
      () => {
        const snap = mountCtx.core.item(mountCtx.tableId);
        const c = snap.content;
        return c.kind === "group" ? [...c.children] : [];
      },
      (ids) => rows.update(ids),
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

  const rootItem = el("div", "ui-item ui-table-root");
  ensureTabbable(rootItem);

  const headerHost = el("div");
  const bodyHost = el("div");
  rootItem.append(headerHost, bodyHost);

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

  const tableFocus: Focus = args.focus ?? { container: tableId, item: tableId };

  applyUiItemState(rootItem, {
    core,
    focus: tableFocus,
    view: "table",
    part: "table",
  });

  if (core.selection().kind === "idle") {
    const rows0 = childrenOf(core, tableId);
    if (rows0.length) {
      const firstRow = rows0[0]!;
      const res = focusRowLabel(tableId, firstRow);
      core.focus(res.focus, res.target, { caret: res.caret });
    }
  }

  return {
    id: `table:${String(tableId)}`,
    root: rootItem,
    onKeyDown,
    dispose() {
      header.dispose();
      body.dispose();
      rootItem.replaceChildren();
    },
  };
}
