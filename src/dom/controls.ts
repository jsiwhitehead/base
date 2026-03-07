import { computed } from "@preact/signals-core";

import type { Location, ItemId } from "../core";
import {
  LABEL_TARGET,
  connTarget,
  fieldsFromConn,
  sameLocation,
} from "../core";
import { createComponent, type Ctx, el } from "./component";
import type { Component, UiCore } from "./runtime";
import { patchConn } from "../core";

type TextInputElement = HTMLInputElement | HTMLTextAreaElement;

type FocusComponent<E extends HTMLElement = HTMLElement> = Component & {
  focusEl: E;
};

export type TextFieldKind = "isolated" | "traversable";

function preventDefaultEvent(e: Event): void {
  e.preventDefault?.();
}

function shouldYieldGlobalShortcut(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
  return e.key === ".";
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

type TextFieldState = { text: string; readOnly: boolean };

type TextFieldOpts = {
  location: Location;
  target: string;
  multiline: boolean;
  autosize?: boolean;
  className?: string;
  inputClassName?: string;
  kind?: TextFieldKind;
  onExitToItem?: () => void;
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
        sameLocation(selection.location, opts.location) &&
        selection.target === opts.target
      );
    };

    const syncMirror = (text: string): void => {
      if (!mirror) return;
      const next = text === "" || text.endsWith("\n") ? text + "\u200B" : text;
      if (mirror.textContent !== next) mirror.textContent = next;
    };

    const resetToCommitted = (committed: string): void => {
      editing = false;
      dirty = false;
      baseline = committed;
      draft = committed;
      wrap.classList.remove("is-stale");
      syncValue(inp, committed);
      syncMirror(committed);
    };

    const syncDraftSession = (committed: string): void => {
      if (!dirty && committed !== baseline) {
        baseline = committed;
        draft = committed;
      }
      wrap.classList.toggle(
        "is-stale",
        editing && dirty && committed !== baseline,
      );
      syncValue(inp, draft);
      syncMirror(draft);
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
      wrap.classList.remove("is-stale");
    };

    const cancelDraft = (): void => {
      if (!editing) return;
      draft = baseline;
      dirty = false;
      syncValue(inp, baseline);
      syncMirror(baseline);
      wrap.classList.remove("is-stale");
    };

    const yieldCommit = (e: KeyboardEvent): void => {
      commitDraft();
      preventDefaultEvent(e);
    };

    ctx.on(inp, "keydown", (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (e.key === "Escape") {
        cancelDraft();
        return;
      }

      if (shouldYieldGlobalShortcut(e)) return;

      if (kind === "isolated") {
        if (e.key === "Enter" || e.key === "Tab") {
          commitDraft();
          preventDefaultEvent(e);
          opts.onExitToItem?.();
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
            preventDefaultEvent(e);
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
          (dir === "right" && !hasSel && end === len);

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
      core.focus({
        type: "editing",
        location: opts.location,
        target: opts.target,
      });
      e.stopPropagation();
    });

    ctx.on(inp, "focus", () => {
      if (!isThisTargetFocused()) {
        core.focus({
          type: "editing",
          location: opts.location,
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

    ctx.target(opts.location, opts.target, () => inp, {
      setCaret: {
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
        resetToCommitted(committed);
        return;
      }

      if (state.readOnly) {
        resetToCommitted(committed);
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

      syncDraftSession(committed);
    });

    return wrap;
  });

  return { ...c, focusEl };
}

function buildHeader(
  core: UiCore,
  args: {
    location: Location;
    id: ItemId;
  },
): Component {
  const { location, id } = args;

  return createComponent(core, (ctx) => {
    const fieldsSignal = computed(() => {
      const item = core.item(id);
      return item.mode.type === "connected"
        ? fieldsFromConn(item.mode.conn)
        : [];
    });

    const headerEl = el("div", "ui-header");
    headerEl.contentEditable = "false";

    const labelWrap = el("div", "ui-header-label");
    const connWrap = el("div", "ui-header-conn");
    headerEl.append(labelWrap, connWrap);

    ctx.mount(
      labelWrap,
      buildTextField(core, {
        location,
        target: LABEL_TARGET,
        multiline: false,
        autosize: true,
        kind: "isolated",
        onExitToItem: () => {
          core.focus({ type: "item", location });
        },
        commit: (text) => {
          const item = core.item(id);
          if (item.mode.type === "readonly") return;
          if ((item.label ?? "") === text) return;
          core.commit((t) => t.setLabel(id, text));
        },
        getState: () => {
          const snap = core.item(id);
          return {
            text: snap.label ?? "",
            readOnly: snap.mode.type === "readonly",
          };
        },
      }),
    );

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
              location,
              target: connTarget(key),
              multiline: fieldSignal.value?.multiline ?? true,
              autosize: true,
              kind: "traversable",
              commit: (text) => {
                const item = core.item(id);
                if (item.mode.type !== "connected") return;
                const { conn } = item.mode;
                core.commit((t) =>
                  t.setConnected(id, patchConn(conn, key, text)),
                );
              },
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

export function mountHeader(
  ctx: Ctx,
  args: {
    core: UiCore;
    host: HTMLElement;
    location: Location;
    id: ItemId;
    visibility?: "auto" | "always";
  },
): void {
  const { core, host, location, id, visibility = "auto" } = args;
  if (visibility === "always") {
    ctx.mount(host, buildHeader(core, { location, id }));
    return;
  }

  const shouldShowHeader = computed(() => {
    const item = core.item(id);
    const selection = core.selection();
    return (
      (item.label ?? "").trim().length > 0 ||
      item.mode.type === "connected" ||
      (selection.type === "editing" &&
        selection.target === LABEL_TARGET &&
        sameLocation(selection.location, location))
    );
  });

  ctx.slot(host, () => {
    if (!shouldShowHeader.value) return null;
    return buildHeader(core, { location, id });
  });
}
