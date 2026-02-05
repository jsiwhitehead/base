import type {
  Core,
  ItemId,
  ScalarOrBlank,
  Component,
  Focus,
  DomView,
} from "../core";
import { DEFAULT_TARGET, clamp } from "../core/runtime";
import { el, stopEvent, createContent, presentItem } from "../dom";

export type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

const DEFAULT_SLIDER_OPTS: SliderResolvedOpts = {
  min: 0,
  max: 100,
  step: 1,
};

type SliderIntent =
  | { type: "NUDGE"; dir: -1 | 1; mul: number }
  | { type: "SET"; kind: "min" | "max" }
  | { type: "ESCAPE" };

function escapeLadder(core: Core): void {
  const sel = core.selection();
  if (sel.kind !== "focused") {
    core.blur();
    return;
  }
  if (sel.target !== DEFAULT_TARGET) {
    core.focus(sel.focus, DEFAULT_TARGET, { caret: { start: 0, end: 0 } });
    return;
  }
  core.blur();
}

function handleSliderKey(
  e: KeyboardEvent,
  dispatch: (intent: SliderIntent) => void,
): boolean {
  if (e.metaKey || e.ctrlKey) return false;

  const mul = (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
  const nudge = (dir: -1 | 1) => dispatch({ type: "NUDGE", dir, mul });

  switch (e.key) {
    case "ArrowLeft":
    case "ArrowDown":
      stopEvent(e);
      nudge(-1);
      return true;

    case "ArrowRight":
    case "ArrowUp":
      stopEvent(e);
      nudge(1);
      return true;

    case "Home":
      stopEvent(e);
      dispatch({ type: "SET", kind: "min" });
      return true;

    case "End":
      stopEvent(e);
      dispatch({ type: "SET", kind: "max" });
      return true;

    case "Escape":
      stopEvent(e);
      dispatch({ type: "ESCAPE" });
      return true;

    default:
      return false;
  }
}

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
    core.focus(focus, DEFAULT_TARGET);
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
  dispatch: (intent: SliderIntent) => void;
};

function mountSliderContent({
  core,
  id,
  focus,
  opts,
  dispatch,
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

    ctx.on(input, "input", () => {
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

    ctx.on(root, "keydown", (e: KeyboardEvent) => {
      handleSliderKey(e, dispatch);
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

  const dispatch = (intent: SliderIntent): void => {
    switch (intent.type) {
      case "NUDGE":
        sliderCommands.nudgeScalarValue(
          core,
          safeFocus,
          id,
          intent.dir * intent.mul,
          resolved,
        );
        return;

      case "SET":
        sliderCommands.setScalarValue(
          core,
          safeFocus,
          id,
          intent.kind === "min" ? resolved.min : resolved.max,
        );
        return;

      case "ESCAPE":
        escapeLadder(core);
        return;
    }
  };

  const comp = presentItem({
    core,
    focus: safeFocus,
    wrapClassName: "ui-slider-root",
    surfaceClassName: "ui-slider-surface",
    mount(ctx, surface) {
      const content = mountSliderContent({
        core,
        id,
        focus: safeFocus,
        opts: resolved,
        dispatch,
      });

      surface.replaceChildren(content.el);
      ctx.cleanup(() => content.dispose());

      if (core.selection().kind === "idle") {
        core.focus(safeFocus, DEFAULT_TARGET);
      }
    },
  });

  const onKeyDown = (e: KeyboardEvent) => {
    handleSliderKey(e, dispatch);
  };

  return {
    id: `slider:${String(id)}`,
    root: comp.el,
    onKeyDown,
    dispose() {
      comp.dispose();
    },
  };
}
