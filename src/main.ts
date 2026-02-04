import { DEV, devAssert, devWarn } from "./dev";
import type { Core, ItemId, ViewKind, ViewName, Scalar } from "./core";
import { createCore } from "./core";
import { viewFactories } from "./views";

export type App = {
  core: Core;
  rootId: ItemId;
  dispose(): void;
};

export type CreateAppOpts = {
  host?: HTMLElement;
  rootView?: ViewName;
  demo?: boolean;
};

export function createApp(opts: CreateAppOpts = {}): App {
  const rootView = opts.rootView ?? "outline";
  const demo = opts.demo ?? DEV;

  const hostEl =
    opts.host ??
    (typeof document !== "undefined"
      ? (document.getElementById("root") as HTMLElement | null)
      : null);

  devAssert(hostEl, "Missing app root element (#root)");

  const { core, rootId } = createCore({ views: viewFactories });

  core.commit((t) => {
    t.setView(rootId, rootView as ViewKind);
  });

  const rootComp = core.mountView({ id: rootId });
  hostEl.replaceChildren(rootComp.el);

  const app: App = {
    core,
    rootId,
    dispose() {
      rootComp.dispose();
      hostEl.replaceChildren();
      core.dispose();
    },
  };

  if (demo) {
    try {
      seedDemo(app);
    } catch (e) {
      devWarn("seedDemo failed:", e);
    }
  }

  return app;
}

function findChildByLabel(
  core: App["core"],
  ownerId: ItemId,
  label: string,
): ItemId | null {
  const want = label.trim();
  if (!want) return null;

  const snap = core.item(ownerId);
  if (snap.content.kind !== "group") return null;

  for (const childId of snap.content.children) {
    const c = core.item(childId);
    if ((c.label ?? "").trim() === want) return childId;
  }

  return null;
}

export function seedDemo(app: App) {
  const { core, rootId } = app;

  if (findChildByLabel(core, rootId, "Demo")) return;

  const mkGroup = (ownerId: ItemId, label: string, view: ViewKind = null) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(ownerId, { kind: "group" });
      t.setLabel(id, label);
      if (view != null) t.setView(id, view);
    });
    return id;
  };

  const mkScalar = (ownerId: ItemId, label: string, value: Scalar) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(ownerId, { kind: "blank" });
      t.setLabel(id, label);
      t.setScalar(id, value);
    });
    return id;
  };

  const mkDerived = (ownerId: ItemId, label: string, expr: string) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(ownerId, { kind: "blank" });
      t.setLabel(id, label);
      t.setSource(id, { type: "derived", expr });
    });
    return id;
  };

  const mkLens = (
    ownerId: ItemId,
    label: string,
    spec: { from: string; where?: string; orderBy?: string },
  ) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(ownerId, { kind: "blank" });
      t.setLabel(id, label);
      t.setSource(id, {
        type: "lens",
        from: spec.from,
        where: spec.where ?? "",
        orderBy: spec.orderBy ?? "",
      });
    });
    return id;
  };

  const demo = mkGroup(rootId, "Demo", "outline");

  mkScalar(demo, "x", 10);
  mkScalar(demo, "y", 2);
  mkDerived(demo, "x_plus_y", "x + y");
  mkDerived(demo, "x_times_y", "x * y");

  const rows = mkGroup(demo, "rows", "table");

  const mkRow = (label: string, score: number, note: string) => {
    const row = mkGroup(rows, label);
    mkScalar(row, "score", score);
    mkScalar(row, "note", note);
    return row;
  };

  mkRow("a", 2, "ok");
  mkRow("b", 1, "low");
  mkRow("c", 3, "high");

  mkLens(demo, "Table", { from: "rows", where: "", orderBy: "" });
}

function autoMount(): void {
  if (typeof document === "undefined") return;
  if (typeof window === "undefined") return;

  const g = globalThis as { __APP_MOUNTED__?: boolean };
  if (g.__APP_MOUNTED__) return;
  g.__APP_MOUNTED__ = true;

  createApp({ demo: true, rootView: "outline" });
}

autoMount();
