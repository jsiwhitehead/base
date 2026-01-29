import { DEV, devAssert, devWarn } from "./dev";
import { type ItemId, type ViewName, type ViewKind, createCore } from "./core";
import { mountViewInto, installDomRuntime } from "./ui/dom";
import { createView } from "./views";

export type App = {
  core: ReturnType<typeof createCore>;
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

  const host =
    opts.host ??
    (typeof document !== "undefined"
      ? (document.getElementById("root") as HTMLElement | null)
      : null);

  devAssert(host, "Missing app root element (#root)");

  const core = createCore();
  const rootId = core.createId();
  core.advanced.model.setRoot(rootId);

  core.commit(
    core.txn([
      core.op.create(core.item.group(rootId)),
      core.op.patchView(rootId, rootView),
    ]),
  );

  const view = createView(
    { editor: core.advanced.editor, evaluator: core.advanced.evaluator },
    rootView,
    rootId,
    { scopeId: rootId, id: rootId },
  );
  devAssert(view, `No view factory for rootView='${rootView}'`);

  const uninstallListeners = installDomRuntime(core.advanced.runtime);
  const unmount = mountViewInto(core.advanced.editor, host!, view!);

  const app: App = {
    core,
    rootId,
    dispose() {
      uninstallListeners();
      unmount();
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
  const model = core.advanced.model;

  if (model.findChildIdByLabel(rootId, "Demo") != null) return;

  const id = () => core.createId();

  const mkGroup = (owner: ItemId, label: string, view: ViewKind = null) => {
    const gid = id();
    core.commit(
      core.txn([
        core.op.create(core.item.group(gid)),
        core.op.patchLabel(gid, label),
        ...(view != null ? [core.op.patchView(gid, view)] : []),
        core.op.reparent({ childId: gid, toOwnerId: owner }),
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
    core.commit(
      core.txn([
        core.op.create(core.item.blank(cid)),
        core.op.patchLabel(cid, label),
        core.op.patchContent(cid, { kind: "scalar", value }),
        core.op.reparent({ childId: cid, toOwnerId: owner }),
      ]),
    );
    return cid;
  };

  const mkDerived = (owner: ItemId, label: string, expr: string) => {
    const cid = id();
    core.commit(
      core.txn([
        core.op.create(core.item.blank(cid)),
        core.op.patchLabel(cid, label),
        core.op.patchContent(cid, { kind: "derived", expr }),
        core.op.reparent({ childId: cid, toOwnerId: owner }),
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
    core.commit(
      core.txn([
        core.op.create(core.item.blank(cid)),
        core.op.patchLabel(cid, label),
        core.op.patchContent(cid, {
          kind: "lens",
          from: spec.from,
          where: spec.where ?? "",
          orderBy: spec.orderBy ?? "",
        }),
        core.op.reparent({ childId: cid, toOwnerId: owner }),
      ]),
    );
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

  const table = id();
  core.commit(
    core.txn([
      core.op.create(core.item.blank(table)),
      core.op.patchLabel(table, "Table"),
      core.op.patchView(table, "outline"),
      core.op.patchContent(table, { kind: "derived", expr: "rows" }),
      core.op.reparent({ childId: table, toOwnerId: demo }),
    ]),
  );
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
