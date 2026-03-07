import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll, expect } from "bun:test";

import type {
  CollabWire,
  Intent,
  ItemId,
  Location,
  ViewName,
} from "../src/core";
import type { DomView, UiCore } from "../src/dom";
import { createUiCoreRuntime } from "../src/setup";
import { viewRegistrations } from "../src/views";

export {
  childrenOf,
  expectSel,
  mkBlank,
  mkGroup,
  requireCreatedEntryId,
  setFormula,
  setQuery,
  setView,
  valueOf,
  valueOfId,
} from "./core-test-utils";

const cleanups: Array<() => void> = [];
const capturedPointers = new WeakMap<HTMLElement, Set<number>>();

function ensureCapturedPointers(el: HTMLElement): Set<number> {
  let pointers = capturedPointers.get(el);
  if (!pointers) {
    pointers = new Set<number>();
    capturedPointers.set(el, pointers);
  }
  return pointers;
}

function drainCleanups(): void {
  document.body.replaceChildren();
  for (const fn of cleanups.toReversed()) fn();
  cleanups.length = 0;
}

beforeAll(() => {
  GlobalRegistrator.register();
  HTMLElement.prototype.setPointerCapture = function (
    this: HTMLElement,
    pointerId: number,
  ): void {
    ensureCapturedPointers(this).add(pointerId);
  };
  HTMLElement.prototype.hasPointerCapture = function (
    this: HTMLElement,
    pointerId: number,
  ): boolean {
    return capturedPointers.get(this)?.has(pointerId) ?? false;
  };
  HTMLElement.prototype.releasePointerCapture = function (
    this: HTMLElement,
    pointerId: number,
  ): void {
    capturedPointers.get(this)?.delete(pointerId);
  };
});

afterEach(() => {
  drainCleanups();
});

export function makeCoreRuntime(args?: {
  views?: Partial<typeof viewRegistrations>;
  collab?: CollabWire;
}): { core: UiCore; rootId: ItemId } {
  drainCleanups();

  const { core, pureCore, rootId, runtime } = createUiCoreRuntime({
    views: args?.views ?? viewRegistrations,
    ...(args?.collab ? { collab: args.collab } : {}),
  });
  const uninstallGlobal = runtime.installGlobalListeners(window);

  cleanups.push(() => {
    uninstallGlobal();
    runtime.dispose();
    pureCore.dispose();
  });
  return { core, rootId };
}

const viewFactories = Object.fromEntries(
  Object.entries(viewRegistrations).map(([viewName, registration]) => [
    viewName,
    registration.factory,
  ]),
) as Record<ViewName, (typeof viewRegistrations)[ViewName]["factory"]>;

export async function mountView(args: {
  view: Extract<ViewName, "outline" | "table" | "slider">;
  core: UiCore;
  id: ItemId;
  location: Location;
}): Promise<{ domView: DomView; unmount: () => void }> {
  const { view, core, id, location } = args;
  const domView = viewFactories[view]({ core, id, location });
  document.body.replaceChildren(domView.root);
  const unmount = (): void => {
    domView.dispose();
    document.body.replaceChildren();
  };
  await flushDomEffects();
  return { domView, unmount };
}

