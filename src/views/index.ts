import type { Core, ViewKind, ViewName, ViewFactory } from "../core";
import { createOutlineView } from "./outline";
import { createTableView } from "./table";
import { createSliderView } from "./slider";

export const viewFactories: Record<ViewName, ViewFactory<Core>> = {
  outline: createOutlineView,
  table: createTableView,
  slider: createSliderView,
};

export function hasView(viewKind: ViewKind): boolean {
  return viewKind != null && viewKind in viewFactories;
}
