import type { Core, ItemId, Value, ViewName } from "./core";
import { createCore } from "./core";
import { buildDebugPanel, createDebugState, instrumentCore } from "./debug";
import { DEV, devAssert, devWarn } from "./dev";
import { bindItemFrame, createComponent, el } from "./dom";
import { viewRegistrations } from "./views";

type App = {
  core: Core;
  rootId: ItemId;
  dispose(): void;
};

type CreateAppOpts = {
  host?: HTMLElement;
  rootView?: ViewName;
  demo?: boolean;
};

function createApp(opts: CreateAppOpts = {}): App {
  const rootView = opts.rootView ?? "outline";
  const demo = opts.demo ?? DEV;

  const hostEl =
    opts.host ??
    (typeof document !== "undefined"
      ? (document.getElementById("root") as HTMLElement | null)
      : null);

  devAssert(hostEl, "Missing app root element (#root)");

  const { core: rawCore, rootId } = createCore({ views: viewRegistrations });

  const debug = createDebugState();
  const core = instrumentCore(rawCore, debug);

  core.commit((t) => {
    t.setView(rootId, rootView);
  });

  const focus = { container: rootId, item: rootId };

  const appRoot = createComponent(core, (ctx) => {
    const rootFrame = el("div");
    rootFrame.classList.add("ui-main");
    rootFrame.tabIndex = 0;

    bindItemFrame(ctx, { core, focus }, rootFrame);

    ctx.slot(rootFrame, () => {
      const wanted = core.view(rootId);
      return core.mountView({ id: rootId, focus, view: wanted });
    });

    return rootFrame;
  });

  const root = el("div", "ui-root");
  const main = appRoot.el;

  main.addEventListener(
    "pointerdown",
    (event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
        return;
      main.focus();
    },
    { capture: true },
  );

  root.append(main);

  let debugPanel: { el: HTMLElement; dispose(): void } | null = null;

  if (DEV) {
    debugPanel = buildDebugPanel({
      core,
      debug,
      probeRoot: main,
      className: "ui-debug",
    });
    root.append(debugPanel.el);
  }

  hostEl.replaceChildren(root);
  main.focus();

  const app: App = {
    core,
    rootId,
    dispose() {
      debugPanel?.dispose();
      appRoot.dispose();
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

function seedDemo(app: App): void {
  const { core, rootId } = app;

  const mkGroup = (
    parentId: ItemId,
    label: string,
    view: ViewName | null = null,
  ): ItemId => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setGroup(id);
      t.setLabel(id, label);
      if (view != null) t.setView(id, view);
    });
    return id;
  };

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

  const demo = mkGroup(rootId, "Demo", "outline");

  mkValue(demo, "x", 10);
  mkValue(demo, "y", 2);
  const table = mkGroup(demo, "Table demo", "table");
  const row1 = mkGroup(table, "r1");
  mkValue(row1, "item", "Apples");
  mkValue(row1, "qty", 3);
  const row2 = mkGroup(table, "r2");
  mkValue(row2, "item", "Oranges");
  mkValue(row2, "qty", 5);

  void mkFormula;
  void mkQuery;
}

function autoMount(): void {
  if (typeof document === "undefined") return;
  if (typeof window === "undefined") return;

  const globalMountState = globalThis as { __APP_MOUNTED__?: boolean };
  if (globalMountState.__APP_MOUNTED__) return;
  globalMountState.__APP_MOUNTED__ = true;

  createApp({ demo: true, rootView: "outline" });
}

autoMount();
