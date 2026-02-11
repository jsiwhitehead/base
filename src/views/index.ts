import type { Core, ViewFactory, ViewName } from "../core";
import { createOutlineView } from "./outline";
import { createSliderView } from "./slider";
import { createTableView } from "./table";

export const viewFactories: Record<ViewName, ViewFactory<Core>> = {
  outline: createOutlineView,
  table: createTableView,
  slider: createSliderView,
};
