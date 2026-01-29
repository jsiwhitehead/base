import { DEV, devAssert, devWarn } from "./dev";
import { type ItemId, type ViewKind, type ViewName, createCore } from "./core";
import { createModel } from "./core/model";
import { EditorRuntime } from "./core/runtime";
import { createDomHost } from "./ui/host";
import { createView } from "./views";

export type App = {
  core: ReturnType<typeof createCore>;
  host: ReturnType<typeof createDomHost>;
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

  const model = createModel();
  const rootId = model.createId();
  model.setRoot(rootId);
  model.apply(
    model.op.transaction([model.op.create(model.createItem.group(rootId))]),
  );

  const runtime = new EditorRuntime({ kind: "idle" });
  const core = createCore({ model, runtime });
  const host = createDomHost({ runtime });

  core.commit((t) => {
    t.setView(rootId, rootView as ViewKind);
  });

  const view = createView({ core, host }, rootView, rootId, {
    scopeId: rootId,
    id: rootId,
  });
  devAssert(view, `No view factory for rootView='${rootView}'`);

  const uninstallListeners = host.installGlobalListeners(window);
  const unmount = host.mountViewInto(hostEl!, view);

  const app: App = {
    core,
    host,
    rootId,
    dispose() {
      uninstallListeners();
      unmount();
      host.dispose();
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

  const mkDerived = (owner: ItemId, label: string, expr: string) => {
    let cid: ItemId = -1;
    core.commit((t) => {
      cid = t.insert(owner, { kind: "blank" });
      t.setLabel(cid, label);
      t.setDerived(cid, expr);
    });
    return cid;
  };

  const mkLens = (
    owner: ItemId,
    label: string,
    spec: { from: string; where?: string; orderBy?: string },
  ) => {
    let cid: ItemId = -1;
    core.commit((t) => {
      cid = t.insert(owner, { kind: "blank" });
      t.setLabel(cid, label);
      t.setLens(cid, spec);
    });
    return cid;
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

  mkLens(demo, "Table", { from: "rows" });
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
