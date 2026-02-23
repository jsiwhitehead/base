import type { ItemId, ViewName } from "./core";
import { buildDebugPanel, createDebugState, instrumentCore } from "./debug";
import { DEV } from "./dev";
import {
  bindItemFrame,
  createComponent,
  createDragController,
  buildDropIndicator,
  el,
  type DomRuntime,
  type UiCore,
  bindUiRuntime,
  typeCharIntoFocusedTextInput,
} from "./dom";
import type { Core, CorePlatformHooks } from "./core";
import { createCore } from "./core";
import {
  splitViewRegistrations,
  viewRegistrations,
  type ViewRegistration,
} from "./views";

export function createUiCoreRuntime(args?: {
  views?: Partial<Record<ViewName, ViewRegistration>>;
  collab?: Parameters<typeof createCore>[0]["collab"];
}): {
  core: UiCore;
  pureCore: Core;
  rootId: ItemId;
  runtime: DomRuntime;
} {
  const views = args?.views ?? {};
  const { constraints, factories } = splitViewRegistrations(views);

  let runtime: DomRuntime | null = null;
  const platform: CorePlatformHooks = {
    onSelectionChange(selection) {
      runtime?.syncSelection(selection);
    },
    getActiveViewIntentHandler() {
      return runtime?.getActiveViewOnIntent() ?? null;
    },
    typeCharAtFocusedTarget(text) {
      queueMicrotask(() => {
        typeCharIntoFocusedTextInput(text);
      });
    },
  };

  const { core: pureCore, rootId } = createCore({
    constraints,
    ...(args?.collab ? { collab: args.collab } : {}),
    platform,
  });

  const bound = bindUiRuntime({ core: pureCore, views: factories });
  runtime = bound.runtime;

  return {
    core: bound.core,
    pureCore,
    rootId,
    runtime: bound.runtime,
  };
}

export type App = {
  core: UiCore;
  rootId: ItemId;
  dispose(): void;
};

export type CreateAppOpts = {
  host: HTMLElement;
  rootView?: ViewName;
};

export function createApp(opts: CreateAppOpts): App {
  const rootView = opts.rootView ?? "outline";
  const hostEl = opts.host;

  const {
    core: uiCore,
    pureCore,
    rootId,
    runtime,
  } = createUiCoreRuntime({
    views: viewRegistrations,
  });

  const debug = createDebugState();
  const core = instrumentCore(uiCore, debug);
  const uninstallGlobal = runtime.installGlobalListeners(window);

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

  const drag = createDragController(core);
  const indicator = buildDropIndicator(drag.state);

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

  root.append(main, indicator.el);

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
      indicator.dispose();
      drag.dispose();
      appRoot.dispose();
      hostEl.replaceChildren();
      uninstallGlobal();
      runtime.dispose();
      pureCore.dispose();
    },
  };

  return app;
}
