import { computed, effect } from "@preact/signals-core";

import type { Caret, Component, Core, Focus, ViewName } from "../core";
import { DEFAULT_TARGET } from "../core";

class Disposer {
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

type Region = {
  host: HTMLElement;
  start: Comment;
  end: Comment;
  clear(): void;
  reconcile(desired: readonly HTMLElement[]): void;
  dispose(): void;
};

function createRegion(host: HTMLElement): Region {
  const start = document.createComment("region:start");
  const end = document.createComment("region:end");
  host.append(start, end);

  const clear = () => {
    let n = start.nextSibling;
    while (n && n !== end) {
      const next = n.nextSibling;
      n.remove();
      n = next;
    }
  };

  const reconcile = (desired: readonly HTMLElement[]) => {
    let anchor: ChildNode = end;

    for (let i = desired.length - 1; i >= 0; i--) {
      const next = desired[i]!;
      if (next.parentNode !== host || next.nextSibling !== anchor)
        host.insertBefore(next, anchor);
      anchor = next;
    }

    let cur = start.nextSibling;
    const keep = new Set(desired);

    while (cur && cur !== end) {
      const next = cur.nextSibling;
      if (cur instanceof HTMLElement && keep.has(cur)) {
        cur = next;
        continue;
      }
      cur.remove();
      cur = next;
    }
  };

  const dispose = () => {
    clear();
    start.remove();
    end.remove();
  };

  return { host, start, end, clear, reconcile, dispose };
}

type ChildRec = { element: HTMLElement; dispose: () => void };

class RegionChildManager<Id extends string | number> {
  private cache = new Map<Id, ChildRec>();

  constructor(
    private region: Region,
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

    this.region.reconcile(desired);
  }

  clear() {
    for (const rec of this.cache.values()) rec.dispose();
    this.cache.clear();
    this.region.clear();
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

type Ctx = {
  cleanup(fn: (() => void) | null | undefined): void;

  on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
    target: T,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;

  effect(run: () => void | (() => void)): void;

  slot(host: HTMLElement, get: () => Component | null): void;

  list<Id extends string | number>(
    host: HTMLElement,
    getIds: () => readonly Id[],
    create: (id: Id) => Component,
  ): void;

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

    slot(host, get) {
      const region = createRegion(host);
      let cur: Component | null = null;

      const disposeEffect = effect(() => {
        const next = get();
        if (next === cur) return;

        cur?.dispose();
        cur = next;

        region.clear();

        if (next) host.insertBefore(next.el, region.end);
      });

      bag.add(() => {
        cur?.dispose();
        cur = null;
        region.dispose();
      });

      bag.add(disposeEffect);
    },

    list<Id extends string | number>(
      host: HTMLElement,
      getIds: () => readonly Id[],
      create: (id: Id) => Component,
    ) {
      const region = createRegion(host);

      const mgr = new RegionChildManager<Id>(region, (id: Id) => {
        const c = create(id);
        return { element: c.el, dispose: c.dispose };
      });

      const disposeEffect = effect(() => {
        mgr.update(getIds());
      });

      bag.add(() => {
        mgr.dispose();
        region.dispose();
      });

      bag.add(disposeEffect);
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

type ShellSpec = {
  core: Core;
  focus: Focus;
};

export function bindUiItemShell(
  ctx: Ctx,
  spec: ShellSpec,
  shell: HTMLElement,
): void {
  shell.classList.add("ui-item");
  shell.dataset.id = spec.focus.item;
  if (!shell.hasAttribute("tabindex")) shell.tabIndex = -1;

  const isFocused = computed(() => {
    const sel = spec.core.selection();
    return (
      sel.kind === "focused" &&
      sel.focus.item === spec.focus.item &&
      sel.focus.container === spec.focus.container
    );
  });
  const isIssue = computed(
    () => spec.core.item(spec.focus.item).content.kind === "issue",
  );

  ctx.target(spec.focus, DEFAULT_TARGET, () => shell);

  ctx.on(shell, "pointerdown", (e: PointerEvent) => {
    spec.core.focus(spec.focus, DEFAULT_TARGET, {
      caret: caretFromTarget(e.target),
    });
    e.stopPropagation();
  });

  ctx.effect(() => {
    shell.classList.toggle("is-focused", isFocused.value);
    shell.classList.toggle("is-issue", isIssue.value);
  });
}

export function stampBody(root: HTMLElement, view: ViewName): void {
  root.classList.add("ui-body", `ui-${String(view)}`);
}
