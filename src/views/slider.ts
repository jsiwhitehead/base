import type {
  Location,
  Intent,
  ItemId,
  ReaderForShape,
  ValueOrBlank,
} from "../core";
import { VALUE_TARGET, defineShape } from "../core";
import type { Component, UiCore } from "../dom";
import {
  bindItemFrame,
  createComponent,
  defineShapedView,
  el,
  setBodyClasses,
} from "../dom";

const sliderShape = defineShape({ type: "value" });

type SliderOpts = { min: number; max: number; step: number };

type SliderMountCtx = {
  core: UiCore;
  id: ItemId;
  reader: SliderReader;
  opts: SliderOpts;
  location: Location;
};

type SliderReader = ReaderForShape<typeof sliderShape>;

const DEFAULT_SLIDER_OPTS: SliderOpts = { min: 0, max: 100, step: 1 };

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

const cmd = {
  setValue(core: UiCore, id: ItemId, value: number): void {
    if (!Number.isFinite(value)) return;
    core.commit((t) => t.setValue(id, value));
  },
} as const;

function buildSliderBody({
  core,
  id,
  reader,
  opts,
  location,
}: SliderMountCtx): Component {
  return createComponent(core, (ctx) => {
    const root = el("div");
    setBodyClasses(root, "slider");
    bindItemFrame(ctx, { core, location }, root);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.tabIndex = -1;

    const valueEl = el("div", "ui-slider-value");
    root.append(input, valueEl);

    const commitValue = (next: number) => {
      if (!Number.isFinite(next)) return;
      cmd.setValue(core, id, next);
    };

    ctx.on(input, "pointerdown", (e: PointerEvent) => {
      core.focus(
        { type: "editing", location, target: VALUE_TARGET },
        { caret: 0 },
      );
      e.stopPropagation();
    });

    ctx.on(input, "keydown", (e: KeyboardEvent) => {
      if (nativeRangeKeys.has(e.key)) e.stopPropagation();
    });

    ctx.on(input, "input", (event: Event) => {
      event.stopPropagation();
      commitValue(Number(input.value));
    });

    ctx.target(location, VALUE_TARGET, () => input);

    ctx.effect(() => {
      const currentValue = toNumberOr(reader.value(), opts.min);
      const snapped = snapToStep(currentValue, opts.min, opts.max, opts.step);
      const valueText = formatNumberForStep(snapped, opts.step);

      if (input.value !== valueText) input.value = valueText;
      if (valueEl.textContent !== valueText) valueEl.textContent = valueText;
    });

    return root;
  });
}

export const sliderView = defineShapedView(
  sliderShape,
  ({ core, id, reader, location }) => {
    const opts = DEFAULT_SLIDER_OPTS;

    const onIntent = (intent: Intent): void => {
      const selection = core.selection();
      if (selection.type !== "editing") return;

      switch (intent.type) {
        case "CONFIRM":
          if (selection.location.item !== id) return;
          if (selection.target === VALUE_TARGET)
            core.focus({ type: "item", location: selection.location });
          return;
        case "NAV":
        case "TAB":
        case "TYPE":
        case "DELETE":
          return;
      }
    };

    const body = buildSliderBody({ core, id, reader, opts, location });

    return { onIntent, body };
  },
);
