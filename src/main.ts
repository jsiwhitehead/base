import type { ItemId, Value } from "./core";
import { DEV, devAssert, devWarn } from "./dev";
import type { App } from "./setup";
import { createApp } from "./setup";

function seedDemo(app: App): void {
  const { core, rootId } = app;

  const mkValue = (parentId: ItemId, label: string, value: Value): ItemId => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setValue(id, value);
    });
    return id;
  };

  const mkFormula = (parentId: ItemId, label: string, expr: string): ItemId => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setConnected(id, { type: "formula", expr });
    });
    return id;
  };

  const mkQuery = (
    parentId: ItemId,
    label: string,
    spec: { from: string; where?: string; orderBy?: string },
  ): ItemId => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setConnected(id, {
        type: "query",
        from: spec.from,
        where: spec.where ?? "",
        orderBy: spec.orderBy ?? "",
      });
    });
    return id;
  };

  // mkValue(rootId, "x", 10);
  // mkValue(rootId, "y", 2);
  mkValue(rootId, "", "hello");
  mkValue(rootId, "", "world");
  // const table = mkGroup(rootId, "table");
  // const row1 = mkGroup(table, "r1");
  // mkValue(row1, "item", "Apples");
  // mkValue(row1, "qty", 3);
  // const row2 = mkGroup(table, "r2");
  // mkValue(row2, "item", "Oranges");
  // mkValue(row2, "qty", 5);
  // core.commit((t) => t.setView(table, "table"));

  void mkFormula;
  void mkQuery;
}

function autoMount(): void {
  if (typeof document === "undefined") return;
  if (typeof window === "undefined") return;

  const globalMountState = globalThis as { __APP_MOUNTED__?: boolean };
  if (globalMountState.__APP_MOUNTED__) return;
  globalMountState.__APP_MOUNTED__ = true;

  const host = document.getElementById("root") as HTMLElement | null;
  devAssert(host, "Missing app root element (#root)");

  const app = createApp({ host, rootView: "outline" });

  if (DEV) {
    try {
      seedDemo(app);
    } catch (e) {
      devWarn("seedDemo failed:", e);
    }
  }
}

autoMount();
