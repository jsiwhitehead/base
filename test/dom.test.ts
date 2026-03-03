import { signal } from "@preact/signals-core";
import { describe, expect, test } from "bun:test";

import type { Location, Intent, ItemId } from "../src/core";
import { LABEL_TARGET, VALUE_TARGET, connTarget } from "../src/core";
import type { Component } from "../src/dom";
import {
  bindItemFrame,
  buildItemHeader,
  buildTextField,
  createComponent,
  domPointToTextOffset,
  el,
  getPlainTextFromDataTransfer,
  handleItemIntent,
  readPlainTextFromContentEditable,
  renderPlainTextToContentEditable,
  setDomCaret,
  setDomSelectionRange,
  textOffsetToDomPoint,
  writePlainTextClipboard,
} from "../src/dom";
import { viewRegistrations } from "../src/views";

import {
  dispatchKey,
  flushDomEffects,
  makeCoreRuntime,
  mkBlank,
  pointerDown,
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

function spy<T extends unknown[] = unknown[]>() {
  const calls: T[] = [];
  const fn = (...args: T) => {
    calls.push(args);
  };
  return { fn, calls, count: () => calls.length };
}

function setInputValueAndFireInput(
  inp: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  inp.value = value;
  inp.dispatchEvent(new InputEvent("input", { bubbles: true }));
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
    const focus: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const frame = el("div");
      bindItemFrame(ctx, { core, focus }, frame);
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
    const focus: Location = { item: id, portals: [] };

    const parentSaw = spy();

    const c = createComponent(core, (ctx) => {
      const host = el("div");
      const frame = el("div");
      host.append(frame);

      host.addEventListener("pointerdown", () => parentSaw.fn());

      bindItemFrame(ctx, { core, focus }, frame);
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
    expect(selection.head.portals).toEqual(focus.portals);
    expect(selection.head.item).toBe(focus.item);
    expect(parentSaw.count()).toBe(0);

    unmount();
  });

  test("class toggles reflect Core: is-focused and is-issue", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: 1 });
    const other = mkBlank(core, rootId, { label: "y", value: 2 });
    const focus: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const frame = el("div");
      bindItemFrame(ctx, { core, focus }, frame);
      return frame;
    });

    const unmount = mount(c);
    await flushDomEffects();

    const frame = c.el as HTMLElement;

    core.focus({
      type: "item",
      anchor: { item: other, portals: [] },
      head: { item: other, portals: [] },
    });
    await flushDomEffects();
    expect(frame.classList.contains("is-focused")).toBe(false);

    core.focus({
      type: "item",
      anchor: { item: focus.item, portals: [] },
      head: { item: focus.item, portals: [] },
    });
    await flushDomEffects();
    expect(frame.classList.contains("is-focused")).toBe(true);

    setFormula(core, id, "unknown_name");
    await flushDomEffects();
    expect(frame.classList.contains("is-issue")).toBe(true);

    unmount();
  });
});

