import { effect } from "@preact/signals-core";
import type { ItemId, Scalar, StoredContentSettable, Txn } from "../store";
import {
  type Editor,
  type Region,
  type Focus,
  type Selection,
  type EditorEffect,
  type Binding,
  type RegionKeyResult,
  mkFocusSelection,
} from "../editor";
import { el, clamp, CleanupBag } from "../ui";

export type SliderRegionCtx = { editor: Editor };
export type SliderOpts = { min?: number; max?: number; step?: number };

type CmdResult = {
  didChange: boolean;
  selection?: Selection;
  effects?: EditorEffect[];
  issue?: string;
};

function toNumberOr(v: Scalar, fallback: number): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return v === true ? 1 : fallback;
}

const canSetContent = (editor: Editor, id: ItemId) =>
  editor.store.sel.item(id).contentSettable;

const withIssue = (err: unknown): CmdResult => ({
  didChange: false,
  issue: err instanceof Error ? err.message : String(err),
});

export const sliderCommands = {
  setNumber(editor: Editor, focus: Focus, id: ItemId, n: number): CmdResult {
    try {
      if (!Number.isFinite(n) || !canSetContent(editor, id))
        return { didChange: false };

      const content: StoredContentSettable = { kind: "scalar", value: n };
      const txn: Txn = { ops: [{ kind: "patch", id, next: { content } }] };

      const res = mkFocusSelection(focus, { kind: "content" }, 0);

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    } catch (err) {
      return withIssue(err);
    }
  },

  nudge(
    editor: Editor,
    focus: Focus,
    id: ItemId,
    deltaSteps: number,
    opts: Required<Pick<SliderOpts, "min" | "max" | "step">>,
  ): CmdResult {
    try {
      if (!canSetContent(editor, id)) return { didChange: false };

      const v = editor.store.sel.value(id);
      const cur =
        v.kind === "scalar" ? toNumberOr(v.value, opts.min) : opts.min;

      return sliderCommands.setNumber(
        editor,
        focus,
        id,
        clamp(cur + deltaSteps * opts.step, opts.min, opts.max),
      );
    } catch (err) {
      return withIssue(err);
    }
  },
} as const;

export function createSliderRegion(
  ctx: SliderRegionCtx,
  id: ItemId,
  focus: Focus,
  opts: SliderOpts = {},
): Region {
  const { editor } = ctx;
  const { store } = editor;

  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const step = opts.step ?? 1;
  const numericOpts = { min, max, step };

  const root = el("div", "region slider");
  root.tabIndex = 0;

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);

  const valueEl = el("div", "slider-value");
  root.append(input, valueEl);

  const cleanup = new CleanupBag();

  const binding: Binding = {
    focus,
    elementFor: () => input,
    setCaret: () => {},
    getTextLength: () => 0,
  };
  editor.runtime.registerBinding(binding);
  cleanup.add(() => editor.runtime.unregisterBinding(focus));

  const setFocusSelection = () => {
    const res = mkFocusSelection(focus, { kind: "content" }, 0);
    editor.setSelection(res.selection, res.effects);
  };

  const onPointerDown = () => setFocusSelection();
  root.addEventListener("pointerdown", onPointerDown);
  cleanup.add(() => root.removeEventListener("pointerdown", onPointerDown));

  const onInput = () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) sliderCommands.setNumber(editor, focus, id, n);
  };
  input.addEventListener("input", onInput);
  cleanup.add(() => input.removeEventListener("input", onInput));

  const stop = effect(() => {
    const { contentSettable } = store.sel.item(id);
    const v = store.sel.value(id);

    const cur = v.kind === "scalar" ? toNumberOr(v.value, min) : min;
    const clamped = clamp(cur, min, max);
    const nextStr =
      step % 1 === 0 ? String(Math.trunc(clamped)) : String(clamped);

    if (input.value !== nextStr) input.value = nextStr;
    valueEl.textContent = nextStr;

    input.disabled = !contentSettable;
    root.classList.toggle("readonly", !contentSettable);
  });
  cleanup.add(stop);

  const region: Region = {
    id: `slider:${String(id)}`,
    root,

    onActivate() {
      const sel = editor.runtime.selection.value;
      const want =
        sel.kind === "focused" &&
        sel.focus.id === focus.id &&
        sel.focus.containerId === focus.containerId;

      if (!want) {
        setFocusSelection();
      } else {
        editor.setSelection(sel, [
          { type: "DOM_FOCUS", focus, target: { kind: "content" } },
        ]);
      }
    },

    onKeyDown(e): RegionKeyResult {
      if (e.metaKey || e.ctrlKey) return;

      let mul = 1;
      if (e.shiftKey) mul *= 10;
      if (e.altKey) mul *= 0.1;

      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          handled();
          sliderCommands.nudge(editor, focus, id, -1 * mul, numericOpts);
          return;

        case "ArrowRight":
        case "ArrowUp":
          handled();
          sliderCommands.nudge(editor, focus, id, 1 * mul, numericOpts);
          return;

        case "Home":
          handled();
          sliderCommands.setNumber(editor, focus, id, min);
          return;

        case "End":
          handled();
          sliderCommands.setNumber(editor, focus, id, max);
          return;

        case "Escape":
          handled();
          editor.setSelection({ kind: "idle" }, [{ type: "CLEAR_DOM_FOCUS" }]);
          return;
      }
    },

    dispose() {
      cleanup.run();
      root.replaceChildren();
    },
  };

  return region;
}
