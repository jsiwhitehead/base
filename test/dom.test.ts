import { signal } from "@preact/signals-core";
import { describe, expect, test } from "bun:test";

import type { Location, ItemId } from "../src/core";
import { LABEL_TARGET, CONTENT_TEXT_TARGET, connTarget } from "../src/core";
import type { Component } from "../src/dom";
import {
  bindItemFrame,
  createComponent,
  domPointToTextOffset,
  el,
  getCollapsedCaretRectInSurface,
  getPlainTextFromDataTransfer,
  mountHeader,
  readPlainTextFromContentEditable,
  renderPlainTextToContentEditable,
  setDomCaret,
  setDomSelectionRange,
  textOffsetToDomPoint,
  writePlainTextClipboard,
} from "../src/dom";
import { buildToolbar } from "../src/toolbar";
import { viewRegistrations } from "../src/views";

import {
  childrenOf,
  dispatchKey,
  flushDomEffects,
  makeCoreRuntime,
  mkBlank,
  mkGroup,
  pointerDown,
  requireFrameEl,
  queryTargetInput,
  requireTargetInput,
  setFormula,
  setQuery,
  setView,
} from "./dom-test-utils";

function mount(c: Component): () => void {
  document.body.append(c.el);
  return () => {
    c.dispose();
    document.body.replaceChildren();
  };
}

function mountInItemFrame(
  core: Parameters<typeof createComponent>[0],
  location: Location,
  c: Component,
): () => void {
  const wrapped = createComponent(core, (ctx) => {
    const frameEl = el("div");
    bindItemFrame(ctx, { core, location }, frameEl);
    ctx.mount(frameEl, c);
    return frameEl;
  });
  return mount(wrapped);
}

function spy<T extends unknown[] = unknown[]>() {
  const calls: T[] = [];
  const fn = (...args: T) => {
    calls.push(args);
  };
  return { fn, calls, count: () => calls.length };
}

function connTargetsInHeaderConn(root: ParentNode): string[] {
  const wrap = root.querySelector(".ui-header-conn") as HTMLElement | null;
  if (!wrap) return [];
  const els = [
    ...wrap.querySelectorAll("textarea[data-target], input[data-target]"),
  ] as Array<HTMLInputElement | HTMLTextAreaElement>;
  return els
    .map((e) => e.dataset.target ?? "")
    .filter((t) => t.startsWith("conn:"));
}

function requireToolbarButton(command: string): HTMLButtonElement {
  const button = document.body.querySelector(
    `.ui-toolbar-button[data-command="${command}"]`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`Missing toolbar button command=${command}`);
  return button;
}

type MockTransfer = {
  _data: Record<string, string>;
  setData(type: string, value: string): void;
  getData(type: string): string;
};

function makeMockTransfer(seed?: Record<string, string>): MockTransfer {
  const data = { ...(seed ?? {}) };
  return {
    _data: data,
    setData(type, value) {
      data[type] = value;
    },
    getData(type) {
      return data[type] ?? "";
    },
  };
}

