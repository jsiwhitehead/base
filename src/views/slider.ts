import type { Core, ItemId, Scalar } from "../core";
import {
  type Focus,
  caret0,
  type Editor,
  type ViewKeyResult,
  focusSelection,
  setIdle,
} from "../core";
import { isScalarValue, type Evaluator } from "../core";
import {
  type Component,
  el,
  clamp,
  stopEvent,
  createComponent,
} from "../ui/dom";
import type { DomView, ViewFactoryArgs } from "./index";

export type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

const DEFAULT_SLIDER_OPTS: SliderResolvedOpts = {
  min: 0,
  max: 100,
  step: 1,
};

function handleSliderKey(
  e: KeyboardEvent,
  dispatch: (intent: SliderIntent) => ViewKeyResult,
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
    core.setSelection(
      focusSelection(focus, { kind: "content" }, caret0()).selection,
    );
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

type SliderIntent =
  | { type: "NUDGE"; dir: -1 | 1; mul: number }
  | { type: "SET"; kind: "min" | "max" }
  | { type: "CANCEL" };

type SliderMountCtx = {
  core: Core;
  editor: Editor;
  evaluator: Evaluator;
  id: ItemId;
  focus: Focus;
  opts: SliderResolvedOpts;
  dispatch: (intent: SliderIntent) => ViewKeyResult;
};

function mountSlider({
  core,
  editor,
  evaluator,
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
      editor,
      focus,
      elementFor: () => input,
      targets: [
        {
          target: { kind: "content" },
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

    componentCtx.on(root, "keydown", (e: KeyboardEvent) => {
      handleSliderKey(e, dispatch);
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

    void evaluator;

    return root;
  });
}

export function createSliderView({
  runtime,
  id,
  focus,
}: ViewFactoryArgs): DomView {
  const core = (runtime as any).core as Core;
  const editor = core.host.editor;
  const evaluator = core.unsafe.evaluator;

  const safeFocus: Focus = focus ?? { scopeId: id, id };
  const resolved = DEFAULT_SLIDER_OPTS;

  const dispatch = (intent: SliderIntent): ViewKeyResult => {
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
        setIdle(editor);
        return;
    }
  };

  const mountCtx: SliderMountCtx = {
    core,
    editor,
    evaluator,
    id,
    focus: safeFocus,
    opts: resolved,
    dispatch,
  };
  const comp = mountSlider(mountCtx);

  return {
    id: `slider:${String(id)}`,
    root: comp.el,

    normalizeTarget(_ctx2, _focus, target) {
      return target.kind === "header" ? { kind: "content" } : target;
    },

    onActivate() {
      const sel = editor.runtime.selection.value;
      const focused =
        sel.kind === "focused" &&
        sel.focus.id === safeFocus.id &&
        sel.focus.scopeId === safeFocus.scopeId;

      if (!focused) {
        editor.setSelection(
          focusSelection(safeFocus, { kind: "content" }, caret0()).selection,
        );
        return;
      }

      editor.setSelection(sel, [
        { type: "FOCUS", focus: safeFocus, target: { kind: "content" } },
      ]);
    },

    onKeyDown(e) {
      handleSliderKey(e as KeyboardEvent, dispatch);
    },

    dispose() {
      comp.dispose();
      comp.el.replaceChildren();
    },
  };
}
