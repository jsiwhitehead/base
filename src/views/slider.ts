import type { ItemId, Scalar, StoredContentSettable, Txn } from "../store";
import type { Editor, View, Focus, ViewKeyResult, CmdResult } from "../editor";
import {
  mkFocusSelection,
  caret0,
  proposeSelection,
  tryCmd,
  applyCmd,
  setIdle,
} from "../editor";
import { createComponent, el, clamp, stopEvent, type Component } from "../ui";

export type SliderViewCtx = { editor: Editor };
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
    const [m, e] = s.split(/[eE]/);
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

const canSetContent = (editor: Editor, id: ItemId) =>
  editor.store.sel.item(id).contentSettable;

const getScalarOr = (editor: Editor, id: ItemId, fallback: number): number => {
  const v = editor.store.sel.value(id);
  return v.kind === "scalar" ? toNumberOr(v.value, fallback) : fallback;
};

export const sliderCommands = {
  setNumber(editor: Editor, focus: Focus, id: ItemId, n: number): CmdResult {
    return tryCmd(() => {
      if (!Number.isFinite(n) || !canSetContent(editor, id))
        return { didChange: false };

      const content: StoredContentSettable = { kind: "scalar", value: n };
      const txn: Txn = { ops: [{ kind: "patch", id, next: { content } }] };

      const next = mkFocusSelection(focus, { kind: "content" }, caret0());
      editor.apply(txn, proposeSelection(next));

      return {
        didChange: true,
        selection: next.selection,
        effects: next.effects,
      };
    });
  },

  nudge(
    editor: Editor,
    focus: Focus,
    id: ItemId,
    deltaSteps: number,
    opts: SliderResolvedOpts,
  ): CmdResult {
    return tryCmd(() => {
      if (!canSetContent(editor, id)) return { didChange: false };

      const cur = getScalarOr(editor, id, opts.min);
      const next = clamp(cur + deltaSteps * opts.step, opts.min, opts.max);

      return sliderCommands.setNumber(editor, focus, id, next);
    });
  },
} as const;

type SliderMountCtx = {
  editor: Editor;
  id: ItemId;
  focus: Focus;
  opts: SliderResolvedOpts;
};

function mountSlider({ editor, id, focus, opts }: SliderMountCtx): Component {
  const { store } = editor;

  return createComponent((cctx) => {
    const root = el("div", "view slider");
    root.tabIndex = 0;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);

    const valueEl = el("div", "slider-value");
    root.append(input, valueEl);

    cctx.focusable({
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

    const focusContent = () => {
      const res = mkFocusSelection(focus, { kind: "content" }, caret0());
      editor.setSelection(res.selection, res.effects);
    };

    cctx.on(root, "pointerdown", (e) => {
      focusContent();
      e.stopPropagation();
    });

    cctx.on(input as any, "input", () => {
      const n = Number(input.value);
      if (Number.isFinite(n))
        applyCmd(editor, sliderCommands.setNumber(editor, focus, id, n));
    });

    cctx.watch(() => {
      const { contentSettable } = store.sel.item(id);
      const cur = getScalarOr(editor, id, opts.min);
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

export function createSliderView(
  ctx: SliderViewCtx,
  id: ItemId,
  focus: Focus,
  opts: SliderOpts = {},
): View {
  const { editor } = ctx;

  const resolved: SliderResolvedOpts = {
    min: opts.min ?? 0,
    max: opts.max ?? 100,
    step: opts.step ?? 1,
  };

  const mountCtx: SliderMountCtx = { editor, id, focus, opts: resolved };
  const comp = mountSlider(mountCtx);

  return {
    id: `slider:${String(id)}`,
    root: comp.el,

    onActivate() {
      const sel = editor.runtime.selection.value;
      const focused =
        sel.kind === "focused" &&
        sel.focus.id === focus.id &&
        sel.focus.scopeId === focus.scopeId;

      if (!focused) {
        const res = mkFocusSelection(focus, { kind: "content" }, caret0());
        editor.setSelection(res.selection, res.effects);
        return;
      }

      editor.setSelection(sel, [
        { type: "DOM_FOCUS", focus, target: { kind: "content" } },
      ]);
    },

    onKeyDown(e): ViewKeyResult {
      if (e.metaKey || e.ctrlKey) return;

      let mul = 1;
      if (e.shiftKey) mul *= 10;
      if (e.altKey) mul *= 0.1;

      const nudge = (dir: number) =>
        applyCmd(
          editor,
          sliderCommands.nudge(editor, focus, id, dir * mul, resolved),
        );

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          stopEvent(e);
          nudge(-1);
          return;

        case "ArrowRight":
        case "ArrowUp":
          stopEvent(e);
          nudge(1);
          return;

        case "Home":
          stopEvent(e);
          applyCmd(
            editor,
            sliderCommands.setNumber(editor, focus, id, resolved.min),
          );
          return;

        case "End":
          stopEvent(e);
          applyCmd(
            editor,
            sliderCommands.setNumber(editor, focus, id, resolved.max),
          );
          return;

        case "Escape":
          stopEvent(e);
          setIdle(editor);
          return;
      }
    },

    dispose() {
      comp.dispose();
      comp.el.replaceChildren();
    },
  };
}
