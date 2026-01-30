import {
  type Core,
  type EntryId,
  type ItemRef,
  type Scalar,
  type Component,
  type Focus,
  type DomView,
} from "../core";
import { clamp } from "../core/runtime";
import { el, stopEvent, createComponent } from "../dom";

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

const isEntryRef = (r: ItemRef) => r.path.length === 0;

const canSetScalar = (core: Core, ref: ItemRef): boolean => {
  const snap = core.item(ref);
  return isEntryRef(ref) && snap.edit.kind === "scalar";
};

const getScalarOr = (core: Core, ref: ItemRef, fallback: number): number => {
  const c = core.item(ref).content;
  if (c.kind === "scalar" && c.value != null)
    return toNumberOr(c.value, fallback);
  return fallback;
};

export const sliderCommands = {
  setScalarValue(core: Core, focus: Focus, ref: ItemRef, value: number): void {
    if (!Number.isFinite(value) || !canSetScalar(core, ref)) return;
    core.edit.setContentScalar(ref, value);
    core.focus(focus, "content");
  },

  nudgeScalarValue(
    core: Core,
    focus: Focus,
    ref: ItemRef,
    deltaSteps: number,
    opts: SliderResolvedOpts,
  ): void {
    if (!canSetScalar(core, ref)) return;
    const cur = getScalarOr(core, ref, opts.min);
    const next = clamp(cur + deltaSteps * opts.step, opts.min, opts.max);
    sliderCommands.setScalarValue(core, focus, ref, next);
  },
} as const;

type SliderMountCtx = {
  core: Core;
  ref: ItemRef;
  focus: Focus;
  opts: SliderResolvedOpts;
  dispatch: (intent: SliderIntent) => void;
};

function mountSlider({
  core,
  ref,
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
      sliderCommands.setScalarValue(core, focus, ref, next);
    };

    componentCtx.on(input, "input", () => {
      commitValue(Number(input.value));
    });

    componentCtx.watch(
      () => {
        const cur = getScalarOr(core, ref, opts.min);
        const clamped = clamp(cur, opts.min, opts.max);
        return formatNumberForStep(clamped, opts.step);
      },
      (str) => {
        if (input.value !== str) input.value = str;
        if (valueEl.textContent !== str) valueEl.textContent = str;
      },
    );

    componentCtx.watch(
      () => !canSetScalar(core, ref),
      (shouldDisable) => {
        if (input.disabled !== shouldDisable) input.disabled = shouldDisable;
        root.classList.toggle("readonly", shouldDisable);
      },
    );

    componentCtx.on(root, "pointerdown", (e: PointerEvent) => {
      core.focus(focus, "content");
      e.stopPropagation();
    });

    componentCtx.on(root, "keydown", (e: KeyboardEvent) => {
      handleSliderKey(e, dispatch);
    });

    return root;
  });
}

export function createSliderView(args: {
  core: Core;
  id: EntryId;
  focus?: Focus;
}): DomView {
  const { core, id } = args;

  const ref: ItemRef = { entryId: id, path: [] };
  const safeFocus: Focus = args.focus ?? { scope: ref, ref };
  const resolved = DEFAULT_SLIDER_OPTS;

  const dispatch = (intent: SliderIntent): void => {
    switch (intent.type) {
      case "NUDGE":
        sliderCommands.nudgeScalarValue(
          core,
          safeFocus,
          ref,
          intent.dir * intent.mul,
          resolved,
        );
        return;

      case "SET":
        sliderCommands.setScalarValue(
          core,
          safeFocus,
          ref,
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
    ref,
    focus: safeFocus,
    opts: resolved,
    dispatch,
  });

  const onKeyDown = (e: KeyboardEvent) => {
    handleSliderKey(e, dispatch);
  };

  if (core.selection().kind === "idle") {
    core.focus(safeFocus, "content");
  }

  return {
    id: `slider:${String(id)}`,
    root: comp.el,
    onKeyDown,
    dispose() {
      comp.dispose();
      comp.el.replaceChildren();
    },
  };
}
