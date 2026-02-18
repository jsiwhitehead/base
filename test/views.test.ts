import { describe, expect, test } from "bun:test";

import type {
  Core,
  DomView,
  Focus,
  ItemId,
  ViewIntent,
  ViewName,
} from "../src/core";
import { DEFAULT_TARGET, VALUE_TARGET } from "../src/core";
import { caretAt, caret0 } from "../src/dom";
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
  requireTargetInput,
  scalarOfId,
  setFormula,
  setView,
} from "./test-utils";

const viewFactories = Object.fromEntries(
  Object.entries(viewRegistrations).map(([k, v]) => [k, v.factory]),
) as Record<ViewName, (typeof viewRegistrations)[ViewName]["factory"]>;

function mountDomView(view: DomView): () => void {
  document.body.replaceChildren(view.root);
  return () => {
    view.dispose();
    document.body.replaceChildren();
  };
}

function fireViewKey(
  view: DomView,
  key: string,
  opts?: Partial<KeyboardEventInit>,
): void {
  const intent = intentFromKey(key, opts);
  if (!intent) return;
  view.onIntent?.(intent);
}

function intentFromKey(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): ViewIntent | null {
  if (key === "Escape") return null;
  if (key === "Tab") return { type: "TAB", shift: !!opts.shiftKey };
  if (key === "Enter") return { type: "CONFIRM" };
  if (key === "Backspace") return { type: "DELETE", dir: "backward" };
  if (key === "Delete") return { type: "DELETE", dir: "forward" };

  const dir =
    key === "ArrowLeft"
      ? "left"
      : key === "ArrowRight"
        ? "right"
        : key === "ArrowUp"
          ? "up"
          : key === "ArrowDown"
            ? "down"
            : null;

  if (dir) {
    return {
      type: "NAV",
      dir,
      mode: opts.metaKey || opts.ctrlKey ? "jump" : "step",
    };
  }

  if (!opts.ctrlKey && !opts.metaKey && !opts.altKey && key.length === 1) {
    return { type: "TYPE", char: key };
  }

  return null;
}

function findFrameEl(root: ParentNode, id: ItemId): HTMLElement | null {
  return root.querySelector(`.ui-frame[data-id="${id}"]`) as HTMLElement | null;
}

function requireFrameEl(root: ParentNode, id: ItemId): HTMLElement {
  const frameEl = findFrameEl(root, id);
  if (!frameEl) throw new Error(`Missing frame element for id=${String(id)}`);
  return frameEl;
}

type ElSnapshot = {
  el: Element;
  keyEls: Element[];
};

function snapshotEl(element: Element, keySelectors: string[] = []): ElSnapshot {
  const keyEls: Element[] = [];
  for (const sel of keySelectors) {
    const hit = (element as ParentNode).querySelector(sel);
    if (!hit) throw new Error(`Missing key element selector=${sel}`);
    keyEls.push(hit);
  }
  return { el: element, keyEls };
}

function expectSnapshotSame(
  snap: ElSnapshot,
  el0: Element,
  keySelectors: string[] = [],
): void {
  expect(snap.el === el0).toBe(true);
  if (keySelectors.length !== snap.keyEls.length)
    throw new Error("Key selector count mismatch");

  for (let i = 0; i < keySelectors.length; i++) {
    const sel = keySelectors[i]!;
    const hit = (el0 as ParentNode).querySelector(sel);
    if (!hit) throw new Error(`Missing key element selector=${sel}`);
    expect(snap.keyEls[i] === hit).toBe(true);
  }
}

async function mountView(args: {
  view: Extract<ViewName, "outline" | "table" | "slider">;
  core: Core;
  id: ItemId;
  focus?: Focus;
}) {
  const { view, core, id, focus } = args;
  const domView = viewFactories[view]({
    core,
    id,
    ...(focus === undefined ? {} : { focus }),
  });
  const unmount = mountDomView(domView);
  await flushDomEffects();
  return { domView, unmount };
}

