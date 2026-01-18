import { type ItemId, sel, ops, getRoot } from "./model";

export type Focus = {
  containerId: ItemId;
  id: ItemId;
};

export function rootContainer(): ItemId {
  return getRoot();
}

export function firstChildOf(containerId: ItemId): Focus | null {
  const kids = sel.groupItems(containerId);
  const first = kids[0];
  return first != null ? { containerId, id: first } : null;
}

export function siblingInContainer(focus: Focus, dir: -1 | 1): Focus | null {
  const kids = sel.groupItems(focus.containerId);
  const i = kids.indexOf(focus.id);
  if (i < 0) return null;

  const j = i + dir;
  if (j < 0 || j >= kids.length) return null;

  return { containerId: focus.containerId, id: kids[j]! };
}

export function enter(focus: Focus): Focus | null {
  const kids = sel.groupItems(focus.id);
  const first = kids[0];
  return first != null ? { containerId: focus.id, id: first } : null;
}

export function exit(focus: Focus): Focus | null {
  const containerItem = sel.item(focus.containerId);
  const ownerId = containerItem.ownerId;
  if (ownerId == null) return null;

  const ownerKids = sel.groupItems(ownerId);
  if (ownerKids.includes(focus.containerId))
    return { containerId: ownerId, id: focus.containerId };

  return { containerId: ownerId, id: focus.containerId };
}

export type NavLayoutContext = "default" | "table-cell" | "bar-child";

export function getLayoutContext(id: ItemId): NavLayoutContext {
  const it = sel.item(id);
  const parentId = it.ownerId ?? undefined;
  const grandId =
    parentId != null ? sel.item(parentId).ownerId ?? undefined : undefined;

  const parentView = parentId != null ? sel.item(parentId).view : "";
  const grandView = grandId != null ? sel.item(grandId).view : "";

  return grandView === "table"
    ? "table-cell"
    : parentView === "bar"
    ? "bar-child"
    : "default";
}

export type FieldSlot = "label" | "content" | "header";

export type EditableField = {
  slot: FieldSlot;
  key: string;
  label?: string;
  multiline?: boolean;
  live?: boolean;
  get(): string;
  set?: (next: string) => void;
};

export function getEditableFields(id: ItemId): EditableField[] {
  const info = sel.item(id);
  const fields: EditableField[] = [];

  fields.push({
    slot: "label",
    key: "label",
    multiline: false,
    live: false,
    get: () => sel.item(id).label ?? "",
    set: (next) => {
      try {
        ops.setLabel(id, next);
      } catch (err) {
        console.error(err);
      }
    },
  });

  if (info.contentKind === "derived") {
    fields.push({
      slot: "header",
      key: "derived.expr",
      label: "=",
      multiline: true,
      live: false,
      get: () => sel.item(id).derivedExpr ?? "",
      set: (next) => {
        try {
          ops.setDerivedExpr(id, next);
        } catch (err) {
          console.error(err);
        }
      },
    });
  } else if (info.contentKind === "lens") {
    fields.push(
      {
        slot: "header",
        key: "lens.from",
        label: "~",
        multiline: false,
        live: false,
        get: () => sel.item(id).lensSpec?.from ?? "",
        set: (next) => {
          const cur = sel.item(id).lensSpec;
          if (!cur) return;
          try {
            ops.setLensSpec(id, {
              from: next,
              where: cur.where,
              orderBy: cur.orderBy,
            });
          } catch (err) {
            console.error(err);
          }
        },
      },
      {
        slot: "header",
        key: "lens.where",
        label: "where:",
        multiline: true,
        live: false,
        get: () => sel.item(id).lensSpec?.where ?? "",
        set: (next) => {
          const cur = sel.item(id).lensSpec;
          if (!cur) return;
          try {
            ops.setLensSpec(id, {
              from: cur.from,
              where: next,
              orderBy: cur.orderBy,
            });
          } catch (err) {
            console.error(err);
          }
        },
      },
      {
        slot: "header",
        key: "lens.orderBy",
        label: "orderBy:",
        multiline: true,
        live: false,
        get: () => sel.item(id).lensSpec?.orderBy ?? "",
        set: (next) => {
          const cur = sel.item(id).lensSpec;
          if (!cur) return;
          try {
            ops.setLensSpec(id, {
              from: cur.from,
              where: cur.where,
              orderBy: next,
            });
          } catch (err) {
            console.error(err);
          }
        },
      }
    );
  }

  if (info.contentSettable) {
    fields.push({
      slot: "content",
      key: "content",
      multiline: true,
      live: true,
      get: () => {
        const v = sel.value(id);
        if (v.kind === "blank") return "";
        if (v.kind === "scalar") return String(v.value);
        if (v.kind === "issue") return v.message;
        return "";
      },
      set: (next) => {
        try {
          ops.setScalarText(id, next);
        } catch (err) {
          console.error(err);
        }
      },
    });
  }

  return fields;
}

