import type { ViewShape, ViewName } from "../core";
import type { UiCore, ViewFactory } from "../dom";
import type { ViewRegistration } from "../dom";
export { defineShapedView, defineView } from "../dom";
import { outlineView } from "./outline";
import { sliderView } from "./slider";
import { tableView } from "./table";

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