describe("views/outline", () => {
  test("renders placeholder for empty group", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });

    core.focus({ container: rootId, item: g }, DEFAULT_TARGET);

    const { unmount } = await mountView({ view: "outline", core, id: rootId });

    const placeholder = document.body.querySelector(
      ".ui-outline-placeholder",
    ) as HTMLElement | null;

    expect(placeholder).toBeTruthy();
    expect(placeholder?.classList.contains("ui-frame")).toBe(false);

    unmount();
  });

  test("Enter on empty group converts to value and enters VALUE", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });

    core.focus({ container: rootId, item: g }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    fireViewKey(domView, "Enter");
    await flushDomEffects();

    const kids = childrenOf(core, g);
    expect(kids.length).toBe(0);
    expectSel(core, { container: rootId, item: g, target: VALUE_TARGET });
    expect(scalarOfId(core, g)).toBe("");

    requireTargetInput(document.body, VALUE_TARGET);

    unmount();
  });

  test("TYPE on empty group converts to value and types character", async () => {
    const { core, rootId } = makeCoreRuntime();
    const g = mkGroup(core, rootId, { label: "g" });

    core.focus({ container: rootId, item: g }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    fireViewKey(domView, "a");
    await flushDomEffects(3);

    const kids = childrenOf(core, g);
    expect(kids.length).toBe(0);
    expectSel(core, { container: rootId, item: g, target: VALUE_TARGET });
    expect(scalarOfId(core, g)).toBe("a");

    unmount();
  });

  test("NAV from container focus follows outline geometry", async () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const a = mkBlank(core, g, { label: "a", value: "aa" });
    const b = mkBlank(core, g, { label: "b", value: "bb" });
    const c = mkBlank(core, rootId, { label: "c", value: "cc" });

    core.focus({ container: rootId, item: g }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: g, item: a, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: g, item: b, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: c, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });

    unmount();
  });

  test("Tab nests in and out", async () => {
    const { core, rootId } = makeCoreRuntime();

    const g = mkGroup(core, rootId, { label: "g" });
    const x = mkBlank(core, g, { label: "x", value: "v" });

    core.focus({ container: g, item: x }, VALUE_TARGET, { caret: caret0() });

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    fireViewKey(domView, "Tab");
    await flushDomEffects();

    const kids = childrenOf(core, g);
    expect(kids.length).toBe(1);
    const wrapper = kids[0]!;
    expect(wrapper).not.toBe(x);

    expectSel(core, { container: wrapper, item: x, target: VALUE_TARGET });

    fireViewKey(domView, "Tab", { shiftKey: true });
    await flushDomEffects();

    expectSel(core, { container: g, item: x, target: VALUE_TARGET });

    unmount();
  });

  test("Enter in VALUE splits item", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: "hello" });
    core.focus({ container: rootId, item: a }, VALUE_TARGET, {
      caret: caretAt(2),
    });

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    domView.onIntent?.({ type: "CONFIRM", caret: caretAt(2) });
    await flushDomEffects();

    const kids = childrenOf(core, rootId);
    const aIdx = kids.indexOf(a);
    expect(aIdx).toBeGreaterThanOrEqual(0);

    const b = kids[aIdx + 1]!;
    expect(scalarOfId(core, a)).toBe("he");
    expect(scalarOfId(core, b)).toBe("llo");

    expectSel(core, { container: rootId, item: b, target: VALUE_TARGET });

    unmount();
  });

  test("Backspace in VALUE joins with previous", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: "hi" });
    const b = mkBlank(core, rootId, { label: "b", value: "there" });

    core.focus({ container: rootId, item: b }, VALUE_TARGET, {
      caret: caret0(),
    });

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    fireViewKey(domView, "Backspace");
    await flushDomEffects();

    expect(scalarOfId(core, a)).toBe("hithere");
    expect(core.item(b).content.type).toBe("issue");
    expectSel(core, { container: rootId, item: a, target: VALUE_TARGET });

    unmount();
  });

  test("NAV boundaries: up from first top-level item does nothing; left from root does nothing", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: "x" });

    core.focus({ container: rootId, item: a }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "outline",
      core,
      id: rootId,
    });

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: a, target: DEFAULT_TARGET });

    core.focus({ container: rootId, item: rootId }, DEFAULT_TARGET);
    await flushDomEffects();

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, {
      container: rootId,
      item: rootId,
      target: DEFAULT_TARGET,
    });

    unmount();
  });

  test("selection changes do not recreate frame elements", async () => {
    const { core, rootId } = makeCoreRuntime();

    const a = mkBlank(core, rootId, { label: "a", value: "x" });
    const b = mkBlank(core, rootId, { label: "b", value: "y" });

    core.focus({ container: rootId, item: a }, DEFAULT_TARGET);

    const { unmount } = await mountView({ view: "outline", core, id: rootId });

    const aFrame0 = requireFrameEl(document.body, a);
    const bFrame0 = requireFrameEl(document.body, b);

    const snapA = snapshotEl(aFrame0);
    const snapB = snapshotEl(bFrame0);

    core.focus({ container: rootId, item: b }, DEFAULT_TARGET);
    await flushDomEffects();

    expectSnapshotSame(snapA, requireFrameEl(document.body, a));
    expectSnapshotSame(snapB, requireFrameEl(document.body, b));

    unmount();
  });
});

