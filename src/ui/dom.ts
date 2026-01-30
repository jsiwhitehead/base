import { computed, effect } from "@preact/signals-core";
import {
  type Core,
  type ItemId,
  type Caret,
  type Focus,
  type Value,
  type Component,
  isBlankValue,
  isIssueValue,
  isItemGroupValue,
  isScalarValue,
  isValueGroupValue,
} from "../core";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";

export type InputComponent<E extends HTMLElement = TextInputElement> =
  Component & {
    focusEl: E;
  };

export function isInputComponent(c: Component): c is InputComponent {
  return "focusEl" in (c as any) && (c as any).focusEl instanceof HTMLElement;
}

export function focusElOf(c: Component): HTMLElement {
  return isInputComponent(c) ? c.focusEl : c.el;
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

export const defaultTextNav = {
  yieldUpDown: "always",
  yieldLeftRight: "boundary",
} as const;

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

const domOn = on;

export const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

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

function isTextInputEl(el0: HTMLElement | null): el0 is TextInputElement {
  return (
    !!el0 &&
    ((el0 instanceof HTMLInputElement && el0.type === "text") ||
      el0 instanceof HTMLTextAreaElement)
  );
}

export function caretFromTarget(el0: HTMLElement | null): Caret {
  if (!isTextInputEl(el0)) return { start: 0, end: 0 };
  const start = el0.selectionStart ?? 0;
  const end = el0.selectionEnd ?? start;
  return { start, end };
}

export function stopEvent(e: Event): void {
  e.preventDefault?.();
  e.stopPropagation?.();
}

export type TextNavDir = NavDir;
export type TextNavMode = NavMode;

export type TextControlKeyHandlers = {
  nav?: {
    yieldUpDown?: "always" | "boundary";
    yieldLeftRight?: "boundary" | "always";
  };
  onNav?: (dir: NavDir, mode: NavMode) => void;
  onEnter?: (caret: Caret) => void;
  onTab?: (shift: boolean) => void;
  onEscape?: () => void;
  onBackspaceBoundary?: () => void;
  onDeleteBoundary?: () => void;
};

export function bindTextControlKeys(
  inp: TextInputElement,
  handlers: TextControlKeyHandlers,
): () => void {
  const {
    onNav,
    onEnter,
    onTab,
    onEscape,
    onBackspaceBoundary,
    onDeleteBoundary,
  } = handlers;

  const nav = handlers.nav ?? {};
  const yieldUpDown = nav.yieldUpDown ?? defaultTextNav.yieldUpDown;
  const yieldLeftRight = nav.yieldLeftRight ?? defaultTextNav.yieldLeftRight;

  const onKeyDown = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    const mode: NavMode = mod ? "jump" : "step";

    const start = inp.selectionStart ?? 0;
    const end = inp.selectionEnd ?? start;
    const hasSel = start !== end;
    const len = inp.value.length;

    const dir: NavDir | null =
      e.key === "ArrowLeft"
        ? "left"
        : e.key === "ArrowRight"
          ? "right"
          : e.key === "ArrowUp"
            ? "up"
            : e.key === "ArrowDown"
              ? "down"
              : null;

    if (dir && onNav) {
      const atStart = !hasSel && start === 0;
      const atEnd = !hasSel && end === len;

      const boundary =
        mod ||
        (dir === "left" && (yieldLeftRight === "always" || atStart)) ||
        (dir === "right" && (yieldLeftRight === "always" || atEnd)) ||
        ((dir === "up" || dir === "down") && yieldUpDown === "always");

      if (boundary) {
        stopEvent(e);
        onNav(dir, mode);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && onEnter) {
      stopEvent(e);
      onEnter({ start, end });
      return;
    }

    if (e.key === "Tab" && onTab) {
      stopEvent(e);
      onTab(!!e.shiftKey);
      return;
    }

    if (e.key === "Escape" && onEscape) {
      stopEvent(e);
      onEscape();
      return;
    }

    if (
      e.key === "Backspace" &&
      onBackspaceBoundary &&
      !hasSel &&
      start === 0
    ) {
      stopEvent(e);
      onBackspaceBoundary();
      return;
    }

    if (e.key === "Delete" && onDeleteBoundary && !hasSel && end === len) {
      stopEvent(e);
      onDeleteBoundary();
      return;
    }
  };

  return on(inp, "keydown", onKeyDown);
}

export type FocusableTargetSpec = Readonly<{
  target: string;
  getEl: () => HTMLElement | null;
  pointerHost?: () => HTMLElement | null;
  caret?: "zero" | "fromTarget";
  stopPropagation?: boolean;
}>;

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

  focusable(opts: {
    core: Core;
    focus: Focus;
    elementFor: (target: string) => HTMLElement | null;
    targets?: readonly FocusableTargetSpec[];
    caret?: { set(pos: number): void; getLength(): number };
  }): void;
};

