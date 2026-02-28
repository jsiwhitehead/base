import { computed } from "@preact/signals-core";

import type { Location, Intent, ItemId, Selection } from "../core";
import {
  applyTypeToPrimaryTarget,
  LABEL_TARGET,
  connTarget,
  editTargetsForItem,
  fieldsFromConn,
  getTextForTarget,
  primaryEditTarget,
} from "../core";
import { createComponent, el } from "./base";
import type { Component, UiCore } from "./runtime";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

type FocusComponent<E extends HTMLElement = HTMLElement> = Component & {
  focusEl: E;
};

export type NavDir = Extract<Intent, { type: "NAV" }>["dir"];
export type TextFieldKind = "isolated" | "traversable";

function prevent(e: Event): void {
  e.preventDefault?.();
}

function textInput(multiline: boolean): TextInputElement {
  const inputEl = document.createElement(multiline ? "textarea" : "input") as
    | HTMLInputElement
    | HTMLTextAreaElement;

  if (inputEl instanceof HTMLInputElement) inputEl.type = "text";
  inputEl.autocapitalize = "off";
  inputEl.autocomplete = "off";
  inputEl.setAttribute("autocorrect", "off");
  inputEl.spellcheck = false;
  if (inputEl instanceof HTMLTextAreaElement) inputEl.rows = 1;
  inputEl.tabIndex = -1;
  return inputEl;
}

