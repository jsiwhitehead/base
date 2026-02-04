import type { Core, ItemId } from "../core";
import { createComponent, el, on, type FocusComponent, setData } from "./base";
import { DEFAULT_TARGET } from "../core/runtime";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

export const defaultTextNav = {
  yieldUpDown: "always",
  yieldLeftRight: "boundary",
} as const;

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";

export type TextNavDir = NavDir;
export type TextNavMode = NavMode;

export type TextControlKeyHandlers = {
  nav?: {
    yieldUpDown?: "always" | "boundary";
    yieldLeftRight?: "boundary" | "always";
  };
  onNav?: (dir: NavDir, mode: NavMode) => void;
  onEnter?: (caret: { start: number; end: number }) => void;
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

  const stopEvent = (e: Event) => {
    e.preventDefault?.();
    e.stopPropagation?.();
  };

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
  ctx: {
    on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
      target: T,
      type: K,
      handler: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ): void;
  },
  target: TextInputElement,
  events: readonly TextCommitEvent[] | undefined,
  handler: () => void,
): void {
  const active = new Set(events ?? ["input", "blur"]);

  if (active.has("input")) ctx.on(target, "input", handler);
  if (active.has("blur")) ctx.on(target, "blur", handler);
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
  multiline: boolean;
  className?: string;
  commit: (text: string) => void;
  getState: () => TextFieldState;
  onCommitEvents?: readonly ("input" | "blur")[];
  textKeys?: (inp: TextInputElement) => (() => void) | void;
  target?: string;
};

export function textField(
  opts: TextFieldOpts,
): FocusComponent<TextInputElement> {
  const c = createComponent((ctx) => {
    const inp = textInput(opts.multiline);
    if (opts.className) inp.className = opts.className;

    setData(inp, "target", opts.target ?? DEFAULT_TARGET);

    registerCommitHandlers(ctx, inp, opts.onCommitEvents, () =>
      opts.commit(inp.value),
    );

    if (opts.textKeys) ctx.cleanup(opts.textKeys(inp) ?? null);

    ctx.effect(() => {
      const st = opts.getState();
      inp.readOnly = st.readOnly;
      syncValue(inp, st.text);
    });

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

export function autosizeTextField(
  opts: AutosizeTextFieldOpts,
): FocusComponent<HTMLInputElement> {
  let focusEl!: HTMLInputElement;

  const c = createComponent((ctx) => {
    const wrap = el("div", opts.wrapClassName ?? "autosize");
    if (opts.className) wrap.classList.add(opts.className);

    const mirror = el("span", opts.mirrorClassName ?? "");
    mirror.setAttribute("aria-hidden", "true");

    const inp = textInput(false) as HTMLInputElement;
    focusEl = inp;
    if (opts.inputClassName) inp.classList.add(opts.inputClassName);

    setData(inp, "target", opts.target ?? DEFAULT_TARGET);

    wrap.append(mirror, inp);

    registerCommitHandlers(ctx, inp, opts.onCommitEvents, () =>
      opts.commit(inp.value),
    );

    if (opts.textKeys) ctx.cleanup(opts.textKeys(inp) ?? null);

    ctx.effect(() => {
      const st = opts.getState();
      inp.readOnly = st.readOnly;
      syncValue(inp, st.text);
      mirror.textContent = st.text.length ? st.text : " ";
    });

    return wrap;
  });

  return { ...c, focusEl };
}

export type ScalarFieldState = {
  text: string;
  editable: boolean;
  isIssue: boolean;
};

export type ScalarFieldOpts = {
  core: Core;
  id: ItemId;
  multiline?: boolean;
  className?: string;
  target?: string;
  commitText?: (text: string) => void;
  onCommitEvents?: readonly ("input" | "blur")[];
  textKeys?: (inp: TextInputElement) => (() => void) | void;
  getState?: () => ScalarFieldState;
};

function deriveScalarFieldState(core: Core, id: ItemId): ScalarFieldState {
  const snap = core.item(id);
  const c = snap.content;

  if (c.kind === "issue") {
    return { text: c.message, editable: false, isIssue: true };
  }

  if (c.kind === "scalar") {
    const editable = snap.mode.kind === "direct";
    const text = c.value == null ? "" : String(c.value);
    return { text, editable, isIssue: false };
  }

  return { text: "", editable: false, isIssue: false };
}

export function scalarField(
  opts: ScalarFieldOpts,
): FocusComponent<HTMLElement> {
  const target = opts.target ?? DEFAULT_TARGET;
  const multiline = opts.multiline ?? true;

  let focusEl: HTMLElement | null = null;

  const c = createComponent((ctx) => {
    const host = el("div");
    if (opts.className) host.className = opts.className;

    const slot = ctx.slot(host);

    const getState = () =>
      (opts.getState ?? (() => deriveScalarFieldState(opts.core, opts.id)))();

    const mountReadonly = (): FocusComponent<HTMLElement> => {
      const d = el("div");
      d.tabIndex = -1;
      setData(d, "target", target);

      ctx.effect(() => {
        const st = getState();
        d.textContent = st.text;
      });

      return { el: d, focusEl: d, dispose: () => d.replaceChildren() };
    };

    const mountEditor = (): FocusComponent<TextInputElement> => {
      return textField({
        multiline,
        className: "",
        commit: (text) => opts.commitText?.(text),
        getState: () => {
          const st = getState();
          return { text: st.text, readOnly: !st.editable, isIssue: st.isIssue };
        },
        onCommitEvents: opts.onCommitEvents,
        textKeys: opts.textKeys,
        target,
      });
    };

    let cur: FocusComponent<HTMLElement> | null = null;
    let curEditable: boolean | null = null;

    const setCur = (next: FocusComponent<HTMLElement>) => {
      cur?.dispose();
      cur = next;
      slot.set(next);
      focusEl = next.focusEl;
    };

    ctx.effect(() => {
      const st = getState();
      const nextEditable = !!st.editable;
      if (curEditable === nextEditable && cur) return;
      curEditable = nextEditable;
      setCur(nextEditable ? mountEditor() : mountReadonly());
    });

    ctx.cleanup(() => {
      cur?.dispose();
      cur = null;
      focusEl = host;
    });

    return host;
  });

  const out: FocusComponent<HTMLElement> = {
    ...c,
    get focusEl() {
      return focusEl ?? c.el;
    },
  };

  return out;
}