describe("dom runtime: createComponent and Ctx primitives", () => {
  test("ctx.on registers and disposes listeners", async () => {
    const { core } = makeCoreRuntime();
    const hit = spy();

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      const btn = el("button");
      host.append(btn);
      ctx.on(btn, "click", () => hit.fn());
      return host;
    });

    const unmount = mount(c);

    const btn = c.el.querySelector("button") as HTMLButtonElement;
    btn.click();
    expect(hit.count()).toBe(1);

    unmount();

    expect(btn.isConnected).toBe(false);
    btn.click();
    expect(hit.count()).toBe(1);

    await flushDomEffects();
  });

  test("ctx.effect runs, re-runs, and cleans up", async () => {
    const { core } = makeCoreRuntime();
    const s = signal(0);
    const ran = spy<[number]>();
    const cleaned = spy<[number]>();

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      ctx.effect(() => {
        const signalValue = s.value;
        ran.fn(signalValue);
        return () => cleaned.fn(signalValue);
      });
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    expect(ran.calls.map((x) => x[0])).toEqual([0]);
    expect(cleaned.count()).toBe(0);

    s.value = 1;
    await flushDomEffects();

    expect(ran.calls.map((x) => x[0])).toEqual([0, 1]);
    expect(cleaned.calls.map((x) => x[0])).toEqual([0]);

    unmount();
    await flushDomEffects();

    expect(cleaned.calls.map((x) => x[0])).toEqual([0, 1]);
  });

  test("ctx.mount disposes child components", async () => {
    const { core } = makeCoreRuntime();
    const disposed = spy();

    const child: Component = {
      el: el("div"),
      dispose() {
        disposed.fn();
      },
    };

    const parent = createComponent(core, (ctx) => {
      const host = el("div");
      ctx.mount(host, child);
      return host;
    });

    const unmount = mount(parent);
    await flushDomEffects();

    expect(disposed.count()).toBe(0);
    unmount();
    expect(disposed.count()).toBe(1);
  });

  test("ctx.slot swaps components and disposes previous", async () => {
    const { core } = makeCoreRuntime();
    const which = signal<"none" | "a" | "b">("none");
    const aDisposed = spy();
    const bDisposed = spy();

    const mkChild = (name: "a" | "b"): Component => ({
      el: el("div", undefined, name),
      dispose() {
        (name === "a" ? aDisposed : bDisposed).fn();
      },
    });

    const parent = createComponent(core, (ctx) => {
      const host = el("div");
      ctx.slot(host, () => {
        if (which.value === "a") return mkChild("a");
        if (which.value === "b") return mkChild("b");
        return null;
      });
      return host;
    });

    const unmount = mount(parent);
    await flushDomEffects();

    expect(parent.el.textContent ?? "").toBe("");

    which.value = "a";
    await flushDomEffects();
    expect(parent.el.textContent).toBe("a");
    expect(aDisposed.count()).toBe(0);

    which.value = "b";
    await flushDomEffects();
    expect(parent.el.textContent).toBe("b");
    expect(aDisposed.count()).toBe(1);
    expect(bDisposed.count()).toBe(0);

    unmount();
    await flushDomEffects();
    expect(bDisposed.count()).toBe(1);
  });

  test("ctx.list: reorder preserves element identity and does not recreate children", async () => {
    const { core } = makeCoreRuntime();
    const ids = signal<readonly string[]>(["a", "b", "c"]);
    const created = spy<[string]>();
    const disposed = spy<[string]>();
    const byId = new Map<string, HTMLElement>();

    const parent = createComponent(core, (ctx) => {
      const host = el("div");
      ctx.list<string>(
        host,
        () => ids.value,
        (id) => {
          created.fn(id);
          const node = el("div");
          node.dataset.id = id;
          byId.set(id, node);
          return {
            el: node,
            dispose() {
              disposed.fn(id);
            },
          };
        },
      );
      return host;
    });

    const unmount = mount(parent);
    await flushDomEffects();

    expect(created.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(disposed.count()).toBe(0);

    const a0 = byId.get("a")!;
    const b0 = byId.get("b")!;
    const c0 = byId.get("c")!;

    ids.value = ["c", "b", "a"];
    await flushDomEffects();

    expect(created.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);
    expect(disposed.count()).toBe(0);

    const rendered = [
      ...parent.el.querySelectorAll("[data-id]"),
    ] as HTMLElement[];
    expect(rendered.map((n) => n.dataset.id ?? "")).toEqual(["c", "b", "a"]);

    expect(rendered.find((n) => n.dataset.id === "a")).toBe(a0);
    expect(rendered.find((n) => n.dataset.id === "b")).toBe(b0);
    expect(rendered.find((n) => n.dataset.id === "c")).toBe(c0);

    unmount();
  });

  test("ctx.list: removal disposes removed children once", async () => {
    const { core } = makeCoreRuntime();
    const ids = signal<readonly string[]>(["a", "b", "c"]);
    const disposed = spy<[string]>();

    const parent = createComponent(core, (ctx) => {
      const host = el("div");
      ctx.list<string>(
        host,
        () => ids.value,
        (id) => {
          const node = el("div");
          node.dataset.id = id;
          return {
            el: node,
            dispose() {
              disposed.fn(id);
            },
          };
        },
      );
      return host;
    });

    const unmount = mount(parent);
    await flushDomEffects();

    ids.value = ["a", "c"];
    await flushDomEffects();

    expect(disposed.calls.map((c) => c[0])).toEqual(["b"]);

    ids.value = ["a", "c"];
    await flushDomEffects();

    expect(disposed.calls.map((c) => c[0])).toEqual(["b"]);

    unmount();
  });

  test("ctx.list: addition creates only new keys", async () => {
    const { core } = makeCoreRuntime();
    const ids = signal<readonly string[]>(["a", "b"]);
    const created = spy<[string]>();

    const parent = createComponent(core, (ctx) => {
      const host = el("div");
      ctx.list<string>(
        host,
        () => ids.value,
        (id) => {
          created.fn(id);
          const node = el("div");
          node.dataset.id = id;
          return { el: node, dispose() {} };
        },
      );
      return host;
    });

    const unmount = mount(parent);
    await flushDomEffects();

    expect(created.calls.map((c) => c[0])).toEqual(["a", "b"]);

    ids.value = ["a", "b", "c"];
    await flushDomEffects();

    expect(created.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);

    ids.value = ["c", "a", "b"];
    await flushDomEffects();

    expect(created.calls.map((c) => c[0])).toEqual(["a", "b", "c"]);

    unmount();
  });
});

