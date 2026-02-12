import type { Core, ItemId, Value, ViewKind, ViewName } from "./core";
import { createCore } from "./core";
import { createDebugPanel, createDebugState, instrumentCore } from "./debug";
import { DEV, devAssert, devWarn } from "./dev";
import { bindUiItemShell, createComponent, el } from "./dom";
import { viewFactories } from "./views";

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

  const { core: rawCore, rootId } = createCore({ views: viewFactories });

  const debug = createDebugState();
  const core = instrumentCore(rawCore, debug);

  core.commit((t) => {
    t.setView(rootId, rootView as ViewKind);
  });

  const focus = { container: rootId, item: rootId };

  const appRoot = createComponent(core, (ctx) => {
    const rootShell = el("div", "ui-app");

    bindUiItemShell(ctx, { core, focus }, rootShell);

    ctx.slot(rootShell, () => {
      const wanted = core.view(rootId);
      return core.mountView({ id: rootId, focus, view: wanted });
    });

    return rootShell;
  });

  const shell = el("div", "ui-shell");
  const main = el("div", "ui-shell-main");

  main.tabIndex = 0;

  main.addEventListener(
    "pointerdown",
    (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
        return;
      main.focus();
    },
    { capture: true },
  );

  main.append(appRoot.el);
  shell.append(main);

  let debugPanel: { el: HTMLElement; dispose(): void } | null = null;

  if (DEV) {
    debugPanel = createDebugPanel({
      core,
      debug,
      probeRoot: main,
      className: "ui-debug",
    });
    shell.append(debugPanel.el);
  }

  hostEl.replaceChildren(shell);
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

function seedDemo(app: App) {
  const { core, rootId } = app;

  const mkGroup = (parentId: ItemId, label: string, view: ViewKind = null) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setGroup(id);
      t.setLabel(id, label);
      if (view != null) t.setView(id, view);
    });
    return id;
  };

  const mkValue = (parentId: ItemId, label: string, value: Value) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setValue(id, value);
    });
    return id;
  };

  const mkFormula = (parentId: ItemId, label: string, expr: string) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setConnected(id, { kind: "formula", expr });
    });
    return id;
  };

  const mkQuery = (
    parentId: ItemId,
    label: string,
    spec: { from: string; where?: string; orderBy?: string },
  ) => {
    let id: ItemId = "";
    core.commit((t) => {
      id = t.insertChild(parentId);
      t.setLabel(id, label);
      t.setConnected(id, {
        kind: "query",
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

  void mkFormula;
  void mkQuery;
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
