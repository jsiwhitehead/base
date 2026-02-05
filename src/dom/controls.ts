import type { Core, ItemId, Focus } from "../core";
import { DEFAULT_TARGET, defaultTextCaret } from "../core";
import { createComponent, el, on, type FocusComponent, setData } from "./base";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

export const defaultTextNav = {
  yieldUpDown: "always",
  yieldLeftRight: "boundary",
} as const;

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";

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

export function keyNavMode(e: KeyboardEvent): NavMode {
  return e.metaKey || e.ctrlKey ? "jump" : "step";
}

export function keyToNavDir(key: string): NavDir | null {
  switch (key) {
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    default:
      return null;
  }
}

export type ContainerKeyHandlers = {
  onNav?: (dir: NavDir, mode: NavMode) => void;
  onConfirm?: () => void;
  onCancel?: () => void;
  onTab?: (shift: boolean) => void;
  onBackspace?: () => void;
  onDelete?: () => void;
};

export function bindContainerKeys(
  host: HTMLElement,
  handlers: ContainerKeyHandlers,
): () => void {
  const { onNav, onConfirm, onCancel, onTab, onBackspace, onDelete } = handlers;

  const stop = (e: Event) => {
    e.preventDefault?.();
    e.stopPropagation?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      stop(e);
      onTab?.(!!e.shiftKey);
      return;
    }

    const dir = keyToNavDir(e.key);
    if (dir && onNav) {
      stop(e);
      onNav(dir, keyNavMode(e));
      return;
    }

    if (e.key === "Enter" && onConfirm) {
      stop(e);
      onConfirm();
      return;
    }

    if (e.key === "Escape" && onCancel) {
      stop(e);
      onCancel();
      return;
    }

    if (e.key === "Backspace" && onBackspace) {
      stop(e);
      onBackspace();
      return;
    }

    if (e.key === "Delete" && onDelete) {
      stop(e);
      onDelete();
      return;
    }
  };

  return on(host, "keydown", onKeyDown);
}

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

  const stop = (e: Event) => {
    e.preventDefault?.();
    e.stopPropagation?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      stop(e);
      onTab?.(!!e.shiftKey);
      return;
    }

    const mode = keyNavMode(e);

    const start = inp.selectionStart ?? 0;
    const end = inp.selectionEnd ?? start;
    const hasSel = start !== end;
    const len = inp.value.length;

    const dir = keyToNavDir(e.key);

    if (dir && onNav) {
      const mod = e.metaKey || e.ctrlKey;
      const atStart = !hasSel && start === 0;
      const atEnd = !hasSel && end === len;

      const boundary =
        mod ||
        (dir === "left" && (yieldLeftRight === "always" || atStart)) ||
        (dir === "right" && (yieldLeftRight === "always" || atEnd)) ||
        ((dir === "up" || dir === "down") && yieldUpDown === "always");

      if (boundary) {
        stop(e);
        onNav(dir, mode);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey && onEnter) {
      stop(e);
      onEnter({ start, end });
      return;
    }

    if (e.key === "Escape" && onEscape) {
      stop(e);
      onEscape();
      return;
    }

    if (
      e.key === "Backspace" &&
      onBackspaceBoundary &&
      !hasSel &&
      start === 0
    ) {
      stop(e);
      onBackspaceBoundary();
      return;
    }

    if (e.key === "Delete" && onDeleteBoundary && !hasSel && end === len) {
      stop(e);
      onDeleteBoundary();
      return;
    }
  };

  return on(inp, "keydown", onKeyDown);
}

export function textInput(multiline: boolean): TextInputElement {
  const n = document.createElement(multiline ? "textarea" : "input") as
    | HTMLInputElement
    | HTMLTextAreaElement;

  if (n instanceof HTMLInputElement) n.type = "text";
  n.autocapitalize = "off";
  n.autocomplete = "off";
  n.setAttribute("autocorrect", "off");
  n.spellcheck = false;
  if (n instanceof HTMLTextAreaElement) n.rows = 1;
  n.tabIndex = -1;
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
  core: Core,
  opts: TextFieldOpts,
): FocusComponent<TextInputElement> {
  const c = createComponent(core, (ctx) => {
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
  core: Core,
  opts: AutosizeTextFieldOpts,
): FocusComponent<HTMLInputElement> {
  let focusEl!: HTMLInputElement;

  const c = createComponent(core, (ctx) => {
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
  focus: Focus;
  target?: string;
  multiline?: boolean;
  className?: string;
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

export function readonlyScalarView(args: {
  core: Core;
  target: string;
  getState: () => ScalarFieldState;
  className?: string;
}): FocusComponent<HTMLElement> {
  const c = createComponent(args.core, (ctx) => {
    const d = el("div", args.className);
    d.tabIndex = -1;
    setData(d, "target", args.target);

    ctx.effect(() => {
      d.textContent = args.getState().text;
    });

    return d;
  });

  return { ...c, focusEl: c.el };
}

export function editableScalarEditor(args: {
  core: Core;
  focus: Focus;
  target: string;
  multiline: boolean;
  commitText?: (text: string) => void;
  onCommitEvents?: readonly ("input" | "blur")[];
  textKeys?: (inp: TextInputElement) => (() => void) | void;
  getState: () => ScalarFieldState;
  className?: string;
}): FocusComponent<TextInputElement> {
  const fc = textField(args.core, {
    multiline: args.multiline,
    className: args.className ?? "",
    commit: (text) => args.commitText?.(text),
    getState: () => {
      const st = args.getState();
      return { text: st.text, readOnly: !st.editable, isIssue: st.isIssue };
    },
    onCommitEvents: args.onCommitEvents,
    textKeys: args.textKeys,
    target: args.target,
  });

  const c = createComponent(args.core, (ctx) => {
    const host = el("div");
    host.append(fc.el);

    ctx.target(args.focus, args.target, () => fc.focusEl, {
      caret: defaultTextCaret(),
    });

    ctx.cleanup(() => fc.dispose());

    return host;
  });

  return { ...c, focusEl: fc.focusEl };
}

export function scalarField(
  opts: ScalarFieldOpts,
): FocusComponent<HTMLElement> {
  const core = opts.core;
  const target = opts.target ?? DEFAULT_TARGET;
  const multiline = opts.multiline ?? true;

  let focusEl: HTMLElement = null as any;

  const c = createComponent(core, (ctx) => {
    const host = el("div");
    if (opts.className) host.className = opts.className;

    const slot = ctx.slot(host);
    const id = opts.focus.item;

    const getState = opts.getState ?? (() => deriveScalarFieldState(core, id));

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

      if (cur && curEditable === nextEditable) return;
      curEditable = nextEditable;

      if (nextEditable) {
        const ed = editableScalarEditor({
          core,
          focus: opts.focus,
          target,
          multiline,
          commitText: opts.commitText,
          onCommitEvents: opts.onCommitEvents,
          textKeys: opts.textKeys,
          getState,
        }) as unknown as FocusComponent<HTMLElement>;
        setCur(ed);
        return;
      }

      setCur(
        readonlyScalarView({
          core,
          target,
          getState,
        }),
      );
    });

    ctx.cleanup(() => {
      cur?.dispose();
      cur = null;
      focusEl = host;
    });

    focusEl = host;
    return host;
  });

  return {
    el: c.el,
    dispose: c.dispose,
    get focusEl() {
      return focusEl ?? c.el;
    },
  };
}