describe("buildTextField contract", () => {
  test("renders wrapper/input with required attributes", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("hello");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    expect(c.el.classList.contains("ui-textfield")).toBe(true);

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    expect(inp.classList.contains("ui-textfield-input")).toBe(true);
    expect(inp.dataset.target).toBe(VALUE_TARGET);
    expect(inp.tabIndex).toBe(-1);

    unmount();
  });

  test("autosize mirror exists and syncs (including trailing newline)", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: true,
      autosize: true,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const mirror = c.el.querySelector(
      ".ui-textfield-mirror",
    ) as HTMLSpanElement;
    expect(mirror).toBeTruthy();
    expect(mirror.getAttribute("aria-hidden")).toBe("true");

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "a");
    await flushDomEffects();
    expect(mirror.textContent).toBe("a");

    setInputValueAndFireInput(inp, "a\n");
    await flushDomEffects();
    expect(mirror.textContent).toBe("a\n\u200B");

    unmount();
  });

  test("default draft model does not commit on input until blur", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "h");
    setInputValueAndFireInput(inp, "hi");
    await flushDomEffects();

    expect(commit.calls).toHaveLength(0);

    inp.blur();
    await flushDomEffects();

    expect(commit.calls.map((c) => c[0])).toEqual(["hi"]);

    unmount();
  });

  test("focus + blur without edits does not commit", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    expect(commit.count()).toBe(0);

    inp.blur();
    await flushDomEffects();

    expect(commit.count()).toBe(0);

    unmount();
  });

  test("Escape cancels draft (reverts to baseline) without committing", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const text = signal("base");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);

    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "changed");
    await flushDomEffects();
    expect(inp.value).toBe("changed");

    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushDomEffects();

    expect(commit.count()).toBe(0);
    expect(inp.value).toBe("base");

    unmount();
  });

  test("dirty draft becomes stale when committed value changes externally", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("base");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "draft");
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(false);

    text.value = "external";
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(true);

    unmount();
  });

  test("committing while stale clears stale class and commits draft", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("base");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      kind: "traversable",
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "draft");
    await flushDomEffects();

    text.value = "external";
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(true);

    dispatchKey(inp, "Enter");
    await flushDomEffects();

    expect(c.el.classList.contains("is-stale")).toBe(false);
    expect(text.value).toBe("draft");

    unmount();
  });

  test("Escape while stale clears stale class and reverts to session baseline", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("base");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "draft");
    await flushDomEffects();

    text.value = "external";
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(true);

    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushDomEffects();

    expect(c.el.classList.contains("is-stale")).toBe(false);
    expect(inp.value).toBe("base");

    unmount();
  });

  test("blur while stale clears stale class and next focus shows latest committed", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("base");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "draft");
    await flushDomEffects();

    text.value = "external";
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(true);

    inp.blur();
    await flushDomEffects();

    expect(c.el.classList.contains("is-stale")).toBe(false);

    text.value = "latest";
    await flushDomEffects();

    inp.focus();
    await flushDomEffects();
    expect(inp.value).toBe("latest");

    unmount();
  });

  test("read-only transition while stale clears stale and resets to committed", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("base");
    const readOnly = signal(false);

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: readOnly.value }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "draft");
    await flushDomEffects();

    text.value = "external";
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(true);

    readOnly.value = true;
    await flushDomEffects();

    expect(c.el.classList.contains("is-stale")).toBe(false);
    expect(inp.readOnly).toBe(true);
    expect(inp.value).toBe("external");

    unmount();
  });

  test("focused clean external sync preserves caret", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("abcdef");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    inp.setSelectionRange(2, 2);
    text.value = "abcdefghi";
    await flushDomEffects();

    expect(inp.value).toBe("abcdefghi");
    expect(inp.selectionStart).toBe(2);
    expect(inp.selectionEnd).toBe(2);

    unmount();
  });

  test("dirty session keeps baseline across multiple external committed updates", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const text = signal("base");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      commit: (t) => {
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "draft");
    await flushDomEffects();

    text.value = "external-1";
    await flushDomEffects();
    text.value = "external-2";
    await flushDomEffects();
    expect(c.el.classList.contains("is-stale")).toBe(true);

    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushDomEffects();

    expect(c.el.classList.contains("is-stale")).toBe(false);
    expect(inp.value).toBe("base");

    unmount();
  });

  test("traversable draft: Tab yields commit and bubbles; Enter yields commit and bubbles", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      kind: "traversable",
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "x");
    await flushDomEffects();

    {
      const r = dispatchKey(inp, "Tab");
      expect(r.defaultPrevented).toBe(true);
      expect(r.bubbled).toBe(1);
    }
    await flushDomEffects();
    expect(commit.calls.map((c) => c[0])).toEqual(["x"]);

    inp.focus();
    await flushDomEffects();
    setInputValueAndFireInput(inp, "y");
    await flushDomEffects();

    {
      const r = dispatchKey(inp, "Enter");
      expect(r.defaultPrevented).toBe(true);
      expect(r.bubbled).toBe(1);
    }
    await flushDomEffects();
    expect(commit.calls.map((c) => c[0])).toEqual(["x", "y"]);

    unmount();
  });

  test("isolated: stops propagation for most keys; Enter/Tab commit + exit", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const exit = spy();
    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      kind: "isolated",
      onExitToItem: () => exit.fn(),
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);

    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "z");
    await flushDomEffects();

    expect(dispatchKey(inp, "ArrowLeft").bubbled).toBe(0);
    expect(dispatchKey(inp, "Backspace").bubbled).toBe(0);
    expect(dispatchKey(inp, "a").bubbled).toBe(0);

    {
      const r = dispatchKey(inp, "Tab");
      expect(r.defaultPrevented).toBe(true);
      expect(r.bubbled).toBe(0);
    }
    await flushDomEffects();
    expect(commit.calls.map((c) => c[0])).toEqual(["z"]);
    expect(exit.count()).toBe(1);

    inp.focus();
    await flushDomEffects();
    setInputValueAndFireInput(inp, "zz");
    await flushDomEffects();

    {
      const r = dispatchKey(inp, "Enter");
      expect(r.defaultPrevented).toBe(true);
      expect(r.bubbled).toBe(0);
    }
    await flushDomEffects();
    expect(commit.calls.map((c) => c[0])).toEqual(["z", "zz"]);
    expect(exit.count()).toBe(2);

    unmount();
  });

  test("traversable: Backspace at start yields; DELETE at end yields", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: false,
      autosize: false,
      kind: "traversable",
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "abc");
    await flushDomEffects();

    inp.setSelectionRange(0, 0);
    {
      const r = dispatchKey(inp, "Backspace");
      expect(r.defaultPrevented).toBe(true);
      expect(r.bubbled).toBe(1);
    }
    await flushDomEffects();
    expect(commit.calls.map((c) => c[0])).toEqual(["abc"]);

    inp.focus();
    await flushDomEffects();
    setInputValueAndFireInput(inp, "abcd");
    await flushDomEffects();

    inp.setSelectionRange(inp.value.length, inp.value.length);
    {
      const r = dispatchKey(inp, "Delete");
      expect(r.defaultPrevented).toBe(true);
      expect(r.bubbled).toBe(1);
    }
    await flushDomEffects();
    expect(commit.calls.map((c) => c[0])).toEqual(["abc", "abcd"]);

    unmount();
  });

  test("traversable textarea: Up/Down stay native and do not yield", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const commit = spy<[string]>();
    const text = signal("");

    const c = buildTextField(core, {
      focus,
      target: VALUE_TARGET,
      multiline: true,
      autosize: false,
      kind: "traversable",
      commit: (t) => {
        commit.fn(t);
        text.value = t;
      },
      getState: () => ({ text: text.value, readOnly: false }),
    });

    const unmount = mount(c);
    await flushDomEffects();

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    expect(inp instanceof HTMLTextAreaElement).toBe(true);

    inp.focus();
    await flushDomEffects();

    setInputValueAndFireInput(inp, "a\nb\nc");
    await flushDomEffects();

    const midLine = inp.value.indexOf("b");
    inp.setSelectionRange(midLine, midLine);
    expect(dispatchKey(inp, "ArrowUp").bubbled).toBe(0);
    expect(dispatchKey(inp, "ArrowDown").bubbled).toBe(0);

    inp.setSelectionRange(0, 0);
    {
      const r = dispatchKey(inp, "ArrowUp");
      expect(r.defaultPrevented).toBe(false);
      expect(r.bubbled).toBe(0);
    }

    inp.setSelectionRange(inp.value.length, inp.value.length);
    {
      const r = dispatchKey(inp, "ArrowDown");
      expect(r.defaultPrevented).toBe(false);
      expect(r.bubbled).toBe(0);
    }

    unmount();
  });
});

