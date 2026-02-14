import type {
  Component,
  Core,
  DomView,
  Focus,
  ItemId,
  ValueOrBlank,
} from "../core";
import { DEFAULT_TARGET } from "../core";
import {
  VALUE_TARGET,
  bindItemFrame,
  caret0,
  createComponent,
  el,
  makeIntentDispatcher,
  setBodyClasses,
} from "../dom";

type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

const DEFAULT_SLIDER_OPTS: SliderResolvedOpts = {
  min: 0,
  max: 100,
  step: 1,
};

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

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
  return precision <= 0 ? String(Math.trunc(value)) : value.toFixed(precision);
}

const canSetValue = (core: Core, id: ItemId): boolean => {
  const item = core.item(id);
  return item.mode.type === "plain" && item.content.type === "value";
};

const getValueOr = (core: Core, id: ItemId, fallback: number): number => {
  const item = core.item(id);
  if (item.content.type === "value")
    return toNumberOr(item.content.value, fallback);
  return fallback;
};

const sliderCommands = {
  setValue(core: Core, id: ItemId, value: number): void {
    if (!Number.isFinite(value) || !canSetValue(core, id)) return;
    core.commit((t) => t.setValue(id, value));
  },

  nudgeValue(
    core: Core,
    id: ItemId,
    deltaSteps: number,
    resolvedOpts: SliderResolvedOpts,
  ): void {
    if (!canSetValue(core, id)) return;
    const currentValue = getValueOr(core, id, resolvedOpts.min);
    const nextValue = clamp(
      currentValue + deltaSteps * resolvedOpts.step,
      resolvedOpts.min,
      resolvedOpts.max,
    );
    sliderCommands.setValue(core, id, nextValue);
  },
} as const;

type SliderMountCtx = {
  core: Core;
  id: ItemId;
  focus: Focus;
  resolvedOpts: SliderResolvedOpts;
};

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
      sliderCommands.setValue(core, id, next);
    };

    ctx.on(input, "pointerdown", (e: PointerEvent) => {
      core.focus(focus, VALUE_TARGET, { caret: caret0() });
      e.stopPropagation();
    });

    ctx.on(input, "input", (event: Event) => {
      event.stopPropagation();
      commitValue(Number(input.value));
    });

    ctx.target(focus, VALUE_TARGET, () => input);

    ctx.effect(() => {
      const currentValue = getValueOr(core, id, resolvedOpts.min);
      const clamped = clamp(currentValue, resolvedOpts.min, resolvedOpts.max);
      const valueText = formatNumberForStep(clamped, resolvedOpts.step);

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

export function createSliderView(args: {
  core: Core;
  id: ItemId;
  focus?: Focus;
}): DomView {
  const { core, id } = args;

  const resolvedOpts = DEFAULT_SLIDER_OPTS;

  const viewFocus: Focus = args.focus ?? { container: id, item: id };

  const dispatch = makeIntentDispatcher(core, {
    NAV(sel, intent) {
      if (sel.focus.item !== id) return;

      const multiplier = intent.mode === "jump" ? 10 : 1;
      const dir = intent.dir === "left" || intent.dir === "down" ? -1 : 1;
      sliderCommands.nudgeValue(core, id, dir * multiplier, resolvedOpts);
    },

    CONFIRM(sel) {
      if (sel.focus.item !== id) return;

      if (sel.target === DEFAULT_TARGET) {
        core.focus(sel.focus, VALUE_TARGET, { caret: caret0() });
        return;
      }

      if (sel.target === VALUE_TARGET) {
        core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
        return;
      }
    },

    TAB() {},
    TYPE() {},
    DELETE() {},
    DELETE_BOUNDARY() {},
  });

  const body = buildSliderBody({
    core,
    id,
    focus: viewFocus,
    resolvedOpts,
  });

  return {
    id: `slider:${String(id)}`,
    root: body.el,
    onIntent: dispatch,
    dispose() {
      body.dispose();
    },
  };
}
