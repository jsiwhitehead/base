import {
  type Core,
  type ItemId,
  type Scalar,
  type Focus,
  isScalarValue,
} from "../core";
import {
  type Component,
  el,
  clamp,
  stopEvent,
  createComponent,
} from "../ui/dom";
import type { DomView } from "./index";

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
  | { type: "CANCEL" };

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
      dispatch({ type: "CANCEL" });
      return true;

    default:
      return false;
  }
}

function toNumberOr(v: Scalar, fallback: number): number {
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

const canSetContent = (core: Core, id: ItemId) => {
  const k = core.get(id).storedKind;
  return k !== "derived" && k !== "lens";
};

const getScalarOr = (core: Core, id: ItemId, fallback: number): number => {
  const v = core.value(id);
  return isScalarValue(v) ? toNumberOr(v.value, fallback) : fallback;
};

export const sliderCommands = {
  setScalarValue(core: Core, focus: Focus, id: ItemId, value: number): void {
    if (!Number.isFinite(value) || !canSetContent(core, id)) return;
    core.edit.setScalar(id, value);
    core.focus(focus, "content");
  },

  nudgeScalarValue(
    core: Core,
    focus: Focus,
    id: ItemId,
    deltaSteps: number,
    opts: SliderResolvedOpts,
  ): void {
    if (!canSetContent(core, id)) return;
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

function mountSlider({
  core,
  id,
  focus,
  opts,
  dispatch,
}: SliderMountCtx): Component {
  return createComponent((componentCtx) => {
    const root = el("div", "view slider");
    root.tabIndex = 0;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);

    const valueEl = el("div", "slider-value");
    root.append(input, valueEl);

    componentCtx.focusable({
      core,
      focus,
      elementFor: () => input,
      targets: [
        {
          target: "content",
          getEl: () => input,
          pointerHost: () => root,
          caret: "zero",
          stopPropagation: true,
        },
      ],
    });

    const commitValue = (next: number) => {
      if (!Number.isFinite(next)) return;
      sliderCommands.setScalarValue(core, focus, id, next);
    };

    componentCtx.on(input, "input", () => {
      commitValue(Number(input.value));
    });

    componentCtx.watch(
      () => {
        const cur = getScalarOr(core, id, opts.min);
        const clamped = clamp(cur, opts.min, opts.max);
        return formatNumberForStep(clamped, opts.step);
      },
      (str) => {
        if (input.value !== str) input.value = str;
        if (valueEl.textContent !== str) valueEl.textContent = str;
      },
    );

    componentCtx.watch(
      () => !canSetContent(core, id),
      (shouldDisable) => {
        if (input.disabled !== shouldDisable) input.disabled = shouldDisable;
        root.classList.toggle("readonly", shouldDisable);
      },
    );

    componentCtx.on(root, "keydown", (e: KeyboardEvent) => {
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

  const safeFocus: Focus = args.focus ?? { scopeId: id, id };
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

      case "CANCEL":
        core.blur();
        return;
    }
  };

  const comp = mountSlider({
    core,
    id,
    focus: safeFocus,
    opts: resolved,
    dispatch,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    handleSliderKey(e, dispatch);
  };

  const unmountRoot = core.mountViewRoot({ root: comp.el, onKeyDown });

  if (core.selection().kind === "idle") {
    core.focus(safeFocus, "content");
  }

  return {
    id: `slider:${String(id)}`,
    root: comp.el,
    onKeyDown,
    dispose() {
      unmountRoot();
      comp.dispose();
      comp.el.replaceChildren();
    },
  };
}
