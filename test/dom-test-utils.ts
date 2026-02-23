import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeAll } from "bun:test";

import type { ItemId } from "../src/core";
import { createCore } from "../src/core";
import type { UiCore } from "../src/dom";
import { createUiCoreRuntime } from "../src/setup";
import { viewRegistrations } from "../src/views";

export {
  childrenOf,
  expectFocused,
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

beforeAll(() => {
  GlobalRegistrator.register();
});

afterEach(() => {
  document.body.replaceChildren();
  for (const fn of cleanups.toReversed()) fn();
  cleanups.length = 0;
});

export function makeCoreRuntime(args?: {
  views?: Partial<typeof viewRegistrations>;
  collab?: Parameters<typeof createCore>[0]["collab"];
}): { core: UiCore; rootId: ItemId } {
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

export function findFrameEl(root: ParentNode, id: ItemId): HTMLElement | null {
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

export function requireEl<T extends Element>(
  element: T | null,
  msg = "Missing element",
): T {
  if (!element) throw new Error(msg);
  return element;
}
