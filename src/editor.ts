import { signal, type Signal } from "@preact/signals-core";
import type { Store, ItemId, Txn, ApplyResult } from "./store";

export type Focus = { containerId: ItemId; id: ItemId };

export type FocusTarget =
  | { kind: "content" }
  | { kind: "header"; index: number };

export type Selection =
  | { kind: "idle" }
  | { kind: "focused"; focus: Focus; target: FocusTarget };

export type Anchor = "top" | "bottom";

export type EditorEffect =
  | {
      type: "DOM_FOCUS";
      focus: Focus;
      target: FocusTarget;
      caret?: number;
      anchor?: Anchor;
    }
  | { type: "CLEAR_DOM_FOCUS" };

export type SelectionHints = {
  propose?: (ctx: {
    store: Store;
    prevSelection: Selection;
    result: ApplyResult;
  }) => { selection?: Selection; effects?: EditorEffect[] };
  effects?: EditorEffect[];
};

export type Editor = {
  store: Store;
  runtime: EditorRuntime;
  getSelection(): Selection;
  setSelection(next: Selection, effects?: EditorEffect[]): void;
  apply(txn: Txn, hints?: SelectionHints): ApplyResult;
};

export type RegionId = string;

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";
export type NavOut = { dir: NavDir; mode: NavMode };
export type RegionKeyResult = void | { navOut: NavOut };

export type Region = {
  id: RegionId;
  root: HTMLElement;
  onKeyDown(e: KeyboardEvent): RegionKeyResult;
  onActivate?(): void;
  onDeactivate?(): void;
  dispose(): void;
};

export type Binding = {
  focus: Focus;
  elementFor(target: FocusTarget): HTMLElement | null;
  setCaret?: (pos: number) => void;
  getTextLength?: () => number;
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

const keyOf = (f: Focus) => `${String(f.containerId)}::${String(f.id)}`;

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
  if (!active) return false;
  if (active instanceof HTMLElement && active.isContentEditable) return true;
  return (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type === "text")
  );
}

export class EditorRuntime {
  selection: Signal<Selection>;

  private rafHandle: number | null = null;
  private pendingEffects: { sel: Selection; effects: EditorEffect[] } | null =
    null;

  private bindings = new Map<string, Binding>();

  private regions = new Map<RegionId, Region>();
  private regionRoots = new WeakMap<HTMLElement, RegionId>();
  private activeRegionId: RegionId | null = null;

  private navOutHandler:
    | ((fromRegionId: RegionId, navOut: NavOut) => void)
    | null = null;

  constructor(initialSelection: Selection = { kind: "idle" }) {
    this.selection = signal<Selection>(initialSelection);
  }

  getActiveRegionId(): RegionId | null {
    return this.activeRegionId;
  }

  setNavOutHandler(
    fn: ((fromRegionId: RegionId, navOut: NavOut) => void) | null,
  ) {
    this.navOutHandler = fn;
  }

  registerRegion(region: Region) {
    this.regions.set(region.id, region);
    this.regionRoots.set(region.root, region.id);
  }

  unregisterRegion(regionId: RegionId) {
    if (this.activeRegionId === regionId) this.setActiveRegion(null);
    this.regions.delete(regionId);
  }

  setActiveRegion(regionId: RegionId | null) {
    if (regionId === this.activeRegionId) return;

    const prev = this.activeRegionId
      ? this.regions.get(this.activeRegionId)
      : null;
    const next = regionId ? this.regions.get(regionId) : null;

    prev?.onDeactivate?.();
    this.activeRegionId = regionId;
    next?.onActivate?.();
  }

