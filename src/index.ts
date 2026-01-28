import { DEV, devAssert, devWarn } from "./dev";
import {
  type ItemId,
  type ViewName,
  type ViewKind,
  createStore,
} from "./store";
import { createEvaluator } from "./eval";
import { interpretExpr } from "./expr";
import { createEditor } from "./editor";
import { mountViewInto } from "./dom";
import { createView } from "./views";

export type App = {
  store: ReturnType<typeof createStore>;
  evaluator: ReturnType<typeof createEvaluator>;
  editor: ReturnType<typeof createEditor>;
  runtime: {
    editor: ReturnType<typeof createEditor>;
    evaluator: ReturnType<typeof createEvaluator>;
  };
  rootId: ItemId;
  dispose(): void;
};

export type CreateAppOpts = {
  host?: HTMLElement;
  rootView?: ViewName;
  demo?: boolean;
};

export function createApp(opts: CreateAppOpts = {}): App {
  const rootView = opts.rootView ?? "tree";
  const demo = opts.demo ?? DEV;

  const host =
    opts.host ??
    (typeof document !== "undefined"
      ? (document.getElementById("root") as HTMLElement | null)
      : null);

  devAssert(host, "Missing app root element (#root)");

  const store = createStore();

  const rootId = store.createId();
  store.setRoot(rootId);
  store.apply(
    store.op.transaction([
      store.op.create(store.create.group(rootId)),
      store.op.patchView(rootId, rootView),
    ]),
  );

  const evaluator = createEvaluator({ store, interpret: interpretExpr });
  const editor = createEditor(store);
  const runtime = { editor, evaluator } as const;

  const view = createView(runtime, rootView, rootId, {
    scopeId: rootId,
    id: rootId,
  });
  devAssert(view, `No view factory for rootView='${rootView}'`);

  const uninstallListeners = editor.runtime.installViewListeners();
  const unmount = mountViewInto(editor, host!, view!);

  const app: App = {
    store,
    evaluator,
    editor,
    runtime,
    rootId,
    dispose() {
      uninstallListeners();
      unmount();
      evaluator.dispose();
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
  const { store, rootId } = app;

  if (store.findChildByLabel(rootId, "Demo") != null) return;

  const id = () => store.createId();

  const mkGroup = (owner: ItemId, label: string, view: ViewKind = null) => {
    const gid = id();
    store.apply(
      store.op.transaction([
        store.op.create(store.create.group(gid)),
        store.op.patchLabel(gid, label),
        ...(view != null ? [store.op.patchView(gid, view)] : []),
        store.op.reparent({ childId: gid, toOwnerId: owner }),
      ]),
    );
    return gid;
  };

  const mkScalar = (
    owner: ItemId,
    label: string,
    value: true | number | string,
  ) => {
    const cid = id();
    store.apply(
      store.op.transaction([
        store.op.create(store.create.blank(cid)),
        store.op.patchLabel(cid, label),
        store.op.patchContent(cid, { kind: "scalar", value }),
        store.op.reparent({ childId: cid, toOwnerId: owner }),
      ]),
    );
    return cid;
  };

  const mkDerived = (owner: ItemId, label: string, expr: string) => {
    const cid = id();
    store.apply(
      store.op.transaction([
        store.op.create(store.create.blank(cid)),
        store.op.patchLabel(cid, label),
        store.op.patchContent(cid, { kind: "derived", expr }),
        store.op.reparent({ childId: cid, toOwnerId: owner }),
      ]),
    );
    return cid;
  };

  const mkLens = (
    owner: ItemId,
    label: string,
    spec: { from: string; where?: string; orderBy?: string },
  ) => {
    const cid = id();
    store.apply(
      store.op.transaction([
        store.op.create(store.create.blank(cid)),
        store.op.patchLabel(cid, label),
        store.op.patchContent(cid, {
          kind: "lens",
          from: spec.from,
          where: spec.where ?? "",
          orderBy: spec.orderBy ?? "",
        }),
        store.op.reparent({ childId: cid, toOwnerId: owner }),
      ]),
    );
    return cid;
  };

  const demo = mkGroup(rootId, "Demo", "tree");

  mkScalar(demo, "x", 10);
  mkScalar(demo, "y", 2);
  mkDerived(demo, "x_plus_y", "x + y");
  mkDerived(demo, "x_times_y", "x * y");

  const rows = mkGroup(demo, "rows", "tree");

  const mkRow = (label: string, score: number, note: string) => {
    const row = mkGroup(rows, label);
    mkScalar(row, "score", score);
    mkScalar(row, "note", note);
    return row;
  };

  mkRow("a", 2, "ok");
  mkRow("b", 1, "low");
  mkRow("c", 3, "high");

  const table = id();
  store.apply(
    store.op.transaction([
      store.op.create(store.create.blank(table)),
      store.op.patchLabel(table, "Table"),
      store.op.patchView(table, "table"),
      store.op.patchContent(table, { kind: "derived", expr: "rows" }),
      store.op.reparent({ childId: table, toOwnerId: demo }),
    ]),
  );

  mkLens(demo, "TopScores", {
    from: "rows",
    where: "_.score > 1",
    orderBy: "_.score",
  });

  const slider = id();
  store.apply(
    store.op.transaction([
      store.op.create(store.create.blank(slider)),
      store.op.patchLabel(slider, "Slider"),
      store.op.patchView(slider, "slider"),
      store.op.patchContent(slider, { kind: "scalar", value: 25 }),
      store.op.reparent({ childId: slider, toOwnerId: demo }),
    ]),
  );
}

function autoMount(): void {
  if (typeof document === "undefined") return;
  if (typeof window === "undefined") return;

  const g = globalThis as { __APP_MOUNTED__?: boolean };
  if (g.__APP_MOUNTED__) return;
  g.__APP_MOUNTED__ = true;

  createApp({ demo: true, rootView: "tree" });
}

autoMount();
