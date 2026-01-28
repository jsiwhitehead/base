import {
  type ItemId,
  type Scalar,
  type StoredContentSettable,
  isDerivedContent,
  isLensContent,
  type Transaction,
} from "../store";
import { isScalarValue, type Evaluator } from "../eval";
import {
  type Focus,
  caret0,
  withSelection,
  type Editor,
  type NavMode,
  type ViewKeyResult,
  type View,
  focusSelection,
  type CmdResult,
  tryCmd,
  applyCmd,
  setIdle,
} from "../editor";
import { type Component, el, clamp, stopEvent, createComponent } from "../dom";
import type { ViewFactoryArgs } from "./index";

export type SliderOpts = { min?: number; max?: number; step?: number };

type SliderResolvedOpts = Required<Pick<SliderOpts, "min" | "max" | "step">>;

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

const canSetContent = (editor: Editor, id: ItemId) => {
  const content = editor.store.readItem(id).content;
  return !isDerivedContent(content) && !isLensContent(content);
};

const getScalarOr = (
  evaluator: Evaluator,
  id: ItemId,
  fallback: number,
): number => {
  const v = evaluator.value(id);
  return isScalarValue(v) ? toNumberOr(v.value, fallback) : fallback;
};

export const sliderCommands = {
  setScalarValue(
    editor: Editor,
    focus: Focus,
    id: ItemId,
    value: number,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      if (!Number.isFinite(value) || !canSetContent(editor, id))
        return { didChange: false };

      const content: StoredContentSettable = { kind: "scalar", value };
      const txn: Transaction = store.op.transaction([
        store.op.patchContent(id, content),
      ]);

      const next = focusSelection(focus, { kind: "content" }, caret0());
      editor.commit(txn, withSelection({ selection: next.selection }));

      return { didChange: true };
    });
  },

  nudgeScalarValue(
    editor: Editor,
    evaluator: Evaluator,
    focus: Focus,
    id: ItemId,
    deltaSteps: number,
    opts: SliderResolvedOpts,
  ): CmdResult {
    return tryCmd(() => {
      if (!canSetContent(editor, id)) return { didChange: false };

      const cur = getScalarOr(evaluator, id, opts.min);
      const next = clamp(cur + deltaSteps * opts.step, opts.min, opts.max);

      return sliderCommands.setScalarValue(editor, focus, id, next);
    });
  },
} as const;

type SliderIntent =
  | { type: "NUDGE"; dir: -1 | 1; mul: number }
  | { type: "SET"; kind: "min" | "max" }
  | { type: "CANCEL" };

type SliderMountCtx = {
  editor: Editor;
  evaluator: Evaluator;
  id: ItemId;
  focus: Focus;
  opts: SliderResolvedOpts;
  dispatch: (intent: SliderIntent) => ViewKeyResult;
};

function mountSlider({
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

    componentCtx.on(input, "input", () => {
      const n = Number(input.value);
      if (Number.isFinite(n))
        applyCmd(editor, sliderCommands.setScalarValue(editor, focus, id, n));
    });

    componentCtx.on(root, "keydown", (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;

      let mul = 1;
      if (e.shiftKey) mul *= 10;
      if (e.altKey) mul *= 0.1;

      const nudgeIntent = (dir: -1 | 1) =>
        dispatch({ type: "NUDGE", dir, mul });

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          stopEvent(e);
          nudgeIntent(-1);
          return;

        case "ArrowRight":
        case "ArrowUp":
          stopEvent(e);
          nudgeIntent(1);
          return;

        case "Home":
          stopEvent(e);
          dispatch({ type: "SET", kind: "min" });
          return;

        case "End":
          stopEvent(e);
          dispatch({ type: "SET", kind: "max" });
          return;

        case "Escape":
          stopEvent(e);
          dispatch({ type: "CANCEL" });
          return;
      }
    });

    componentCtx.watch(() => {
      const contentSettable = canSetContent(editor, id);

      const cur = getScalarOr(evaluator, id, opts.min);
      const clamped = clamp(cur, opts.min, opts.max);
      const str = formatNumberForStep(clamped, opts.step);

      if (input.value !== str) input.value = str;
      if (valueEl.textContent !== str) valueEl.textContent = str;

      input.disabled = !contentSettable;
      root.classList.toggle("readonly", !contentSettable);
    });

    return root;
  });
}

export function createSliderView({
  runtime,
  id,
  focus,
}: ViewFactoryArgs): View {
  const { editor, evaluator } = runtime;
  const safeFocus: Focus = focus ?? { scopeId: id, id };

  const resolved: SliderResolvedOpts = {
    min: 0,
    max: 100,
    step: 1,
  };

  const dispatch = (intent: SliderIntent): ViewKeyResult => {
    switch (intent.type) {
      case "NUDGE":
        applyCmd(
          editor,
          sliderCommands.nudgeScalarValue(
            editor,
            evaluator,
            safeFocus,
            id,
            intent.dir * intent.mul,
            resolved,
          ),
        );
        return;

      case "SET":
        applyCmd(
          editor,
          sliderCommands.setScalarValue(
            editor,
            safeFocus,
            id,
            intent.kind === "min" ? resolved.min : resolved.max,
          ),
        );
        return;

      case "CANCEL":
        setIdle(editor);
        return;
    }
  };

  const mountCtx: SliderMountCtx = {
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
        { type: "DOM_FOCUS", focus: safeFocus, target: { kind: "content" } },
      ]);
    },

    onKeyDown(e): ViewKeyResult {
      const mode: NavMode = e.metaKey || e.ctrlKey ? "jump" : "step";
      void mode;
      void e;
    },

    dispose() {
      comp.dispose();
      comp.el.replaceChildren();
    },
  };
}