describe("dom toolbar", () => {
  test("reflects current state and disables invalid content conversions", async () => {
    const { core, rootId } = makeCoreRuntime();
    const groupId = mkGroup(core, rootId, { label: "group" });
    mkBlank(core, groupId, { label: "child", value: "x" });

    core.focus({ type: "item", location: { item: groupId, portals: [] } });

    const toolbar = buildToolbar(core);
    const unmount = mount(toolbar);
    await flushDomEffects();

    expect(
      requireToolbarButton("outline").classList.contains("is-active"),
    ).toBe(true);
    expect(requireToolbarButton("plain").classList.contains("is-active")).toBe(
      true,
    );
    expect(requireToolbarButton("formula").disabled).toBe(true);
    expect(requireToolbarButton("query").disabled).toBe(true);

    unmount();
  });

  test("clicking commands updates the selected item", async () => {
    const { core, rootId } = makeCoreRuntime();
    const valueId = mkBlank(core, rootId, { label: "x", value: "hello" });

    core.focus({ type: "item", location: { item: valueId, portals: [] } });

    const toolbar = buildToolbar(core);
    const unmount = mount(toolbar);
    await flushDomEffects();

    requireToolbarButton("formula").click();
    await flushDomEffects();
    expect(core.item(valueId).mode.type).toBe("connected");
    expect(
      requireToolbarButton("formula").classList.contains("is-active"),
    ).toBe(true);

    requireToolbarButton("plain").click();
    await flushDomEffects();
    expect(core.item(valueId).mode.type).toBe("plain");
    expect(requireToolbarButton("plain").classList.contains("is-active")).toBe(
      true,
    );

    requireToolbarButton("table").click();
    await flushDomEffects();
    expect(core.view(valueId)).toBe("table");
    expect(requireToolbarButton("table").classList.contains("is-active")).toBe(
      true,
    );

    unmount();
  });
});

