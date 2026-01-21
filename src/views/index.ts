import type { ItemId, ViewKind } from "../store";
import type { Editor, View, Focus, EditorRuntime, Selection } from "../editor";
import type { Component } from "../ui";
import { el, ensureTabbable, valueField, mountChildViewInto } from "../ui";
import { createTreeView } from "./tree";
import { createTableView } from "./table";
import { createSliderView } from "./slider";

export type ViewCtx = { editor: Editor };
export type ViewFactory = (ctx: ViewCtx, id: ItemId, focus?: Focus) => View;

const factories = {
  tree: createTreeView,
  table: createTableView,
  slider: createSliderView,
} as const satisfies Record<ViewKind, ViewFactory | undefined>;

export function createViewForItem(
  ctx: ViewCtx,
  viewKind: ViewKind,
  id: ItemId,
  focus?: Focus,
): View | null {
  return factories[viewKind]?.(ctx, id, focus) ?? null;
}

export function hasView(viewKind: ViewKind): boolean {
  return viewKind in factories;
}

export function viewWantsChildView(viewKind: ViewKind): boolean {
  return viewKind === "table" || viewKind === "slider";
}

export const createChildViewForItem = createViewForItem;

export type MountedView = {
  id: string;
  view: View;
  unmount(): void;
};

export function mountView(
  runtime: EditorRuntime,
  host: HTMLElement,
  view: View,
): MountedView {
  runtime.registerView(view);
  host.replaceChildren(view.root);

  let mounted = true;

  const unmount = () => {
    if (!mounted) return;
    mounted = false;
    runtime.unregisterView(view.id);
    view.dispose();
  };

  return { id: view.id, view, unmount };
}

export function replaceMountedView(
  runtime: EditorRuntime,
  host: HTMLElement,
  current: MountedView | null,
  next: View | null,
): MountedView | null {
  if (current?.view === next) return current;

  current?.unmount();
  host.replaceChildren();

  return next ? mountView(runtime, host, next) : null;
}

export function mountViewWithIdleSelection(
  runtime: EditorRuntime,
  host: HTMLElement,
  view: View,
  opts: {
    isIdle: () => boolean;
    setSelection: (sel: Selection) => void;
    idleSelection: Selection;
  },
): MountedView {
  const mounted = mountView(runtime, host, view);
  if (opts.isIdle()) opts.setSelection(opts.idleSelection);
  return mounted;
}

export function itemBody(
  ctx: { editor: Editor; focus: Focus; id: ItemId },
  opts: {
    textKeys?: (
      inp: HTMLInputElement | HTMLTextAreaElement,
    ) => (() => void) | void;
    renderItemGroupChild?: (childId: ItemId) => Component;
  } = {},
): Component {
  const { editor, id, focus } = ctx;
  const viewKind = editor.store.sel.item(id).view as ViewKind;

  if (!viewWantsChildView(viewKind)) {
    return valueField({
      editor,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
    });
  }

  const child = createViewForItem({ editor }, viewKind, id, focus);
  if (!child) {
    return valueField({
      editor,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
    });
  }

  const host = el("div") as HTMLElement & { __unmount?: () => void };
  ensureTabbable(host);
  ensureTabbable(child.root);

  host.__unmount = mountChildViewInto(editor, host, child);
  host.replaceChildren(child.root);

  return {
    el: host,
    dispose() {
      host.__unmount?.();
      host.__unmount = undefined;
      host.replaceChildren();
    },
  };
}