  installRegionListeners() {
    const onPointerDown = (e: PointerEvent) =>
      this.setActiveRegion(this.regionAtTarget(e.target));

    const onKeyDown = (e: KeyboardEvent) => {
      if (!this.activeRegionId || shouldBypassGlobalKeydown()) return;
      const res = this.regions.get(this.activeRegionId)?.onKeyDown(e);
      if (res && "navOut" in res)
        this.navOutHandler?.(this.activeRegionId, res.navOut);
    };

    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      } as any);
      window.removeEventListener("keydown", onKeyDown);
    };
  }

  registerBinding(binding: Binding) {
    const k = keyOf(binding.focus);
    if (this.bindings.get(k) === binding) {
      this.updateDOMFocus(this.selection.peek());
      return;
    }
    this.bindings.set(k, binding);
    this.updateDOMFocus(this.selection.peek());
  }

  unregisterBinding(focus: Focus) {
    const k = keyOf(focus);
    this.bindings.delete(k);

    const sel = this.selection.peek();
    if (sel.kind === "focused" && keyOf(sel.focus) === k) {
      this.selection.value = { kind: "idle" };
      this.scheduleEffects(this.selection.peek(), [
        { type: "CLEAR_DOM_FOCUS" },
      ]);
    }
  }

  scheduleEffects(sel: Selection, effects: EditorEffect[]) {
    if (!effects.length) return;
    this.pendingEffects = { sel, effects };
    if (this.rafHandle != null) return;

    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      const next = this.pendingEffects;
      this.pendingEffects = null;
      if (next) this.applyEffects(next.sel, next.effects);
    });
  }

  applyEffects(sel: Selection, effects: EditorEffect[]) {
    for (const eff of effects) {
      if (eff.type === "DOM_FOCUS") {
        this.updateDOMFocus(sel, eff.caret, eff.anchor);
      } else if (eff.type === "CLEAR_DOM_FOCUS") {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
      }
    }
  }

  updateDOMFocus(sel: Selection, caretPos?: number, anchor?: Anchor) {
    if (sel.kind !== "focused") return;

    const binding = this.bindings.get(keyOf(sel.focus));
    const targetEl = binding?.elementFor(sel.target);
    if (!binding || !targetEl) return;

    const wasFocused = document.activeElement === targetEl;
    if (!wasFocused) targetEl.focus({ preventScroll: true });

    const hitRegion = this.regionAtTarget(targetEl);
    if (hitRegion) this.setActiveRegion(hitRegion);

    if (caretPos !== undefined && binding.setCaret && binding.getTextLength) {
      const len = binding.getTextLength();
      binding.setCaret(caretPos === Infinity ? len : clamp(caretPos, 0, len));
      return;
    }

    if (!isTextInput(targetEl)) return;

    let pos: number | null = null;

    if (caretPos !== undefined) {
      pos =
        caretPos === Infinity
          ? targetEl.value.length
          : clamp(caretPos, 0, targetEl.value.length);
    } else if (!wasFocused) {
      pos = anchor
        ? computeAnchoredPos(targetEl.value, targetEl.value.length, anchor)
        : targetEl.value.length;
    }

    if (pos != null) targetEl.setSelectionRange(pos, pos);
  }

  private regionAtTarget(target: EventTarget | null): RegionId | null {
    for (
      let el = target instanceof HTMLElement ? target : null;
      el;
      el = el.parentElement
    ) {
      const hit = this.regionRoots.get(el);
      if (hit) return hit;
    }
    return null;
  }
}

export function mkFocusSelection(
  focus: Focus,
  target: FocusTarget,
  caret = 0,
): { selection: Selection; effects: EditorEffect[] } {
  const selection: Selection = { kind: "focused", focus, target };
  const effects: EditorEffect[] = [{ type: "DOM_FOCUS", focus, target, caret }];
  return { selection, effects };
}

function headerExtraCount(store: Store, id: ItemId): number {
  const { contentKind } = store.sel.item(id);
  if (contentKind === "derived") return 1;
  if (contentKind === "lens") return 3;
  return 0;
}

function normalizeTarget(
  store: Store,
  focusId: ItemId,
  target: FocusTarget,
): FocusTarget {
  if (target.kind !== "header") return target;
  const total = 1 + headerExtraCount(store, focusId);
  if (total <= 0) return { kind: "content" };
  const index = clamp(target.index, 0, total - 1);
  return index === target.index ? target : { kind: "header", index };
}

function repairSelection(store: Store, sel: Selection): Selection {
  if (sel.kind === "idle") return sel;

  try {
    store.sel.item(sel.focus.id);
    const target = normalizeTarget(store, sel.focus.id, sel.target);
    return target === sel.target ? sel : { ...sel, target };
  } catch {
    try {
      const root = store.getRoot();
      store.sel.item(root);
      return {
        kind: "focused",
        focus: { containerId: root, id: root },
        target: { kind: "content" },
      };
    } catch {
      return { kind: "idle" };
    }
  }
}

export function createEditor(store: Store): Editor {
  const runtime = new EditorRuntime({ kind: "idle" });

  const getSelection = () => runtime.selection.value;

  const setSelection = (next: Selection, effects: EditorEffect[] = []) => {
    const repaired = repairSelection(store, next);
    runtime.selection.value = repaired;
    runtime.scheduleEffects(repaired, effects);
  };

  const apply = (txn: Txn, hints: SelectionHints = {}): ApplyResult => {
    const prevSelection = getSelection();
    const result = store.apply(txn);

    const proposed = hints.propose?.({ store, prevSelection, result });
    const nextSelection = proposed?.selection ?? prevSelection;
    const repaired = repairSelection(store, nextSelection);

    runtime.selection.value = repaired;
    runtime.scheduleEffects(repaired, [
      ...(proposed?.effects ?? []),
      ...(hints.effects ?? []),
    ]);

    return result;
  };

  return { store, runtime, getSelection, setSelection, apply };
}