function intentFromKey(
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): Intent | null {
  if (key === "Escape") {
    return {
      type: "NAV",
      dir: "out",
      mode: opts.metaKey || opts.ctrlKey ? "jump" : "step",
    };
  }
  if (key === "Tab") return { type: "TAB", shift: !!opts.shiftKey };
  if (key === "Enter") return { type: "CONFIRM" };
  if ((opts.metaKey || opts.ctrlKey) && !opts.altKey) {
    if (key.toLowerCase() === "z") {
      return {
        type: "HISTORY",
        action: opts.shiftKey ? "redo" : "undo",
      };
    }
    if (key.toLowerCase() === "y") {
      return { type: "HISTORY", action: "redo" };
    }
    if (key === ".") {
      return { type: "EDIT_LABEL" };
    }
  }
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

export function fireViewKey(
  view: DomView,
  key: string,
  opts?: Partial<KeyboardEventInit>,
): void {
  const intent = intentFromKey(key, opts);
  if (!intent) return;
  view.onIntent?.(intent);
}

type ElSnapshot = { el: Element; keyEls: Element[] };

export function snapshotEl(
  element: Element,
  keySelectors: string[] = [],
): ElSnapshot {
  const keyEls: Element[] = [];
  for (const sel of keySelectors) {
    const hit = (element as ParentNode).querySelector(sel);
    if (!hit) throw new Error(`Missing key element selector=${sel}`);
    keyEls.push(hit);
  }
  return { el: element, keyEls };
}

export function expectSnapshotSame(
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

type CapturedWindowHandlers = {
  emitPointer(
    type: "pointermove" | "pointerup" | "pointercancel",
    init: { pointerId?: number; clientX?: number; clientY?: number },
  ): void;
  emitKeydown(key: string): void;
  dispose(): void;
};

export function installCapturedWindowHandlers(): CapturedWindowHandlers {
  const origAdd = window.addEventListener.bind(window);
  const origRemove = window.removeEventListener.bind(window);
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: AddEventListenerOptions | boolean,
  ) => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(listener);
    return origAdd(type, listener, options as never);
  }) as typeof window.addEventListener;

  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: EventListenerOptions | boolean,
  ) => {
    listeners.get(type)?.delete(listener);
    return origRemove(type, listener, options as never);
  }) as typeof window.removeEventListener;

  const call = (type: string, ev: Event): void => {
    for (const listener of listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(ev);
      else listener.handleEvent(ev);
    }
  };

  return {
    emitPointer(type, init) {
      call(type, {
        pointerId: init.pointerId,
        clientX: init.clientX ?? 0,
        clientY: init.clientY ?? 0,
      } as unknown as Event);
    },
    emitKeydown(key) {
      call("keydown", new KeyboardEvent("keydown", { key }));
    },
    dispose() {
      window.addEventListener = origAdd;
      window.removeEventListener = origRemove;
    },
  };
}

export function dispatchKey(
  target: Element,
  key: string,
  opts: Partial<KeyboardEventInit> = {},
): { defaultPrevented: boolean; bubbled: number } {
  let bubbled = 0;
  const onBubble = () => {
    bubbled += 1;
  };
  window.addEventListener("keydown", onBubble);

  const ev = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...opts,
  });

  target.dispatchEvent(ev);
  window.removeEventListener("keydown", onBubble);

  return { defaultPrevented: ev.defaultPrevented, bubbled };
}

export async function flushDomEffects(turns = 2): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

export function queryTargetInput(
  root: ParentNode,
  target: string,
): HTMLTextAreaElement | HTMLInputElement | null {
  const selector = `textarea[data-target="${target}"], input[data-target="${target}"]`;
  return root.querySelector(selector) as
    | HTMLTextAreaElement
    | HTMLInputElement
    | null;
}

function findFrameEl(root: ParentNode, id: ItemId): HTMLElement | null {
  return root.querySelector(`.ui-frame[data-id="${id}"]`) as HTMLElement | null;
}

export function requireFrameEl(root: ParentNode, id: ItemId): HTMLElement {
  const frameEl = findFrameEl(root, id);
  if (!frameEl) throw new Error(`Missing frame element for id=${String(id)}`);
  return frameEl;
}

export function requireTargetInput(
  root: ParentNode,
  target: string,
): HTMLTextAreaElement | HTMLInputElement {
  const targetInput = queryTargetInput(root, target);
  if (!targetInput) throw new Error(`Missing input for target=${target}`);
  return targetInput;
}

export function pointerDown(element: HTMLElement): void {
  element.dispatchEvent(
    new Event("pointerdown", { bubbles: true, cancelable: true }),
  );
}

export function dispatchPointerEvent(
  target: EventTarget,
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  init: {
    button?: number;
    pointerId?: number;
    clientX?: number;
    clientY?: number;
    shiftKey?: boolean;
    altKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    bubbles?: boolean;
    cancelable?: boolean;
  } = {},
): Event {
  const ev = new PointerEvent(type, {
    bubbles: init.bubbles ?? true,
    cancelable: init.cancelable ?? true,
    button: init.button ?? 0,
    pointerId: init.pointerId ?? 1,
    clientX: init.clientX ?? 0,
    clientY: init.clientY ?? 0,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
  });
  Object.defineProperties(ev, {
    button: { value: init.button ?? 0, configurable: true },
    pointerId: { value: init.pointerId ?? 1, configurable: true },
    clientX: { value: init.clientX ?? 0, configurable: true },
    clientY: { value: init.clientY ?? 0, configurable: true },
    shiftKey: { value: init.shiftKey ?? false, configurable: true },
    altKey: { value: init.altKey ?? false, configurable: true },
    ctrlKey: { value: init.ctrlKey ?? false, configurable: true },
    metaKey: { value: init.metaKey ?? false, configurable: true },
  });

  target.dispatchEvent(ev);
  return ev;
}

export function requireEl<T extends Element>(
  element: T | null,
  msg = "Missing element",
): T {
  if (!element) throw new Error(msg);
  return element;
}
