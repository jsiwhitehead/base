import type {
  Location,
  Intent,
  NodeId,
  ReaderForShape,
  ValueOrBlank,
} from "../core";
import { contentTarget, defineShape } from "../core";
import type { Component, UiCore } from "../dom";
import { createComponent, defineShapedView, el, setBodyClasses } from "../dom";

const sliderShape = defineShape({ type: "value" });

type SliderOpts = { min: number; max: number; step: number };

type SliderMountCtx = {
  core: UiCore;
  id: NodeId;
  reader: SliderReader;
  opts: SliderOpts;
  location: Location;
};

type SliderReader = ReaderForShape<typeof sliderShape>;

const DEFAULT_SLIDER_OPTS: SliderOpts = { min: 0, max: 100, step: 1 };
const CONTENT_SLIDER_TARGET = contentTarget("slider");

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
  setValue(core: UiCore, id: NodeId, value: number): void {
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

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.tabIndex = -1;

    root.append(input);

    const commitValue = (next: number) => {
      if (!Number.isFinite(next)) return;
      cmd.setValue(core, id, next);
    };

    ctx.on(input, "pointerdown", (e: PointerEvent) => {
      core.focus(
        { type: "editing", location, target: CONTENT_SLIDER_TARGET },
        { caret: 0 },
      );
      e.stopPropagation();
    });

    ctx.on(input, "input", (event: Event) => {
      event.stopPropagation();
      commitValue(Number(input.value));
    });

    ctx.target(location, CONTENT_SLIDER_TARGET, () => input, {
      primary: true,
    });

    ctx.effect(() => {
      const currentValue = toNumberOr(reader.value(), opts.min);
      const snapped = snapToStep(currentValue, opts.min, opts.max, opts.step);
      const valueText = formatNumberForStep(snapped, opts.step);

      if (input.value !== valueText) input.value = valueText;
    });

    return root;
  });
}

export const sliderView = defineShapedView(
  sliderShape,
  ({ core, id, reader, location }) => {
    const opts = DEFAULT_SLIDER_OPTS;

    const bodyRoot = buildSliderBody({ core, id, reader, opts, location });

    return { onIntent: (_intent: Intent): void => {}, bodyRoot };
  },
);
