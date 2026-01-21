import { computed, effect } from "@preact/signals-core";
import type { Store, ItemId, Scalar, StoredContent } from "./store";
import { isContentSettableKind } from "./store";
import type {
  Editor,
  Focus,
  FocusTarget,
  Binding,
  Caret,
  View,
  NavDir,
  NavMode,
} from "./editor";
import { focusSelection, caret0 } from "./editor";
import type { Evaluator, Value, LabeledValue } from "./eval";

export type Component = { el: HTMLElement; dispose(): void };

export const defaultTextNav = {
  yieldUpDown: "always",
  yieldLeftRight: "boundary",
} as const;

export class Disposer {
  private fns: (() => void)[] = [];

  add(fn: (() => void) | null | undefined) {
    if (!fn) return fn ?? undefined;
    this.fns.push(fn);
    return fn;
  }

  run() {
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
  el0.addEventListener(type, handler as any, opts);
  return () => el0.removeEventListener(type, handler as any, opts as any);
}

export const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

export function ensureTabbable(elm: HTMLElement) {
  const e = elm as any;
  if (e.tabIndex == null || e.tabIndex < 0) e.tabIndex = 0;
}

export function reconcileChildren(parent: HTMLElement, desired: HTMLElement[]) {
  for (let i = 0; i < desired.length; i++) {
    const next = desired[i];
    const cur = parent.children[i];
    if (cur !== next) parent.insertBefore(next, cur || null);
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

    const desired = ids.map((id) => {
      let rec = this.cache.get(id);
      if (!rec) {
        const v = this.create(id);
        rec = { element: v.element, dispose: v.dispose.bind(v) };
        this.cache.set(id, rec);
      }
      return rec.element;
    });

    reconcileChildren(this.container, desired as any);
  }

  dispose() {
    for (const rec of this.cache.values()) rec.dispose();
    this.cache.clear();
  }
}

function isTextInputEl(
  el0: HTMLElement | null,
): el0 is HTMLInputElement | HTMLTextAreaElement {
  return (
    !!el0 &&
    ((el0 instanceof HTMLInputElement && el0.type === "text") ||
      el0 instanceof HTMLTextAreaElement)
  );
}

export function caretFromTarget(el0: HTMLElement | null): Caret {
  if (!isTextInputEl(el0)) return caret0();
  const start = el0.selectionStart ?? 0;
  const end = el0.selectionEnd ?? start;
  return { start, end };
}

export function stopEvent(e: Event) {
  (e as any).preventDefault?.();
  (e as any).stopPropagation?.();
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
  inp: HTMLInputElement | HTMLTextAreaElement,
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

  inp.addEventListener("keydown", onKeyDown);
  return () => inp.removeEventListener("keydown", onKeyDown);
}

export type FocusableTargetSpec = Readonly<{
  target: FocusTarget;
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

  watch(fn: () => void): void;

  watchComputed<T>(compute: () => T, apply: (v: T) => void): void;

  slot(host: HTMLElement): { set(next: Component | null): void };

  list<Id extends string | number>(
    host: HTMLElement,
    create: (id: Id) => Component,
  ): { update(ids: readonly Id[]): void };

  focusable(opts: {
    editor: Editor;
    focus: Focus;
    elementFor: (target: FocusTarget) => HTMLElement | null;
    targets?: readonly FocusableTargetSpec[];
  }): void;
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
      bag.add(on(el0 as any, type as any, handler as any, opts));
    },

    watch(fn) {
      bag.add(effect(fn));
    },

    watchComputed(compute, apply) {
      const sig = computed(compute);
      bag.add(effect(() => apply(sig.value)));
    },

    slot(host) {
      let cur: Component | null = null;

      const set = (next: Component | null) => {
        if (cur === next) return;
        cur?.dispose();
        cur = next;
        host.replaceChildren(next ? next.el : null);
      };

      bag.add(() => {
        cur?.dispose();
        cur = null;
      });

      return { set };
    },

    list(host, create) {
      const mgr = new ChildManager<any>(host, (id) => {
        const c = create(id);
        return { element: c.el, dispose: c.dispose };
      });

      bag.add(() => mgr.dispose());

      return { update: (ids: readonly any[]) => mgr.update(ids) };
    },

    focusable(opts) {
      const runtime = opts.editor.runtime;

      const binding: Binding = {
        focus: opts.focus,
        elementFor: (t: FocusTarget) => opts.elementFor(t),
        setCaret: (pos: number) => {
          const a = document.activeElement;
          if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement)
            a.setSelectionRange(pos, pos);
        },
        getTextLength: () => {
          const a = document.activeElement;
          return a instanceof HTMLInputElement ||
            a instanceof HTMLTextAreaElement
            ? a.value.length
            : 0;
        },
      };

      runtime.registerBinding(binding);
      bag.add(() => runtime.unregisterBinding(opts.focus));

