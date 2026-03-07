import type { Tx } from "./commit";
import type { Connected } from "./read";
import type { Item, ItemId, ValueOrBlank } from "./read";
import { CONTENT_TEXT_TARGET, LABEL_TARGET } from "./select";

const NUMERIC_VALUE_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type ReadCore = { item(id: ItemId): Item };
type EditCore = ReadCore & {
  commit(run: (t: Tx) => void): void;
  locate(
    id: ItemId,
  ): { parentId: ItemId; index: number; siblings: readonly ItemId[] } | null;
};

type ConnField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

export function isNumericLikeValue(value: ValueOrBlank): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (!NUMERIC_VALUE_RE.test(text)) return false;
  return Number.isFinite(Number(text));
}

export function fieldsFromConn(conn: Connected): ConnField[] {
  if (conn.type === "formula") {
    return [
      { key: "expr", label: "=", multiline: false, text: conn.expr ?? "" },
    ];
  }
  return [
    { key: "from", label: "~", multiline: false, text: conn.from ?? "" },
    { key: "where", label: "where:", multiline: false, text: conn.where ?? "" },
    {
      key: "orderBy",
      label: "orderBy:",
      multiline: false,
      text: conn.orderBy ?? "",
    },
  ];
}

export function getTextForTarget(
  core: ReadCore,
  id: ItemId,
  target: string,
): string {
  const snapshot = core.item(id);
  if (target === CONTENT_TEXT_TARGET) {
    return snapshot.content.type === "value"
      ? String(snapshot.content.value ?? "")
      : "";
  }
  if (target === LABEL_TARGET) return snapshot.label ?? "";
  if (!target.startsWith("conn:") || snapshot.mode.type !== "connected") {
    return "";
  }
  const key = target.slice("conn:".length);
  return (
    fieldsFromConn(snapshot.mode.conn).find((field) => field.key === key)
      ?.text ?? ""
  );
}

export function patchConn(
  conn: Connected,
  key: string,
  text: string,
): Connected {
  if (conn.type === "formula") {
    if (key !== "expr") return conn;
    return { type: "formula", expr: text };
  }
  if (key === "from") return { ...conn, from: text };
  if (key === "where") return { ...conn, where: text };
  if (key === "orderBy") return { ...conn, orderBy: text };
  return conn;
}

export function applyTypeToPrimaryTarget(
  core: EditCore,
  id: ItemId,
  char: string,
  target: string | null,
): { target: string; caret: number } | null {
  if (!target) return null;
  const caret = char.length;

  if (target === CONTENT_TEXT_TARGET) {
    core.commit((t) => t.setValue(id, char));
    return { target, caret };
  }
  return null;
}

export function indentItemInPlace(core: EditCore, id: ItemId): ItemId | null {
  const snapshot = core.item(id);
  if (snapshot.mode.type !== "plain") return null;
  if (snapshot.content.type === "issue") return null;

  const value =
    snapshot.content.type === "value" ? snapshot.content.value : null;
  const children =
    snapshot.content.type === "group" ? [...snapshot.content.children] : null;

  let childId: ItemId | null = null;
  core.commit((t) => {
    t.setGroup(id);
    childId = t.insertChild(id, { at: 0 });
    if (!children) {
      t.setValue(childId, value);
      return;
    }
    t.setGroup(childId);
    for (let i = 0; i < children.length; i += 1) {
      t.move(children[i]!, childId, { at: i });
    }
  });

  return childId;
}
