import type { Core, ItemId, ViewKind, ViewName, Focus } from "../core";
import type { DomHost, View } from "../ui/host";
import { type Component, el, ensureTabbable, contentField } from "../ui/dom";
import { createOutlineView } from "./outline";
import { createTableView } from "./table";
import { createSliderView } from "./slider";

export type Runtime = { core: Core; host: DomHost };

export type DomView = View & { root: HTMLElement };

export type ViewFactoryArgs = { runtime: Runtime; id: ItemId; focus?: Focus };
export type ViewFactory = (args: ViewFactoryArgs) => DomView;

const factories: Record<ViewName, ViewFactory> = {
  outline: createOutlineView,
  table: createTableView,
  slider: createSliderView,
};

export function createView(
  runtime: Runtime,
  viewKind: ViewKind,
  id: ItemId,
  focus?: Focus,
): DomView | null {
  if (viewKind == null) return null;
  return factories[viewKind]?.({ runtime, id, focus }) ?? null;
}

export function hasView(viewKind: ViewKind): boolean {
  return viewKind != null && viewKind in factories;
}

export function viewWantsChildView(viewKind: ViewKind): boolean {
  return viewKind === "table" || viewKind === "slider";
}

export function mountItemBody(
  runtime: Runtime,
  focus: Focus,
  id: ItemId,
  opts: {
    textKeys?: (
      inp: HTMLInputElement | HTMLTextAreaElement,
    ) => (() => void) | void;
    renderItemGroupChild?: (childId: ItemId) => Component;
    commitText?: (text: string) => void;
  } = {},
): Component {
  const { core, host } = runtime;
  const viewKind = core.get(id).view as ViewKind;

  if (!viewWantsChildView(viewKind)) {
    return contentField({
      core,
      host,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
      commitText: opts.commitText,
    });
  }

  const child = createView(runtime, viewKind, id, focus);
  if (!child) {
    return contentField({
      core,
      host,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
      commitText: opts.commitText,
    });
  }

  const hostEl = el("div") as HTMLElement & { __unmount?: () => void };
  ensureTabbable(hostEl);
  ensureTabbable(child.root);

  hostEl.__unmount = host.mountViewInto(hostEl, child);
  hostEl.replaceChildren(child.root);

  return {
    el: hostEl,
    dispose() {
      hostEl.__unmount?.();
      hostEl.__unmount = undefined;
      hostEl.replaceChildren();
    },
  };
}
