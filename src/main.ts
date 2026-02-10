import { DEV, devAssert, devWarn } from "./dev";
import type {
  Core,
  ItemId,
  ViewKind,
  ViewName,
  Scalar,
  Component,
} from "./core";
import { createCore } from "./core";
import { viewFactories } from "./views";
import { el, createComponent, bindUiItemShell } from "./dom";
import { createDebugPanel, createDebugState, instrumentCore } from "./debug";

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

  const { core: rawCore, rootId } = createCore({ views: viewFactories });

  const debug = createDebugState();
  const core = instrumentCore(rawCore, debug);

  core.commit((t) => {
    t.setView(rootId, rootView as ViewKind);
  });

  const focus = { container: rootId, item: rootId };

  let currentRootView:
    | (Component & { onKeyDown?(e: KeyboardEvent): void })
    | null = null;

  const appRoot = createComponent(core, (ctx) => {
    const rootShell = el("div", "ui-app");
    const bodyHost = el("div", "ui-app-body");
    rootShell.append(bodyHost);

    bindUiItemShell(ctx, { core, focus }, rootShell);

    const slot = ctx.slot(bodyHost);

    ctx.effect(() => {
      const wanted = core.view(rootId);
      const mounted = core.mountView({ id: rootId, focus, view: wanted });
      currentRootView = mounted;
      slot.set(mounted);
    });

    ctx.cleanup(() => {
      currentRootView = null;
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

  main.addEventListener("keydown", (e: KeyboardEvent) => {
    currentRootView?.onKeyDown?.(e);
  });

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

  void mkDerived;
  void mkLens;
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
