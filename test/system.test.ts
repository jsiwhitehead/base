import { describe, expect, test } from "bun:test";

import type { ItemId, Transaction } from "../src/core";
import { DEFAULT_TARGET, VALUE_TARGET } from "../src/core";
import type { UiCore } from "../src/dom";
import { bindItemFrame, createComponent, el } from "../src/dom";
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
  requireTargetInput,
  setView,
  valueOfId,
} from "./dom-test-utils";

function mountAppShell(core: UiCore, rootId: ItemId): () => void {
  const focus = { container: rootId, item: rootId };

  const appRoot = createComponent(core, (ctx) => {
    const rootFrame = el("div");
    rootFrame.classList.add("ui-main");
    rootFrame.tabIndex = 0;

    bindItemFrame(ctx, { core, focus }, rootFrame);

    ctx.slot(rootFrame, () => {
      return core.mountView({ id: rootId, containerId: focus.container });
    });

    return rootFrame;
  });

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
    expect(document.activeElement).toBe(main);
    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });

    unmount();
    expect(document.body.querySelector(".ui-main")).toBeNull();
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
    const c21 = childrenOf(core, r2)[0]!;

    const unmount = mountAppShell(core, rootId);
    await flushDomEffects();

    const c11Frame = requireFrameEl(document.body, c11);
    pointerDown(c11Frame);
    await flushDomEffects();

    expectSel(core, { container: r1, item: c11, target: DEFAULT_TARGET });

    dispatchKey(c11Frame, "ArrowDown");
    await flushDomEffects();

    expectSel(core, { container: r2, item: c21, target: DEFAULT_TARGET });

    unmount();
  });
});

describe("system/history across views", () => {
  test("mixed outline + table edits undo/redo coherently", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: "x" });

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");
    const r1 = mkGroup(core, tableId, { label: "r1" });
    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });

    const unmount = mountAppShell(core, rootId);
    await flushDomEffects();

    core.focus({ container: rootId, item: a }, DEFAULT_TARGET);
    await flushDomEffects();
    dispatchKey(requireFrameEl(document.body, a), "Enter");
    await flushDomEffects();
    const aInput = requireTargetInput(
      requireFrameEl(document.body, a),
      VALUE_TARGET,
    );
    aInput.value = "x2";
    aInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    core.focus({ container: r1, item: c11 }, DEFAULT_TARGET);
    await flushDomEffects();
    dispatchKey(requireFrameEl(document.body, c11), "Enter");
    await flushDomEffects();
    const cInput = requireTargetInput(
      requireFrameEl(document.body, c11),
      VALUE_TARGET,
    );
    cInput.value = "9";
    cInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    expect(valueOfId(core, a)).toBe("x2");
    expect(valueOfId(core, c11)).toBe("9");

    core.undo();
    expect(valueOfId(core, c11)).toBe(1);
    expect(valueOfId(core, a)).toBe("x2");

    core.undo();
    expect(valueOfId(core, a)).toBe("x");

    core.redo();
    core.redo();
    expect(valueOfId(core, a)).toBe("x2");
    expect(valueOfId(core, c11)).toBe("9");

    const selection = core.selection();
    expect(selection.type).toBe("focused");

    unmount();
  });
});

describe("system/collab + local history", () => {
  test("local echo is ignored and remote apply updates mounted state", async () => {
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

    await flushDomEffects();

    expect(valueOfId(core, x)).toBe(7);
    expect(requireFrameEl(document.body, x).isConnected).toBe(true);

    unmount();
    core.dispose();
  });
});
