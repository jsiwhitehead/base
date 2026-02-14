import { computed, effect } from "@preact/signals-core";

import type { Caret, Component, Core, Focus, ViewName } from "../core";
import { DEFAULT_TARGET } from "../core";

type Ctx = {
  on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
    target: T,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;

  effect(run: () => void | (() => void)): void;

  mount(host: HTMLElement, child: Component): void;

  slot(host: HTMLElement, getComponent: () => Component | null): void;

  list<Id extends string | number>(
    host: HTMLElement,
    getIds: () => readonly Id[],
    buildById: (id: Id) => Component,
  ): void;

  target(
    focus: Focus,
    target: string,
    getEl: () => HTMLElement | null,
    opts?: { caret?: { set(pos: number): void; getLength(): number } },
  ): void;
};

type Region = {
  host: HTMLElement;
  start: Comment;
  end: Comment;
  clear(): void;
  reconcile(desired: readonly HTMLElement[]): void;
  dispose(): void;
};

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
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function createRegion(host: HTMLElement): Region {
  const start = document.createComment("region:start");
  const end = document.createComment("region:end");
  host.append(start, end);

  const clear = (): void => {
    let n = start.nextSibling;
    while (n && n !== end) {
      const next = n.nextSibling;
      n.remove();
      n = next;
    }
  };

  const reconcile = (desired: readonly HTMLElement[]): void => {
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

  const dispose = (): void => {
    clear();
    start.remove();
    end.remove();
  };

  return { host, start, end, clear, reconcile, dispose };
}

class RegionChildManager<Id extends string | number> {
  private cache = new Map<Id, { element: HTMLElement; dispose: () => void }>();

  constructor(
    private region: Region,
    private create: (id: Id) => { element: HTMLElement; dispose(): void },
  ) {}

  update(ids: readonly Id[]): void {
    const keep = new Set(ids);

    for (const [id, rec] of this.cache) {
      if (keep.has(id)) continue;
      rec.dispose();
      this.cache.delete(id);
    }

    const desired: HTMLElement[] = ids.map((id) => {
      let rec = this.cache.get(id);
      if (!rec) {
        const child = this.create(id);
        rec = { element: child.element, dispose: child.dispose.bind(child) };
        this.cache.set(id, rec);
      }
      return rec.element;
    });

    this.region.reconcile(desired);
  }

  clear(): void {
    for (const rec of this.cache.values()) rec.dispose();
    this.cache.clear();
  }

  dispose(): void {
    this.clear();
  }
}

export function caretFromTarget(target: EventTarget | null): Caret {
  const targetEl = target instanceof HTMLElement ? target : null;
  if (
    targetEl instanceof HTMLInputElement ||
    targetEl instanceof HTMLTextAreaElement
  ) {
    const start = targetEl.selectionStart ?? 0;
    const end = targetEl.selectionEnd ?? start;
    return { start, end };
  }
  return { start: 0, end: 0 };
}

export function createComponent(
  core: Core,
  build: (ctx: Ctx) => HTMLElement,
): Component {
  const bag = new Disposer();

  const ctx: Ctx = {
    on(target, type, handler, opts) {
      const listener = (event: Event) =>
        handler.call(target, event as HTMLElementEventMap[typeof type]);
      target.addEventListener(type, listener as EventListener, opts);
      bag.add(() =>
        target.removeEventListener(type, listener as EventListener, opts),
      );
    },

    effect(run) {
      bag.add(effect(run));
    },

    mount(host, child) {
      host.append(child.el);
      bag.add(() => child.dispose());
    },

    slot(host, getComponent) {
      const region = createRegion(host);
      let cur: Component | null = null;

      const disposeEffect = effect(() => {
        const next = getComponent();

        region.clear();
        cur?.dispose();
        cur = next;

        if (next) host.insertBefore(next.el, region.end);
      });

      bag.add(() => {
        disposeEffect();
        cur?.dispose();
        region.dispose();
      });
    },

    list<Id extends string | number>(
      host: HTMLElement,
      getIds: () => readonly Id[],
      buildById: (id: Id) => Component,
    ) {
      const region = createRegion(host);

      const childManager = new RegionChildManager<Id>(region, (id) => {
        const c = buildById(id);
        return { element: c.el, dispose: c.dispose };
      });

      const disposeEffect = effect(() => {
        childManager.update(getIds());
      });

      bag.add(() => {
        disposeEffect();
        childManager.dispose();
        region.dispose();
      });
    },

    target(focus, target, getEl, opts) {
      bag.add(
        core.attachTarget({
          focus,
          target,
          getEl,
          ...(opts?.caret ? { caret: opts.caret } : {}),
        }),
      );
    },
  };

  const rootEl = build(ctx);

  return {
    el: rootEl,
    dispose() {
      bag.run();
      rootEl.replaceChildren();
    },
  };
}

export function bindItemFrame(
  ctx: Ctx,
  spec: { core: Core; focus: Focus },
  shell: HTMLElement,
): void {
  shell.classList.add("ui-frame");
  shell.dataset.id = spec.focus.item;
  if (!shell.hasAttribute("tabindex")) shell.tabIndex = -1;

  const isFocused = computed(() => {
    const sel = spec.core.selection();
    return (
      sel.type === "focused" &&
      sel.focus.item === spec.focus.item &&
      sel.focus.container === spec.focus.container
    );
  });
  const isIssue = computed(
    () => spec.core.item(spec.focus.item).content.type === "issue",
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

export function setBodyClasses(root: HTMLElement, view: ViewName): void {
  root.classList.add("ui-body", `ui-${String(view)}`);
}
