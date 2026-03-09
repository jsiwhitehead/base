import type { ReadonlySignal } from "@preact/signals-core";
import { signal } from "@preact/signals-core";

import type { CaretPlacement, Core, ItemId, Selection } from "./core";
import type { Component, UiCore } from "./dom";
import { createComponent, el } from "./dom";

type DebugLast =
  | {
      type: "commit" | "undo" | "redo";
      selectionBefore: Selection;
      selectionAfter: Selection;
    }
  | {
      type: "focus";
      selectionBefore: Selection;
      selectionAfter: Selection;
      caret?: CaretPlacement;
    }
  | { type: "dispose" };

type DebugState = {
  lastSignal: ReadonlySignal<DebugLast | null>;
  recentSignal: ReadonlySignal<readonly string[]>;
  setLast(next: DebugLast | null): void;
  pushRecent(line: string): void;
};

type DebugPanelOpts = {
  core: UiCore;
  debug: DebugState;
  probeRoot: HTMLElement;
  className?: string;
};

export function createDebugState(): DebugState {
  const last = signal<DebugLast | null>(null);
  const recent = signal<readonly string[]>([]);
  let seq = 0;
  const RECENT_LIMIT = 50;
  return {
    lastSignal: last,
    recentSignal: recent,
    setLast(next) {
      last.value = next;
    },
    pushRecent(line) {
      seq += 1;
      const next = `#${seq} ${line}`;
      const items = recent.value;
      recent.value =
        items.length >= RECENT_LIMIT
          ? [...items.slice(items.length - RECENT_LIMIT + 1), next]
          : [...items, next];
    },
  };
}

export function instrumentCore<T extends Core>(core: T, debug: DebugState): T {
  const commitCore = core.commit.bind(core);
  const undoCore = core.undo.bind(core);
  const redoCore = core.redo.bind(core);
  const focusCore = core.focus.bind(core) as (
    selection: Selection,
    opts?: { caret?: CaretPlacement },
  ) => void;
  const disposeCore = core.dispose.bind(core);
  const selectionCore = core.selection.bind(core);

  const readSelection = () => selectionCore();

  core.commit = (run) => {
    const selectionBefore = readSelection();
    commitCore(run);
    const selectionAfter = readSelection();
    debug.setLast({ type: "commit", selectionBefore, selectionAfter });
    debug.pushRecent("commit");
  };

  core.undo = () => {
    const selectionBefore = readSelection();
    undoCore();
    const selectionAfter = readSelection();
    debug.setLast({ type: "undo", selectionBefore, selectionAfter });
    debug.pushRecent("undo");
  };

  core.redo = () => {
    const selectionBefore = readSelection();
    redoCore();
    const selectionAfter = readSelection();
    debug.setLast({ type: "redo", selectionBefore, selectionAfter });
    debug.pushRecent("redo");
  };

  core.focus = ((selection: Selection, opts?: { caret?: CaretPlacement }) => {
    const selectionBefore = readSelection();
    focusCore(selection, opts);
    const selectionAfter = readSelection();
    debug.setLast({
      type: "focus",
      selectionBefore,
      selectionAfter,
      ...(opts?.caret !== undefined ? { caret: opts.caret } : {}),
    });
    debug.pushRecent(
      `focus ${recentSelectionSummary(selectionAfter)}${opts?.caret !== undefined ? ` caret=${opts.caret}` : ""}`,
    );
  }) as T["focus"];

  core.dispose = () => {
    debug.setLast({ type: "dispose" });
    debug.pushRecent("dispose");
    disposeCore();
  };

  return core;
}

function safeJson(x: unknown): string {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
}

function selectionText(selection: Selection): string {
  if (selection.type === "idle") return "idle";
  const formatLocation = (item: ItemId, portals: readonly ItemId[]): string =>
    `item=${item} portals=[${portals.join("|")}]`;
  if (selection.type === "item") {
    return [
      "item",
      `anchor:    ${formatLocation(selection.anchor.item, selection.anchor.portals)}`,
      `head:      ${formatLocation(selection.head.item, selection.head.portals)}`,
    ].join("\n");
  }
  return [
    "editing",
    `item:      ${selection.location.item}`,
    `portals:   [${selection.location.portals.join("|")}]`,
    `target:    ${selection.target}`,
  ].join("\n");
}

function recentLinesText(lines: readonly string[]): string {
  if (!lines.length) return "(none)";
  return [...lines].reverse().join("\n");
}

function recentSelectionSummary(selection: Selection): string {
  if (selection.type === "idle") return "selection=idle";
  const formatLocation = (item: ItemId, portals: readonly ItemId[]): string =>
    `item=${item} portals=[${portals.join("|")}]`;
  if (selection.type === "item")
    return `selection=item anchor(${formatLocation(selection.anchor.item, selection.anchor.portals)}) head(${formatLocation(selection.head.item, selection.head.portals)})`;
  return `editing item=${selection.location.item} portals=[${selection.location.portals.join("|")}] target=${selection.target}`;
}

function lastText(last: DebugLast | null): string {
  if (!last) return "last: (none)";
  if (last.type === "dispose") return "last: dispose";

  if (last.type === "commit" || last.type === "undo" || last.type === "redo") {
    return `last: ${last.type}`;
  }

  if (last.type === "focus") {
    const caret = last.caret !== undefined ? ` caret:${last.caret}` : "";
    return `last: focus ${recentSelectionSummary(last.selectionAfter)}${caret}`;
  }

  return "last: focus";
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
    root.dataset.role = "debug";

    const header = el("div", "ui-debug-header");
    const lastLine = el("div", "ui-debug-last");
    header.append(lastLine);

    const secSelection = el("div", "ui-debug-section");
    const hSel = el("div", "ui-debug-title", "Selection");
    const bSel = el("pre", "ui-debug-pre");
    secSelection.append(hSel, bSel);

    const secActive = el("div", "ui-debug-section");
    const hActive = el("div", "ui-debug-title", "Active DOM Location");
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

    const secRecent = el("div", "ui-debug-section");
    const hRecent = el("div", "ui-debug-title", "Recent Events");
    const bRecent = el("pre", "ui-debug-pre");
    secRecent.append(hRecent, bRecent);

    root.append(header, secSelection, secActive, secItem, secDom, secRecent);

    ctx.effect(() => {
      const last = debug.lastSignal.value;
      lastLine.textContent = lastText(last);
    });

    ctx.effect(() => {
      bRecent.textContent = recentLinesText(debug.recentSignal.value);
    });

    ctx.effect(() => {
      const selection = core.selection();
      bSel.textContent = selectionText(selection);
      bActive.textContent = activeDomFocusText();

      if (selection.type !== "editing") {
        bItem.textContent = "(none)";
        bDom.textContent = "(none)";
        return;
      }

      const snap = core.item(selection.location.item);
      bItem.textContent = safeJson(snap);

      const probe = probeUiFrame(probeRoot, selection.location.item);
      if (!probe.mounted) {
        bDom.textContent = "mounted: no";
        return;
      }
      bDom.textContent = `mounted: yes\n${formatDataset(probe.dataset)}`;
    });

    return root;
  });
}