describe("views/table", () => {
  test("renders header columns based on schema row", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    core.focus({ container: tableId, item: tableId }, DEFAULT_TARGET);

    const { unmount } = await mountView({ view: "table", core, id: tableId });

    const header = document.body.querySelector(
      ".ui-table-header",
    ) as HTMLElement | null;
    expect(header).toBeTruthy();

    const headerCols = [
      ...(header?.querySelectorAll(":scope > .ui-table-col") ?? []),
    ] as HTMLElement[];
    expect(headerCols.length).toBe(3);

    unmount();
  });

  test("NAV in row container moves rows; right enters first cell", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    core.focus({ container: tableId, item: r1 }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
    });

    fireViewKey(domView, "ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: r2, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: r1, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: r1, item: c11, target: DEFAULT_TARGET });

    unmount();
  });

  test("NAV in cells moves in grid; left from first cell exits to row container", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    const c12 = mkBlank(core, r1, { label: "c2", value: 2 });

    const c21 = childrenOf(core, r2)[0]!;
    const c22 = childrenOf(core, r2)[1]!;

    core.focus({ container: r1, item: c11 }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
    });

    fireViewKey(domView, "ArrowRight");
    await flushDomEffects();
    expectSel(core, { container: r1, item: c12, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowDown");
    await flushDomEffects();
    expectSel(core, { container: r2, item: c22, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: r2, item: c21, target: DEFAULT_TARGET });

    fireViewKey(domView, "ArrowLeft");
    await flushDomEffects();
    expectSel(core, { container: tableId, item: r2, target: DEFAULT_TARGET });

    unmount();
  });

  test("TAB moves across cells and wraps rows", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    const c12 = mkBlank(core, r1, { label: "c2", value: 2 });

    const c21 = childrenOf(core, r2)[0]!;

    core.focus({ container: r1, item: c11 }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
    });

    fireViewKey(domView, "Tab");
    await flushDomEffects();
    expectSel(core, { container: r1, item: c12, target: DEFAULT_TARGET });

    fireViewKey(domView, "Tab");
    await flushDomEffects();
    expectSel(core, { container: r2, item: c21, target: DEFAULT_TARGET });

    unmount();
  });

  test("Enter from cell VALUE moves to same column next row container", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: "a" });
    mkBlank(core, r1, { label: "c2", value: "b" });

    const c21 = childrenOf(core, r2)[0]!;

    core.focus({ container: r1, item: c11 }, VALUE_TARGET, {
      caret: caretAt(1),
    });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
    });

    fireViewKey(domView, "Enter");
    await flushDomEffects();

    expectSel(core, { container: r2, item: c21, target: DEFAULT_TARGET });

    unmount();
  });

  test("DELETE: row container removes row; cell container clears value", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    const r2 = mkGroup(core, tableId, { label: "r2" });

    const c11 = mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
    });

    core.focus({ container: r1, item: c11 }, DEFAULT_TARGET);
    await flushDomEffects();

    fireViewKey(domView, "Backspace");
    await flushDomEffects();
    expect(scalarOfId(core, c11)).toBe(null);

    core.focus({ container: tableId, item: r2 }, DEFAULT_TARGET);
    await flushDomEffects();

    fireViewKey(domView, "Backspace");
    await flushDomEffects();

    expect(childrenOf(core, tableId).includes(r2)).toBe(false);

    unmount();
  });

  test("NAV beyond grid edges does nothing", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const r1 = mkGroup(core, tableId, { label: "r1" });
    mkBlank(core, r1, { label: "c1", value: 1 });
    mkBlank(core, r1, { label: "c2", value: 2 });

    const firstRow = childrenOf(core, tableId)[0]!;
    core.focus({ container: tableId, item: firstRow }, DEFAULT_TARGET);

    const { domView, unmount } = await mountView({
      view: "table",
      core,
      id: tableId,
    });

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, {
      container: tableId,
      item: firstRow,
      target: DEFAULT_TARGET,
    });

    const firstCell = childrenOf(core, firstRow)[0]!;
    core.focus({ container: firstRow, item: firstCell }, DEFAULT_TARGET);
    await flushDomEffects();

    fireViewKey(domView, "ArrowUp");
    await flushDomEffects();
    expectSel(core, {
      container: firstRow,
      item: firstCell,
      target: DEFAULT_TARGET,
    });

    unmount();
  });
});

