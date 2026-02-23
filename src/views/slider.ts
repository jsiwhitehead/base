import type { Focus, Intent, ItemId, ValueOrBlank } from "../core";
import { DEFAULT_TARGET, VALUE_TARGET } from "../core";
import type { Component, DomView, UiCore } from "../dom";
import {
  bindItemFrame,
  caret0,
  createComponent,
  el,
  setBodyClasses,
} from "../dom";
import type { ViewRegistration } from "./index";

type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

type SliderMountCtx = {
  core: UiCore;
  id: ItemId;
  focus: Focus;
  resolvedOpts: SliderResolvedOpts;
};

const DEFAULT_SLIDER_OPTS: SliderResolvedOpts = {
  min: 0,
  max: 100,
  step: 1,
};

const nativeRangeKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

function snapToStep(
  value: number,
  min: number,
  max: number,
  step: number,
): number {
  const clamped = clamp(value, min, max);
  if (!Number.isFinite(step) || step <= 0) return clamped;
  const steps = Math.round((clamped - min) / step);
  return clamp(min + steps * step, min, max);
}

function toNumberOr(value: ValueOrBlank, fallback: number): number {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string") {
    const parsedNumber = Number(value);
    return Number.isFinite(parsedNumber) ? parsedNumber : fallback;
  }
  return value === true ? 1 : fallback;
}

function precisionFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const stepText = String(step);

  if (/[eE]/.test(stepText)) {
    const [mantissa = "", exponentText = "0"] = stepText.split(/[eE]/);
    const exponent = Number(exponentText);
    const decimals = (mantissa.split(".")[1]?.length ?? 0) - exponent;
    return Math.max(0, decimals);
  }

  return Math.max(0, stepText.split(".")[1]?.length ?? 0);
}

function formatNumberForStep(value: number, step: number): string {
  const precision = precisionFromStep(step);
  return precision <= 0 ? value.toFixed(0) : value.toFixed(precision);
}

const canSetValue = (core: UiCore, id: ItemId): boolean => {
  const item = core.item(id);
  return item.mode.type === "plain" && item.content.type === "value";
};

const getValueOr = (core: UiCore, id: ItemId, fallback: number): number => {
  const item = core.item(id);
  if (item.content.type === "value")
    return toNumberOr(item.content.value, fallback);
  return fallback;
};

const cmd = {
  setValue(core: UiCore, id: ItemId, value: number): void {
    if (!Number.isFinite(value) || !canSetValue(core, id)) return;
    core.commit((t) => t.setValue(id, value));
  },
} as const;

function buildSliderBody({
  core,
  id,
  focus,
  resolvedOpts,
}: SliderMountCtx): Component {
  return createComponent(core, (ctx) => {
    const root = el("div");
    setBodyClasses(root, "slider");
    bindItemFrame(ctx, { core, focus }, root);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(resolvedOpts.min);
    input.max = String(resolvedOpts.max);
    input.step = String(resolvedOpts.step);
    input.tabIndex = -1;

    const valueEl = el("div", "ui-slider-value");
    root.append(input, valueEl);

    const commitValue = (next: number) => {
      if (!Number.isFinite(next)) return;
      cmd.setValue(core, id, next);
    };

    ctx.on(input, "pointerdown", (e: PointerEvent) => {
      core.focus(focus, VALUE_TARGET, { caret: caret0() });
      e.stopPropagation();
    });

    ctx.on(input, "keydown", (e: KeyboardEvent) => {
      if (nativeRangeKeys.has(e.key)) e.stopPropagation();
    });

    ctx.on(input, "input", (event: Event) => {
      event.stopPropagation();
      commitValue(Number(input.value));
    });

    ctx.target(focus, VALUE_TARGET, () => input);

    ctx.effect(() => {
      const currentValue = getValueOr(core, id, resolvedOpts.min);
      const snapped = snapToStep(
        currentValue,
        resolvedOpts.min,
        resolvedOpts.max,
        resolvedOpts.step,
      );
      const valueText = formatNumberForStep(snapped, resolvedOpts.step);

      if (input.value !== valueText) input.value = valueText;
      if (valueEl.textContent !== valueText) valueEl.textContent = valueText;
    });

    ctx.effect(() => {
      const shouldDisable = !canSetValue(core, id);
      if (input.disabled !== shouldDisable) input.disabled = shouldDisable;
    });

    return root;
  });
}

function createSliderView(args: {
  core: UiCore;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id } = args;

  const resolvedOpts = DEFAULT_SLIDER_OPTS;

  const viewFocus: Focus = args.focus ?? { container: id, item: id };

  const dispatch = (intent: Intent): void => {
    const selection = core.selection();
    if (selection.type !== "focused") return;

    switch (intent.type) {
      case "CONFIRM":
        if (selection.focus.item !== id) return;
        if (selection.target === VALUE_TARGET)
          core.focus(selection.focus, DEFAULT_TARGET);
        return;
      case "NAV":
      case "TAB":
      case "TYPE":
      case "DELETE":
        return;
    }
  };

  const body = buildSliderBody({
    core,
    id,
    focus: viewFocus,
    resolvedOpts,
  });

  return {
    root: body.el,
    onIntent: dispatch,
    dispose() {
      body.dispose();
    },
  };
}

export const sliderView: ViewRegistration = {
  factory: createSliderView,
  constraint: { content: "value" },
};
