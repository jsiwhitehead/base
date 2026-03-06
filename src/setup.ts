import type {
  CollabWire,
  Core,
  CorePlatformHooks,
  ItemId,
  ViewName,
} from "./core";
import { createCore } from "./core";
import { buildDebugPanel, createDebugState, instrumentCore } from "./debug";
import { DEV } from "./dev";
import type { DomRuntime, UiCore } from "./dom";
import {
  bindItemFrame,
  bindUiRuntime,
  buildDropIndicator,
  createComponent,
  createDragController,
  el,
} from "./dom";
import type { ViewRegistration } from "./dom";
import { splitViewRegistrations, viewRegistrations } from "./views";

const SHOW_DEBUG_PANEL = true;

export function createUiCoreRuntime(args?: {
  views?: Partial<Record<ViewName, ViewRegistration>>;
  collab?: CollabWire;
}): { core: UiCore; pureCore: Core; rootId: ItemId; runtime: DomRuntime } {
  const views = args?.views ?? {};
  const { shapes, factories } = splitViewRegistrations(views);

  let runtime: DomRuntime | null = null;
  const platform: CorePlatformHooks = {
    onSelectionChange(selection, caret) {
      runtime?.syncSelection(selection, caret);
    },
    readCurrentCaret() {
      return runtime?.readCurrentCaret();
    },
    resolveIntentHandler(selection) {
      return runtime?.resolveIntentHandler(selection) ?? null;
    },
  };

  const { core: pureCore, rootId } = createCore({
    shapes,
    ...(args?.collab ? { collab: args.collab } : {}),
    platform,
  });

  const bound = bindUiRuntime({ core: pureCore, views: factories });
  runtime = bound.runtime;

  return { core: bound.core, pureCore, rootId, runtime: bound.runtime };
}

export type App = { core: UiCore; rootId: ItemId; dispose(): void };

export type CreateAppOpts = { host: HTMLElement; rootView?: ViewName };

export function createApp(opts: CreateAppOpts): App {
  const rootView = opts.rootView ?? "outline";
  const hostEl = opts.host;
  const showDebugPanel = DEV && SHOW_DEBUG_PANEL;

  const {
    core: uiCore,
    pureCore,
    rootId,
    runtime,
  } = createUiCoreRuntime({ views: viewRegistrations });

  const debug = showDebugPanel ? createDebugState() : null;
  const core = debug ? instrumentCore(uiCore, debug) : uiCore;
  const uninstallGlobal = runtime.installGlobalListeners(window);

  core.commit((t) => {
    t.setView(rootId, rootView);
  });

  const location = { item: rootId, portals: [] };

  const appRoot = createComponent(core, (ctx) => {
    const rootFrame = el("div");
    rootFrame.classList.add("ui-main");
    rootFrame.tabIndex = 0;

    bindItemFrame(ctx, { core, location }, rootFrame);

    ctx.slot(rootFrame, () => {
      return core.mountView({ id: rootId, portals: [] });
    });

    return rootFrame;
  });

  const drag = createDragController(core);
  const indicator = buildDropIndicator(drag.state);

  const root = el("div", "ui-root");
  root.dataset.debug = showDebugPanel ? "on" : "off";
  const main = appRoot.el;
  const mainScroll = el("div", "ui-main-scroll");

  mainScroll.append(main);
  root.append(mainScroll, indicator.el);

  let debugPanel: { el: HTMLElement; dispose(): void } | null = null;

  if (debug) {
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

  const onDocumentPointerDown = (event: PointerEvent): void => {
    const targetNode = event.target;
    if (!(targetNode instanceof Node)) return;
    if (main.contains(targetNode)) return;
    core.focus({ type: "idle" });
  };
  document.addEventListener("pointerdown", onDocumentPointerDown, {
    capture: true,
  });

  const app: App = {
    core,
    rootId,
    dispose() {
      document.removeEventListener("pointerdown", onDocumentPointerDown, {
        capture: true,
      });
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
