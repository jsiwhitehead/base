import type { ViewName, ViewRegistration } from "../core";
import { outlineView } from "./outline";
import { sliderView } from "./slider";
import { tableView } from "./table";

export const viewRegistrations: Record<ViewName, ViewRegistration> = {
  outline: outlineView,
  slider: sliderView,
  table: tableView,
};