export function installFocusableTargets(
  ctx: Ctx,
  opts: {
    core: Core;
    focus: Focus;
    targets: readonly FocusableTargetSpec[];
  },
): void {
  for (const t of opts.targets) {
    const hostFn = t.pointerHost ?? t.getEl;
    const host = hostFn();
    if (!host) continue;

    ctx.on(host, "pointerdown", (e: PointerEvent) => {
      const pointerTarget =
        t.getEl() ?? (e.target instanceof HTMLElement ? e.target : null);

      const caret =
        (t.caret ?? "zero") === "fromTarget"
          ? caretFromTarget(pointerTarget)
          : undefined;

      opts.core.focus(opts.focus, t.target, { caret });

      if (t.stopPropagation ?? true) e.stopPropagation();
    });
  }
}

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
      bag.add(domOn(el0, type, handler, opts));
    },

    watch(...args) {
      const run = args.at(-1) as (...vals: any[]) => void | (() => void);
      const sigs = args.slice(0, -1).map((c) => computed(c as () => unknown));

      let prev: unknown[] | null = null;

      const memo = computed(() => {
        const next = sigs.map((s) => s.value);

        if (prev && next.every((v, i) => shallowEqual(v, prev![i]))) {
          return prev;
        }

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

    focusable(opts) {
      const unbind = opts.core.attachFocus({
        focus: opts.focus,
        elementFor: (t) => opts.elementFor(t),
        caret:
          opts.caret ??
          ({
            set: (pos: number) => {
              const a = document.activeElement;
              if (
                a instanceof HTMLInputElement ||
                a instanceof HTMLTextAreaElement
              )
                a.setSelectionRange(pos, pos);
            },
            getLength: () => {
              const a = document.activeElement;
              return a instanceof HTMLInputElement ||
                a instanceof HTMLTextAreaElement
                ? a.value.length
                : 0;
            },
          } as const),
      });

      bag.add(unbind);

      installFocusableTargets(ctx, {
        core: opts.core,
        focus: opts.focus,
        targets: opts.targets ?? [],
      });
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

export function textInput(multiline: boolean): TextInputElement {
  const n = document.createElement(
    multiline ? "textarea" : "input",
  ) as TextInputElement;

  if (n instanceof HTMLInputElement) n.type = "text";
  n.autocapitalize = "off";
  n.autocomplete = "off";
  n.setAttribute("autocorrect", "off");
  n.spellcheck = false;
  if (n instanceof HTMLTextAreaElement) n.rows = 1;
  return n;
}

type TextCommitEvent = "input" | "blur";

function registerCommitHandlers(
  ctx: Ctx,
  target: TextInputElement,
  events: readonly TextCommitEvent[] | undefined,
  handler: () => void,
): void {
  const active = new Set(events ?? ["input", "blur"]);

  if (active.has("input"))
    ctx.on(target, "input", () => {
      handler();
    });

  if (active.has("blur"))
    ctx.on(target, "blur", () => {
      handler();
    });
}

export function syncValue(inp: TextInputElement, next: string) {
  if (inp.value === next) return;

  if (document.activeElement !== inp) {
    inp.value = next;
    return;
  }

  const start = inp.selectionStart ?? next.length;
  const end = inp.selectionEnd ?? start;

  inp.value = next;

  const len = next.length;
  inp.setSelectionRange(Math.min(start, len), Math.min(end, len));
}

export type TextFieldState = {
  text: string;
  readOnly: boolean;
  isIssue: boolean;
};

export type TextFieldOpts = {
  core: Core;
  focus: Focus;
  target: string;
  multiline: boolean;
  className?: string;
  caret?: "zero" | "fromTarget";
  stopPropagation?: boolean;
  registerFocus?: boolean;
  commit: (text: string) => void;
  getState: () => TextFieldState;
  onCommitEvents?: readonly ("input" | "blur")[];
  textKeys?: (inp: TextInputElement) => (() => void) | void;
};

export function textField(opts: TextFieldOpts): InputComponent {
  const c = createComponent((ctx) => {
    const inp = textInput(opts.multiline);
    if (opts.className) inp.className = opts.className;

    const targets: FocusableTargetSpec[] = [
      {
        target: opts.target,
        getEl: () => inp,
        pointerHost: () => inp,
        caret: opts.caret ?? "fromTarget",
        stopPropagation: opts.stopPropagation ?? true,
      },
    ];

    if (opts.registerFocus !== false) {
      ctx.focusable({
        core: opts.core,
        focus: opts.focus,
        elementFor: () => inp,
        targets,
      });
    } else {
      installFocusableTargets(ctx, {
        core: opts.core,
        focus: opts.focus,
        targets,
      });
    }

    registerCommitHandlers(ctx, inp, opts.onCommitEvents, () =>
      opts.commit(inp.value),
    );

    if (opts.textKeys) ctx.use(opts.textKeys(inp) ?? null);

    ctx.watch(
      () => opts.getState(),
      (st) => {
        inp.readOnly = st.readOnly;
        inp.classList.toggle("issue", st.isIssue);
        syncValue(inp, st.text);
      },
    );

    return inp;
  });

  return { ...c, focusEl: c.el as TextInputElement };
}

export type AutosizeTextFieldOpts = Omit<
  TextFieldOpts,
  "multiline" | "className"
> & {
  className?: string;
  inputClassName?: string;
  mirrorClassName?: string;
  wrapClassName?: string;
};

export function autosizeTextField(opts: AutosizeTextFieldOpts): InputComponent {
  let focusEl!: HTMLInputElement;

  const c = createComponent((ctx) => {
    const wrap = el("div", opts.wrapClassName ?? "autosize");
    if (opts.className) wrap.classList.add(opts.className);

    const mirror = el("span", opts.mirrorClassName ?? "");
    mirror.setAttribute("aria-hidden", "true");

    const inp = textInput(false) as HTMLInputElement;
    focusEl = inp;
    if (opts.inputClassName) inp.classList.add(opts.inputClassName);

    wrap.append(mirror, inp);

    const targets: FocusableTargetSpec[] = [
      {
        target: opts.target,
        getEl: () => inp,
        pointerHost: () => wrap,
        caret: opts.caret ?? "fromTarget",
        stopPropagation: opts.stopPropagation ?? true,
      },
    ];

    if (opts.registerFocus !== false) {
      ctx.focusable({
        core: opts.core,
        focus: opts.focus,
        elementFor: () => inp,
        targets,
      });
    } else {
      installFocusableTargets(ctx, {
        core: opts.core,
        focus: opts.focus,
        targets,
      });
    }

    registerCommitHandlers(ctx, inp, opts.onCommitEvents, () =>
      opts.commit(inp.value),
    );

    if (opts.textKeys) ctx.use(opts.textKeys(inp) ?? null);

    ctx.watch(
      () => opts.getState(),
      (st) => {
        inp.readOnly = st.readOnly;
        inp.classList.toggle("issue", st.isIssue);
        syncValue(inp, st.text);
        mirror.textContent = st.text.length ? st.text : " ";
      },
    );

    return wrap;
  });

  return { ...c, focusEl };
}

export function renderValueReadonly(v: Value): HTMLElement {
  if (isBlankValue(v)) return el("div", "item readonly");

  if (isIssueValue(v)) return el("div", "item readonly issue", v.message);

  if (isScalarValue(v)) return el("div", "item readonly", String(v.value));

  if (isItemGroupValue(v))
    return el("div", "item readonly issue", "[item-group]");

  const wrap = el("div", "group readonly");
  for (const it of v.items)
    wrap.append(renderLabeledValueReadonly(it.label, it.value));
  return wrap;
}

export function renderLabeledValueReadonly(
  label: string | undefined,
  v: Value,
): HTMLElement {
  if (!label) return renderValueReadonly(v);
  const row = el("div", "row readonly");
  const lab = el("div", "label", label);
  const val = renderValueReadonly(v);
  val.classList.add("item");
  row.append(lab, val);
  return row;
}

export type ContentFieldOpts = {
  core: Core;
  focus: Focus;
  id: ItemId;
  className?: string;
  registerFocus?: boolean;
  textKeys?: (inp: TextInputElement) => (() => void) | void;
  renderItemGroupChild?: (childId: ItemId) => Component;
  commitText?: (text: string) => void;
  focusElRef?: { current: HTMLElement | null };
};

function readonlyItemText(core: Core, id: ItemId): Component {
  return createComponent((ctx) => {
    const d = el("div", "item readonly");
    ctx.watch(
      () => {
        const v = core.value(id);
        const text = isIssueValue(v)
          ? v.message
          : isScalarValue(v)
            ? String(v.value)
            : "";
        const isIssue = isIssueValue(v);
        return { text, isIssue };
      },
      ({ text, isIssue }) => {
        d.textContent = text;
        d.classList.toggle("issue", isIssue);
      },
    );
    return d;
  });
}

export function contentField(opts: ContentFieldOpts): Component {
  return createComponent((ctx) => {
    const hostEl = el("div");
    if (opts.className) hostEl.className = opts.className;

    const core = opts.core;

    const slot = ctx.slot(hostEl);

    const register = opts.registerFocus !== false;
    const setFocusEl = (comp: Component | null) => {
      const next = comp ? focusElOf(comp) : hostEl;
      if (opts.focusElRef) opts.focusElRef.current = next;
    };
    setFocusEl(null);

    const installContentClickTarget = (wrap: HTMLElement) => {
      const targets: FocusableTargetSpec[] = [
        {
          target: "content",
          getEl: () => wrap,
          pointerHost: () => wrap,
          caret: "zero",
          stopPropagation: true,
        },
      ];

      if (register) {
        ctx.focusable({
          core,
          focus: opts.focus,
          elementFor: () => wrap,
          targets,
        });
      } else {
        installFocusableTargets(ctx, {
          core,
          focus: opts.focus,
          targets,
        });
      }
    };

    const mountText = (): Component => {
      const { focus, id } = opts;
      return textField({
        core,
        focus,
        target: "content",
        multiline: true,
        className: "content",
        caret: "fromTarget",
        stopPropagation: true,
        registerFocus: register,
        commit: (text) => {
          opts.commitText?.(text);
        },
        getState: () => {
          const t = core.text(id);
          if (t.kind === "editable")
            return { text: t.text, readOnly: false, isIssue: false };
          return { text: t.text, readOnly: true, isIssue: !!t.issue };
        },
        textKeys: opts.textKeys,
      });
    };

    const mountReadonlyText = (): Component => {
      const d = el("div", "item readonly");
      installContentClickTarget(d);

      const inner = readonlyItemText(core, opts.id);
      d.replaceChildren(inner.el);
      ctx.use(inner);

      return {
        el: d,
        dispose() {
          inner.dispose();
          d.replaceChildren();
        },
      };
    };

    const mountValueGroup = (): Component => {
      const wrap = el("div", "group readonly");
      installContentClickTarget(wrap);

      ctx.watch(() => {
        const v = core.value(opts.id);
        if (!isValueGroupValue(v)) {
          wrap.replaceChildren();
          return;
        }

        const nodes = v.items.map((it) =>
          renderLabeledValueReadonly(it.label, it.value),
        );
        wrap.replaceChildren(...nodes);
      });

      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    const mountItemGroup = (): Component => {
      const wrap = el("div", "group");
      ensureTabbable(wrap);
      installContentClickTarget(wrap);

      const children = ctx.list(wrap, (childId: ItemId) => {
        const c =
          opts.renderItemGroupChild?.(childId) ??
          readonlyItemText(core, childId);
        c.el.classList.add("item");
        return c;
      });

      ctx.watch(() => {
        const v = core.value(opts.id);
        children.update(isItemGroupValue(v) ? v.itemIds : []);
      });

      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    let currentKind: "item-group" | "value-group" | "text" | "readonly" | null =
      null;

    ctx.watch(
      () => core.value(opts.id),
      (v) => {
        hostEl.classList.toggle("issue", isIssueValue(v));

        const t = core.text(opts.id);
        const nextKind = isItemGroupValue(v)
          ? "item-group"
          : isValueGroupValue(v)
            ? "value-group"
            : t.kind === "editable"
              ? "text"
              : "readonly";

        if (nextKind === currentKind) return;
        currentKind = nextKind;

        const nextComp =
          nextKind === "item-group"
            ? mountItemGroup()
            : nextKind === "value-group"
              ? mountValueGroup()
              : nextKind === "text"
                ? mountText()
                : mountReadonlyText();

        slot.set(nextComp);
        setFocusEl(nextComp);
      },
    );

    ctx.onCleanup(() => {
      if (opts.focusElRef) opts.focusElRef.current = hostEl;
    });

    return hostEl;
  });
}
