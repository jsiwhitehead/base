import { signal, type Signal } from "@preact/signals-core";
import type { ItemId, Transaction, ApplyResult, Model } from "./model";

export type Focus = { scopeId: ItemId; id: ItemId };

export type FocusTarget =
  | { kind: "content" }
  | { kind: "header"; index: number };

export type Caret = { start: number; end: number };

export const caret0 = (): Caret => ({ start: 0, end: 0 });
export const caretAt = (pos: number): Caret => ({ start: pos, end: pos });
export const caretRange = (start: number, end: number): Caret => ({
  start,
  end,
});

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

export type Editor = {
  model: Model;
  runtime: EditorRuntime;
  getSelection(): Selection;
  setSelection(next: Selection, effects?: EditorEffect[]): void;
  commit(txn: Transaction, hints?: CommitHints): ApplyResult;
};

export type ViewId = string;

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";
export type NavOut = { dir: NavDir; mode: NavMode };
export type ViewKeyResult = void | { navOut: NavOut };

export type View = {
  id: ViewId;
  onKeyDown?: (e: unknown) => ViewKeyResult;
  onActivate?(): void;
  onDeactivate?(): void;
  normalizeTarget?: (
    ctx: { model: Model },
    focus: Focus,
    target: FocusTarget,
  ) => FocusTarget;
  dispose(): void;
};

export type BindingHandle = unknown;

export type Binding = {
  focus: Focus;
  elementFor(target: FocusTarget): BindingHandle | null;
  setCaret?: (pos: number) => void;
  getTextLength?: () => number;
};

export type EffectsApplier = (sel: Selection, effects: EditorEffect[]) => void;

const keyOf = (f: Focus): string => `${String(f.scopeId)}::${String(f.id)}`;

function fallbackNormalizeTarget(target: FocusTarget): FocusTarget {
  return target.kind === "header" ? { kind: "content" } : target;
}

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

  private bindings = new Map<string, Binding>();

  private views = new Map<ViewId, View>();
  private activeViewId: ViewId | null = null;

  private navOutHandler: ((fromViewId: ViewId, navOut: NavOut) => void) | null =
    null;

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

  getActiveViewId(): ViewId | null {
    return this.activeViewId;
  }

  getActiveView(): View | null {
    const id = this.activeViewId;
    return id ? (this.views.get(id) ?? null) : null;
  }

  setNavOutHandler(
    fn: ((fromViewId: ViewId, navOut: NavOut) => void) | null,
  ): void {
    this.navOutHandler = fn;
  }

  registerView(view: View): void {
    this.views.set(view.id, view);
  }

  unregisterView(viewId: ViewId): void {
    if (this.activeViewId === viewId) this.setActiveView(null);
    this.views.delete(viewId);
  }

  setActiveView(viewId: ViewId | null): void {
    if (viewId === this.activeViewId) return;

    const prevId = this.activeViewId;
    const prev = prevId ? this.views.get(prevId) : null;
    const next = viewId ? this.views.get(viewId) : null;

    prev?.onDeactivate?.();
    this.activeViewId = viewId;
    next?.onActivate?.();
  }

  dispatchKeyDown(e: unknown): void {
    const viewId = this.activeViewId;
    if (!viewId) return;

    const res = this.views.get(viewId)?.onKeyDown?.(e);
    if (res && "navOut" in res && res.navOut) {
      this.navOutHandler?.(viewId, res.navOut);
    }
  }

  registerBinding(binding: Binding): void {
    const k = keyOf(binding.focus);
    this.bindings.set(k, binding);
  }

  unregisterBinding(focus: Focus): void {
    const k = keyOf(focus);
    this.bindings.delete(k);

    const sel = this.selection.peek();
    if (sel.kind !== "focused" || keyOf(sel.focus) !== k) return;

    this.scheduleEffects(sel, [{ type: "CLEAR_FOCUS" }]);
  }

  getBinding(focus: Focus): Binding | null {
    return this.bindings.get(keyOf(focus)) ?? null;
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

    const active = editor.runtime.getActiveView();
    const normalized =
      active?.normalizeTarget?.({ model }, sel.focus, sel.target) ??
      fallbackNormalizeTarget(sel.target);

    if (normalized === sel.target) return sel;
    return { ...sel, target: normalized };
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