describe("dom/contenteditable utility contracts", () => {
  test("render/read plain text round-trips with trailing-newline sentinel", () => {
    const surface = el("div");

    renderPlainTextToContentEditable(surface, "a\n");

    expect([...surface.childNodes].map((n) => n.nodeName)).toEqual([
      "#text",
      "BR",
      "BR",
    ]);
    const sentinel = surface.lastChild as HTMLBRElement | null;
    expect(sentinel?.dataset.ceSentinel).toBe("1");
    expect(readPlainTextFromContentEditable(surface)).toBe("a\n");
  });

  test("readPlainTextFromContentEditable converts block wrappers to line breaks", () => {
    const surface = el("div");
    surface.innerHTML = "<div>a</div><div>b</div>";

    expect(readPlainTextFromContentEditable(surface)).toBe("a\nb");
  });

  test("textOffsetToDomPoint and domPointToTextOffset round-trip logical offsets", () => {
    const surface = el("div");
    renderPlainTextToContentEditable(surface, "ab\ncd");

    for (let offset = 0; offset <= 5; offset += 1) {
      const point = textOffsetToDomPoint(surface, offset);
      expect(domPointToTextOffset(surface, point.node, point.offset)).toBe(
        offset,
      );
    }
  });

  test("setDomSelectionRange and setDomCaret update window selection", () => {
    const surface = el("div");
    document.body.append(surface);
    renderPlainTextToContentEditable(surface, "hello");

    const anchor = textOffsetToDomPoint(surface, 2);
    const focus = textOffsetToDomPoint(surface, 4);

    expect(setDomSelectionRange(anchor, focus)).toBe(true);
    const sel = window.getSelection();
    expect(sel?.toString()).toBe("ll");
    expect(sel?.isCollapsed).toBe(false);

    expect(setDomCaret(textOffsetToDomPoint(surface, 1))).toBe(true);
    expect(sel?.isCollapsed).toBe(true);
    expect(sel?.toString()).toBe("");
    document.body.replaceChildren();
  });

  test("getCollapsedCaretRectInSurface falls back to the blank surface start rect", () => {
    const root = el("div");
    const surface = el("div");
    root.append(surface);
    document.body.replaceChildren(root);

    const sel = window.getSelection();
    if (!sel) throw new Error("Missing window selection");
    const range = document.createRange();
    range.setStart(surface, 0);
    range.setEnd(surface, 0);
    sel.removeAllRanges();
    sel.addRange(range);

    const original = surface.getBoundingClientRect.bind(surface);
    surface.getBoundingClientRect = () => new DOMRect(45, 80, 100, 20);

    const info = getCollapsedCaretRectInSurface(root, surface);

    expect(info).toBeTruthy();
    expect(info?.rect.left).toBe(45);
    expect(info?.rect.right).toBe(45);
    expect(info?.rect.top).toBe(80);
    expect(info?.rect.bottom).toBe(100);

    surface.getBoundingClientRect = original;
    document.body.replaceChildren();
  });

  test("data transfer helpers read and write text/plain", () => {
    const transfer = makeMockTransfer({ "text/plain": "hello" });
    expect(
      getPlainTextFromDataTransfer(transfer as unknown as DataTransfer),
    ).toBe("hello");

    const ev = new Event("copy", {
      bubbles: true,
      cancelable: true,
    }) as ClipboardEvent;
    Object.defineProperty(ev, "clipboardData", {
      value: makeMockTransfer(),
      configurable: true,
    });

    expect(writePlainTextClipboard(ev, "x")).toBe(true);
    expect(ev.clipboardData?.getData("text/plain")).toBe("x");
  });
});

