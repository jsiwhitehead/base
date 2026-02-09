import { computed, effect } from "@preact/signals-core";
import type { Core, Focus, Component, Caret, ViewName } from "../core";
import { DEFAULT_TARGET } from "../core";

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

export type UiItemState = {
  id: string;
  view: ViewName;
  kind: string;
  mode: string;
  part?: string | null;
};

export function applyUiItemState(root: HTMLElement, st: UiItemState): void {
  setData(root, "id", st.id);
  setData(root, "view", st.view);
  setData(root, "kind", st.kind);
  setData(root, "mode", st.mode);
  setData(root, "part", st.part ?? null);
}

type ChildRec = { element: HTMLElement; dispose: () => void };

class ChildManager<Id extends string | number> {
  private cache = new Map<Id, ChildRec>();

  constructor(
    private container: HTMLElement,
    private create: (id: Id) => { element: HTMLElement; dispose(): void },
  ) {}

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

  clear() {
    for (const rec of this.cache.values()) rec.dispose();
    this.cache.clear();
    this.container.replaceChildren();
  }

  dispose() {
    this.clear();
  }
}

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

  slot(host: HTMLElement): { set(next: Component | null): void; clear(): void };

  list<Id extends string | number>(
    host: HTMLElement,
    create: (id: Id) => Component,
  ): { update(ids: readonly Id[]): void; clear(): void };

  target(
    focus: Focus,
    target: string,
    getEl: () => HTMLElement | null,
    opts?: { caret?: { set(pos: number): void; getLength(): number } },
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

      const clear = () => set(null);

      bag.add(() => {
        cur?.dispose();
        cur = null;
      });

      return { set, clear };
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

      return {
        update: (ids: readonly Id[]) => mgr.update(ids),
        clear: () => mgr.clear(),
      };
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

export function createContent(
  spec: ContentSpec,
  build: (ctx: Ctx) => HTMLElement,
): Component {
  return createComponent(spec.core, (ctx) => {
    const root = build(ctx);
    root.classList.add("ui-item");

    const isFocused = computed(() => {
      const sel = spec.core.selection();
      return (
        sel.kind === "focused" &&
        sel.focus.item === spec.focus.item &&
        sel.focus.container === spec.focus.container
      );
    });

    ctx.effect(() => {
      const snap = spec.core.item(spec.focus.item);
      applyUiItemState(root, {
        id: spec.focus.item,
        view: spec.view,
        kind: snap.content.kind,
        mode: snap.mode.kind,
        part: spec.part ?? null,
      });
    });

    ctx.effect(() => {
      setDataBool(root, "focused", isFocused.value);
    });

    return root;
  });
}

export type PresentItemOpts = {
  core: Core;
  focus: Focus;
  className?: string;
  mount: (
    ctx: Ctx,
    host: HTMLElement,
    slot: { set(next: Component | null): void; clear(): void },
  ) => void;
};

export function presentItem(opts: PresentItemOpts): Component {
  const { core, focus } = opts;

  return createComponent(core, (ctx) => {
    const host = el("div", opts.className);
    host.tabIndex = -1;

    const slot = ctx.slot(host);

    ctx.target(focus, DEFAULT_TARGET, () => host);

    ctx.on(host, "pointerdown", (e: PointerEvent) => {
      core.focus(focus, DEFAULT_TARGET, { caret: caretFromTarget(e.target) });
      e.stopPropagation();
    });

    opts.mount(ctx, host, slot);

    return host;
  });
}
