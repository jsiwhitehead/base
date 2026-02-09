import type { Core, ItemId, Focus, Caret, Component } from "../core";
import { DEFAULT_TARGET, defaultTextCaret } from "../core";
import {
  createComponent,
  el,
  on,
  caretFromTarget,
  setData,
  setDataBool,
} from "./base";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

export type FocusComponent<E extends HTMLElement = HTMLElement> = Component & {
  focusEl: E;
};

export type NavDir = "left" | "right" | "up" | "down";
export type NavMode = "step" | "jump";

export type Intent =
  | { type: "NAV"; dir: NavDir; mode: NavMode }
  | { type: "CONFIRM"; caret?: Caret }
  | { type: "CANCEL" }
  | { type: "TAB"; shift: boolean }
  | { type: "TYPE"; char: string }
  | { type: "DELETE"; dir: "backward" | "forward" }
  | { type: "DELETE_BOUNDARY"; dir: "backward" | "forward" };

export const SELECT_ALL: Caret = { start: 0, end: Number.MAX_SAFE_INTEGER };
export const caret0 = (): Caret => ({ start: 0, end: 0 });
export const caretAt = (pos: number): Caret => ({ start: pos, end: pos });

export function consume(e: Event): void {
  e.preventDefault?.();
  e.stopPropagation?.();
}

export function isPrintableKeydown(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key.length === 1;
}

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

export function parseKeydownIntent(e: KeyboardEvent): Intent | null {
  if (e.key === "Escape") return { type: "CANCEL" };
  if (e.key === "Tab") return { type: "TAB", shift: !!e.shiftKey };
  if (e.key === "Enter") return { type: "CONFIRM" };

  if (e.key === "Backspace") return { type: "DELETE", dir: "backward" };
  if (e.key === "Delete") return { type: "DELETE", dir: "forward" };

  const dir = keyToNavDir(e.key);
  if (dir) return { type: "NAV", dir, mode: keyNavMode(e) };

  if (isPrintableKeydown(e)) return { type: "TYPE", char: e.key };

  return null;
}

export function insertTextIntoActiveEditor(text: string): void {
  const a = document.activeElement;
  if (!(a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement))
    return;
  if (a.readOnly || a.disabled) return;

  const start = a.selectionStart ?? 0;
  const end = a.selectionEnd ?? start;

  a.setRangeText(text, start, end, "end");
  a.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

export function escapeLadder(core: Core): void {
  const sel = core.selection();
  if (sel.kind !== "focused") {
    core.blur();
    return;
  }
  if (sel.target !== DEFAULT_TARGET) {
    core.focus(sel.focus, DEFAULT_TARGET, { caret: caret0() });
    return;
  }
  core.blur();
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

function isFirstLine(inp: HTMLTextAreaElement): boolean {
  const pos = inp.selectionStart ?? 0;
  return inp.value.lastIndexOf("\n", Math.max(0, pos - 1)) < 0;
}

function isLastLine(inp: HTMLTextAreaElement): boolean {
  const pos = inp.selectionEnd ?? inp.selectionStart ?? 0;
  return inp.value.indexOf("\n", pos) < 0;
}

export function bindTextEditorYield(
  inp: TextInputElement,
  onIntent: (i: Intent) => void,
): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Tab") {
      consume(e);
      onIntent({ type: "TAB", shift: !!e.shiftKey });
      return;
    }

    if (e.key === "Escape") {
      consume(e);
      onIntent({ type: "CANCEL" });
      return;
    }

    const mode = keyNavMode(e);

    const start = inp.selectionStart ?? 0;
    const end = inp.selectionEnd ?? start;
    const hasSel = start !== end;
    const len = inp.value.length;

    const dir = keyToNavDir(e.key);
    if (dir) {
      const atStart = !hasSel && start === 0;
      const atEnd = !hasSel && end === len;

      const shouldYield =
        (dir === "left" && atStart) ||
        (dir === "right" && atEnd) ||
        (dir === "up" &&
          (inp instanceof HTMLTextAreaElement ? isFirstLine(inp) : true)) ||
        (dir === "down" &&
          (inp instanceof HTMLTextAreaElement ? isLastLine(inp) : true));

      if (shouldYield) {
        consume(e);
        onIntent({ type: "NAV", dir, mode });
        return;
      }
    }

    if (e.key === "Enter") {
      if (inp instanceof HTMLTextAreaElement && (e.metaKey || e.ctrlKey))
        return;
      consume(e);
      onIntent({ type: "CONFIRM", caret: { start, end } });
      return;
    }

    if (e.key === "Backspace" && !hasSel && start === 0) {
      consume(e);
      onIntent({ type: "DELETE_BOUNDARY", dir: "backward" });
      return;
    }

    if (e.key === "Delete" && !hasSel && end === len) {
      consume(e);
      onIntent({ type: "DELETE_BOUNDARY", dir: "forward" });
      return;
    }
  };

  return on(inp, "keydown", onKeyDown);
}

