import type {
  Focus,
  Intent,
  ItemId,
  ReaderForShape,
  ViewShape,
  ViewName,
} from "../core";
import type { Component, UiCore, ViewFactory } from "../dom";
import { outlineView } from "./outline";
import { sliderView } from "./slider";
import { tableView } from "./table";

export type ViewRegistration = {
  factory: ViewFactory<UiCore>;
  shape?: ViewShape;
};

type ViewMountArgs = {
  core: UiCore;
  id: ItemId;
  focus: Focus;
};

export type AuthoredView = {
  onIntent?: (intent: Intent) => void;
  body: Component;
};

export type ShapedViewRegistration<S extends ViewShape> = {
  factory: ViewFactory<UiCore>;
  shape: S;
};

export function defineView(
  mount: (args: ViewMountArgs) => AuthoredView,
): ViewRegistration {
  return {
    factory: (args) => {
      const view = mount(args);
      return {
        root: view.body.el,
        ...(view.onIntent ? { onIntent: view.onIntent } : {}),
        dispose() {
          view.body.dispose();
        },
      };
    },
  };
}

export function defineShapedView<S extends ViewShape>(
  shape: S,
  mount: (
    args: Omit<ViewMountArgs, "focus"> & {
      reader: ReaderForShape<S>;
      focus: Focus;
    },
  ) => AuthoredView,
): ShapedViewRegistration<S> {
  return {
    shape,
    factory: ({ core, id, focus }) => {
      const view = mount({
        core,
        id,
        reader: core.reader(id, shape),
        focus,
      });
      return {
        root: view.body.el,
        ...(view.onIntent ? { onIntent: view.onIntent } : {}),
        dispose() {
          view.body.dispose();
        },
      };
    },
  };
}

export const viewRegistrations: Record<ViewName, ViewRegistration> = {
  outline: outlineView,
  slider: sliderView,
  table: tableView,
};

export function splitViewRegistrations(
  regs: Partial<Record<ViewName, ViewRegistration>>,
): {
  shapes: Partial<Record<ViewName, ViewShape>>;
  factories: Partial<Record<ViewName, ViewFactory<UiCore>>>;
} {
  const shapes: Partial<Record<ViewName, ViewShape>> = {};
  const factories: Partial<Record<ViewName, ViewFactory<UiCore>>> = {};

  for (const [name, reg] of Object.entries(regs) as [
    ViewName,
    ViewRegistration,
  ][]) {
    factories[name] = reg.factory;
    if (reg.shape) shapes[name] = reg.shape;
  }

  return { shapes, factories };
}
