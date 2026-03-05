import { computed, effect } from "@preact/signals-core";

import type { Location, ViewName } from "../core";
import { ITEM_TARGET, isCoreReadError, isNumericLikeValue } from "../core";
import { DEV, devAssert } from "../dev";
import type { Component, UiCore } from "./runtime";

type Ctx = {
  on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  on<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    handler: (e: DocumentEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ): void;
  on<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    handler: (e: WindowEventMap[K]) => void,
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
    focus: Location,
    target: string,
    getEl: () => HTMLElement | null,
    opts?: {
      setCaret?: { set(pos: number): void; getLength(): number };
      getCaret?: () => number | undefined;
    },
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

export function resolveEventTargetElement(
  target: EventTarget | null,
): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
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
    if (DEV) {
      devAssert(
        new Set(ids).size === ids.length,
        "ctx.list requires unique keys",
      );
    }

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

export function createComponent(
  core: UiCore,
  build: (ctx: Ctx) => HTMLElement,
): Component {
  const bag = new Disposer();

  const addSafeEffect = (run: () => void | (() => void)): void => {
    let disposeEffect: (() => void) | null = null;
    let stopped = false;

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      disposeEffect?.();
    };

    disposeEffect = effect(() => {
      if (stopped) return;
      try {
        return run();
      } catch (err) {
        if (!isCoreReadError(err)) throw err;
        queueMicrotask(stop);
      }
    });
    bag.add(stop);
  };

  const ctx: Ctx = {
    on(
      target: HTMLElement | Document | Window,
      type: string,
      handler: (e: Event) => void,
      opts?: AddEventListenerOptions,
    ) {
      target.addEventListener(type, handler as EventListener, opts);
      bag.add(() =>
        target.removeEventListener(type, handler as EventListener, opts),
      );
    },

    effect(run) {
      addSafeEffect(run);
    },

    mount(host, child) {
      host.append(child.el);
      bag.add(() => child.dispose());
    },

    slot(host, getComponent) {
      const region = createRegion(host);
      let cur: Component | null = null;

      addSafeEffect(() => {
        const next = getComponent();

        region.clear();
        cur?.dispose();
        cur = next;

        if (next) host.insertBefore(next.el, region.end);
      });

      bag.add(() => {
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

      addSafeEffect(() => {
        childManager.update(getIds());
      });

      bag.add(() => {
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
          ...(opts?.setCaret !== undefined ? { setCaret: opts.setCaret } : {}),
          ...(opts?.getCaret !== undefined ? { getCaret: opts.getCaret } : {}),
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
  spec: { core: UiCore; focus: Location; isItemSelected?: () => boolean },
  frameEl: HTMLElement,
): void {
  frameEl.classList.add("ui-frame");
  frameEl.dataset.id = spec.focus.item;
  if (!frameEl.hasAttribute("tabindex")) frameEl.tabIndex = -1;

  const sameFocus = (a: Location, b: Location): boolean =>
    a.item === b.item &&
    a.portals.length === b.portals.length &&
    a.portals.every((portal, i) => portal === b.portals[i]);

  const isItemSelected = computed(() => {
    const overrideSelected = spec.isItemSelected?.();
    if (overrideSelected !== undefined) return overrideSelected;
    const sel = spec.core.selection();
    if (sel.type === "item") {
      return (
        sameFocus(sel.anchor, spec.focus) || sameFocus(sel.head, spec.focus)
      );
    }
    return false;
  });
  const isEditingOnItem = computed(() => {
    const sel = spec.core.selection();
    if (sel.type !== "editing") return false;
    return (
      sel.location.item === spec.focus.item &&
      sameFocus(sel.location, spec.focus)
    );
  });
  const isSelected = computed(() => {
    return isItemSelected.value || isEditingOnItem.value;
  });
  const isIssue = computed(() => {
    return spec.core.item(spec.focus.item).content.type === "issue";
  });
  const isNumeric = computed(() => {
    const content = spec.core.item(spec.focus.item).content;
    return content.type === "value" && isNumericLikeValue(content.value);
  });
  const isEditingTarget = (node: Element | null): boolean => {
    const target = node?.closest<HTMLElement>("[data-target]");
    return !!(
      target?.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement
    );
  };
  const isInNestedContentEditable = (node: Element | null): boolean => {
    const host = node?.closest<HTMLElement>("[contenteditable='true']");
    return !!(host && host !== frameEl && frameEl.contains(host));
  };

  ctx.on(frameEl, "pointerdown", (e: PointerEvent) => {
    if (e.defaultPrevented) return;
    if ((e.button ?? 0) !== 0) return;
    const targetEl = resolveEventTargetElement(e.target);
    if (isInNestedContentEditable(targetEl)) return;
    if (isEditingTarget(targetEl)) return;

    if (targetEl === frameEl) {
      const sel = window.getSelection();
      if (sel?.rangeCount) {
        const start = sel.getRangeAt(0).startContainer;
        const startEl = start instanceof Element ? start : start.parentElement;
        if (isEditingTarget(startEl)) return;
      }
    }
    spec.core.focus({ type: "item", location: spec.focus });
    e.stopPropagation();
  });
  ctx.target(spec.focus, ITEM_TARGET, () => frameEl);

  ctx.effect(() => {
    frameEl.classList.toggle("is-selected", isSelected.value);
    frameEl.classList.toggle("is-item-selected", isItemSelected.value);
    frameEl.classList.toggle("is-issue", isIssue.value);
    frameEl.classList.toggle("is-numeric", isNumeric.value);
  });
}

export function setBodyClasses(root: HTMLElement, view: ViewName): void {
  root.classList.add("ui-body", `ui-${String(view)}`);
  delete root.dataset.dragStart;
}
