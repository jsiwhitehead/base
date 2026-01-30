import { signal, type Signal } from "@preact/signals-core";
import type { ItemId, Transaction, ApplyResult, Model } from "./model";

export type Focus = { scopeId: ItemId; id: ItemId };

export type FocusTarget =
  | { kind: "content" }
  | { kind: "header"; index: number };

export type Caret = { start: number; end: number };

export type Selection =
  | { kind: "idle" }
  | { kind: "focused"; focus: Focus; target: FocusTarget; caret?: Caret };

export type Anchor = "top" | "bottom";

export type EditorEffect =
  | { type: "FOCUS"; focus: Focus; target: FocusTarget; anchor?: Anchor }
  | { type: "CLEAR_FOCUS" };

export type CommitHints = {
  propose?: (ctx: {
    model: Model;
    prevSelection: Selection;
    result: ApplyResult;
  }) => { selection?: Selection; effects?: EditorEffect[] };
  effects?: EditorEffect[];
};

export type NextSelection =
  | { selection: Selection; effects?: EditorEffect[] }
  | ((ctx: { model: Model; prevSelection: Selection; result: ApplyResult }) => {
      selection?: Selection;
      effects?: EditorEffect[];
    });

export function withSelection(proposal: NextSelection): CommitHints {
  return typeof proposal === "function"
    ? { propose: proposal }
    : {
        propose: () => ({
          selection: proposal.selection,
          effects: proposal.effects,
        }),
      };
}

export type EffectsApplier = (sel: Selection, effects: EditorEffect[]) => void;

function normalizeEffectsForSelection(
  sel: Selection,
  effects: EditorEffect[],
): EditorEffect[] {
  const hasClear = effects.some((e) => e.type === "CLEAR_FOCUS");
  const hasFocus = effects.some((e) => e.type === "FOCUS");

  if (sel.kind === "idle") {
    if (hasClear) return effects;
    return [...effects, { type: "CLEAR_FOCUS" }];
  }

  if (hasClear) return effects;
  if (hasFocus) return effects;

  return [...effects, { type: "FOCUS", focus: sel.focus, target: sel.target }];
}

export class EditorRuntime {
  selection: Signal<Selection>;

  private pending: { sel: Selection; effects: EditorEffect[] } | null = null;
  private flushScheduled = false;

  private effectsApplier: EffectsApplier;

  constructor(
    initialSelection: Selection = { kind: "idle" },
    effectsApplier: EffectsApplier = () => {},
  ) {
    this.selection = signal(initialSelection);
    this.effectsApplier = effectsApplier;
  }

  setEffectsApplier(applier: EffectsApplier): void {
    this.effectsApplier = applier;
  }

  scheduleEffects(sel: Selection, effects: EditorEffect[]): void {
    if (!effects.length) return;

    this.pending = this.pending
      ? { sel, effects: [...this.pending.effects, ...effects] }
      : { sel, effects };

    if (this.flushScheduled) return;
    this.flushScheduled = true;

    queueMicrotask(() => {
      this.flushScheduled = false;
      const next = this.pending;
      this.pending = null;
      if (next) this.applyEffects(next.sel, next.effects);
    });
  }

  applyEffects(sel: Selection, effects: EditorEffect[]): void {
    this.effectsApplier(sel, effects);
  }
}

export type Editor = {
  model: Model;
  runtime: EditorRuntime;
  getSelection(): Selection;
  setSelection(next: Selection, effects?: EditorEffect[]): void;
  commit(txn: Transaction, hints?: CommitHints): ApplyResult;
};

export function focusSelection(
  focus: Focus,
  target: FocusTarget,
  caret?: Caret,
): { selection: Selection; effects: EditorEffect[] } {
  const selection: Selection = {
    kind: "focused",
    focus,
    target,
    ...(caret ? { caret } : {}),
  };
  return { selection, effects: [{ type: "FOCUS", focus, target }] };
}

export function repairSelection(editor: Editor, sel: Selection): Selection {
  const model = editor.model;

  if (sel.kind === "idle") return sel;

  try {
    model.peekItem(sel.focus.id);
    // Selection is valid, return as-is
    return sel;
  } catch {
    try {
      const rootId = model.rootId();
      model.peekItem(rootId);
      return {
        kind: "focused",
        focus: { scopeId: rootId, id: rootId },
        target: { kind: "content" },
      };
    } catch {
      return { kind: "idle" };
    }
  }
}

export function ensureSelection(
  editor: Editor,
  next: Selection,
  effects: EditorEffect[] = [],
): void {
  const repaired = repairSelection(editor, next);
  editor.runtime.selection.value = repaired;
  editor.runtime.scheduleEffects(
    repaired,
    normalizeEffectsForSelection(repaired, effects),
  );
}

export function createEditor(
  model: Model,
  opts: { runtime?: EditorRuntime } = {},
): Editor {
  const runtime = opts.runtime ?? new EditorRuntime({ kind: "idle" });

  const getSelection = (): Selection => runtime.selection.value;

  const setSelection = (
    next: Selection,
    effects: EditorEffect[] = [],
  ): void => {
    const editor = api;
    const repaired = repairSelection(editor, next);
    runtime.selection.value = repaired;
    runtime.scheduleEffects(
      repaired,
      normalizeEffectsForSelection(repaired, effects),
    );
  };

  const commit = (txn: Transaction, hints: CommitHints = {}): ApplyResult => {
    const prevSelection = getSelection();
    const result = model.apply(txn);

    const proposed = hints.propose?.({ model, prevSelection, result });
    const editor = api;
    const repaired = repairSelection(
      editor,
      proposed?.selection ?? prevSelection,
    );

    runtime.selection.value = repaired;

    const mergedEffects = [
      ...(proposed?.effects ?? []),
      ...(hints.effects ?? []),
    ];

    runtime.scheduleEffects(
      repaired,
      normalizeEffectsForSelection(repaired, mergedEffects),
    );

    return result;
  };

  const api: Editor = { model, runtime, getSelection, setSelection, commit };
  return api;
}

export type CmdResult = {
  didChange: boolean;
  selection?: Selection;
  effects?: EditorEffect[];
  issue?: string;
};

export function safeIssue(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function tryCmd(fn: () => CmdResult): CmdResult {
  try {
    return fn();
  } catch (err) {
    return { didChange: false, issue: safeIssue(err) };
  }
}

export function applyCmd(editor: Editor, res: CmdResult): CmdResult {
  if (res.selection) editor.setSelection(res.selection, res.effects ?? []);
  return res;
}

export function setIdle(editor: Editor): void {
  editor.setSelection({ kind: "idle" });
}