describe("buildItemHeader contract", () => {
  test("always renders label field (LABEL_TARGET)", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const c = buildItemHeader(core, {
      focus,
      id,
      commitLabel: () => {},
      canEditLabel: () => true,
      commitConnField: () => {},
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
    const focus: Location = { item: id, portals: [] };

    const c = buildItemHeader(core, {
      focus,
      id,
      commitLabel: () => {},
      canEditLabel: () => true,
      commitConnField: () => {},
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
    const focus: Location = { item: id, portals: [] };

    const c = buildItemHeader(core, {
      focus,
      id,
      commitLabel: () => {},
      canEditLabel: () => true,
      commitConnField: () => {},
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
    const focus: Location = { item: id, portals: [] };

    const c = buildItemHeader(core, {
      focus,
      id,
      commitLabel: () => {},
      canEditLabel: () => true,
      commitConnField: () => {},
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
  test("TYPE moves to primary edit target and types a character", async () => {
    const { core, rootId } = makeCoreRuntime();
    const id = mkBlank(core, rootId, { label: "x", value: "" });
    const focus: Location = { item: id, portals: [] };

    const c = createComponent(core, (ctx) => {
      const host = el("div");

      const frame = el("div");
      bindItemFrame(ctx, { core, focus }, frame);

      const field = buildTextField(core, {
        focus,
        target: VALUE_TARGET,
        multiline: false,
        autosize: false,
        commit: (t) => {
          core.commit((tx) => tx.setValue(id, t));
        },
        getState: () => {
          const snap = core.item(id);
          const text =
            snap.content.type === "value"
              ? String(snap.content.value ?? "")
              : "";
          return { text, readOnly: false };
        },
      });

      ctx.mount(frame, field);
      host.append(frame);
      return host;
    });

    const unmount = mount(c);
    await flushDomEffects();

    core.focus({
      type: "item",
      anchor: { item: focus.item, portals: [] },
      head: { item: focus.item, portals: [] },
    });
    await flushDomEffects();

    const selection = core.selection();
    expect(selection.type).toBe("item");
    if (selection.type !== "item") throw new Error("Expected item selection");
    const ok = handleItemIntent({
      core,
      sel: selection,
      intent: { type: "TYPE", char: "a" } as Extract<Intent, { type: "TYPE" }>,
    });
    expect(ok).toBe(true);

    await flushDomEffects();
    await flushDomEffects();

    const sel1 = core.selection();
    expect(sel1.type).toBe("editing");
    if (sel1.type !== "editing") throw new Error("Expected editing selection");
    expect(sel1.location).toEqual(focus);
    expect(sel1.target).toBe(VALUE_TARGET);

    const inp = requireTargetInput(c.el, VALUE_TARGET);
    expect(inp.value).toBe("a");

    unmount();
  });
});

describe("dom runtime: UiCore target binding and view mounting", () => {
  test("edit with exact target binding focuses correct element", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });
    const focus = { item: x, portals: [] };

    const valueEl = document.createElement("input");
    document.body.append(valueEl);

    const cleanValue = core.attachTarget({
      focus,
      target: VALUE_TARGET,
      getEl: () => valueEl,
    });

    core.focus({ type: "editing", location: focus, target: VALUE_TARGET });
    await flushDomEffects();
    expect(document.activeElement).toBe(valueEl);

    cleanValue();
  });

  test("new binding for same (focus, target) replaces previous binding", async () => {
    const { core, rootId } = makeCoreRuntime();
    const x = mkBlank(core, rootId, { label: "x", value: "v" });
    const focus = { item: x, portals: [] };

    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);

    const c1 = core.attachTarget({
      focus,
      target: VALUE_TARGET,
      getEl: () => first,
    });
    core.focus({ type: "editing", location: focus, target: VALUE_TARGET });
    await flushDomEffects();
    expect(document.activeElement).toBe(first);

    const c2 = core.attachTarget({
      focus,
      target: VALUE_TARGET,
      getEl: () => second,
    });
    core.focus({ type: "editing", location: focus, target: VALUE_TARGET });
    await flushDomEffects();
    expect(document.activeElement).toBe(second);

    c2();
    c1();
  });

  test("mountView throws for invalid or missing item ids", () => {
    const { core } = makeCoreRuntime();

    expect(() =>
      core.mountView({
        id: "not-an-id" as ItemId,
        portals: [],
      }),
    ).toThrow();
    expect(() =>
      core.mountView({
        id: "999999:" as ItemId,
        portals: [],
      }),
    ).toThrow();
  });

  test("mountView falls back to outline when resolved view factory is missing", () => {
    const { slider: _slider, ...viewsWithoutSlider } = viewRegistrations;
    const { core, rootId } = makeCoreRuntime({ views: viewsWithoutSlider });
    const s = mkBlank(core, rootId, { label: "s", value: 1 });
    setView(core, s, "slider");

    const mounted = core.mountView({ id: s, portals: [] });

    expect(mounted.el.classList.contains("ui-body")).toBe(true);
    expect(mounted.el.classList.contains("ui-outline")).toBe(true);

    mounted.dispose();
  });

  test("mountView throws when requested view and outline fallback are both missing", () => {
    const { core, rootId } = makeCoreRuntime({ views: {} });

    expect(() => core.mountView({ id: rootId, portals: [] })).toThrow();
  });
});
