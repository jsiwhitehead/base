import type {
  Core,
  ItemId,
  ScalarOrBlank,
  Component,
  Focus,
  DomView,
} from "../core";
import { DEFAULT_TARGET, clamp } from "../core/runtime";
import {
  el,
  createContent,
  escapeLadder,
  caret0,
  consume,
  parseKeydownIntent,
  type Intent,
} from "../dom";

export type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

const DEFAULT_SLIDER_OPTS: SliderResolvedOpts = {
  min: 0,
  max: 100,
  step: 1,
};

function toNumberOr(v: ScalarOrBlank, fallback: number): number {
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

const canSetScalar = (core: Core, id: ItemId): boolean => {
  const it = core.item(id);
  return it.mode.kind === "direct" && it.content.kind === "scalar";
};

const getScalarOr = (core: Core, id: ItemId, fallback: number): number => {
  const it = core.item(id);
  if (it.content.kind === "scalar")
    return toNumberOr(it.content.value, fallback);
  return fallback;
};

export const sliderCommands = {
  setScalarValue(core: Core, focus: Focus, id: ItemId, value: number): void {
    if (!Number.isFinite(value) || !canSetScalar(core, id)) return;
    core.commit((t) => t.setScalar(id, value));
    core.focus(focus, DEFAULT_TARGET, { caret: caret0() });
  },

  nudgeScalarValue(
    core: Core,
    focus: Focus,
    id: ItemId,
    deltaSteps: number,
    opts: SliderResolvedOpts,
  ): void {
    if (!canSetScalar(core, id)) return;
    const cur = getScalarOr(core, id, opts.min);
    const next = clamp(cur + deltaSteps * opts.step, opts.min, opts.max);
    sliderCommands.setScalarValue(core, focus, id, next);
  },
} as const;

type SliderMountCtx = {
  core: Core;
  id: ItemId;
  focus: Focus;
  opts: SliderResolvedOpts;
};

function mountSliderContent({
  core,
  id,
  focus,
  opts,
}: SliderMountCtx): Component {
  return createContent({ core, focus, view: "slider" }, (ctx) => {
    const root = el("div");

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
      sliderCommands.setScalarValue(core, focus, id, next);
    };

    ctx.on(input, "pointerdown", (e: PointerEvent) => {
      e.stopPropagation();
    });

    ctx.on(input, "input", (e: Event) => {
      e.stopPropagation();
      commitValue(Number(input.value));
    });

    ctx.effect(() => {
      const cur = getScalarOr(core, id, opts.min);
      const clamped0 = clamp(cur, opts.min, opts.max);
      const str = formatNumberForStep(clamped0, opts.step);

      if (input.value !== str) input.value = str;
      if (valueEl.textContent !== str) valueEl.textContent = str;
    });

    ctx.effect(() => {
      const shouldDisable = !canSetScalar(core, id);
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

  const safeFocus: Focus = args.focus ?? { container: id, item: id };
  const resolved = DEFAULT_SLIDER_OPTS;

  const content = mountSliderContent({
    core,
    id,
    focus: safeFocus,
    opts: resolved,
  });

  const dispatch = (intent: Intent) => {
    switch (intent.type) {
      case "CANCEL":
        escapeLadder(core);
        return;

      case "NAV": {
        const mul = intent.mode === "jump" ? 10 : 1;
        const dir = intent.dir === "left" || intent.dir === "down" ? -1 : 1;
        sliderCommands.nudgeScalarValue(
          core,
          safeFocus,
          id,
          dir * mul,
          resolved,
        );
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

  const onKeyDown = (e: KeyboardEvent) => {
    const intent = parseKeydownIntent(e);
    if (!intent) return;
    consume(e);
    dispatch(intent);
  };

  return {
    id: `slider:${String(id)}`,
    root: content.el,
    onKeyDown,
    dispose() {
      content.dispose();
    },
  };
}