function syncValue(inp: TextInputElement, next: string): void {
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

type TextFieldState = { text: string; readOnly: boolean };

type TextFieldOpts = {
  focus: Location;
  target: string;
  multiline: boolean;
  autosize?: boolean;
  className?: string;
  inputClassName?: string;
  kind?: TextFieldKind;
  onExitToContainer?: () => void;
  commit: (text: string) => void;
  getState: () => TextFieldState;
};

export function buildTextField(
  core: UiCore,
  opts: TextFieldOpts,
): FocusComponent<TextInputElement> {
  const kind: TextFieldKind = opts.kind ?? "traversable";
  const autosize = opts.autosize ?? false;

  let focusEl!: TextInputElement;

  const c = createComponent(core, (ctx) => {
    const wrap = el("div", "ui-textfield");
    if (opts.className) wrap.classList.add(opts.className);

    const inp = textInput(opts.multiline);
    focusEl = inp;
    inp.classList.add("ui-textfield-input");
    if (opts.inputClassName) inp.classList.add(opts.inputClassName);
    inp.dataset.target = opts.target;

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
      const selection = core.selection();
      return (
        selection.type === "editing" &&
        selection.location.item === opts.focus.item &&
        selection.location.container === opts.focus.container &&
        selection.target === opts.target
      );
    };

    const syncMirror = (text: string): void => {
      if (!mirror) return;
      const next = text === "" || text.endsWith("\n") ? text + "\u200B" : text;
      if (mirror.textContent !== next) mirror.textContent = next;
    };

    const beginDraftSession = (): void => {
      if (editing) return;
      const state = opts.getState();
      if (state.readOnly) return;

      const committed = state.text ?? "";
      editing = true;
      dirty = false;
      baseline = committed;
      draft = committed;
      syncValue(inp, draft);
      syncMirror(draft);
    };

    const commitDraft = (): void => {
      if (!editing || !dirty) return;
      const state = opts.getState();
      if (state.readOnly) return;

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

    const yieldCommit = (e: KeyboardEvent): void => {
      commitDraft();
      prevent(e);
    };

    ctx.on(inp, "keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (e.key === "Escape") {
        cancelDraft();
        return;
      }

      if (kind === "isolated") {
        if (e.key === "Enter" || e.key === "Tab") {
          commitDraft();
          prevent(e);
          opts.onExitToContainer?.();
        }
        e.stopPropagation();
        return;
      }

      if (e.key === "Tab") {
        yieldCommit(e);
        return;
      }

      if (e.key === "Enter") {
        if (inp instanceof HTMLTextAreaElement) {
          if (e.shiftKey) {
            e.stopPropagation();
            return;
          }
          if (e.metaKey || e.ctrlKey) {
            prevent(e);
            e.stopPropagation();
            return;
          }
        }
        yieldCommit(e);
        return;
      }

      const start = inp.selectionStart ?? 0;
      const end = inp.selectionEnd ?? start;
      const hasSel = start !== end;
      const len = inp.value.length;

      const dir =
        e.key === "ArrowLeft"
          ? "left"
          : e.key === "ArrowRight"
            ? "right"
            : e.key === "ArrowUp"
              ? "up"
              : e.key === "ArrowDown"
                ? "down"
                : null;

      if (dir) {
        const shouldYield =
          (dir === "left" && !hasSel && start === 0) ||
          (dir === "right" && !hasSel && end === len) ||
          (dir === "up" &&
            (inp instanceof HTMLTextAreaElement ? isFirstLine(inp) : true)) ||
          (dir === "down" &&
            (inp instanceof HTMLTextAreaElement ? isLastLine(inp) : true));

        if (shouldYield) {
          yieldCommit(e);
          return;
        }

        e.stopPropagation();
        return;
      }

      if (e.key === "Backspace" && !hasSel && start === 0) {
        yieldCommit(e);
        return;
      }

      if (e.key === "Delete" && !hasSel && end === len) {
        yieldCommit(e);
        return;
      }

      e.stopPropagation();
    });

    ctx.on(inp, "pointerdown", (e: PointerEvent) => {
      const paddingTopPx = Number.parseFloat(getComputedStyle(inp).paddingTop);
      if (Number.isFinite(paddingTopPx) && paddingTopPx > 0) {
        const y = e.clientY - inp.getBoundingClientRect().top;
        if (y < paddingTopPx) {
          e.preventDefault();
          const end = inp.value.length;
          inp.setSelectionRange(end, end);
        }
      }

      core.focus({
        type: "editing",
        location: opts.focus,
        target: opts.target,
      });
      e.stopPropagation();
    });

    ctx.on(inp, "focus", () => {
      if (!isThisTargetFocused()) {
        core.focus({
          type: "editing",
          location: opts.focus,
          target: opts.target,
        });
      }
      beginDraftSession();
    });

    ctx.on(inp, "input", () => {
      if (!editing) beginDraftSession();
      draft = inp.value;
      dirty = true;
      syncMirror(draft);
    });

    ctx.on(inp, "blur", () => {
      if (!editing) return;
      commitDraft();
    });

    ctx.target(opts.focus, opts.target, () => inp, {
      caret: {
        set(pos: number): void {
          const p = Math.max(0, Math.min(pos, inp.value.length));
          inp.setSelectionRange(p, p);
        },
        getLength(): number {
          return inp.value.length;
        },
      },
    });

    ctx.effect(() => {
      const state = opts.getState();
      inp.readOnly = state.readOnly;

      const committed = state.text ?? "";
      const focused = isThisTargetFocused();

      if (!focused) {
        editing = false;
        dirty = false;
        baseline = committed;
        draft = committed;
        syncValue(inp, committed);
        syncMirror(committed);
        return;
      }

      if (!editing && !state.readOnly) {
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

export function moveWithinItemEditTargets(
  core: UiCore,
  id: ItemId,
  fromTarget: string,
  dir: "backward" | "forward",
): { target: string; caret: number } | null {
  const targets = editTargetsForItem(core, id);
  const at = targets.indexOf(fromTarget);
  if (at < 0) return null;
  const nextIdx = dir === "backward" ? at - 1 : at + 1;
  const target = targets[nextIdx] ?? null;
  if (!target) return null;
  if (dir === "forward") return { target, caret: 0 };
  return { target, caret: getTextForTarget(core, id, target).length };
}

export function resolveFocusAfterRemove(
  core: UiCore,
  removedId: ItemId,
  prefer: "prev" | "next",
): { focus: Location } | null {
  const loc = core.locate(removedId);
  if (!loc) return null;

  const prev = loc.siblings[loc.index - 1] ?? null;
  const next = loc.siblings[loc.index + 1] ?? null;
  const sibling =
    prefer === "prev" ? (prev ?? next ?? null) : (next ?? prev ?? null);
  if (sibling) {
    return { focus: { container: loc.parentId, item: sibling } };
  }

  const parentLoc = core.locate(loc.parentId);
  if (!parentLoc) {
    return { focus: { container: loc.parentId, item: loc.parentId } };
  }
  return { focus: { container: parentLoc.parentId, item: loc.parentId } };
}

export function handleItemIntent(args: {
  core: UiCore;
  sel: Extract<Selection, { type: "item" }>;
  intent: Extract<Intent, { type: "CONFIRM" | "TYPE" }>;
}): boolean {
  const { core, sel, intent } = args;

  const id = sel.head.item;
  const location: Location = sel.head;

  if (intent.type === "TYPE") {
    const item = core.item(id);
    const valueText =
      item.content.type === "value" ? String(item.content.value ?? "") : "";
    const isEmptyPlainValue =
      item.content.type === "value" && valueText.trim() === "";
    const isEmptyPlainGroup =
      item.content.type === "group" && item.content.children.length === 0;

    if (
      intent.char === "=" &&
      item.mode.type === "plain" &&
      (isEmptyPlainValue || isEmptyPlainGroup)
    ) {
      core.commit((t) => t.setConnected(id, { type: "formula", expr: "" }));
      core.focus(
        { type: "editing", location: location, target: connTarget("expr") },
        { caret: 0 },
      );
      return true;
    }

    const applied = applyTypeToPrimaryTarget(core, id, intent.char);
    if (!applied) return false;
    core.focus(
      { type: "editing", location: location, target: applied.target },
      { caret: applied.caret },
    );
    return true;
  }

  const target = primaryEditTarget(core, id);
  if (!target) return false;

  const text = getTextForTarget(core, id, target);
  const caretPos = text.length;
  core.focus(
    { type: "editing", location: location, target },
    { caret: caretPos },
  );
  return true;
}

export function buildItemHeader(
  core: UiCore,
  args: {
    focus: Location;
    id: ItemId;
    commitLabel: (text: string) => void;
    canEditLabel: () => boolean;
    commitConnField: (key: string, text: string) => void;
  },
): Component {
  const id = args.id;

  return createComponent(core, (ctx) => {
    const headerEl = el("div", "ui-header");
    headerEl.dataset.dragStart = "block";
    headerEl.contentEditable = "false";

    const labelWrap = el("div", "ui-header-label");
    const connWrap = el("div", "ui-header-conn");
    headerEl.append(labelWrap, connWrap);

    ctx.mount(
      labelWrap,
      buildTextField(core, {
        focus: args.focus,
        target: LABEL_TARGET,
        multiline: false,
        autosize: true,
        kind: "isolated",
        onExitToContainer: () => {
          core.focus({ type: "item", location: args.focus });
        },
        commit: args.commitLabel,
        getState: () => {
          const snap = core.item(id);
          return { text: snap.label ?? "", readOnly: !args.canEditLabel() };
        },
      }),
    );

    const fieldsSignal = computed(() => {
      const snap = core.item(id);
      return snap.mode.type === "connected"
        ? fieldsFromConn(snap.mode.conn)
        : [];
    });

    ctx.list<string>(
      connWrap,
      () => fieldsSignal.value.map((f) => f.key),
      (key) =>
        createComponent(core, (rowCtx) => {
          const row = el("div", "ui-header-conn-row");
          const keyEl = el("div", "ui-header-conn-key");
          const valueEl = el("div", "ui-header-conn-val");
          row.append(keyEl, valueEl);

          const fieldSignal = computed(() => {
            const fields = fieldsSignal.value;
            return fields.find((f) => f.key === key) ?? null;
          });

          rowCtx.effect(() => {
            const label = fieldSignal.value?.label ?? "";
            if (keyEl.textContent !== label) keyEl.textContent = label;
          });

          rowCtx.mount(
            valueEl,
            buildTextField(core, {
              focus: args.focus,
              target: connTarget(key),
              multiline: fieldSignal.value?.multiline ?? true,
              autosize: true,
              kind: "traversable",
              commit: (text) => args.commitConnField(key, text),
              getState: () => {
                const field = fieldSignal.value;
                if (!field) return { text: "", readOnly: true };
                return { text: field.text ?? "", readOnly: false };
              },
            }),
          );

          return row;
        }),
    );

    return headerEl;
  });
}