      for (const t of opts.targets ?? []) {
        const hostFn = t.pointerHost ?? t.getEl;

        const stop = (() => {
          const host = hostFn();
          if (!host) return null;

          const handler = (e: PointerEvent) => {
            const targetEl = t.getEl() ?? (e.target as HTMLElement);
            const c =
              (t.caret ?? "zero") === "fromTarget"
                ? caretFromTarget(targetEl)
                : caret0();

            const out = focusSelection(opts.focus, t.target, c);
            opts.editor.setSelection(out.selection);

            if (t.stopPropagation ?? true) e.stopPropagation();
          };

          host.addEventListener("pointerdown", handler);
          return () => host.removeEventListener("pointerdown", handler);
        })();

        bag.add(stop);
      }
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

export function mountViewInto(
  editor: Editor,
  host: HTMLElement,
  view: View,
): () => void {
  editor.runtime.registerView(view);
  host.replaceChildren(view.root);
  return () => {
    editor.runtime.unregisterView(view.id);
    view.dispose();
    host.replaceChildren();
  };
}

export function textInput(
  multiline: boolean,
): HTMLInputElement | HTMLTextAreaElement {
  const n = document.createElement(multiline ? "textarea" : "input") as
    | HTMLInputElement
    | HTMLTextAreaElement;

  if (n instanceof HTMLInputElement) n.type = "text";
  n.autocapitalize = "off";
  n.autocomplete = "off";
  n.autocorrect = "off" as any;
  n.spellcheck = false;
  if (n instanceof HTMLTextAreaElement) n.rows = 1;
  return n;
}

export function syncValue(
  inp: HTMLInputElement | HTMLTextAreaElement,
  next: string,
) {
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

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalar(text: string): Scalar {
  const t = text.trim();
  if (NUM_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t === "true") return true;
  return text;
}

export type DisplayText =
  | { kind: "blank"; text: "" }
  | { kind: "issue"; text: string }
  | { kind: "scalar"; text: string }
  | { kind: "other"; text: string };

export function getDisplayText(v: Value): DisplayText {
  switch (v.kind) {
    case "blank":
      return { kind: "blank", text: "" };
    case "issue":
      return { kind: "issue", text: v.message };
    case "scalar":
      return { kind: "scalar", text: String(v.value) };
    default:
      return { kind: "other", text: "" };
  }
}

export type EditableText =
  | { kind: "editable"; text: string }
  | { kind: "readonly"; text: string };

function storedScalarTextForEdit(
  store: Store,
  id: ItemId,
): { kind: "editable"; text: string } | null {
  const it = store.readItem(id);
  const kind = it.content.kind;

  if (!isContentSettableKind(kind)) return null;

  if (kind === "blank") return { kind: "editable", text: "" };

  if (kind === "scalar") {
    const c = it.content as Extract<StoredContent, { kind: "scalar" }>;
    return { kind: "editable", text: String(c.value) };
  }

  return null;
}

export function getEditableText(
  store: Store,
  evaluator: Evaluator,
  id: ItemId,
): EditableText {
  return (
    storedScalarTextForEdit(store, id) ?? {
      kind: "readonly",
      text: getDisplayText(evaluator.value(id)).text,
    }
  );
}

export function renderValueReadonly(v: Value): HTMLElement {
  if (v.kind === "blank") return el("div", "item readonly");

  if (v.kind === "issue") return el("div", "item readonly issue", v.message);

  if (v.kind === "scalar") return el("div", "item readonly", String(v.value));

  if (v.kind === "item-group")
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

export type TextFieldState = {
  text: string;
  readOnly: boolean;
  isIssue: boolean;
};

export type TextFieldOpts = {
  editor: Editor;
  focus: Focus;
  target: FocusTarget;
  multiline: boolean;
  className?: string;
  caret?: "zero" | "fromTarget";
  stopPropagation?: boolean;
  commit: (text: string) => void;
  getState: () => TextFieldState;
  onCommitEvents?: readonly ("input" | "blur")[];
  textKeys?: (
    inp: HTMLInputElement | HTMLTextAreaElement,
  ) => (() => void) | void;
};

export function textField(opts: TextFieldOpts): Component {
  return createComponent((ctx) => {
    const inp = textInput(opts.multiline);
    if (opts.className) inp.className = opts.className;

    ctx.focusable({
      editor: opts.editor,
      focus: opts.focus,
      elementFor: () => inp,
      targets: [
        {
          target: opts.target,
          getEl: () => inp,
          pointerHost: () => inp,
          caret: opts.caret ?? "fromTarget",
          stopPropagation: opts.stopPropagation ?? true,
        },
      ],
    });

    const events = opts.onCommitEvents ?? ["input", "blur"];
    const commit = () => opts.commit(inp.value);

    if (events.includes("input")) ctx.on(inp as any, "input", commit as any);
    if (events.includes("blur")) ctx.on(inp as any, "blur", commit as any);

    if (opts.textKeys) ctx.use(opts.textKeys(inp) ?? null);

    ctx.watchComputed(
      () => opts.getState(),
      (st) => {
        inp.readOnly = st.readOnly;
        inp.classList.toggle("issue", st.isIssue);
        syncValue(inp, st.text);
      },
    );

    return inp;
  });
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

export function autosizeTextField(opts: AutosizeTextFieldOpts): Component {
  return createComponent((ctx) => {
    const wrap = el("div", opts.wrapClassName ?? "autosize");
    if (opts.className) wrap.classList.add(opts.className);

    const mirror = el("span", opts.mirrorClassName ?? "");
    mirror.setAttribute("aria-hidden", "true");

    const inp = textInput(false);
    if (opts.inputClassName) inp.classList.add(opts.inputClassName);

    wrap.append(mirror, inp as any);

    ctx.focusable({
      editor: opts.editor,
      focus: opts.focus,
      elementFor: () => inp,
      targets: [
        {
          target: opts.target,
          getEl: () => inp,
          pointerHost: () => inp,
          caret: opts.caret ?? "fromTarget",
          stopPropagation: opts.stopPropagation ?? true,
        },
      ],
    });

    const events = opts.onCommitEvents ?? ["input", "blur"];
    const commit = () => opts.commit(inp.value);

    if (events.includes("input")) ctx.on(inp as any, "input", commit as any);
    if (events.includes("blur")) ctx.on(inp as any, "blur", commit as any);

    if (opts.textKeys) ctx.use(opts.textKeys(inp) ?? null);

    ctx.watchComputed(
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
}

export type ContentFieldOpts = {
  editor: Editor;
  evaluator: Evaluator;
  focus: Focus;
  id: ItemId;
  className?: string;
  textKeys?: (
    inp: HTMLInputElement | HTMLTextAreaElement,
  ) => (() => void) | void;
  renderItemGroupChild?: (childId: ItemId) => Component;
  commitScalarText?: (text: string) => void;
};

function readonlyItemText(evaluator: Evaluator, id: ItemId): Component {
  return createComponent((ctx) => {
    const d = el("div", "item readonly");
    ctx.watchComputed(
      () => {
        const v = evaluator.value(id);
        return { text: getDisplayText(v).text, isIssue: v.kind === "issue" };
      },
      ({ text, isIssue }) => {
        d.textContent = text;
        d.classList.toggle("issue", isIssue);
      },
    );
    return d;
  });
}

function canEditScalarText(store: Store, id: ItemId): boolean {
  const it = store.readItem(id);
  const kind = it.content.kind;
  return isContentSettableKind(kind) && (kind === "blank" || kind === "scalar");
}

export function contentField(opts: ContentFieldOpts): Component {
  return createComponent((ctx) => {
    const host = el("div");
    if (opts.className) host.className = opts.className;

    const slot = ctx.slot(host);

    const mountReadonlyFocusWrap = (wrap: HTMLElement): Component => {
      ctx.focusable({
        editor: opts.editor,
        focus: opts.focus,
        elementFor: () => wrap,
        targets: [
          {
            target: { kind: "content" },
            getEl: () => wrap,
            pointerHost: () => wrap,
            caret: "zero",
            stopPropagation: true,
          },
        ],
      });
      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    const mountText = (): Component => {
      const { editor, id, focus, evaluator } = opts;
      return textField({
        editor,
        focus,
        target: { kind: "content" },
        multiline: true,
        className: "content",
        caret: "fromTarget",
        stopPropagation: true,
        commit: (text) => {
          opts.commitScalarText?.(text);
        },
        getState: () => {
          const store = editor.store;
          const editable = getEditableText(store, evaluator, id);
          const display = getDisplayText(evaluator.value(id));
          return {
            text: editable.kind === "editable" ? editable.text : display.text,
            readOnly: editable.kind !== "editable",
            isIssue: display.kind === "issue",
          };
        },
        textKeys: opts.textKeys,
      });
    };

    const mountReadonlyText = (): Component => {
      const d = el("div", "item readonly");
      mountReadonlyFocusWrap(d);

      const inner = readonlyItemText(opts.evaluator, opts.id);
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
      mountReadonlyFocusWrap(wrap);

      ctx.watch(() => {
        const v = opts.evaluator.value(opts.id);
        wrap.replaceChildren();
        if (v.kind === "value-group") {
          for (const it of v.items)
            wrap.append(renderLabeledValueReadonly(it.label, it.value));
        }
      });

      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    const mountItemGroup = (): Component => {
      const wrap = el("div", "group");
      ensureTabbable(wrap);
      mountReadonlyFocusWrap(wrap);

      const children = ctx.list(wrap, (childId: ItemId) => {
        const c =
          opts.renderItemGroupChild?.(childId) ??
          readonlyItemText(opts.evaluator, childId);
        c.el.classList.add("item");
        return c;
      });

      ctx.watch(() => {
        const v = opts.evaluator.value(opts.id);
        children.update(v.kind === "item-group" ? v.items : []);
      });

      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    ctx.watch(() => {
      const v = opts.evaluator.value(opts.id);

      host.classList.toggle("issue", v.kind === "issue");

      if (v.kind === "item-group") {
        slot.set(mountItemGroup());
        return;
      }

      if (v.kind === "value-group") {
        slot.set(mountValueGroup());
        return;
      }

      slot.set(
        canEditScalarText(opts.editor.store, opts.id)
          ? mountText()
          : mountReadonlyText(),
      );
    });

    return host;
  });
}
