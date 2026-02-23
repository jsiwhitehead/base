import type { ViewConstraint, ViewName } from "../core";
import type { UiCore, ViewFactory } from "../dom";
import { outlineView } from "./outline";
import { sliderView } from "./slider";
import { tableView } from "./table";

export type ViewRegistration = {
  factory: ViewFactory<UiCore>;
  constraint?: ViewConstraint;
};

export const viewRegistrations: Record<ViewName, ViewRegistration> = {
  outline: outlineView,
  slider: sliderView,
  table: tableView,
};

export function splitViewRegistrations(
  regs: Partial<Record<ViewName, ViewRegistration>>,
): {
  constraints: Partial<Record<ViewName, ViewConstraint>>;
  factories: Partial<Record<ViewName, ViewFactory<UiCore>>>;
} {
  const constraints: Partial<Record<ViewName, ViewConstraint>> = {};
  const factories: Partial<Record<ViewName, ViewFactory<UiCore>>> = {};

  for (const [name, reg] of Object.entries(regs) as [
    ViewName,
    ViewRegistration,
  ][]) {
    factories[name] = reg.factory;
    if (reg.constraint) constraints[name] = reg.constraint;
  }

  return { constraints, factories };
}
