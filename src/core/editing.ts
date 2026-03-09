import type { Tx } from "./commit";
import type { Connected } from "./read";
import type { Item, ItemId, ValueOrBlank } from "./read";
import { connTarget } from "./select";

const NUMERIC_VALUE_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

type EditCore = {
  item(id: ItemId): Item;
  commit(run: (t: Tx) => void): void;
  locate(
    id: ItemId,
  ): { parentId: ItemId; index: number; siblings: readonly ItemId[] } | null;
};

export function isNumericLikeValue(value: ValueOrBlank): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text) return false;
  if (!NUMERIC_VALUE_RE.test(text)) return false;
  return Number.isFinite(Number(text));
}

export function primaryHeaderTargetForConn(conn: Connected): string | null {
  if (conn.type === "formula") return connTarget("expr");
  if (conn.type === "query") return connTarget("from");
  return null;
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
