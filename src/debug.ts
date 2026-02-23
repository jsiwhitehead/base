import type { ReadonlySignal } from "@preact/signals-core";
import { signal } from "@preact/signals-core";

import type {
  ApplyResult,
  Caret,
  Core,
  Focus,
  ItemId,
  Selection,
} from "./core";
import { DEFAULT_TARGET } from "./core";
import type { Component, UiCore } from "./dom";
import { createComponent, el } from "./dom";

type DebugLast =
  | {
      type: "commit" | "undo" | "redo";
      selectionBefore: Selection;
      selectionAfter: Selection;
      result: ApplyResult;
    }
  | {
      type: "focus";
      selectionBefore: Selection;
      selectionAfter: Selection;
      focus: Focus;
      target: string;
      caret?: Caret;
    }
  | {
      type: "blur";
      selectionBefore: Selection;
      selectionAfter: Selection;
    }
  | { type: "dispose" };

type DebugState = {
  lastSignal: ReadonlySignal<DebugLast | null>;
  setLast(next: DebugLast | null): void;
};

export function createDebugState(): DebugState {
  const last = signal<DebugLast | null>(null);
  return {
    lastSignal: last,
    setLast(next) {
      last.value = next;
    },
  };
}

export function instrumentCore<T extends Core>(core: T, debug: DebugState): T {
  const commitCore = core.commit.bind(core);
  const undoCore = core.undo.bind(core);
  const redoCore = core.redo.bind(core);
  const focusCore = core.focus.bind(core);
  const blurCore = core.blur.bind(core);
  const disposeCore = core.dispose.bind(core);
  const selectionCore = core.selection.bind(core);

  const readSelection = () => selectionCore();

  core.commit = (run) => {
    const selectionBefore = readSelection();
    const result = commitCore(run);
    const selectionAfter = readSelection();
    debug.setLast({ type: "commit", selectionBefore, selectionAfter, result });
    return result;
  };

  core.undo = () => {
    const selectionBefore = readSelection();
    const result = undoCore();
    const selectionAfter = readSelection();
    debug.setLast({ type: "undo", selectionBefore, selectionAfter, result });
    return result;
  };

  core.redo = () => {
    const selectionBefore = readSelection();
    const result = redoCore();
    const selectionAfter = readSelection();
    debug.setLast({ type: "redo", selectionBefore, selectionAfter, result });
    return result;
  };

  core.focus = (focus, target = DEFAULT_TARGET, opts = {}) => {
    const selectionBefore = readSelection();
    focusCore(focus, target, opts);
    const selectionAfter = readSelection();
    debug.setLast({
      type: "focus",
      selectionBefore,
      selectionAfter,
      focus,
      target,
      ...(opts.caret ? { caret: opts.caret } : {}),
    });
  };

  core.blur = () => {
    const selectionBefore = readSelection();
    blurCore();
    const selectionAfter = readSelection();
    debug.setLast({ type: "blur", selectionBefore, selectionAfter });
  };

  core.dispose = () => {
    debug.setLast({ type: "dispose" });
    disposeCore();
  };

  return core;
}

type DebugPanelOpts = {
  core: UiCore;
  debug: DebugState;
  probeRoot: HTMLElement;
  className?: string;
};

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function selectionText(selection: Selection): string {
  if (selection.type === "idle") return "idle";
  const caret = selection.caret
    ? `caret: { start: ${selection.caret.start}, end: ${selection.caret.end} }`
    : "caret: (none)";
  return [
    "focused",
    `container: ${selection.focus.container}`,
    `item:      ${selection.focus.item}`,
    `target:    ${selection.target}`,
    caret,
  ].join("\n");
}

function applyResultSummary(r: ApplyResult): string {
  return `created: ${r.created.length}, touched: ${r.touched.length}, moved: ${r.moved.length}`;
}

