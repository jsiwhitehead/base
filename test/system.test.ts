import { describe, expect, test } from "bun:test";

import type { ItemId, Transaction } from "../src/core";
import type { UiCore } from "../src/dom";
import { buildRootShell, createApp } from "../src/setup";
import { viewRegistrations } from "../src/views";

import {
  childrenOf,
  dispatchKey,
  expectSel,
  flushDomEffects,
  makeCoreRuntime,
  mkBlank,
  mkGroup,
  pointerDown,
  requireCreatedEntryId,
  requireFrameEl,
  setView,
  valueOfId,
} from "./dom-test-utils";

function mountAppShell(core: UiCore, rootId: ItemId): () => void {
  const appRoot = buildRootShell(core, rootId);

  document.body.replaceChildren(appRoot.el);
  appRoot.el.focus();

  return () => {
    appRoot.dispose();
    document.body.replaceChildren();
  };
}

describe("system/bootstrap & lifecycle", () => {
  test("bootstraps root shell and disposes cleanly", async () => {
    const { core, rootId } = makeCoreRuntime();

    const unmount = mountAppShell(core, rootId);
    await flushDomEffects();

    const main = document.body.querySelector(".ui-main") as HTMLElement | null;
    expect(main).toBeTruthy();
    expectSel(core, { item: rootId, portals: [] });

    unmount();
    expect(document.body.querySelector(".ui-main")).toBeNull();
  });

  test("root item selection focuses the root shell", async () => {
    const { core, rootId } = makeCoreRuntime();

    const unmount = mountAppShell(core, rootId);
    core.focus({ type: "item", location: { item: rootId, portals: [] } });
    await flushDomEffects();

    const main = document.body.querySelector(".ui-main") as HTMLElement | null;
    expect(main).toBeTruthy();
    expect(document.activeElement).toBe(main);

    unmount();
  });
});

describe("system/keyboard routing & focus ownership", () => {
  test("routes NAV to the active nested table view", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "t" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    const c21 = childrenOf(core, r2)[1]!;

    const unmount = mountAppShell(core, rootId);
    await flushDomEffects();

    const c11Frame = requireFrameEl(document.body, c11);
    pointerDown(c11Frame);
    await flushDomEffects();

    expectSel(core, { item: c11, portals: [] });

    dispatchKey(c11Frame, "ArrowDown");
    await flushDomEffects();

    expectSel(core, { item: c21, portals: [] });

    unmount();
  });

  test("toolbar clicks do not clear the current selection", async () => {
    const host = document.createElement("div");
    document.body.replaceChildren(host);

    const app = createApp({ host, rootView: "outline" });
    const { core, rootId } = app;

    let itemId: ItemId = "";
    core.commit((t) => {
      itemId = t.insertChild(rootId);
      t.setValue(itemId, "hello");
    });

    core.focus({ type: "item", location: { item: itemId, portals: [] } });
    await flushDomEffects();

    const toolbarButton = document.body.querySelector(
      '.ui-toolbar-button[data-command="table"]',
    ) as HTMLButtonElement | null;
    expect(toolbarButton).toBeTruthy();

    pointerDown(toolbarButton!);
    toolbarButton!.click();
    await flushDomEffects();

    expectSel(core, { item: itemId, portals: [] });

    app.dispose();
    document.body.replaceChildren();
  });

  test("toolbar table conversion bootstraps a row and cell", async () => {
    const host = document.createElement("div");
    document.body.replaceChildren(host);

    const app = createApp({ host, rootView: "outline" });
    const { core, rootId } = app;

    let itemId: ItemId = "";
    core.commit((t) => {
      itemId = t.insertChild(rootId);
      t.setValue(itemId, null);
    });

    core.focus({ type: "item", location: { item: itemId, portals: [] } });
    await flushDomEffects();

    const toolbarButton = document.body.querySelector(
      '.ui-toolbar-button[data-command="table"]',
    ) as HTMLButtonElement | null;
    expect(toolbarButton).toBeTruthy();

    pointerDown(toolbarButton!);
    toolbarButton!.click();
    await flushDomEffects();

    expect(core.view(itemId)).toBe("table");
    expect(core.item(itemId).content.type).toBe("group");

    const rows = childrenOf(core, itemId);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(core.item(rows[0]!).content.type).toBe("group");

    const cells = childrenOf(core, rows[0]!);
    expect(cells.length).toBeGreaterThanOrEqual(1);

    app.dispose();
    document.body.replaceChildren();
  });
});

describe("system/history across views", () => {
  test("mixed outline + table commits undo/redo coherently", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: "x" });

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");
    const r1 = mkGroup(core, tableId, { label: "r1" });
    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });

    core.commit((t) => t.setValue(a, "x2"));
    core.commit((t) => t.setValue(c11, 9));

    expect(valueOfId(core, a)).toBe("x2");
    expect(valueOfId(core, c11)).toBe(9);

    core.undo();
    expect(valueOfId(core, c11)).toBe(1);
    expect(valueOfId(core, a)).toBe("x2");

    core.undo();
    expect(valueOfId(core, a)).toBe("x");

    core.redo();
    core.redo();
    expect(valueOfId(core, a)).toBe("x2");
    expect(valueOfId(core, c11)).toBe(9);

    const selection = core.selection();
    expect(selection.type).toBe("item");
  });
});

describe("system/collab + local history", () => {
  test("local echo is ignored and remote apply updates core state", async () => {
    let onRemote: ((txn: Transaction) => void) | undefined;
    const sent: Transaction[] = [];

    const { core, rootId } = makeCoreRuntime({
      views: viewRegistrations,
      collab: {
        origin: "test-origin",
        send(txn) {
          sent.push(txn);
        },
        subscribe(fn) {
          onRemote = fn;
          return () => {
            onRemote = undefined;
          };
        },
      },
    });
    const unmount = mountAppShell(core, rootId);
    await flushDomEffects();

    let x: ItemId = "";
    core.commit((t) => {
      x = t.insertChild(rootId);
      t.setLabel(x, "x");
      t.setValue(x, 1);
    });

    const baselineChildren = childrenOf(core, rootId).length;
    const echo = sent.at(-1)!;
    if (!onRemote) throw new Error("Missing collab subscriber");
    onRemote(echo);

    expect(childrenOf(core, rootId).length).toBe(baselineChildren);

    const entryId = requireCreatedEntryId(echo);

    onRemote({
      ops: [
        {
          type: "patch",
          id: entryId,
          next: { content: { type: "scalar", value: 7 } },
        },
      ],
      meta: { origin: "remote-user", seq: 1 },
    });

    expect(valueOfId(core, x)).toBe(7);
    expect(requireFrameEl(document.body, x).isConnected).toBe(true);
    unmount();
    core.dispose();
  });
});
