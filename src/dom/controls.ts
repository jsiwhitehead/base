import type { Core, ItemId, Caret, Component } from "../core";
import {
  createComponent,
  el,
  on,
  stopEvent,
  ensureTabbable,
  type FocusComponent,
  focusElOf,
} from "./base";

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
      el0: T,
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
  multiline: boolean;
  className?: string;
  commit: (text: string) => void;
  getState: () => TextFieldState;
  onCommitEvents?: readonly ("input" | "blur")[];
  textKeys?: (inp: TextInputElement) => (() => void) | void;
};

export function textField(
  opts: TextFieldOpts,
): FocusComponent<TextInputElement> {
  const c = createComponent((ctx) => {
    const inp = textInput(opts.multiline);
    if (opts.className) inp.className = opts.className;

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

    wrap.append(mirror, inp);

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

function readonlyItemText(core: Core, id: ItemId): Component {
  return createComponent((ctx) => {
    const d = el("div", "item readonly");
    ensureTabbable(d);

    ctx.watch(
      () => core.item(id),
      (snap) => {
        const c = snap.content;
        const isIssue = c.kind === "issue";
        const text =
          c.kind === "issue"
            ? c.message
            : c.kind === "scalar"
              ? c.value == null
                ? ""
                : String(c.value)
              : "";
        d.textContent = text;
        d.classList.toggle("issue", isIssue);
      },
    );

    return d;
  });
}

export type ContentFieldOpts = {
  core: Core;
  id: ItemId;
  className?: string;
  textKeys?: (inp: TextInputElement) => (() => void) | void;
  renderGroupChild?: (childId: ItemId) => Component;
  commitText?: (text: string) => void;
};

export function contentField(opts: ContentFieldOpts): FocusComponent {
  let focusEl: HTMLElement | null = null;

  const c = createComponent((ctx) => {
    const hostEl = el("div");
    if (opts.className) hostEl.className = opts.className;

    const core = opts.core;
    const slot = ctx.slot(hostEl);

    const setFocusEl = (comp: Component | null) => {
      focusEl = comp ? focusElOf(comp) : hostEl;
    };
    setFocusEl(null);

    const mountText = (): FocusComponent<TextInputElement> => {
      return textField({
        multiline: true,
        className: "content",
        commit: (text) => opts.commitText?.(text),
        getState: () => {
          const snap = core.item(opts.id);
          const c0 = snap.content;

          const canEdit = snap.mode.kind === "direct" && c0.kind === "scalar";

          if (canEdit) {
            return {
              text: c0.value == null ? "" : String(c0.value),
              readOnly: false,
              isIssue: false,
            };
          }

          const isIssue = c0.kind === "issue";
          const text =
            c0.kind === "issue"
              ? c0.message
              : c0.kind === "scalar"
                ? c0.value == null
                  ? ""
                  : String(c0.value)
                : "";
          return { text, readOnly: true, isIssue };
        },
        textKeys: opts.textKeys,
      });
    };

    const mountReadonlyText = (): Component => {
      const d = el("div", "item readonly");
      ensureTabbable(d);

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

    const mountGroup = (): Component => {
      const wrap = el("div", "group");
      ensureTabbable(wrap);

      const children = ctx.list(wrap, (childId: string) => {
        const c0 =
          opts.renderGroupChild?.(childId) ?? readonlyItemText(core, childId);
        c0.el.classList.add("item");
        return c0;
      });

      ctx.watch(
        () => {
          const snap = core.item(opts.id);
          const c0 = snap.content;
          return c0.kind === "group" ? [...c0.children] : [];
        },
        (ids) => {
          children.update(ids);
        },
      );

      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    let currentKind: "group" | "text" | "readonly" | null = null;

    ctx.watch(
      () => core.item(opts.id),
      (snap) => {
        const c0 = snap.content;

        const nextKind =
          c0.kind === "group"
            ? "group"
            : snap.mode.kind === "direct" && c0.kind === "scalar"
              ? "text"
              : "readonly";

        if (nextKind === currentKind) return;
        currentKind = nextKind;

        const nextComp =
          nextKind === "group"
            ? mountGroup()
            : nextKind === "text"
              ? mountText()
              : mountReadonlyText();

        slot.set(nextComp);
        setFocusEl(nextComp);
      },
    );

    ctx.onCleanup(() => {
      focusEl = hostEl;
    });

    return hostEl;
  });

  return {
    ...c,
    get focusEl() {
      return focusEl ?? c.el;
    },
  } as FocusComponent;
}
