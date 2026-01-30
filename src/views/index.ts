import type { Core, ItemId, ViewKind, ViewName, Focus } from "../core";
import { ensureTabbable, contentField, el, type Component } from "../ui/dom";
import { createOutlineView } from "./outline";
import { createTableView } from "./table";
import { createSliderView } from "./slider";

export type DomView = {
  id: string;
  root: HTMLElement;
  onKeyDown?: (e: KeyboardEvent) => void;
  dispose(): void;
};

export type ViewFactoryArgs = { core: Core; id: ItemId; focus?: Focus };
export type ViewFactory = (args: ViewFactoryArgs) => DomView;

const factories: Record<ViewName, ViewFactory> = {
  outline: createOutlineView as any,
  table: createTableView as any,
  slider: createSliderView as any,
};

export function createView(
  runtime: { core: Core } | Core,
  viewKind: ViewKind,
  id: ItemId,
  focus?: Focus,
): DomView | null {
  const core = (runtime as any).core
    ? (runtime as any).core
    : (runtime as Core);
  if (viewKind == null) return null;
  const fn = factories[viewKind];
  return fn ? fn({ core, id, focus }) : null;
}

export function hasView(viewKind: ViewKind): boolean {
  return viewKind != null && viewKind in factories;
}

export function viewWantsChildView(viewKind: ViewKind): boolean {
  return viewKind === "table" || viewKind === "slider";
}

export function mountItemBody(
  core: Core,
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
  const viewKind = core.meta(id).view as ViewKind;

  if (!viewWantsChildView(viewKind)) {
    return contentField({
      core,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
      commitText: opts.commitText,
    });
  }

  const child = createView(core, viewKind, id, focus);
  if (!child) {
    return contentField({
      core,
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

  const unmountRoot = core.attachView({
    root: child.root,
    onKeyDown: child.onKeyDown,
  });
  hostEl.__unmount = () => {
    unmountRoot();
    child.dispose();
  };

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
