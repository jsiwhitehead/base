import { computed, effect } from "@preact/signals-core";
import type { Core, Focus, Component, Caret, ViewName } from "../core";
import { DEFAULT_TARGET, defaultTextCaret } from "../core/runtime";

export class Disposer {
  private fns: (() => void)[] = [];

  add(fn: (() => void) | null | undefined): (() => void) | undefined {
    if (!fn) return undefined;
    this.fns.push(fn);
    return fn;
  }

  run(): void {
    for (let i = this.fns.length - 1; i >= 0; i--) this.fns[i]?.();
    this.fns = [];
  }
}

export function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
  el0: T,
  type: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
): () => void {
  const listener = (event: Event) =>
    handler.call(el0, event as HTMLElementEventMap[K]);
  el0.addEventListener(type, listener as EventListener, opts);
  return () => el0.removeEventListener(type, listener as EventListener, opts);
}

export function stopEvent(e: Event): void {
  e.preventDefault?.();
  e.stopPropagation?.();
}

export function ensureTabbable(elm: HTMLElement): void {
  if (elm.tabIndex == null || elm.tabIndex < 0) elm.tabIndex = 0;
}

export function reconcileChildren(
  parent: HTMLElement,
  desired: readonly HTMLElement[],
): void {
  for (let i = 0; i < desired.length; i++) {
    const next = desired[i]!;
    const cur = parent.children.item(i);
    if (cur !== next) parent.insertBefore(next, cur);
  }
  while (parent.children.length > desired.length)
    parent.lastElementChild?.remove();
}

export function setData(
  el0: HTMLElement,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value == null || value === "") {
    delete (el0.dataset as any)[key];
    return;
  }
  (el0.dataset as any)[key] = String(value);
}

export function setDataBool(el0: HTMLElement, key: string, on0: boolean): void {
  (el0.dataset as any)[key] = on0 ? "true" : "false";
}

export function applyUiItemState(
  root: HTMLElement,
  args: { core: Core; focus: Focus; view: ViewName; part?: string },
): void {
  const { core, focus, view } = args;

  const snap = core.item(focus.item);
  const sel = core.selection();

  const focused =
    sel.kind === "focused" &&
    sel.focus.item === focus.item &&
    sel.focus.container === focus.container;

  setData(root, "id", focus.item);
  setData(root, "view", view);
  setData(root, "kind", snap.content.kind);
  setData(root, "mode", snap.mode.kind);
  setDataBool(root, "focused", focused);
  setData(root, "part", args.part ?? null);
}

type ChildRec = { element: HTMLElement; dispose: () => void };

class ChildManager<Id extends string | number> {
  private cache = new Map<Id, ChildRec>();

  constructor(
    private container: HTMLElement,
    private create: (id: Id) => { element: HTMLElement; dispose(): void },
  ) {}

  setContainer(next: HTMLElement) {
    if (this.container === next) return;
    for (const { element } of this.cache.values()) next.append(element);
    this.container = next;
  }

  update(ids: readonly Id[]) {
    const keep = new Set(ids);

    for (const [id, rec] of this.cache) {
      if (keep.has(id)) continue;
      rec.dispose();
      this.cache.delete(id);
    }

    const desired: HTMLElement[] = ids.map((id) => {
      let rec = this.cache.get(id);
      if (!rec) {
        const v = this.create(id);
        rec = { element: v.element, dispose: v.dispose.bind(v) };
        this.cache.set(id, rec);
      }
      return rec.element;
    });

    reconcileChildren(this.container, desired);
  }