describe("bindItemFrame contract", () => {
  test("sets baseline frame attributes", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: 1 });
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const frame = el("div");
      bindItemFrame(ctx, { core, location }, frame);
      return frame;
    });

    const unmount = mount(c);
    await flushDomEffects();

    const frame = c.el as HTMLElement;
    expect(frame.classList.contains("ui-frame")).toBe(true);
    expect(frame.dataset.id).toBe(id);
    expect(frame.tabIndex).toBe(-1);

    unmount();
  });

  test("pointerdown focuses core and stops propagation", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: 1 });
    const location: Location = { item: id, portals: [] };

    const parentSaw = spy();

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      const frame = el("div");
      host.append(frame);

      host.addEventListener("pointerdown", () => parentSaw.fn());

      bindItemFrame(ctx, { core, location }, frame);
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    const frame = c.el.querySelector(".ui-frame") as HTMLElement;

    pointerDown(frame);
    await flushDomEffects();

    const selection = core.selection();
    expect(selection.type).toBe("item");
    if (selection.type !== "item") throw new Error("Expected item selection");
    expect(selection.head.portals).toEqual(location.portals);
    expect(selection.head.item).toBe(location.item);
    expect(parentSaw.count()).toBe(0);

    unmount();
  });

  test("pointerdown on contenteditable target does not force frame item focus", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: 1 });
    const other = mkBlank(core, rootId, { label: "y", value: 2 });
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const frame = el("div");
      const value = el("span");
      value.dataset.target = CONTENT_TEXT_TARGET;
      value.contentEditable = "true";
      value.textContent = "hello";
      frame.append(value);
      bindItemFrame(ctx, { core, location }, frame);
      return frame;
    });

    const unmount = mount(c);
    await flushDomEffects();

    core.focus({
      type: "item",
      anchor: { item: other, portals: [] },
      head: { item: other, portals: [] },
    });
    await flushDomEffects();

    const value = c.el.querySelector(
      `[data-target="${CONTENT_TEXT_TARGET}"]`,
    ) as HTMLElement;
    pointerDown(value);
    await flushDomEffects();

    const selection = core.selection();
    expect(selection.type).toBe("item");
    if (selection.type !== "item") throw new Error("Expected item selection");
    expect(selection.head.item).toBe(other);

    unmount();
  });

  test("pointerdown on frame shell preserves CE selection ownership and does not bubble to parent", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: 1 });
    const other = mkBlank(core, rootId, { label: "y", value: 2 });
    const location: Location = { item: id, portals: [] };
    const parentSaw = spy();

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      const frame = el("div");
      const value = el("span");
      value.dataset.target = CONTENT_TEXT_TARGET;
      value.contentEditable = "true";
      value.textContent = "hello";
      frame.append(value);
      host.append(frame);
      host.addEventListener("pointerdown", () => parentSaw.fn());
      bindItemFrame(ctx, { core, location }, frame);
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    core.focus({
      type: "item",
      anchor: { item: other, portals: [] },
      head: { item: other, portals: [] },
    });
    await flushDomEffects();

    const value = c.el.querySelector(
      `[data-target="${CONTENT_TEXT_TARGET}"]`,
    ) as HTMLElement;
    const textNode = value.firstChild as Text;
    const sel = window.getSelection();
    if (!sel) throw new Error("Missing window selection");
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 3);
    sel.removeAllRanges();
    sel.addRange(range);

    const frame = c.el.querySelector(".ui-frame") as HTMLElement;
    pointerDown(frame);
    await flushDomEffects();

    const selection = core.selection();
    expect(selection.type).toBe("item");
    if (selection.type !== "item") throw new Error("Expected item selection");
    expect(selection.head.item).toBe(other);
    expect(parentSaw.count()).toBe(0);

    unmount();
  });

  test("class toggles reflect Core: is-selected and is-issue", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: 1 });
    const other = mkBlank(core, rootId, { label: "y", value: 2 });
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const frame = el("div");
      bindItemFrame(ctx, { core, location }, frame);
      return frame;
    });

    const unmount = mountInItemFrame(core, location, c);
    await flushDomEffects();

    const frame = c.el as HTMLElement;

    core.focus({
      type: "item",
      anchor: { item: other, portals: [] },
      head: { item: other, portals: [] },
    });
    await flushDomEffects();
    expect(frame.classList.contains("is-selected")).toBe(false);

    core.focus({
      type: "item",
      anchor: { item: location.item, portals: [] },
      head: { item: location.item, portals: [] },
    });
    await flushDomEffects();
    expect(frame.classList.contains("is-selected")).toBe(true);

    setFormula(core, id, "unknown_name");
    await flushDomEffects();
    expect(frame.classList.contains("is-issue")).toBe(true);

    unmount();
  });
});