function bindEditorPointerSelect(
  core: Core,
  focus: Focus,
  target: string,
  focusEl: HTMLElement,
): () => void {
  return on(focusEl, "pointerdown", (e: PointerEvent) => {
    core.focus(focus, target, { caret: caretFromTarget(e.target) });
    e.stopPropagation();
  });
}

export type TextFieldState = {
  text: string;
  readOnly: boolean;
  isIssue: boolean;
};

export type TextFieldEditModel = "live" | "draft";

export type TextFieldOpts = {
  focus: Focus;
  target: string;
  multiline: boolean;
  className?: string;
  editModel?: TextFieldEditModel;
  commit: (text: string) => void;
  getState: () => TextFieldState;
  onIntent?: (i: Intent) => void;
};

export function textField(
  core: Core,
  opts: TextFieldOpts,
): FocusComponent<TextInputElement> {
  const editModel: TextFieldEditModel = opts.editModel ?? "draft";

  const c = createComponent(core, (ctx) => {
    const inp = textInput(opts.multiline);
    if (opts.className) inp.className = opts.className;

    setData(inp, "target", opts.target);

    let editing = false;
    let dirty = false;
    let baseline = "";
    let draft = "";

    const isThisTargetFocused = (): boolean => {
      const sel = core.selection();
      return (
        sel.kind === "focused" &&
        sel.focus.item === opts.focus.item &&
        sel.focus.container === opts.focus.container &&
        sel.target === opts.target
      );
    };

    const beginDraftSession = () => {
      if (editModel !== "draft") return;
      if (editing) return;

      const st = opts.getState();
      if (st.readOnly) return;

      const committed = st.text ?? "";
      editing = true;
      dirty = false;
      baseline = committed;
      draft = committed;
      syncValue(inp, draft);
    };

    const commitDraft = (): void => {
      if (!editing) return;
      if (!dirty) return;

      const st = opts.getState();
      if (st.readOnly) return;

      opts.commit(draft);
      dirty = false;
      baseline = draft;
    };

    const cancelDraft = (): void => {
      if (!editing) return;
      draft = baseline;
      dirty = false;
      syncValue(inp, baseline);
    };

    const handleIntent = (i: Intent) => {
      if (editModel === "draft") {
        if (i.type === "CANCEL") {
          cancelDraft();
          opts.onIntent?.(i);
          return;
        }

        if (i.type === "CONFIRM" || i.type === "TAB" || i.type === "NAV") {
          commitDraft();
          opts.onIntent?.(i);
          return;
        }

        opts.onIntent?.(i);
        return;
      }

      opts.onIntent?.(i);
    };

    if (opts.onIntent) ctx.cleanup(bindTextEditorYield(inp, handleIntent));

    ctx.on(inp, "focus", () => {
      beginDraftSession();
    });

    ctx.on(inp, "input", () => {
      if (editModel === "live") {
        opts.commit(inp.value);
        return;
      }

      if (!editing) beginDraftSession();
      draft = inp.value;
      dirty = true;
    });

    ctx.on(inp, "blur", () => {
      if (editModel !== "draft") return;
      if (!editing) return;
      commitDraft();
    });

    ctx.cleanup(bindEditorPointerSelect(core, opts.focus, opts.target, inp));

    ctx.target(opts.focus, opts.target, () => inp, {
      caret: defaultTextCaret(),
    });

    ctx.effect(() => {
      const st = opts.getState();
      inp.readOnly = st.readOnly;

      const committed = st.text ?? "";
      const focused = isThisTargetFocused();

      if (editModel === "live") {
        syncValue(inp, committed);
        setDataBool(inp, "issue", !!st.isIssue);
        return;
      }

      if (!focused) {
        editing = false;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, committed);
        setDataBool(inp, "issue", !!st.isIssue);
        return;
      }

      if (!editing && !st.readOnly) {
        editing = true;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, draft);
        setDataBool(inp, "issue", !!st.isIssue);
        return;
      }

      if (!dirty && committed !== baseline) {
        baseline = committed;
        draft = committed;
      }

      syncValue(inp, draft);
      setDataBool(inp, "issue", !!st.isIssue);
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
  const editModel: TextFieldEditModel = opts.editModel ?? "draft";

  let focusEl!: HTMLInputElement;

  const c = createComponent(core, (ctx) => {
    const wrap = el("div", opts.wrapClassName ?? "autosize");
    if (opts.className) wrap.classList.add(opts.className);

    const mirror = el("span", opts.mirrorClassName ?? "");
    mirror.setAttribute("aria-hidden", "true");

    const inp = textInput(false) as HTMLInputElement;
    focusEl = inp;
    if (opts.inputClassName) inp.classList.add(opts.inputClassName);

    setData(inp, "target", opts.target);

    wrap.append(mirror, inp);

    let editing = false;
    let dirty = false;
    let baseline = "";
    let draft = "";

    const isThisTargetFocused = (): boolean => {
      const sel = core.selection();
      return (
        sel.kind === "focused" &&
        sel.focus.item === opts.focus.item &&
        sel.focus.container === opts.focus.container &&
        sel.target === opts.target
      );
    };

    const beginDraftSession = () => {
      if (editModel !== "draft") return;
      if (editing) return;

      const st = opts.getState();
      if (st.readOnly) return;

      const committed = st.text ?? "";
      editing = true;
      dirty = false;
      baseline = committed;
      draft = committed;
      syncValue(inp, draft);
      mirror.textContent = draft.length ? draft : " ";
    };

    const commitDraft = (): void => {
      if (!editing) return;
      if (!dirty) return;

      const st = opts.getState();
      if (st.readOnly) return;

      opts.commit(draft);
      dirty = false;
      baseline = draft;
    };

    const cancelDraft = (): void => {
      if (!editing) return;
      draft = baseline;
      dirty = false;
      syncValue(inp, baseline);
      mirror.textContent = baseline.length ? baseline : " ";
    };

    const handleIntent = (i: Intent) => {
      if (editModel === "draft") {
        if (i.type === "CANCEL") {
          cancelDraft();
          opts.onIntent?.(i);
          return;
        }

        if (i.type === "CONFIRM" || i.type === "TAB" || i.type === "NAV") {
          commitDraft();
          opts.onIntent?.(i);
          return;
        }

        opts.onIntent?.(i);
        return;
      }

      opts.onIntent?.(i);
    };

    if (opts.onIntent) ctx.cleanup(bindTextEditorYield(inp, handleIntent));

    ctx.on(inp, "focus", () => {
      beginDraftSession();
    });

    ctx.on(inp, "input", () => {
      if (editModel === "live") {
        opts.commit(inp.value);
        return;
      }

      if (!editing) beginDraftSession();
      draft = inp.value;
      dirty = true;
      mirror.textContent = draft.length ? draft : " ";
    });

    ctx.on(inp, "blur", () => {
      if (editModel !== "draft") return;
      if (!editing) return;
      commitDraft();
    });

    ctx.cleanup(bindEditorPointerSelect(core, opts.focus, opts.target, inp));

    ctx.target(opts.focus, opts.target, () => inp, {
      caret: defaultTextCaret(),
    });

    ctx.effect(() => {
      const st = opts.getState();
      inp.readOnly = st.readOnly;

      const committed = st.text ?? "";
      const focused = isThisTargetFocused();

      if (editModel === "live") {
        syncValue(inp, committed);
        mirror.textContent = committed.length ? committed : " ";
        setDataBool(inp, "issue", !!st.isIssue);
        return;
      }

      if (!focused) {
        editing = false;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, committed);
        mirror.textContent = committed.length ? committed : " ";
        setDataBool(inp, "issue", !!st.isIssue);
        return;
      }

      if (!editing && !st.readOnly) {
        editing = true;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, draft);
        mirror.textContent = draft.length ? draft : " ";
        setDataBool(inp, "issue", !!st.isIssue);
        return;
      }

      if (!dirty && committed !== baseline) {
        baseline = committed;
        draft = committed;
      }

      syncValue(inp, draft);
      mirror.textContent = draft.length ? draft : " ";
      setDataBool(inp, "issue", !!st.isIssue);
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
  target: string;
  multiline: boolean;
  className?: string;
  commitText?: (text: string) => void;
  getState?: () => ScalarFieldState;
  onIntent?: (i: Intent) => void;
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

function readonlyScalarView(args: {
  core: Core;
  focus: Focus;
  target: string;
  getState: () => ScalarFieldState;
  className?: string;
}): FocusComponent<HTMLElement> {
  const c = createComponent(args.core, (ctx) => {
    const d = el("div", args.className);
    d.tabIndex = -1;
    setData(d, "target", args.target);

    ctx.cleanup(bindEditorPointerSelect(args.core, args.focus, args.target, d));
    ctx.target(args.focus, args.target, () => d);

    ctx.effect(() => {
      d.textContent = args.getState().text;
    });

    return d;
  });

  return { ...c, focusEl: c.el };
}

function editableScalarEditor(args: {
  core: Core;
  focus: Focus;
  target: string;
  multiline: boolean;
  commitText?: (text: string) => void;
  getState: () => ScalarFieldState;
  className?: string;
  onIntent?: (i: Intent) => void;
}): FocusComponent<TextInputElement> {
  const fc = textField(args.core, {
    focus: args.focus,
    target: args.target,
    multiline: args.multiline,
    className: args.className ?? "",
    editModel: "live",
    commit: (text) => args.commitText?.(text),
    getState: () => {
      const st = args.getState();
      return { text: st.text, readOnly: !st.editable, isIssue: st.isIssue };
    },
    onIntent: args.onIntent,
  });

  const c = createComponent(args.core, (ctx) => {
    const host = el("div");
    host.append(fc.el);
    ctx.cleanup(() => fc.dispose());
    return host;
  });

  return { ...c, focusEl: fc.focusEl };
}

export function scalarField(
  opts: ScalarFieldOpts,
): FocusComponent<HTMLElement> {
  const { core, focus, target } = opts;
  const id = focus.item;

  const getState = opts.getState ?? (() => deriveScalarFieldState(core, id));

  let focusEl: HTMLElement;

  const c = createComponent(core, (ctx) => {
    const host = el("div");
    if (opts.className) host.className = opts.className;

    const slot = ctx.slot(host);

    focusEl = host;
    let currentEditable: boolean | null = null;
    let current: FocusComponent<HTMLElement> | null = null;

    ctx.effect(() => {
      const st = getState();
      const nextEditable = !!st.editable;
      if (current && currentEditable === nextEditable) return;
      currentEditable = nextEditable;

      if (nextEditable) {
        current = editableScalarEditor({
          core,
          focus,
          target,
          multiline: opts.multiline,
          commitText: opts.commitText,
          getState,
          onIntent: opts.onIntent,
        }) as unknown as FocusComponent<HTMLElement>;
        slot.set(current);
        focusEl = current.focusEl;
        return;
      }

      current = readonlyScalarView({
        core,
        focus,
        target,
        getState,
      });
      slot.set(current);
      focusEl = current.focusEl;
    });

    ctx.cleanup(() => {
      current = null;
      currentEditable = null;
      focusEl = host;
    });

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