describe("views/slider", () => {
  test("renders range input and value readout", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({ container: s, item: s }, DEFAULT_TARGET);

    const { unmount } = await mountView({ view: "slider", core, id: s });

    requireFrameEl(document.body, s);

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement | null;
    expect(input).toBeTruthy();

    const valueEl = document.body.querySelector(
      ".ui-slider-value",
    ) as HTMLElement | null;
    expect(valueEl).toBeTruthy();

    unmount();
  });

  test("pointerdown on input focuses VALUE_TARGET", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({ container: s, item: s }, DEFAULT_TARGET);

    const { unmount } = await mountView({ view: "slider", core, id: s });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    pointerDown(input);
    await flushDomEffects();

    expectSel(core, { container: s, item: s, target: VALUE_TARGET });

    unmount();
  });

  test("native range keys do not bubble", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    core.focus({ container: s, item: s }, DEFAULT_TARGET);

    const { unmount } = await mountView({ view: "slider", core, id: s });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    expect(dispatchKey(input, "ArrowLeft").bubbled).toBe(0);
    expect(dispatchKey(input, "ArrowRight").bubbled).toBe(0);
    expect(dispatchKey(input, "ArrowUp").bubbled).toBe(0);
    expect(dispatchKey(input, "ArrowDown").bubbled).toBe(0);

    unmount();
  });

  test("input updates core value", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 0 });
    setView(core, s, "slider");

    const { unmount } = await mountView({ view: "slider", core, id: s });

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();

    input.value = "42";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await flushDomEffects();

    expect(scalarOfId(core, s)).toBe(42);

    unmount();
  });

  test("input is disabled when not editable", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    const { unmount } = await mountView({ view: "slider", core, id: s });

    setFormula(core, s, "unknown_name");
    await flushDomEffects();

    const input = document.body.querySelector(
      'input[type="range"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.disabled).toBe(true);

    unmount();
  });

  test("CONFIRM toggles VALUE_TARGET to DEFAULT_TARGET only when focused item is slider id", async () => {
    const { core, rootId } = makeCoreRuntime();

    const s = mkBlank(core, rootId, { label: "s", value: 5 });
    setView(core, s, "slider");

    const other = mkBlank(core, rootId, { label: "o", value: 1 });

    core.focus({ container: s, item: s }, VALUE_TARGET, { caret: caret0() });

    const { domView, unmount } = await mountView({
      view: "slider",
      core,
      id: s,
    });

    fireViewKey(domView, "Enter");
    await flushDomEffects();
    expectSel(core, { container: s, item: s, target: DEFAULT_TARGET });

    core.focus({ container: rootId, item: other }, VALUE_TARGET, {
      caret: caret0(),
    });
    await flushDomEffects();

    fireViewKey(domView, "Enter");
    await flushDomEffects();
    expectSel(core, { container: rootId, item: other, target: VALUE_TARGET });

    unmount();
  });
});