function lastText(last: DebugLast | null): string {
  if (!last) return "last: (none)";
  if (last.type === "dispose") return "last: dispose";

  if (last.type === "commit" || last.type === "undo" || last.type === "redo") {
    return `last: ${last.type} (${applyResultSummary(last.result)})`;
  }

  if (last.type === "focus") {
    const caret = last.caret
      ? ` caret:${last.caret.start}-${last.caret.end}`
      : "";
    return `last: focus target=${last.target}${caret}`;
  }

  return "last: blur";
}

function probeUiFrame(
  probeRoot: HTMLElement,
  id: ItemId,
): { mounted: boolean; dataset?: Record<string, string> } {
  const ui = probeRoot.querySelector(
    `.ui-frame[data-id="${CSS.escape(id)}"]`,
  ) as HTMLElement | null;
  if (!ui) return { mounted: false };
  const ds: Record<string, string> = {};
  for (const [k, v] of Object.entries(ui.dataset)) {
    if (v != null) ds[k] = v;
  }
  return { mounted: true, dataset: ds };
}

function formatDataset(ds: Record<string, string> | undefined): string {
  if (!ds) return "";
  const keys = ["id", "view", "type", "mode", "focused", "part"].filter(
    (k) => k in ds,
  );
  const rest = Object.keys(ds)
    .filter((k) => !keys.includes(k))
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...keys, ...rest];
  return ordered.map((k) => `${k}: ${ds[k] ?? ""}`).join("\n");
}

function activeDomFocusText(): string {
  const activeElement =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  if (!activeElement) return "active: (none)\ntarget: (none)";

  const tag = activeElement.tagName.toUpperCase();
  const isInput = activeElement instanceof HTMLInputElement;
  const type = isInput ? ` ${activeElement.type}` : "";
  const target = activeElement.dataset?.target ?? "(none)";

  return `active: ${tag}${type}\ntarget: ${target}`;
}

export function buildDebugPanel(opts: DebugPanelOpts): Component {
  const { core, debug, probeRoot } = opts;

  return createComponent(core, (ctx) => {
    const root = el("div", opts.className ?? "ui-debug");
    root.tabIndex = -1;
    root.dataset.role = "debug";

    const header = el("div", "ui-debug-header");
    const lastLine = el("div", "ui-debug-last");
    header.append(lastLine);

    const secSelection = el("div", "ui-debug-section");
    const hSel = el("div", "ui-debug-title", "Selection");
    const bSel = el("pre", "ui-debug-pre");
    secSelection.append(hSel, bSel);

    const secActive = el("div", "ui-debug-section");
    const hActive = el("div", "ui-debug-title", "Active DOM Focus");
    const bActive = el("pre", "ui-debug-pre");
    secActive.append(hActive, bActive);

    const secItem = el("div", "ui-debug-section");
    const hItem = el("div", "ui-debug-title", "Focused Item");
    const bItem = el("pre", "ui-debug-pre");
    secItem.append(hItem, bItem);

    const secDom = el("div", "ui-debug-section");
    const hDom = el("div", "ui-debug-title", "DOM Probe (.ui-frame)");
    const bDom = el("pre", "ui-debug-pre");
    secDom.append(hDom, bDom);

    root.append(header, secSelection, secActive, secItem, secDom);

    ctx.effect(() => {
      const last = debug.lastSignal.value;
      lastLine.textContent = lastText(last);
    });

    ctx.effect(() => {
      const selection = core.selection();
      bSel.textContent = selectionText(selection);
      bActive.textContent = activeDomFocusText();

      if (selection.type !== "focused") {
        bItem.textContent = "(none)";
        bDom.textContent = "(none)";
        return;
      }

      const snap = core.item(selection.focus.item);
      bItem.textContent = safeJson(snap);

      const probe = probeUiFrame(probeRoot, selection.focus.item);
      if (!probe.mounted) {
        bDom.textContent = "mounted: no";
        return;
      }
      bDom.textContent = `mounted: yes\n${formatDataset(probe.dataset)}`;
    });

    return root;
  });
}
