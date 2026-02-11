import { computed } from "@preact/signals-core";

import type { Caret, Component, Core, Focus, ItemId, Connected } from "../core";
import { DEFAULT_TARGET, defaultTextCaret } from "../core";
import { caretFromTarget, createComponent, el, on, setData } from "./base";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

type FocusComponent<E extends HTMLElement = HTMLElement> = Component & {
  focusEl: E;
};

export type NavDir = "left" | "right" | "up" | "down";
type NavMode = "step" | "jump";

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

export const LABEL_TARGET = "label";
export const VALUE_TARGET = "value";
export const connTarget = (key: string): string => `conn:${key}`;

function consume(e: Event): void {
  e.preventDefault?.();
  e.stopPropagation?.();
}

function isPrintableKeydown(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  return e.key.length === 1;
}

function keyNavMode(e: KeyboardEvent): NavMode {
  return e.metaKey || e.ctrlKey ? "jump" : "step";
}

function keyToNavDir(key: string): NavDir | null {
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

function textInput(multiline: boolean): TextInputElement {
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

function syncValue(inp: TextInputElement, next: string) {
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

function bindTextEditorYield(
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

type TextFieldState = {
  text: string;
  readOnly: boolean;
  isIssue: boolean;
};

type TextFieldEditModel = "live" | "draft";

type TextFieldOpts = {
  focus: Focus;
  target: string;
  multiline: boolean;
  autosize?: boolean;
  className?: string;
  inputClassName?: string;
  editModel?: TextFieldEditModel;
  yieldNav?: boolean;
  commit: (text: string) => void;
  getState: () => TextFieldState;
  onIntent?: (i: Intent) => void;
};

export function textField(
  core: Core,
  opts: TextFieldOpts,
): FocusComponent<TextInputElement> {
  const editModel: TextFieldEditModel = opts.editModel ?? "draft";
  const yieldNav = opts.yieldNav ?? true;
  const autosize = opts.autosize ?? false;

  let focusEl!: TextInputElement;

  const c = createComponent(core, (ctx) => {
    const wrap = el("div", "ui-textfield");
    if (opts.className) wrap.classList.add(opts.className);

    const inp = textInput(opts.multiline);
    focusEl = inp;
    inp.classList.add("ui-textfield-input");
    if (opts.inputClassName) inp.classList.add(opts.inputClassName);

    setData(inp, "target", opts.target);

    const mirror = autosize
      ? (el("span", "ui-textfield-mirror") as HTMLSpanElement)
      : null;

    if (mirror) mirror.setAttribute("aria-hidden", "true");

    if (mirror) wrap.append(mirror, inp);
    else wrap.append(inp);

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

    const syncMirror = (text: string) => {
      if (!mirror) return;
      const next = text.length ? text : " ";
      if (mirror.textContent !== next) mirror.textContent = next;
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
      syncMirror(draft);
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
      syncMirror(baseline);
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

    if (opts.onIntent && yieldNav)
      ctx.cleanup(bindTextEditorYield(inp, handleIntent));

    ctx.on(inp, "focus", () => {
      beginDraftSession();
    });

    ctx.on(inp, "input", () => {
      if (editModel === "live") {
        opts.commit(inp.value);
        syncMirror(inp.value);
        return;
      }

      if (!editing) beginDraftSession();
      draft = inp.value;
      dirty = true;
      syncMirror(draft);
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
        syncMirror(committed);
        return;
      }

      if (!focused) {
        editing = false;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, committed);
        syncMirror(committed);
        return;
      }

      if (!editing && !st.readOnly) {
        editing = true;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, draft);
        syncMirror(draft);
        return;
      }

      if (!dirty && committed !== baseline) {
        baseline = committed;
        draft = committed;
      }

      syncValue(inp, draft);
      syncMirror(draft);
    });

    return wrap;
  });

  return { ...c, focusEl };
}

type ConnField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

export function fieldsFromConn(conn: Connected): ConnField[] {
  if (conn.kind === "formula") {
    return [
      { key: "expr", label: "=", multiline: true, text: conn.expr ?? "" },
    ];
  }
  return [
    { key: "from", label: "~", multiline: false, text: conn.from ?? "" },
    { key: "where", label: "where:", multiline: true, text: conn.where ?? "" },
    {
      key: "orderBy",
      label: "orderBy:",
      multiline: true,
      text: conn.orderBy ?? "",
    },
  ];
}

export function patchConn(
  conn: Connected,
  key: string,
  text: string,
): Connected {
  if (conn.kind === "formula") {
    if (key === "expr") return { kind: "formula", expr: text };
    return conn;
  }
  if (key === "from") return { ...conn, from: text };
  if (key === "where") return { ...conn, where: text };
  if (key === "orderBy") return { ...conn, orderBy: text };
  return conn;
}

export function mountItemMeta(
  core: Core,
  args: {
    focus: Focus;
    id: ItemId;
    dispatch: (i: Intent) => void;
    commitLabel: (text: string) => void;
    canEditLabel: () => boolean;
    commitConnField: (key: string, text: string) => void;
  },
): Component {
  const id = args.id;

  return createComponent(core, (ctx) => {
    const meta = el("div", "ui-meta");

    const labelWrap = el("div", "ui-meta-label");
    const connWrap = el("div", "ui-meta-conn");
    meta.append(labelWrap, connWrap);

    const labelComp = textField(core, {
      focus: args.focus,
      target: LABEL_TARGET,
      multiline: false,
      autosize: true,
      yieldNav: false,
      commit: args.commitLabel,
      getState: () => {
        const snap = core.item(id);
        return {
          text: snap.label ?? "",
          readOnly: !args.canEditLabel(),
          isIssue: false,
        };
      },
      onIntent: args.dispatch,
    });

    labelWrap.replaceChildren(labelComp.el);
    ctx.cleanup(() => labelComp.dispose());

    const rows = ctx.list<string>(connWrap, (key) =>
      createComponent(core, (ctx2) => {
        const row = el("div", "ui-meta-conn-row");
        const keyEl = el("div", "ui-meta-conn-key");
        const valEl = el("div", "ui-meta-conn-val");
        row.append(keyEl, valEl);

        const tkey = connTarget(key);

        const specForKey = (): ConnField | null => {
          const snap = core.item(id);
          if (snap.mode.kind !== "connected") return null;
          return (
            fieldsFromConn(snap.mode.conn).find((f) => f.key === key) ?? null
          );
        };

        const multilineForKey = (): boolean => specForKey()?.multiline ?? true;
        const labelForKey = (): string => specForKey()?.label ?? "";

        const fc = textField(core, {
          focus: args.focus,
          target: tkey,
          multiline: multilineForKey(),
          autosize: true,
          commit: (text) => args.commitConnField(key, text),
          getState: () => {
            const snap = core.item(id);
            if (snap.mode.kind !== "connected")
              return { text: "", readOnly: true, isIssue: false };
            const txt =
              fieldsFromConn(snap.mode.conn).find((x) => x.key === key)?.text ??
              "";
            return { text: txt, readOnly: false, isIssue: false };
          },
          onIntent: args.dispatch,
        });

        valEl.replaceChildren(fc.el);
        ctx2.cleanup(() => fc.dispose());

        ctx2.effect(() => {
          const lbl = labelForKey();
          if (keyEl.textContent !== lbl) keyEl.textContent = lbl;
        });

        return row;
      }),
    );

    const fieldsSignal = computed(() => {
      const snap = core.item(id);
      return snap.mode.kind === "connected"
        ? fieldsFromConn(snap.mode.conn)
        : [];
    });

    ctx.effect(() => {
      rows.update(fieldsSignal.value.map((f) => f.key));
    });

    return meta;
  });
}
