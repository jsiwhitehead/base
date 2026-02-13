import type {
  Component,
  Core,
  DomView,
  Focus,
  ItemId,
  ValueOrBlank,
} from "../core";
import type { Intent } from "../dom";
import { createComponent, el, escapeLadder, stampBody } from "../dom";

type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

const DEFAULT_SLIDER_OPTS: SliderResolvedOpts = {
  min: 0,
  max: 100,
  step: 1,
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

function toNumberOr(v: ValueOrBlank, fallback: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return v === true ? 1 : fallback;
}

function precisionFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);

  if (/[eE]/.test(s)) {
    const [m = "", e = "0"] = s.split(/[eE]/);
    const exp = Number(e);
    const dec = (m.split(".")[1]?.length ?? 0) - exp;
    return Math.max(0, dec);
  }

  return Math.max(0, s.split(".")[1]?.length ?? 0);
}

function formatNumberForStep(n: number, step: number): string {
  const p = precisionFromStep(step);
  return p <= 0 ? String(Math.trunc(n)) : n.toFixed(p);
}

const canSetValue = (core: Core, id: ItemId): boolean => {
  const item = core.item(id);
  return item.mode.kind === "plain" && item.content.kind === "value";
};

const getValueOr = (core: Core, id: ItemId, fallback: number): number => {
  const item = core.item(id);
  if (item.content.kind === "value")
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
    opts: SliderResolvedOpts,
  ): void {
    if (!canSetValue(core, id)) return;
    const cur = getValueOr(core, id, opts.min);
    const next = clamp(cur + deltaSteps * opts.step, opts.min, opts.max);
    sliderCommands.setValue(core, id, next);
  },
} as const;

type SliderMountCtx = {
  core: Core;
  id: ItemId;
  opts: SliderResolvedOpts;
};

function buildSliderBody({ core, id, opts }: SliderMountCtx): Component {
  return createComponent(core, (ctx) => {
    const root = el("div");
    stampBody(root, "slider");

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
      sliderCommands.setValue(core, id, next);
    };

    ctx.on(input, "pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
    });

    ctx.on(input, "input", (event: Event) => {
      event.stopPropagation();
      commitValue(Number(input.value));
    });

    ctx.effect(() => {
      const currentValue = getValueOr(core, id, opts.min);
      const clamped = clamp(currentValue, opts.min, opts.max);
      const valueText = formatNumberForStep(clamped, opts.step);

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

  const resolved = DEFAULT_SLIDER_OPTS;

  const content = buildSliderBody({
    core,
    id,
    opts: resolved,
  });

  const dispatch = (intent: Intent) => {
    switch (intent.type) {
      case "CANCEL":
        escapeLadder(core);
        return;

      case "NAV": {
        const multiplier = intent.mode === "jump" ? 10 : 1;
        const dir = intent.dir === "left" || intent.dir === "down" ? -1 : 1;
        sliderCommands.nudgeValue(core, id, dir * multiplier, resolved);
        return;
      }

      case "CONFIRM":
      case "TAB":
      case "TYPE":
      case "DELETE":
      case "DELETE_BOUNDARY":
        return;
    }
  };

  return {
    id: `slider:${String(id)}`,
    root: content.el,
    onIntent: dispatch,
    dispose() {
      content.dispose();
    },
  };
}
