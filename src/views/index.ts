import type { ItemId, ViewName, ViewKind } from "../store";
import type { Evaluator } from "../eval";
import type { Focus, Editor, View } from "../editor";
import {
  type Component,
  el,
  ensureTabbable,
  mountViewInto,
  contentField,
} from "../dom";
import { createTreeView } from "./tree";
import { createTableView } from "./table";
import { createSliderView } from "./slider";

export type Runtime = { editor: Editor; evaluator: Evaluator };

export type DomView = View & { root: HTMLElement };

export type ViewFactoryArgs = { runtime: Runtime; id: ItemId; focus?: Focus };
export type ViewFactory = (args: ViewFactoryArgs) => DomView;

const factories: Record<ViewName, ViewFactory> = {
  tree: createTreeView,
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
    commitScalarText?: (text: string) => void;
  } = {},
): Component {
  const { editor, evaluator } = runtime;
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