function getContentField(id: ItemId): EditableField | null {
  return getEditableFields(id).find((f) => f.slot === "content") ?? null;
}

export type ItemUpdateKind = "text" | "text-get-only" | "group";

export function getItemUpdateKind(id: ItemId): ItemUpdateKind {
  const v = sel.value(id);
  if (v.kind === "item-group") return "group";
  return getContentField(id)?.set ? "text" : "text-get-only";
}

function isNavStop(_containerId: ItemId, id: ItemId): boolean {
  const kids = sel.groupItems(id);
  if (kids.length === 0) return true;
  return getEditableFields(id).some((f) => f.slot === "header");
}

function collectNavStopsFrom(rootContainerId: ItemId): Focus[] {
  const out: Focus[] = [];

  function walk(containerId: ItemId) {
    const kids = sel.groupItems(containerId);
    for (const id of kids) {
      if (isNavStop(containerId, id)) out.push({ containerId, id });
      walk(id);
    }
  }

  walk(rootContainerId);
  return out;
}

function focusKey(f: Focus): string {
  return `${String(f.containerId)}::${String(f.id)}`;
}

function neighborNavStop(from: Focus, dir: -1 | 1): Focus | null {
  const stops = collectNavStopsFrom(getRoot());
  const key = focusKey(from);

  const i = stops.findIndex((s) => focusKey(s) === key);
  if (i < 0) return null;

  const j = i + dir;
  return j >= 0 && j < stops.length ? stops[j]! : null;
}

function tableVerticalMove(from: Focus, dir: -1 | 1): Focus | null {
  const cellId = from.id;
  const cell = sel.item(cellId);
  const rowId = cell.ownerId;
  if (rowId == null) return null;

  const row = sel.item(rowId);
  const tableId = row.ownerId;
  if (tableId == null) return null;

  const colLabel = cell.label;
  if (!colLabel) return null;

  const rows = sel.groupItems(tableId);
  const rowIdx = rows.indexOf(rowId);
  if (rowIdx < 0) return null;

  const nextRowId = rows[rowIdx + dir];
  if (nextRowId == null) return null;

  const nextRowKids = sel.groupItems(nextRowId);
  const targetCell = nextRowKids.find(
    (cid) => sel.item(cid).label === colLabel
  );
  if (!targetCell) return null;

  return { containerId: nextRowId, id: targetCell };
}

export function standardMove(
  focus: Focus,
  dir: "left" | "right" | "up" | "down",
  mod: boolean
): Focus | null {
  const kind = getItemUpdateKind(focus.id);
  const viewContext = getLayoutContext(focus.id);

  if (dir === "left" || dir === "right") {
    const sign: -1 | 1 = dir === "left" ? -1 : 1;

    if (mod && (viewContext === "table-cell" || viewContext === "bar-child")) {
      if (sign === -1) {
        return siblingInContainer(focus, -1) ?? exit(focus);
      }
      return siblingInContainer(focus, 1);
    }

    if (sign === -1 && (kind === "group" || mod)) {
      return exit(focus);
    }

    if (sign === 1) {
      const into = enter(focus);
      if (into) return into;
      if (mod) return null;
    }

    return neighborNavStop(focus, sign);
  }

  const sign: -1 | 1 = dir === "up" ? -1 : 1;

  if (viewContext === "table-cell") {
    const next = tableVerticalMove(focus, sign);
    if (mod || next) return next ?? null;
    return neighborNavStop(focus, sign);
  }

  if (viewContext === "bar-child") {
    return mod ? null : neighborNavStop(focus, sign);
  }

  if (mod || kind === "group") {
    return siblingInContainer(focus, sign);
  }

  return neighborNavStop(focus, sign);
}

