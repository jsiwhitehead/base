import { effect } from "@preact/signals-core";
import type { Core, Focus, Component, Caret, ViewName } from "../core";
import { DEFAULT_TARGET } from "../core/runtime";

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

export function makeNotTabbable(elm: HTMLElement): void {
  elm.tabIndex = -1;
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

export function caretFromTarget(el0: EventTarget | null): Caret {
  const el1 = el0 instanceof HTMLElement ? el0 : null;
  if (el1 instanceof HTMLInputElement || el1 instanceof HTMLTextAreaElement) {
    const start = el1.selectionStart ?? 0;
    const end = el1.selectionEnd ?? start;
    return { start, end };
  }
  return { start: 0, end: 0 };
}

export type Ctx = {
  cleanup(fn: (() => void) | null | undefined): void;

  on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
    target: T,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;

  effect(run: () => void | (() => void)): void;

  slot(host: HTMLElement): { set(next: Component | null): void };

  list<Id extends string | number>(
    host: HTMLElement,
    create: (id: Id) => Component,
  ): { update(ids: readonly Id[]): void };

  target(
    focus: Focus,
    target: string,
    getEl: () => HTMLElement | null,
    opts?: { caret?: { set(pos: number): void; getLength(): number } },
  ): void;

  select(
    focus: Focus,
    el0: HTMLElement,
    opts?: {
      target?: string;
      caret?: PointerCaretMode;
      stopPropagation?: boolean;
    },
  ): void;
};

export function createComponent(
  core: Core,
  build: (ctx: Ctx) => HTMLElement,
): Component {
  const bag = new Disposer();

  const ctx: Ctx = {
    cleanup(fn) {
      bag.add(fn);
    },

    on(target, type, handler, opts) {
      bag.add(on(target, type, handler, opts));
    },

    effect(run) {
      let prevCleanup: (() => void) | null = null;

      const disposeEffect = effect(() => {
        prevCleanup?.();
        prevCleanup = null;

        const next = run();
        if (typeof next === "function") prevCleanup = next;
      });

      bag.add(() => {
        prevCleanup?.();
        prevCleanup = null;
      });
      bag.add(disposeEffect);
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

    target(focus, target, getEl, opts) {
      const unbind = core.attachTarget({
        focus,
        target,
        getEl,
        ...(opts?.caret ? { caret: opts.caret } : {}),
      });
      bag.add(unbind);
    },

    select(focus, el0, opts = {}) {
      const target = opts.target ?? DEFAULT_TARGET;
      const caretMode = opts.caret ?? "zero";
      const stop = opts.stopPropagation ?? true;

      bag.add(
        on(el0, "pointerdown", (e: Event) => {
          const pe = e as PointerEvent;
          const caret0 =
            caretMode === "fromTarget" ? caretFromTarget(pe.target) : null;

          core.focus(focus, target, caret0 ? { caret: caret0 } : undefined);

          if (stop) pe.stopPropagation();
        }),
      );
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

export type ContentSpec = {
  core: Core;
  focus: Focus;
  view: ViewName;
  part?: string;
};

export function createPresenter(
  core: Core,
  build: (ctx: Ctx) => HTMLElement,
): Component {
  return createComponent(core, build);
}

export function createContent(
  spec: ContentSpec,
  build: (ctx: Ctx) => HTMLElement,
): Component {
  return createComponent(spec.core, (ctx) => {
    const root = build(ctx);
    root.classList.add("ui-item");

    ctx.effect(() => {
      spec.core.item(spec.focus.item);
      spec.core.selection();
      applyUiItemState(root, {
        core: spec.core,
        focus: spec.focus,
        view: spec.view,
        part: spec.part,
      });
    });

    return root;
  });
}
