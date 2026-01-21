import type { ItemId, ViewKind } from "../store";
import type { Editor, View, Focus } from "../editor";
import type { Component } from "../dom";
import { el, ensureTabbable, contentField, mountViewInto } from "../dom";
import type { Evaluator } from "../eval";
import { createTreeView } from "./tree";
import { createTableView } from "./table";
import { createSliderView } from "./slider";

export type Runtime = { editor: Editor; eval: Evaluator };

export type ViewFactoryArgs = { runtime: Runtime; id: ItemId; focus?: Focus };
export type ViewFactory = (args: ViewFactoryArgs) => View;

const factories = {
  tree: createTreeView,
  table: createTableView,
  slider: createSliderView,
} as const satisfies Record<ViewKind, ViewFactory | undefined>;

export function createView(
  runtime: Runtime,
  viewKind: ViewKind,
  id: ItemId,
  focus?: Focus,
): View | null {
  return factories[viewKind]?.({ runtime, id, focus }) ?? null;
}

export function hasView(viewKind: ViewKind): boolean {
  return viewKind in factories;
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
    commitScalarText?: (text: string) => void;
  } = {},
): Component {
  const { editor, eval: evaluator } = runtime;
  const viewKind = editor.store.readItem(id).view as ViewKind;

  if (!viewWantsChildView(viewKind)) {
    return contentField({
      editor,
      evaluator,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
      commitScalarText: opts.commitScalarText,
    });
  }

  const child = createView(runtime, viewKind, id, focus);
  if (!child) {
    return contentField({
      editor,
      evaluator,
      focus,
      id,
      textKeys: opts.textKeys,
      renderItemGroupChild: opts.renderItemGroupChild,
      commitScalarText: opts.commitScalarText,
    });
  }

  const host = el("div") as HTMLElement & { __unmount?: () => void };
  ensureTabbable(host);
  ensureTabbable(child.root);

  host.__unmount = mountViewInto(editor, host, child);
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
