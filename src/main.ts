import { DEV, devAssert, devWarn } from "./dev";
import {
  type ItemId,
  type ViewKind,
  type ViewName,
  createCore,
  type Source,
} from "./core";
import { createView } from "./views";

export type App = {
  core: ReturnType<typeof createCore>["core"];
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

  const { core, rootId } = createCore();

  core.commit((t) => {
    t.setView(rootId, rootView as ViewKind);
  });

  const view = createView(core, rootView, rootId, {
    scopeId: rootId,
    id: rootId,
  });
  devAssert(view, `No view factory for rootView='${rootView}'`);

  const unmountRoot = core.mountViewRoot({
    root: view.root,
    onKeyDown: view.onKeyDown,
  });

  hostEl.replaceChildren(view.root);

  const app: App = {
    core,
    rootId,
    dispose() {
      unmountRoot();
      view.dispose();
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

export function seedDemo(app: App) {
  const { core, rootId } = app;

  if (core.findChild(rootId, "Demo") != null) return;

  const mkGroup = (owner: ItemId, label: string, view: ViewKind = null) => {
    let gid: ItemId = -1;
    core.commit((t) => {
      gid = t.insert(owner, { kind: "group" });
      t.setLabel(gid, label);
      if (view != null) t.setView(gid, view);
    });
    return gid;
  };

  const mkScalar = (
    owner: ItemId,
    label: string,
    value: true | number | string,
  ) => {
    let cid: ItemId = -1;
    core.commit((t) => {
      cid = t.insert(owner, { kind: "blank" });
      t.setLabel(cid, label);
      t.setScalar(cid, value);
    });
    return cid;
  };

  const mkSource = (owner: ItemId, label: string, source: Source) => {
    let cid: ItemId = -1;
    core.commit((t) => {
      cid = t.insert(owner, { kind: "blank" });
      t.setLabel(cid, label);
      t.setSource(cid, source);
    });
    return cid;
  };

  const demo = mkGroup(rootId, "Demo", "outline");

  mkScalar(demo, "x", 10);
  mkScalar(demo, "y", 2);
  mkSource(demo, "x_plus_y", { kind: "derived", expr: "x + y" });
  mkSource(demo, "x_times_y", { kind: "derived", expr: "x * y" });

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

  mkSource(demo, "Table", {
    kind: "lens",
    from: "rows",
    where: "",
    orderBy: "",
  });
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
