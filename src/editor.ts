import { signal, type Signal } from "@preact/signals-core";
import { DEV, devWarn } from "./dev";
import type { ItemId, Transaction, ApplyResult, Store } from "./store";

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
  | { type: "DOM_FOCUS"; focus: Focus; target: FocusTarget; anchor?: Anchor }
  | { type: "CLEAR_DOM_FOCUS" };

export type CommitHints = {
  propose?: (ctx: {
    store: Store;
    prevSelection: Selection;
    result: ApplyResult;
  }) => { selection?: Selection; effects?: EditorEffect[] };
  effects?: EditorEffect[];
};

export type NextSelection =
  | { selection: Selection; effects?: EditorEffect[] }
  | ((ctx: { store: Store; prevSelection: Selection; result: ApplyResult }) => {
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
  store: Store;
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
  root: HTMLElement;
  onKeyDown(e: KeyboardEvent): ViewKeyResult;
  onActivate?(): void;
  onDeactivate?(): void;
  normalizeTarget?: (
    ctx: { store: Store },
    focus: Focus,
    target: FocusTarget,
  ) => FocusTarget;
  dispose(): void;
};

export type Binding = {
  focus: Focus;
  elementFor(target: FocusTarget): HTMLElement | null;
  setCaret?: (pos: number) => void;
  getTextLength?: () => number;
};

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));
const keyOf = (f: Focus): string => `${String(f.scopeId)}::${String(f.id)}`;

function isTextInput(
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement {
  return (
    (el instanceof HTMLInputElement && el.type === "text") ||
    el instanceof HTMLTextAreaElement
  );
}

function computeAnchoredPos(
  text: string,
  column: number,
  anchor: Anchor,
): number {
  const nl = anchor === "top" ? text.indexOf("\n") : text.lastIndexOf("\n");
  if (nl === -1) return clamp(column, 0, text.length);
  const lineStart = anchor === "top" ? 0 : nl + 1;
  return lineStart + clamp(column, 0, text.length - lineStart);
}

function shouldBypassGlobalKeydown(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  return (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type === "text")
  );
}

function normalizeEffectsForSelection(
  sel: Selection,
  effects: EditorEffect[],
): EditorEffect[] {
  const hasClear = effects.some((e) => e.type === "CLEAR_DOM_FOCUS");
  const hasFocus = effects.some((e) => e.type === "DOM_FOCUS");

  if (sel.kind === "idle") {
    if (hasClear) return effects;
    return [...effects, { type: "CLEAR_DOM_FOCUS" }];
  }

  if (hasClear) return effects;
  if (hasFocus) return effects;

  return [
    ...effects,
    { type: "DOM_FOCUS", focus: sel.focus, target: sel.target },
  ];
}

function fallbackNormalizeTarget(target: FocusTarget): FocusTarget {
  return target.kind === "header" ? { kind: "content" } : target;
}

export class EditorRuntime {
  selection: Signal<Selection>;

  private rafHandle: number | null = null;
  private pending: { sel: Selection; effects: EditorEffect[] } | null = null;

  private bindings = new Map<string, Binding>();

  private views = new Map<ViewId, View>();
  private viewRoots = new WeakMap<HTMLElement, ViewId>();
  private activeViewId: ViewId | null = null;

  private navOutHandler: ((fromViewId: ViewId, navOut: NavOut) => void) | null =
    null;

