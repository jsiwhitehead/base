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
import { createComponent, el, setData } from "./dom";

type DebugLast =
  | {
      kind: "commit" | "undo" | "redo";
      selectionBefore: Selection;
      selectionAfter: Selection;
      result: ApplyResult;
    }
  | {
      kind: "focus";
      selectionBefore: Selection;
      selectionAfter: Selection;
      focus: Focus;
      target: string;
      caret?: Caret;
    }
  | {
      kind: "blur";
      selectionBefore: Selection;
      selectionAfter: Selection;
    }
  | { kind: "dispose" };

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

export function instrumentCore(core: Core, debug: DebugState): Core {
  const commit0 = core.commit.bind(core);
  const undo0 = core.undo.bind(core);
  const redo0 = core.redo.bind(core);
  const focus0 = core.focus.bind(core);
  const blur0 = core.blur.bind(core);
  const dispose0 = core.dispose.bind(core);
  const selection0 = core.selection.bind(core);

  const readSelection = () => selection0();

  core.commit = (run) => {
    const selectionBefore = readSelection();
    const result = commit0(run);
    const selectionAfter = readSelection();
    debug.setLast({ kind: "commit", selectionBefore, selectionAfter, result });
    return result;
  };

  core.undo = () => {
    const selectionBefore = readSelection();
    const result = undo0();
    const selectionAfter = readSelection();
    debug.setLast({ kind: "undo", selectionBefore, selectionAfter, result });
    return result;
  };

  core.redo = () => {
    const selectionBefore = readSelection();
    const result = redo0();
    const selectionAfter = readSelection();
    debug.setLast({ kind: "redo", selectionBefore, selectionAfter, result });
    return result;
  };

  core.focus = (focus, target = DEFAULT_TARGET, opts = {}) => {
    const selectionBefore = readSelection();
    focus0(focus, target, opts);
    const selectionAfter = readSelection();
    debug.setLast({
      kind: "focus",
      selectionBefore,
      selectionAfter,
      focus,
      target,
      ...(opts.caret ? { caret: opts.caret } : {}),
    });
  };

  core.blur = () => {
    const selectionBefore = readSelection();
    blur0();
    const selectionAfter = readSelection();
    debug.setLast({ kind: "blur", selectionBefore, selectionAfter });
  };

  core.dispose = () => {
    debug.setLast({ kind: "dispose" });
    dispose0();
  };

  return core;
}

type DebugPanelOpts = {
  core: Core;
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

function selectionText(sel: Selection): string {
  if (sel.kind === "idle") return "idle";
  const caret = sel.caret
    ? `caret: { start: ${sel.caret.start}, end: ${sel.caret.end} }`
    : "caret: (none)";
  return [
    "focused",
    `container: ${sel.focus.container}`,
    `item:      ${sel.focus.item}`,
    `target:    ${sel.target}`,
    caret,
  ].join("\n");
}

function applyResultSummary(r: ApplyResult): string {
  return `created: ${r.created.length}, touched: ${r.touched.length}, moved: ${r.moved.length}`;
}

function lastText(last: DebugLast | null): string {
  if (!last) return "last: (none)";
  if (last.kind === "dispose") return "last: dispose";

  if (last.kind === "commit" || last.kind === "undo" || last.kind === "redo") {
    return `last: ${last.kind} (${applyResultSummary(last.result)})`;
  }

  if (last.kind === "focus") {
    const caret = last.caret
      ? ` caret:${last.caret.start}-${last.caret.end}`
      : "";
    return `last: focus target=${last.target}${caret}`;
  }

  return "last: blur";
}

function probeUiItem(
  probeRoot: HTMLElement,
  id: ItemId,
): { mounted: boolean; dataset?: Record<string, string> } {
  const ui = probeRoot.querySelector(
    `.ui-item[data-id="${CSS.escape(id)}"]`,
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
  const keys = ["id", "view", "kind", "mode", "focused", "part"].filter(
    (k) => k in ds,
  );
  const rest = Object.keys(ds)
    .filter((k) => !keys.includes(k))
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...keys, ...rest];
  return ordered.map((k) => `${k}: ${ds[k] ?? ""}`).join("\n");
}

function activeDomFocusText(): string {
  const ae =
    typeof document !== "undefined"
      ? (document.activeElement as HTMLElement | null)
      : null;
  if (!ae) return "active: (none)\ntarget: (none)";

  const tag = ae.tagName.toUpperCase();
  const isInput = ae instanceof HTMLInputElement;
  const type = isInput ? ` ${ae.type}` : "";
  const target = (ae as HTMLElement).dataset?.target ?? "(none)";

  return `active: ${tag}${type}\ntarget: ${target}`;
}

export function buildDebugPanel(opts: DebugPanelOpts) {
  const { core, debug, probeRoot } = opts;

  return createComponent(core, (ctx) => {
    const root = el("div", opts.className ?? "ui-debug");
    root.tabIndex = -1;
    setData(root, "role", "debug");

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
    const hDom = el("div", "ui-debug-title", "DOM Probe (.ui-item)");
    const bDom = el("pre", "ui-debug-pre");
    secDom.append(hDom, bDom);

    root.append(header, secSelection, secActive, secItem, secDom);

    ctx.effect(() => {
      const last = debug.lastSignal.value;
      lastLine.textContent = lastText(last);
    });

    ctx.effect(() => {
      const sel = core.selection();
      bSel.textContent = selectionText(sel);
      bActive.textContent = activeDomFocusText();

      if (sel.kind !== "focused") {
        bItem.textContent = "(none)";
        bDom.textContent = "(none)";
        return;
      }

      const snap = core.item(sel.focus.item);
      bItem.textContent = safeJson(snap);

      const p = probeUiItem(probeRoot, sel.focus.item);
      if (!p.mounted) {
        bDom.textContent = "mounted: no";
        return;
      }
      bDom.textContent = `mounted: yes\n${formatDataset(p.dataset)}`;
    });

    return root;
  });
}