export type UpdateResult = { focus: Focus; caret?: number };

function focusInSameContainer(
  containerId: ItemId,
  id: ItemId | undefined
): Focus {
  if (id == null) {
    const first = firstChildOf(containerId);
    return first ?? { containerId, id: containerId };
  }
  return { containerId, id };
}

function safeUpdate(
  fn: () => UpdateResult,
  fallback: UpdateResult
): UpdateResult {
  try {
    return fn();
  } catch (err) {
    console.error(err);
    return fallback;
  }
}

export function updateItemText(focus: Focus, raw: string): UpdateResult {
  return safeUpdate(
    () => {
      const content = getContentField(focus.id);
      if (!content?.set) return { focus };
      content.set(raw);
      return { focus };
    },
    { focus }
  );
}

export function setItemAsDerived(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      ops.setDerivedExpr(focus.id, "");
      return { focus, caret: 0 };
    },
    { focus, caret: 0 }
  );
}

export function addItemBefore(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.insertBlankBefore(focus.id);
      if (!res) return { focus };
      return { focus: focusInSameContainer(focus.containerId, res.id) };
    },
    { focus }
  );
}

export function addItemAfter(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.insertBlankAfter(focus.id);
      if (!res) return { focus };
      return { focus: focusInSameContainer(focus.containerId, res.id) };
    },
    { focus }
  );
}

function removeAndChooseFocus(
  focus: Focus,
  prefer: "prev" | "next"
): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.removeFromOwner(focus.id);
      if (!res) return { focus };

      const nextId =
        prefer === "prev"
          ? res.prevId ?? res.nextId ?? res.ownerId
          : res.nextId ?? res.prevId ?? res.ownerId;

      const containerKids = sel.groupItems(focus.containerId);
      if (containerKids.includes(nextId)) {
        return { focus: { containerId: focus.containerId, id: nextId } };
      }

      return { focus: focusInSameContainer(res.ownerId, nextId) };
    },
    { focus }
  );
}

export function removeItemBackward(focus: Focus): UpdateResult {
  return removeAndChooseFocus(focus, "prev");
}

export function removeItemForward(focus: Focus): UpdateResult {
  return removeAndChooseFocus(focus, "next");
}

export function wrapInGroup(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.wrapChildInNewGroup(focus.id);
      if (!res) return { focus };

      const next: Focus = { containerId: res.wrapperId, id: res.childId };
      return { focus: next };
    },
    { focus }
  );
}

export function unwrapGroup(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.unwrapIfSingleChild(focus.id);
      if (!res) return { focus };

      const containerKids = sel.groupItems(focus.containerId);
      if (containerKids.includes(focus.id)) return { focus };

      return { focus: { containerId: res.ownerId, id: res.childId } };
    },
    { focus }
  );
}

export function splitItemAt(
  focus: Focus,
  caretStart: number,
  caretEnd: number = caretStart
): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.splitTextItem(focus.id, caretStart, caretEnd);
      if (!res) return { focus };

      return {
        focus: { containerId: focus.containerId, id: res.rightId },
        caret: res.caretInRight,
      };
    },
    { focus }
  );
}

export function joinWithBefore(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.joinWithPrevious(focus.id);
      if (!res) return { focus };

      return {
        focus: { containerId: focus.containerId, id: res.keptId },
        caret: res.caret,
      };
    },
    { focus }
  );
}

export function joinWithAfter(focus: Focus): UpdateResult {
  return safeUpdate(
    () => {
      const res = ops.joinWithNext(focus.id);
      if (!res) return { focus };

      return {
        focus: { containerId: focus.containerId, id: res.keptId },
        caret: res.caret,
      };
    },
    { focus }
  );
}