  constructor(initialSelection: Selection = { kind: "idle" }) {
    this.selection = signal(initialSelection);
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
    this.viewRoots.set(view.root, view.id);
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

  installViewListeners(): () => void {
    const onPointerDown = (e: PointerEvent) =>
      this.setActiveView(this.viewAtTarget(e.target));
    const pointerOptions = { capture: true } as const;
    const onKeyDown = (e: KeyboardEvent) => {
      const viewId = this.activeViewId;
      if (!viewId || shouldBypassGlobalKeydown()) return;
      const res = this.views.get(viewId)?.onKeyDown(e);
      if (res?.navOut) this.navOutHandler?.(viewId, res.navOut);
    };

    window.addEventListener("pointerdown", onPointerDown, pointerOptions);
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, pointerOptions);
      window.removeEventListener("keydown", onKeyDown);
    };
  }

  registerBinding(binding: Binding): void {
    const k = keyOf(binding.focus);
    this.bindings.set(k, binding);
    this.updateDOMFocus(this.selection.peek());
  }

  unregisterBinding(focus: Focus): void {
    const k = keyOf(focus);
    this.bindings.delete(k);

    const sel = this.selection.peek();
    if (sel.kind !== "focused" || keyOf(sel.focus) !== k) return;

    const next: Selection = { kind: "idle" };
    this.selection.value = next;
    this.scheduleEffects(next, normalizeEffectsForSelection(next, []));
  }

  scheduleEffects(sel: Selection, effects: EditorEffect[]): void {
    if (!effects.length) return;

    this.pending = this.pending
      ? { sel, effects: [...this.pending.effects, ...effects] }
      : { sel, effects };

    if (this.rafHandle != null) return;

    if (DEV && typeof requestAnimationFrame !== "function") {
      devWarn(
        "requestAnimationFrame is not defined; EditorRuntime effects won't schedule (tests should shim it).",
      );
    }

    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      const next = this.pending;
      this.pending = null;
      if (next) this.applyEffects(next.sel, next.effects);
    });
  }

  applyEffects(sel: Selection, effects: EditorEffect[]): void {
    for (const eff of effects) {
      if (eff.type === "DOM_FOCUS") {
        this.updateDOMFocus(sel, eff.anchor);
      } else {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
    }
  }

  updateDOMFocus(sel: Selection, anchor?: Anchor): void {
    if (sel.kind !== "focused") return;

    const binding = this.bindings.get(keyOf(sel.focus));
    if (DEV && !binding) devWarn("No binding for focus", sel.focus);
    const targetEl = binding?.elementFor(sel.target);
    if (!binding || !targetEl) return;

    const wasFocused = document.activeElement === targetEl;
    if (!wasFocused) targetEl.focus({ preventScroll: true });

    const hitView = this.viewAtTarget(targetEl);
    if (hitView) this.setActiveView(hitView);

    const caret = sel.caret;
    if (caret && binding.setCaret && binding.getTextLength) {
      const len = binding.getTextLength();
      binding.setCaret(clamp(caret.end, 0, len));
      return;
    }

    if (!isTextInput(targetEl) || wasFocused) return;

    const pos = anchor
      ? computeAnchoredPos(targetEl.value, targetEl.value.length, anchor)
      : targetEl.value.length;

    targetEl.setSelectionRange(pos, pos);
  }

  private viewAtTarget(target: EventTarget | null): ViewId | null {
    for (
      let el = target instanceof HTMLElement ? target : null;
      el;
      el = el.parentElement
    ) {
      const hit = this.viewRoots.get(el);
      if (hit) return hit;
    }
    return null;
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
  return { selection, effects: [{ type: "DOM_FOCUS", focus, target }] };
}

export function repairSelection(editor: Editor, sel: Selection): Selection {
  const store = editor.store;

  if (sel.kind === "idle") return sel;

  try {
    store.peekItem(sel.focus.id);

    const active = editor.runtime.getActiveView();
    const normalized =
      active?.normalizeTarget?.({ store }, sel.focus, sel.target) ??
      fallbackNormalizeTarget(sel.target);

    if (normalized === sel.target) return sel;
    return { ...sel, target: normalized };
  } catch {
    try {
      const root = store.getRoot();
      store.peekItem(root);
      return {
        kind: "focused",
        focus: { scopeId: root, id: root },
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

export function createEditor(store: Store): Editor {
  const runtime = new EditorRuntime({ kind: "idle" });

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
    const result = store.apply(txn);

    const proposed = hints.propose?.({ store, prevSelection, result });
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

  const api: Editor = { store, runtime, getSelection, setSelection, commit };
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
