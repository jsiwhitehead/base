import type {
  Core,
  ItemRef,
  ItemContent,
  Caret,
  Focus,
  Component,
} from "../core";
import {
  createComponent,
  el,
  on,
  stopEvent,
  ensureTabbable,
  type InputComponent,
  focusElOf,
  type FocusableTargetSpec,
  installFocusableTargets,
  type Ctx,
  type NavDir,
  type NavMode,
} from "./base";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

export const defaultTextNav = {
  yieldUpDown: "always",
  yieldLeftRight: "boundary",
} as const;

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

export function textField(
  opts: TextFieldOpts,
): InputComponent<TextInputElement> {
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

export function autosizeTextField(
  opts: AutosizeTextFieldOpts,
): InputComponent<HTMLInputElement> {
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

const refKey = (r: ItemRef): string =>
  `${String(r.entryId)}:${r.path.length ? r.path.join(",") : ""}`;

const refFromKey = (key: string): ItemRef => {
  const i = key.indexOf(":");
  if (i === -1) return { entryId: Number(key), path: [] };
  const entryId = Number(key.slice(0, i));
  const rest = key.slice(i + 1);
  const path = rest.trim() === "" ? [] : rest.split(",").map((x) => Number(x));
  return { entryId, path };
};

function readonlyItemText(core: Core, ref: ItemRef): Component {
  return createComponent((ctx) => {
    const d = el("div", "item readonly");
    ctx.watch(
      () => core.item(ref).content,
      (c) => {
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
  focus: Focus;
  ref: ItemRef;
  className?: string;
  registerFocus?: boolean;
  textKeys?: (inp: TextInputElement) => (() => void) | void;
  renderGroupChild?: (childRef: ItemRef) => Component;
  commitText?: (text: string) => void;
  focusElRef?: { current: HTMLElement | null };
};

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
      return textField({
        core,
        focus: opts.focus,
        target: "content",
        multiline: true,
        className: "content",
        caret: "fromTarget",
        stopPropagation: true,
        registerFocus: register,
        commit: (text) => opts.commitText?.(text),
        getState: () => {
          const snap = core.item(opts.ref);
          if (snap.edit.kind === "scalar")
            return { text: snap.edit.text, readOnly: false, isIssue: false };

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
          return { text, readOnly: true, isIssue };
        },
        textKeys: opts.textKeys,
      });
    };

    const mountReadonlyText = (): Component => {
      const d = el("div", "item readonly");
      installContentClickTarget(d);

      const inner = readonlyItemText(core, opts.ref);
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
      installContentClickTarget(wrap);

      const children = ctx.list(wrap, (key: string) => {
        const childRef = refFromKey(key);
        const c =
          opts.renderGroupChild?.(childRef) ?? readonlyItemText(core, childRef);
        c.el.classList.add("item");
        return c;
      });

      ctx.watch(
        () => {
          const c = core.item(opts.ref).content;
          if (c.kind !== "group") return [] as string[];
          return c.children.map(refKey);
        },
        (keys) => {
          children.update(keys);
        },
      );

      return { el: wrap, dispose: () => wrap.replaceChildren() };
    };

    let currentKind: "group" | "text" | "readonly" | null = null;

    ctx.watch(
      () => core.item(opts.ref),
      (snap) => {
        const c = snap.content;

        const nextKind =
          c.kind === "group"
            ? "group"
            : snap.edit.kind === "scalar"
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
      if (opts.focusElRef) opts.focusElRef.current = hostEl;
    });

    return hostEl;
  });
}
