import { effect } from "@preact/signals-core";

import type { ItemId, SnapshotData, Value } from "./core";
import { DEV, devAssert, devWarn } from "./dev";
import type { App } from "./setup";
import { createApp } from "./setup";

const STORAGE_KEY = "base:snapshot";

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

  const mkGroup = (parentId: ItemId, label: string): ItemId => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setGroup(id);
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

  mkValue(rootId, "", "hello");
  mkValue(rootId, "", "world");
  const table = mkGroup(rootId, "table");
  const row1 = mkGroup(table, "r1");
  mkValue(row1, "item", "Apples");
  mkValue(row1, "qty", 3);
  const row2 = mkGroup(table, "r2");
  mkValue(row2, "item", "Oranges");
  mkValue(row2, "qty", 5);
  core.commit((t) => t.setView(table, "table"));

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
  const { core } = app;

  let restored = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      core.importSnapshot(JSON.parse(raw) as SnapshotData);
      restored = true;
    }
  } catch (e) {
    devWarn("Session restore failed, starting fresh:", e);
    localStorage.removeItem(STORAGE_KEY);
  }

  if (!restored && DEV) {
    try {
      seedDemo(app);
    } catch (e) {
      devWarn("seedDemo failed:", e);
    }
  }

  let lastSaved = "";
  effect(() => {
    const serialized = JSON.stringify(core.exportSnapshot());
    if (serialized === lastSaved) return;
    try {
      localStorage.setItem(STORAGE_KEY, serialized);
      lastSaved = serialized;
    } catch (e) {
      devWarn("Autosave failed:", e);
    }
  });
}

autoMount();