  dispose() {
    for (const rec of this.cache.values()) rec.dispose();
    this.cache.clear();
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;

  const aKeys = Object.keys(a as object);
  const bKeys = Object.keys(b as object);
  if (aKeys.length !== bKeys.length) return false;

  for (const k of aKeys) {
    if (!(k in (b as object)) || !Object.is((a as any)[k], (b as any)[k])) {
      return false;
    }
  }
  return true;
}

export type FocusComponent<E extends HTMLElement = HTMLElement> = Component & {
  focusEl: E;
};

export function isFocusComponent(c: Component): c is FocusComponent {
  return "focusEl" in (c as any) && (c as any).focusEl instanceof HTMLElement;
}

export function focusElOf(c: Component): HTMLElement {
  return isFocusComponent(c) ? c.focusEl : c.el;
}

type PointerCaretMode = "zero" | "fromTarget";

function caretFromTarget(el0: EventTarget | null): Caret {
  const el1 = el0 instanceof HTMLElement ? el0 : null;
  if (el1 instanceof HTMLInputElement || el1 instanceof HTMLTextAreaElement) {
    const start = el1.selectionStart ?? 0;
    const end = el1.selectionEnd ?? start;
    return { start, end };
  }
  return { start: 0, end: 0 };
}

export type FocusScope = {
  elementFor(target: string, getEl: () => HTMLElement | null): void;

  selectOn(
    el0: HTMLElement,
    opts?: {
      target?: string;
      caret?: PointerCaretMode;
      stopPropagation?: boolean;
    },
  ): void;
};

export type Ctx = {
  onCleanup(fn: (() => void) | null | undefined): void;

  use(x: { dispose(): void } | (() => void) | null | undefined): void;

  on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
    el0: T,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;

  watch<T extends readonly unknown[]>(
    ...args: [
      ...computes: { [K in keyof T]: () => T[K] },
      run: (...vals: T) => void | (() => void),
    ]
  ): void;

  slot(host: HTMLElement): { set(next: Component | null): void };

  list<Id extends string | number>(
    host: HTMLElement,
    create: (id: Id) => Component,
  ): { update(ids: readonly Id[]): void };

  focus(
    core: Core,
    focus: Focus,
    spec: {
      default: () => HTMLElement | null;
      caret?: { set(pos: number): void; getLength(): number };
    },
  ): FocusScope;
};

export function createComponent(build: (ctx: Ctx) => HTMLElement): Component {
  const bag = new Disposer();

  const ctx: Ctx = {
    onCleanup(fn) {
      bag.add(fn);
    },

    use(x) {
      if (!x) return;
      if (typeof x === "function") bag.add(x);
      else bag.add(() => x.dispose());
    },

    on(el0, type, handler, opts) {
      bag.add(on(el0, type, handler, opts));
    },

    watch(...args) {
      const run = args.at(-1) as (...vals: any[]) => void | (() => void);
      const sigs = args.slice(0, -1).map((c) => computed(c as () => unknown));

      let prev: unknown[] | null = null;

      const memo = computed(() => {
        const next = sigs.map((s) => s.value);
        if (prev && next.every((v, i) => shallowEqual(v, prev![i])))
          return prev;
        prev = next;
        return next;
      });

      bag.add(effect(() => run(...memo.value)));
    },

    slot(host) {
      let cur: Component | null = null;

      const set = (next: Component | null) => {
        if (cur === next) return;
        cur?.dispose();
        cur = next;
        if (next) host.replaceChildren(next.el);
        else host.replaceChildren();
      };

      bag.add(() => {
        cur?.dispose();
        cur = null;
      });

      return { set };
    },

    list<Id extends string | number>(
      host: HTMLElement,
      create: (id: Id) => Component,
    ) {
      const mgr = new ChildManager<Id>(host, (id) => {
        const c = create(id);
        return { element: c.el, dispose: c.dispose };
      });

      bag.add(() => mgr.dispose());

      return { update: (ids: readonly Id[]) => mgr.update(ids) };
    },

    focus(core, focus, spec) {
      const targets = new Map<string, () => HTMLElement | null>();
      targets.set(DEFAULT_TARGET, spec.default);

      const caret = spec.caret ?? defaultTextCaret();

      const unbind = core.attachFocus({
        focus,
        elementFor: (target: string) =>
          (targets.get(target) ?? targets.get(DEFAULT_TARGET))?.() ?? null,
        caret,
      });

      bag.add(unbind);

      const scope: FocusScope = {
        elementFor(target, getEl) {
          targets.set(target, getEl);
        },

        selectOn(el0, opts = {}) {
          const target = opts.target ?? DEFAULT_TARGET;
          const caretMode = opts.caret ?? "zero";
          const stop = opts.stopPropagation ?? true;

          bag.add(
            on(el0, "pointerdown", (e: PointerEvent) => {
              const caret0 =
                caretMode === "fromTarget" ? caretFromTarget(e.target) : null;

              core.focus(focus, target, caret0 ? { caret: caret0 } : undefined);

              if (stop) e.stopPropagation();
            }),
          );
        },
      };

      return scope;
    },
  };

  const el0 = build(ctx);

  return {
    el: el0,
    dispose() {
      bag.run();
      el0.replaceChildren();
    },
  };
}