describe("mountHeader contract", () => {
  test("always renders label field (LABEL_TARGET)", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      mountHeader(ctx, {
        core,
        host,
        location,
        id,
        visibility: "always",
      });
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    requireTargetInput(c.el, LABEL_TARGET);

    unmount();
  });

  test("formula mode renders only expr field", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    setFormula(core, id, "");
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      mountHeader(ctx, {
        core,
        host,
        location,
        id,
        visibility: "always",
      });
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    requireTargetInput(c.el, connTarget("expr"));

    expect(queryTargetInput(c.el, connTarget("from"))).toBe(null);
    expect(queryTargetInput(c.el, connTarget("where"))).toBe(null);
    expect(queryTargetInput(c.el, connTarget("orderBy"))).toBe(null);

    unmount();
  });

  test("query mode renders from/where/orderBy in order", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    setQuery(core, id, { from: "rows", where: "", orderBy: "" });
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      mountHeader(ctx, {
        core,
        host,
        location,
        id,
        visibility: "always",
      });
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    requireTargetInput(c.el, connTarget("from"));
    requireTargetInput(c.el, connTarget("where"));
    requireTargetInput(c.el, connTarget("orderBy"));

    expect(connTargetsInHeaderConn(c.el)).toEqual([
      connTarget("from"),
      connTarget("where"),
      connTarget("orderBy"),
    ]);

    unmount();
  });

  test("switching connected modes reconciles fields (no stale inputs)", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    setQuery(core, id, { from: "rows", where: "", orderBy: "" });
    const location: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      mountHeader(ctx, {
        core,
        host,
        location,
        id,
        visibility: "always",
      });
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    expect(queryTargetInput(c.el, connTarget("from"))).toBeTruthy();
    expect(queryTargetInput(c.el, connTarget("expr"))).toBe(null);

    setFormula(core, id, "");
    await flushDomEffects();

    expect(queryTargetInput(c.el, connTarget("from"))).toBe(null);
    expect(queryTargetInput(c.el, connTarget("where"))).toBe(null);
    expect(queryTargetInput(c.el, connTarget("orderBy"))).toBe(null);
    expect(queryTargetInput(c.el, connTarget("expr"))).toBeTruthy();

    unmount();
  });
});

describe("smoke: item TYPE intent model-apply path", () => {
  test("TYPE dispatch moves to primary edit target and types a character", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const location: Location = { item: id, portals: [] };

    const mounted = core.mountView({
      id,
      portals: location.portals,
      view: "outline",
    });
    const unmount = mount(mounted);
    await flushDomEffects();

    core.focus({
      type: "item",
      anchor: { item: location.item, portals: [] },
      head: { item: location.item, portals: [] },
    });
    await flushDomEffects();

    core.dispatch({ type: "TYPE", char: "a" });

    await flushDomEffects();
    await flushDomEffects();

    const sel1 = core.selection();
    expect(sel1.type).toBe("editing");
    if (sel1.type !== "editing") throw new Error("Expected editing selection");
    expect(sel1.location).toEqual(location);
    expect(sel1.target).toBe(CONTENT_TEXT_TARGET);
    expect(core.item(id).content).toEqual({ type: "value", value: "a" });

    unmount();
  });
});

