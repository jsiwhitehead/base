import { DEV, devAssert, devWarn } from "./dev";
import type { EntryId, ItemRef, ViewKind, ViewName, Scalar } from "./core";
import { createCore } from "./core";
import { viewFactories } from "./views";

export type App = {
  core: ReturnType<typeof createCore>["core"];
  rootId: EntryId;
  dispose(): void;
};

export type CreateAppOpts = {
  host?: HTMLElement;
  rootView?: ViewName;
  demo?: boolean;
};

const refOf = (entryId: EntryId): ItemRef => ({ entryId, path: [] });

export function createApp(opts: CreateAppOpts = {}): App {
  const rootView = opts.rootView ?? "outline";
  const demo = opts.demo ?? DEV;

  const hostEl =
    opts.host ??
    (typeof document !== "undefined"
      ? (document.getElementById("root") as HTMLElement | null)
      : null);

  devAssert(hostEl, "Missing app root element (#root)");

  const { core, rootId } = createCore({ views: viewFactories as any });

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
  owner: ItemRef,
  label: string,
): ItemRef | null {
  const want = label.trim();
  if (!want) return null;

  const snap = core.item(owner);
  if (snap.content.kind !== "group") return null;

  for (const child of snap.content.children) {
    const c = core.item(child);
    if ((c.label ?? "").trim() === want) return child;
  }
  return null;
}

export function seedDemo(app: App) {
  const { core, rootId } = app;
  const rootRef = refOf(rootId);

  if (findChildByLabel(core, rootRef, "Demo")) return;

  const mkGroup = (owner: ItemRef, label: string, view: ViewKind = null) => {
    let id: EntryId = -1;
    core.commit((t) => {
      id = t.insertChild(owner, { kind: "group" });
      t.setLabel(refOf(id), label);
      if (view != null) t.setView(id, view);
    });
    return refOf(id);
  };

  const mkScalar = (owner: ItemRef, label: string, value: Scalar) => {
    let id: EntryId = -1;
    core.commit((t) => {
      id = t.insertChild(owner, { kind: "blank" });
      t.setLabel(refOf(id), label);
      t.setScalar(refOf(id), value);
    });
    return refOf(id);
  };

  const mkDerived = (owner: ItemRef, label: string, expr: string) => {
    let id: EntryId = -1;
    core.commit((t) => {
      id = t.insertChild(owner, { kind: "blank" });
      t.setLabel(refOf(id), label);
      t.setSource(refOf(id), { type: "derived", expr });
    });
    return refOf(id);
  };

  const mkLens = (
    owner: ItemRef,
    label: string,
    spec: { from: string; where?: string; orderBy?: string },
  ) => {
    let id: EntryId = -1;
    core.commit((t) => {
      id = t.insertChild(owner, { kind: "blank" });
      t.setLabel(refOf(id), label);
      t.setSource(refOf(id), {
        type: "lens",
        from: spec.from,
        where: spec.where ?? "",
        orderBy: spec.orderBy ?? "",
      });
    });
    return refOf(id);
  };

  const demo = mkGroup(rootRef, "Demo", "outline");

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