describe("dom runtime: UiCore target binding and view mounting", () => {
  test("global Cmd+Z and Cmd+Shift+Z route through core history", () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "one" });
    const rootBoundary = document.body.lastElementChild as HTMLElement | null;
    if (!rootBoundary) throw new Error("Missing root boundary");

    core.commit((t) => {
      t.setValue(id, "two");
    });
    expect(core.item(id).content).toEqual({ type: "value", value: "two" });

    const undo = dispatchKey(rootBoundary, "z", { metaKey: true });
    expect(undo).toBe(true);
    expect(core.item(id).content).toEqual({ type: "value", value: "one" });

    const redo = dispatchKey(rootBoundary, "z", {
      metaKey: true,
      shiftKey: true,
    });
    expect(redo).toBe(true);
    expect(core.item(id).content).toEqual({ type: "value", value: "two" });
  });

  test("global Ctrl+Y redoes through core history", () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "one" });
    const rootBoundary = document.body.lastElementChild as HTMLElement | null;
    if (!rootBoundary) throw new Error("Missing root boundary");

    core.commit((t) => {
      t.setValue(id, "two");
    });
    core.undo();
    expect(core.item(id).content).toEqual({ type: "value", value: "one" });

    const redo = dispatchKey(rootBoundary, "y", { ctrlKey: true });
    expect(redo).toBe(true);
    expect(core.item(id).content).toEqual({ type: "value", value: "two" });
  });

  test("Cmd+. stays local inside an active text field", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "label" });
    setFormula(core, id, "value");

    const mounted = core.mountView({
      id: rootId,
      portals: [],
      view: "outline",
    });
    const unmount = mount(mounted);
    await flushDomEffects();

    core.focus({
      type: "editing",
      location: { item: id, portals: [] },
      target: connTarget("expr"),
    });
    await flushDomEffects();

    const exprInp = requireTargetInput(mounted.el, connTarget("expr"));
    expect(document.activeElement).toBe(exprInp);

    const editLabel = dispatchKey(exprInp, ".", { metaKey: true });
    expect(editLabel).toBe(false);

    await flushDomEffects();
    await flushDomEffects();

    expect(document.activeElement).toBe(exprInp);

    const selection = core.selection();
    expect(selection.type).toBe("editing");
    if (selection.type !== "editing") throw new Error("Expected editing");
    expect(selection.location).toEqual({ item: id, portals: [] });
    expect(selection.target).toBe(connTarget("expr"));
    expect(exprInp.selectionStart).toBe(exprInp.value.length);
    expect(exprInp.selectionEnd).toBe(exprInp.value.length);

    unmount();
  });

  test("global Cmd+. falls back to the active view when the current item has no label target", async () => {
    const { core, rootId } = makeCoreRuntime();

    const tableId = mkGroup(core, rootId, { label: "table" });
    setView(core, tableId, "table");

    const row1 = mkGroup(core, tableId, { label: "r1" });
    const row2 = mkGroup(core, tableId, { label: "r2" });

    mkBlank(core, row1, { label: "name", value: "alice" });
    mkBlank(core, row1, { label: "score", value: 1 });
    const cell = childrenOf(core, row2)[2]!;
    const schemaRow = childrenOf(core, tableId)[0]!;
    const schemaCell = childrenOf(core, schemaRow)[2]!;

    core.commit((t) => t.setValue(cell, 2));

    const mounted = core.mountView({
      id: tableId,
      portals: [],
      view: "table",
    });
    const unmount = mount(mounted);
    await flushDomEffects();

    core.focus(
      {
        type: "editing",
        location: { item: cell, portals: [] },
        target: CONTENT_TEXT_TARGET,
      },
      { caret: "end" },
    );
    await flushDomEffects();

    const active = document.activeElement as HTMLElement | null;
    expect(active).toBeTruthy();
    if (!active) throw new Error("Expected active element");

    const editLabel = dispatchKey(active, ".", { metaKey: true });
    expect(editLabel).toBe(true);

    await flushDomEffects();
    await flushDomEffects();

    const selection = core.selection();
    expect(selection.type).toBe("editing");
    if (selection.type !== "editing") throw new Error("Expected editing");
    expect(selection.location).toEqual({ item: schemaCell, portals: [] });
    expect(selection.target).toBe(LABEL_TARGET);

    const labelInp = document.activeElement as HTMLInputElement | null;
    expect(labelInp?.dataset.target).toBe(LABEL_TARGET);
    expect(labelInp?.value).toBe("score");
    expect(labelInp?.selectionStart).toBe(labelInp?.value.length);
    expect(labelInp?.selectionEnd).toBe(labelInp?.value.length);

    unmount();
  });

  test("edit with exact target binding focuses correct element", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });
    const location = { item: x, portals: [] };

    const valueEl = document.createElement("input");
    document.body.append(valueEl);

    const cleanValue = core.attachTarget({
      location,
      target: CONTENT_TEXT_TARGET,
      getEl: () => valueEl,
    });

    core.focus({ type: "editing", location, target: CONTENT_TEXT_TARGET });
    await flushDomEffects();
    expect(document.activeElement).toBe(valueEl);

    cleanValue();
  });

  test("item selection focuses the bound structural item target", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });

    const mounted = core.mountView({
      id: rootId,
      portals: [],
      view: "outline",
    });
    const unmount = mount(mounted);
    await flushDomEffects();

    core.focus({ type: "item", location: { item: x, portals: [] } });
    await flushDomEffects();

    expect(document.activeElement).toBe(requireFrameEl(document.body, x));

    unmount();
  });

  test("new binding for same (location, target) replaces previous binding", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });
    const location = { item: x, portals: [] };

    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);

    const c1 = core.attachTarget({
      location,
      target: CONTENT_TEXT_TARGET,
      getEl: () => first,
    });
    core.focus({ type: "editing", location, target: CONTENT_TEXT_TARGET });
    await flushDomEffects();
    expect(document.activeElement).toBe(first);

    const c2 = core.attachTarget({
      location,
      target: CONTENT_TEXT_TARGET,
      getEl: () => second,
    });
    core.focus({ type: "editing", location, target: CONTENT_TEXT_TARGET });
    await flushDomEffects();
    expect(document.activeElement).toBe(second);

    c2();
    c1();
  });

  test("mountView with invalid or missing outline ids returns an inert view shell", async () => {
    const { core } = makeCoreRuntime();

    const invalidMounted = core.mountView({
      id: "not-an-id" as ItemId,
      portals: [],
      view: "outline",
    });
    const invalidUnmount = mount(invalidMounted);
    await flushDomEffects();
    expect(invalidMounted.el.classList.contains("ui-body")).toBe(true);
    expect(invalidMounted.el.classList.contains("ui-outline")).toBe(true);
    invalidUnmount();

    const missingMounted = core.mountView({
      id: "999999:" as ItemId,
      portals: [],
      view: "outline",
    });
    const missingUnmount = mount(missingMounted);
    await flushDomEffects();
    expect(missingMounted.el.classList.contains("ui-body")).toBe(true);
    expect(missingMounted.el.classList.contains("ui-outline")).toBe(true);
    missingUnmount();
  });

  test("mountView falls back to outline when resolved view factory is missing", () => {
    const { slider: _slider, ...viewsWithoutSlider } = viewRegistrations;
    const { core, rootId } = makeCoreRuntime({ views: viewsWithoutSlider });
    const s = mkBlank(core, rootId, { label: "s", value: 1 });
    setView(core, s, "slider");

    const mounted = core.mountView({ id: s, portals: [], view: "slider" });

    expect(mounted.el.classList.contains("ui-body")).toBe(true);
    expect(mounted.el.classList.contains("ui-outline")).toBe(true);

    mounted.dispose();
  });

  test("mountView throws when requested view and outline fallback are both missing", () => {
    const { core, rootId } = makeCoreRuntime({ views: {} });

    expect(() =>
      core.mountView({ id: rootId, portals: [], view: "outline" }),
    ).toThrow();
  });
});
