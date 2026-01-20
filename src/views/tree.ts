import { effect } from "@preact/signals-core";
import type { Store, ItemId, Value, Txn, StoredContent } from "../store";
import {
  type Editor,
  type Region,
  type Selection,
  type Focus,
  type FocusTarget,
  type EditorEffect,
  type Binding,
  type RegionKeyResult,
  mkFocusSelection,
} from "../editor";
import {
  el,
  on,
  textInput,
  syncValue,
  clamp,
  ChildManager,
  getEditableText,
  getDisplayText,
  parseScalar,
  bindCommitTextInput,
  renderLabeledValueReadonly,
  CleanupBag,
} from "../ui";
import { replaceMountedRegion } from "./index";
import { createTableRegion } from "./table";
import { createSliderRegion } from "./slider";

export type TreeRegionCtx = { editor: Editor };

export function createTreeRegion(
  ctx: TreeRegionCtx,
  rootId: ItemId,
  _focus?: Focus,
): Region {
  const { editor } = ctx;
  const store = editor.store;

  const root = el("div", "region tree");
  const regionId = `tree:${String(rootId)}`;

  const rootView = new ItemView(
    { editor, rootId, regionId },
    { containerId: rootId, id: rootId },
    { showHeader: false },
  );
  root.append(rootView.element);

  return {
    id: regionId,
    root,

    onActivate() {
      const sel = editor.runtime.selection.value;
      if (sel.kind !== "idle") return;

      const first = firstNavStop(store, rootId);
      if (!first) return;

      const target = defaultTargetFor(store, first.id);
      const res = mkFocusSelection(first, target, 0);
      editor.setSelection(res.selection, res.effects);
    },

    onKeyDown(e): RegionKeyResult {
      const sel = editor.runtime.selection.value;
      if (sel.kind !== "focused") return;

      const mod = e.metaKey || e.ctrlKey;
      const mode = mod ? "jump" : "step";

      const stopAndPrevent = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      switch (e.key) {
        case "ArrowUp":
        case "ArrowDown":
        case "ArrowLeft":
        case "ArrowRight": {
          stopAndPrevent();

          const dir =
            e.key === "ArrowUp"
              ? "up"
              : e.key === "ArrowDown"
                ? "down"
                : e.key === "ArrowLeft"
                  ? "left"
                  : "right";

          const res = treeNavMove(store, sel, dir, mode);
          if (res) editor.setSelection(res.selection, res.effects);
          return;
        }

        case "Enter": {
          stopAndPrevent();
          const res = treeCommands.confirm(editor, sel);
          if (res.selection)
            editor.setSelection(res.selection, res.effects ?? []);
          return;
        }

        case "Backspace": {
          stopAndPrevent();
          const res = treeCommands.deleteBoundary(editor, sel, "backward");
          if (res.selection)
            editor.setSelection(res.selection, res.effects ?? []);
          return;
        }

        case "Delete": {
          stopAndPrevent();
          const res = treeCommands.deleteBoundary(editor, sel, "forward");
          if (res.selection)
            editor.setSelection(res.selection, res.effects ?? []);
          return;
        }

        case "Tab": {
          stopAndPrevent();
          const res = treeCommands.changeNesting(
            editor,
            sel,
            e.shiftKey ? "out" : "in",
          );
          if (res.selection)
            editor.setSelection(res.selection, res.effects ?? []);
          return;
        }

        case "Escape": {
          stopAndPrevent();
          editor.setSelection({ kind: "idle" }, [{ type: "CLEAR_DOM_FOCUS" }]);
          return;
        }
      }
    },

    dispose() {
      rootView.dispose();
      root.replaceChildren();
    },
  };
}

type CmdResult = {
  didChange: boolean;
  selection?: Selection;
  effects?: EditorEffect[];
  issue?: string;
};

function tryCmd(fn: () => CmdResult): CmdResult {
  try {
    return fn();
  } catch (err) {
    return {
      didChange: false,
      issue: err instanceof Error ? err.message : String(err),
    };
  }
}

export const treeCommands = {
  commitLabel(editor: Editor, f: Focus, text: string): CmdResult {
    return tryCmd(() => {
      editor.apply({
        ops: [{ kind: "patch", id: f.id, next: { label: text } }],
      });
      return { didChange: true };
    });
  },

  commitContentText(editor: Editor, f: Focus, raw: string): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      if (!store.sel.canEditScalarText(f.id)) return { didChange: false };
      editor.apply({
        ops: [
          {
            kind: "patch",
            id: f.id,
            next: { content: { kind: "scalar", value: parseScalar(raw) } },
          },
        ],
      });
      return { didChange: true };
    });
  },

  setDerived(editor: Editor, f: Focus): CmdResult {
    return tryCmd(() => {
      const target: FocusTarget = { kind: "header", index: 1 };
      const nextSel: Selection = { kind: "focused", focus: f, target };
      const effects: EditorEffect[] = [
        { type: "DOM_FOCUS", focus: f, target, caret: 0 },
      ];

      editor.apply(
        {
          ops: [
            {
              kind: "patch",
              id: f.id,
              next: { content: { kind: "derived", expr: "" } },
            },
          ],
        },
        { propose: () => ({ selection: nextSel, effects }) },
      );

      return { didChange: true, selection: nextSel, effects };
    });
  },

  commitHeaderField(
    editor: Editor,
    f: Focus,
    fieldKey: string,
    text: string,
  ): CmdResult {
    return tryCmd(() => {
      const store = editor.store;
      const info = store.sel.item(f.id);

      if (fieldKey === "derived.expr") {
        editor.apply({
          ops: [
            {
              kind: "patch",
              id: f.id,
              next: { content: { kind: "derived", expr: text } },
            },
          ],
        });
        return { didChange: true };
      }

      if (info.contentKind === "lens" && info.lensSpec) {
        const cur = info.lensSpec;
        const next = {
          from: fieldKey === "lens.from" ? text : cur.from,
          where: fieldKey === "lens.where" ? text : cur.where,
          orderBy: fieldKey === "lens.orderBy" ? text : cur.orderBy,
        };
        editor.apply({
          ops: [
            {
              kind: "patch",
              id: f.id,
              next: { content: { kind: "lens", ...next } },
            },
          ],
        });
        return { didChange: true };
      }

      return { didChange: false };
    });
  },

  insertSibling(
    editor: Editor,
    sel: Selection,
    side: "before" | "after",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      const loc = store.sel.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const at = side === "before" ? loc.index : loc.index + 1;

      const id = store.allocId();
      const txn: Txn = {
        ops: [
          { kind: "create", item: store.make.blank(id) },
          {
            kind: "reparent",
            spec: { childId: id, toOwnerId: loc.ownerId, toIndex: at },
          },
        ],
      };

      const nextFocus: Focus = { containerId: f.containerId, id };
      const res = mkFocusSelection(nextFocus, { kind: "content" }, 0);

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    });
  },

  splitAt(
    editor: Editor,
    sel: Selection,
    caretStart: number,
    caretEnd = caretStart,
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      if (!store.sel.canEditScalarText(f.id))
        return treeCommands.insertSibling(editor, sel, "after");

      const loc = store.sel.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const curText = getEditableText(store, f.id).text;
      const len = curText.length;
      const start = clamp(caretStart, 0, len);
      const end = clamp(caretEnd, 0, len);

      const left = curText.slice(0, start);
      const right = curText.slice(end);

      const rightId = store.allocId();

      const txn: Txn = {
        ops: [
          {
            kind: "patch",
            id: f.id,
            next: { content: { kind: "scalar", value: parseScalar(left) } },
          },
          { kind: "create", item: store.make.blank(rightId) },
          {
            kind: "reparent",
            spec: {
              childId: rightId,
              toOwnerId: loc.ownerId,
              toIndex: loc.index + 1,
            },
          },
          {
            kind: "patch",
            id: rightId,
            next: { content: { kind: "scalar", value: parseScalar(right) } },
          },
        ],
      };

      const nextFocus: Focus = { containerId: f.containerId, id: rightId };
      const res = mkFocusSelection(nextFocus, { kind: "content" }, 0);

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    });
  },

  joinBoundary(
    editor: Editor,
    sel: Selection,
    dir: "backward" | "forward",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      if (!store.sel.canEditScalarText(f.id)) return { didChange: false };

      const loc = store.sel.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const i = loc.index;
      const neighborId =
        dir === "backward" ? loc.items[i - 1] : loc.items[i + 1];
      if (neighborId == null) return { didChange: false };
      if (!store.sel.canEditScalarText(neighborId)) return { didChange: false };

      const a = getEditableText(
        store,
        dir === "backward" ? neighborId : f.id,
      ).text;
      const b = getEditableText(
        store,
        dir === "backward" ? f.id : neighborId,
      ).text;
      const merged = a + b;

      const survivorId = dir === "backward" ? neighborId : f.id;
      const removedId = dir === "backward" ? f.id : neighborId;

      const caret = a.length;

      const txn: Txn = {
        ops: [
          {
            kind: "patch",
            id: survivorId,
            next: { content: { kind: "scalar", value: parseScalar(merged) } },
          },
          { kind: "reparent", spec: { childId: removedId, toOwnerId: null } },
        ],
      };

      const nextFocus: Focus = { containerId: f.containerId, id: survivorId };
      const res = mkFocusSelection(nextFocus, { kind: "content" }, caret);

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    });
  },

  removeItem(
    editor: Editor,
    sel: Selection,
    prefer: "prev" | "next",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      const loc = store.sel.locateInOwner(f.id);
      if (!loc) return { didChange: false };

      const prevId = loc.items[loc.index - 1] ?? null;
      const nextId = loc.items[loc.index + 1] ?? null;

      const chosen =
        prefer === "prev"
          ? (prevId ?? nextId ?? loc.ownerId)
          : (nextId ?? prevId ?? loc.ownerId);

      const containerKids = store.sel.groupItems(f.containerId);
      const nextFocus: Focus = containerKids.includes(chosen as ItemId)
        ? { containerId: f.containerId, id: chosen as ItemId }
        : { containerId: loc.ownerId, id: chosen as ItemId };

      const target = defaultTargetFor(store, nextFocus.id);
      const res = mkFocusSelection(nextFocus, target, 0);

      const txn: Txn = {
        ops: [{ kind: "reparent", spec: { childId: f.id, toOwnerId: null } }],
      };

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    });
  },

  changeNesting(editor: Editor, sel: Selection, dir: "in" | "out"): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    return tryCmd(() => {
      if (dir === "in") {
        const loc = store.sel.locateInOwner(f.id);
        if (!loc) return { didChange: false };

        const childInfo = store.sel.item(f.id);
        const wrapperId = store.allocId();
        const wrapper = store.make.group(wrapperId);

        const txn: Txn = {
          ops: [
            { kind: "create", item: { ...wrapper, label: childInfo.label } },
            {
              kind: "reparent",
              spec: {
                childId: wrapperId,
                toOwnerId: loc.ownerId,
                toIndex: loc.index,
              },
            },
            { kind: "patch", id: f.id, next: { label: "" } },
            {
              kind: "reparent",
              spec: { childId: f.id, toOwnerId: wrapperId, toIndex: 0 },
            },
          ],
        };

        const nextFocus: Focus = { containerId: wrapperId, id: f.id };
        const target = defaultTargetFor(store, nextFocus.id);
        const res = mkFocusSelection(nextFocus, target, 0);

        editor.apply(txn, {
          propose: () => ({ selection: res.selection, effects: res.effects }),
        });

        return {
          didChange: true,
          selection: res.selection,
          effects: res.effects,
        };
      }

      const child = store.sel.item(f.id);
      const wrapperId = child.ownerId;
      if (wrapperId == null) return { didChange: false };

      const wrapper = store.sel.item(wrapperId);
      if (wrapper.contentKind !== "group") return { didChange: false };

      const kids = store.sel.groupItems(wrapperId);
      if (kids.length !== 1 || kids[0] !== f.id) return { didChange: false };

      const ownerId = wrapper.ownerId;
      if (ownerId == null) return { didChange: false };

      const ownerKids = store.sel.groupItems(ownerId);
      const idx = ownerKids.indexOf(wrapperId);
      if (idx < 0) return { didChange: false };

      const txn: Txn = {
        ops: [
          {
            kind: "reparent",
            spec: { childId: f.id, toOwnerId: ownerId, toIndex: idx },
          },
          { kind: "reparent", spec: { childId: wrapperId, toOwnerId: null } },
          { kind: "patch", id: f.id, next: { label: wrapper.label } },
          {
            kind: "patch",
            id: wrapperId,
            next: { label: "", content: { kind: "blank" } },
          },
        ],
      };

      const nextFocus: Focus = { containerId: ownerId, id: f.id };
      const target = defaultTargetFor(store, nextFocus.id);
      const res = mkFocusSelection(nextFocus, target, 0);

      editor.apply(txn, {
        propose: () => ({ selection: res.selection, effects: res.effects }),
      });

      return {
        didChange: true,
        selection: res.selection,
        effects: res.effects,
      };
    });
  },

  confirm(editor: Editor, sel: Selection): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;
    const t = sel.target;

    if (t.kind === "header") {
      const res = mkFocusSelection(f, { kind: "content" }, 0);
      return {
        didChange: false,
        selection: res.selection,
        effects: res.effects,
      };
    }

    return store.sel.canEditScalarText(f.id)
      ? treeCommands.splitAt(editor, sel, 0, 0)
      : treeCommands.insertSibling(editor, sel, "after");
  },

  deleteBoundary(
    editor: Editor,
    sel: Selection,
    dir: "backward" | "forward",
  ): CmdResult {
    if (sel.kind !== "focused") return { didChange: false };
    const store = editor.store;
    const f = sel.focus;

    if (store.sel.canEditScalarText(f.id)) {
      const txt = getEditableText(store, f.id).text;
      if (txt.length === 0) {
        return treeCommands.removeItem(
          editor,
          sel,
          dir === "backward" ? "prev" : "next",
        );
      }
      return treeCommands.joinBoundary(editor, sel, dir);
    }

    return treeCommands.removeItem(
      editor,
      sel,
      dir === "backward" ? "prev" : "next",
    );
  },
} as const;

type NavDir = "left" | "right" | "up" | "down";
type NavMode = "step" | "jump";

function hasHeaderFields(store: Store, id: ItemId): boolean {
  const it = store.sel.item(id);
  return it.contentKind === "derived" || it.contentKind === "lens";
}

function isNavStop(store: Store, id: ItemId): boolean {
  const kids = store.sel.groupItems(id);
  return kids.length === 0 || hasHeaderFields(store, id);
}

function defaultTargetFor(store: Store, id: ItemId): FocusTarget {
  return hasHeaderFields(store, id)
    ? { kind: "header", index: 1 }
    : { kind: "content" };
}

function focusKey(f: Focus) {
  return `${String(f.containerId)}::${String(f.id)}`;
}

function collectNavStopsFrom(store: Store, containerId: ItemId): Focus[] {
  const out: Focus[] = [];
  const walk = (ownerId: ItemId) => {
    const kids = store.sel.groupItems(ownerId);
    for (const id of kids) {
      if (isNavStop(store, id)) out.push({ containerId: ownerId, id });
      walk(id);
    }
  };
  walk(containerId);
  return out;
}

function neighborNavStop(store: Store, from: Focus, dir: -1 | 1): Focus | null {
  const stops = collectNavStopsFrom(store, store.getRoot());
  const key = focusKey(from);
  const i = stops.findIndex((s) => focusKey(s) === key);
  if (i < 0) return null;
  const j = i + dir;
  return j >= 0 && j < stops.length ? stops[j]! : null;
}

function parentFocus(store: Store, f: Focus): Focus | null {
  const it = store.sel.item(f.containerId);
  const ownerId = it.ownerId;
  return ownerId == null ? null : { containerId: ownerId, id: f.containerId };
}

function firstChildStop(store: Store, id: ItemId): Focus | null {
  const kids = store.sel.groupItems(id);
  for (const cid of kids) {
    if (isNavStop(store, cid)) return { containerId: id, id: cid };
    const deeper = firstChildStop(store, cid);
    if (deeper) return deeper;
  }
  return null;
}

function firstNavStop(store: Store, rootContainerId: ItemId): Focus | null {
  return firstChildStop(store, rootContainerId);
}

function treeNavMove(
  store: Store,
  sel: Selection,
  dir: NavDir,
  mode: NavMode,
): { selection: Selection; effects: EditorEffect[] } | null {
  if (sel.kind !== "focused") return null;

  const from = sel.focus;
  const sign: -1 | 1 = dir === "up" || dir === "left" ? -1 : 1;

  let next: Focus | null = null;

  if (dir === "up" || dir === "down") {
    next = neighborNavStop(store, from, sign);
  } else if (dir === "right") {
    next = firstChildStop(store, from.id) ?? neighborNavStop(store, from, 1);
    if (mode === "jump") next = neighborNavStop(store, from, 1) ?? next;
  } else if (dir === "left") {
    next = parentFocus(store, from) ?? neighborNavStop(store, from, -1);
    if (mode === "jump") next = neighborNavStop(store, from, -1) ?? next;
  }

  if (!next) return null;

  const target = defaultTargetFor(store, next.id);
  const res = mkFocusSelection(next, target, 0);
  return { selection: res.selection, effects: res.effects };
}

type ItemRenderCtx = {
  editor: Editor;
  rootId: ItemId;
  regionId: string;
};

type HeaderFieldDef = Readonly<{
  key: string;
  label: string;
  multiline: boolean;
}>;

function headerFieldsFor(store: Store, id: ItemId): readonly HeaderFieldDef[] {
  const it = store.sel.item(id);

  if (it.contentKind === "derived") {
    return [{ key: "derived.expr", label: "=", multiline: true }] as const;
  }
  if (it.contentKind === "lens") {
    return [
      { key: "lens.from", label: "~", multiline: false },
      { key: "lens.where", label: "where:", multiline: true },
      { key: "lens.orderBy", label: "orderBy:", multiline: true },
    ] as const;
  }
  return [] as const;
}

function contentMode(
  store: Store,
  id: ItemId,
): "text" | "readonly-text" | "item-group" | "value-group" {
  const v = store.sel.value(id);
  if (v.kind === "item-group") return "item-group";
  if (v.kind === "value-group") return "value-group";
  return store.sel.canEditScalarText(id) ? "text" : "readonly-text";
}

function ensureTabbable(elm: HTMLElement) {
  const anyEl = elm as any;
  if (anyEl.tabIndex == null || anyEl.tabIndex < 0) anyEl.tabIndex = 0;
}

class ItemView {
  element: HTMLElement;

  private headerEl = el("div", "header");
  private labelWrap = el("div", "autosize label");
  private labelMirror = el("span", "", "");
  private labelInput = textInput(false);

  private headerFieldsWrap = el("div", "header-fields");
  private contentHost = el("div", "content-host");

  private childMgr: ChildManager<ItemId> | null = null;
  private mounted: ReturnType<typeof replaceMountedRegion> | null = null;

  private headerInputs: (HTMLInputElement | HTMLTextAreaElement)[] = [];
  private contentTarget: HTMLElement = this.contentHost;

  private binding: Binding;

  private cleanup = new CleanupBag();
  private contentCleanup = new CleanupBag();
  private labelBound = false;

  constructor(
    private ctx: ItemRenderCtx,
    private focus: Focus,
    private opts: { showHeader: boolean },
  ) {
    this.element = el("div", "item");

    this.labelMirror.setAttribute("aria-hidden", "true");
    this.labelWrap.append(this.labelMirror, this.labelInput as any);

    this.headerEl.append(this.labelWrap, this.headerFieldsWrap);
    this.element.append(this.contentHost);

    this.binding = {
      focus: { ...focus },
      elementFor: (target: FocusTarget) => {
        if (target.kind === "content") return this.contentTarget ?? null;
        if (target.kind === "header")
          return this.headerInputs[target.index] ?? null;
        return null;
      },
      setCaret: (pos: number) => {
        const sel = this.ctx.editor.runtime.selection.value;
        const t =
          sel.kind === "focused"
            ? sel.target
            : ({ kind: "content" } as FocusTarget);
        const el2 = this.binding.elementFor(t) as any;
        if (
          el2 instanceof HTMLInputElement ||
          el2 instanceof HTMLTextAreaElement
        )
          el2.setSelectionRange(pos, pos);
      },
      getTextLength: () => {
        const sel = this.ctx.editor.runtime.selection.value;
        const t =
          sel.kind === "focused"
            ? sel.target
            : ({ kind: "content" } as FocusTarget);
        const el2 = this.binding.elementFor(t) as any;
        if (
          el2 instanceof HTMLInputElement ||
          el2 instanceof HTMLTextAreaElement
        )
          return el2.value.length;
        return 0;
      },
    };

    this.ctx.editor.runtime.registerBinding(this.binding);

    this.cleanup.add(
      effect(() => {
        const store = this.ctx.editor.store;
        const id = this.focus.id;

        const it = store.sel.item(id);
        const v = store.sel.value(id);
        const mode = contentMode(store, id);
        const headerDefs = headerFieldsFor(store, id);
        const label = it.label ?? "";
        const viewId = it.view || "";

        const sel = this.ctx.editor.runtime.selection.value;
        const focused =
          sel.kind === "focused" &&
          focusKey(sel.focus) === focusKey(this.focus);

        const labelFocused =
          focused &&
          sel.kind === "focused" &&
          sel.target.kind === "header" &&
          sel.target.index === 0;

        const needHeader =
          this.opts.showHeader &&
          (label.trim() !== "" || headerDefs.length > 0 || labelFocused);

        this.reconcileHeader(needHeader, label, headerDefs, it, labelFocused);
        this.reconcileContent(mode, v, viewId);
        this.reconcileBinding(needHeader, headerDefs.length);

        this.element.classList.toggle("focused", focused);
        this.labelWrap.classList.toggle(
          "hidden",
          label.trim() === "" && !labelFocused,
        );
        this.contentHost.classList.toggle("issue", v.kind === "issue");
      }),
    );
  }

  dispose() {
    this.unmountChildRegion();
    this.childMgr?.dispose();
    this.childMgr = null;

    this.contentCleanup.run();
    this.ctx.editor.runtime.unregisterBinding(this.focus);

    this.cleanup.run();
    this.element.replaceChildren();
  }

  private setFocusedSelection(target: FocusTarget) {
    const res = mkFocusSelection(this.focus, target, 0);
    this.ctx.editor.setSelection(res.selection, res.effects);
  }

  private reconcileHeader(
    needHeader: boolean,
    labelText: string,
    defs: readonly HeaderFieldDef[],
    info: ReturnType<Store["sel"]["item"]>,
    labelFocused: boolean,
  ) {
    if (needHeader) {
      if (this.element.firstChild !== this.headerEl)
        this.element.insertBefore(this.headerEl, this.contentHost);
    } else {
      if (this.headerEl.parentElement === this.element) this.headerEl.remove();
    }

    syncValue(this.labelInput as any, labelText);
    this.labelMirror.textContent = labelText.length ? labelText : " ";

    if (!this.labelBound) {
      this.labelBound = true;

      this.contentCleanup.add(
        bindCommitTextInput(this.labelInput as any, {
          commit: (text) =>
            treeCommands.commitLabel(this.ctx.editor, this.focus, text),
        }),
      );

      this.contentCleanup.add(
        on(this.labelInput as any, "keydown", (e: any) => {
          if (e.key === " ") {
            e.preventDefault();
            return;
          }
          if (e.key === "Enter" || e.key === "Escape" || e.key === "Tab") {
            e.preventDefault();
            e.stopPropagation();
            const res = mkFocusSelection(this.focus, { kind: "content" }, 0);
            this.ctx.editor.setSelection(res.selection, res.effects);
          }
        }),
      );

      this.contentCleanup.add(
        on(this.labelInput as any, "mousedown", (e: any) => {
          this.setFocusedSelection({ kind: "header", index: 0 });
          e.stopPropagation();
        }),
      );
    }

    this.headerFieldsWrap.replaceChildren();
    this.headerInputs = [];

    if (needHeader) {
      this.headerInputs.push(this.labelInput as any);

      for (let i = 0; i < defs.length; i++) {
        const d = defs[i]!;
        const wrap = el("div", "wrap");
        const lab = el("span", "equals");
        lab.textContent = d.label;
        const inp = textInput(d.multiline);

        syncValue(inp, headerFieldValue(info, d.key));

        this.contentCleanup.add(
          bindCommitTextInput(inp, {
            commit: (text) =>
              treeCommands.commitHeaderField(
                this.ctx.editor,
                this.focus,
                d.key,
                text,
              ),
          }),
        );

        this.contentCleanup.add(
          on(inp, "keydown", (e: any) => {
            if ((e.key === "Enter" && !e.shiftKey) || e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              const res = mkFocusSelection(this.focus, { kind: "content" }, 0);
              this.ctx.editor.setSelection(res.selection, res.effects);
            }
          }),
        );

        const headerIndex = i + 1;
        this.contentCleanup.add(
          on(inp, "mousedown", (e: any) => {
            this.setFocusedSelection({ kind: "header", index: headerIndex });
            e.stopPropagation();
          }),
        );

        wrap.append(lab, inp);
        this.headerFieldsWrap.append(wrap);
        this.headerInputs.push(inp);
      }
    }

    this.labelWrap.classList.toggle(
      "hidden",
      labelText.trim() === "" && !labelFocused,
    );
  }

  private reconcileContent(
    mode: ReturnType<typeof contentMode>,
    v: Value,
    viewId: string,
  ) {
    this.contentCleanup.run();

    if (viewId === "table") return void this.mountChildRegion("table");
    if (viewId === "slider") return void this.mountChildRegion("slider");
    this.unmountChildRegion();

    const bindContentClick = (host: HTMLElement) => {
      ensureTabbable(host);
      this.contentCleanup.add(
        on(host, "mousedown", (e: any) => {
          this.setFocusedSelection({ kind: "content" });
          e.stopPropagation();
        }),
      );
    };

    if (mode === "item-group") {
      const wrap = el("div", "group");
      this.contentHost.replaceChildren(wrap);

      if (!this.childMgr) {
        this.childMgr = new ChildManager<ItemId>(wrap, (id) => {
          return new ItemView(
            this.ctx,
            { containerId: this.focus.id, id },
            { showHeader: true },
          );
        });
      } else {
        this.childMgr.setContainer(wrap);
      }

      this.childMgr.update(v.kind === "item-group" ? v.items : []);

      this.contentTarget = wrap;
      bindContentClick(wrap);
      return;
    }

    if (mode === "value-group") {
      const wrap = el("div", "group readonly");
      this.contentHost.replaceChildren(wrap);

      if (v.kind === "value-group") {
        for (const it of v.items)
          wrap.append(renderLabeledValueReadonly(it.label, it.value));
      }

      this.contentTarget = wrap;
      bindContentClick(wrap);
      return;
    }

    const inp = textInput(true);
    inp.classList.add("content");

    const store = this.ctx.editor.store;
    const editable = getEditableText(store, this.focus.id);
    const display = getDisplayText(store.sel.value(this.focus.id));

    syncValue(inp, editable.kind === "editable" ? editable.text : display.text);
    inp.readOnly = editable.kind !== "editable";

    this.contentCleanup.add(
      bindCommitTextInput(inp, {
        commit: (text) => {
          const store2 = this.ctx.editor.store;
          if (!store2.sel.canEditScalarText(this.focus.id)) return;
          this.ctx.editor.apply({
            ops: [
              {
                kind: "patch",
                id: this.focus.id,
                next: { content: { kind: "scalar", value: parseScalar(text) } },
              },
            ],
          });
        },
      }),
    );

    this.contentCleanup.add(
      on(inp, "blur", () => {
        const store2 = this.ctx.editor.store;
        if (!store2.sel.canEditScalarText(this.focus.id)) return;
        this.ctx.editor.apply({
          ops: [
            {
              kind: "patch",
              id: this.focus.id,
              next: {
                content: { kind: "scalar", value: parseScalar(inp.value) },
              },
            },
          ],
        });
      }),
    );

    this.contentCleanup.add(
      on(inp, "mousedown", (e: any) => {
        this.setFocusedSelection({ kind: "content" });
        e.stopPropagation();
      }),
    );

    this.contentCleanup.add(
      on(inp, "keydown", (e: any) => {
        const mod = e.metaKey || e.ctrlKey;
        const caret = inp.selectionStart ?? 0;
        const end = inp.selectionEnd ?? caret;
        const hasSel = caret !== end;

        const run = (res: CmdResult) => {
          if (res.selection)
            this.ctx.editor.setSelection(res.selection, res.effects ?? []);
        };

        if (e.key === "=" && !inp.value) {
          e.preventDefault();
          e.stopPropagation();
          return void run(treeCommands.setDerived(this.ctx.editor, this.focus));
        }

        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          return void run(
            treeCommands.splitAt(
              this.ctx.editor,
              this.ctx.editor.runtime.selection.value,
              caret,
              end,
            ),
          );
        }

        if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          return void run(
            treeCommands.changeNesting(
              this.ctx.editor,
              this.ctx.editor.runtime.selection.value,
              e.shiftKey ? "out" : "in",
            ),
          );
        }

        if (e.key === "Backspace" && !hasSel && caret === 0) {
          e.preventDefault();
          e.stopPropagation();
          return void run(
            treeCommands.deleteBoundary(
              this.ctx.editor,
              this.ctx.editor.runtime.selection.value,
              "backward",
            ),
          );
        }

        if (e.key === "Delete" && !hasSel && caret === inp.value.length) {
          e.preventDefault();
          e.stopPropagation();
          return void run(
            treeCommands.deleteBoundary(
              this.ctx.editor,
              this.ctx.editor.runtime.selection.value,
              "forward",
            ),
          );
        }

        if (
          e.key === "ArrowUp" ||
          e.key === "ArrowDown" ||
          e.key === "ArrowLeft" ||
          e.key === "ArrowRight"
        ) {
          const dir =
            e.key === "ArrowUp"
              ? "up"
              : e.key === "ArrowDown"
                ? "down"
                : e.key === "ArrowLeft"
                  ? "left"
                  : "right";

          const len = inp.value.length;
          const atStart = caret === 0 && end === 0;
          const atEnd = caret === len && end === len;

          const atBoundary =
            (dir === "left" && atStart) ||
            (dir === "right" && atEnd) ||
            dir === "up" ||
            dir === "down";

          if (mod || atBoundary) {
            e.preventDefault();
            e.stopPropagation();
            const res = treeNavMove(
              this.ctx.editor.store,
              this.ctx.editor.runtime.selection.value,
              dir as any,
              mod ? "jump" : "step",
            );
            if (res) this.ctx.editor.setSelection(res.selection, res.effects);
          }
        }

        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          const res = mkFocusSelection(this.focus, { kind: "content" }, 0);
          this.ctx.editor.setSelection(res.selection, res.effects);
        }
      }),
    );

    this.contentHost.replaceChildren(inp);
    this.contentTarget = inp;
  }

  private reconcileBinding(needHeader: boolean, headerFieldCount: number) {
    const mountedRoot = this.mounted?.region?.root as HTMLElement | undefined;

    this.contentTarget =
      mountedRoot ??
      this.contentTarget ??
      (this.contentHost.firstElementChild as HTMLElement) ??
      this.contentHost;

    ensureTabbable(this.contentTarget);

    if (!needHeader) {
      this.headerInputs = [];
    } else {
      this.headerInputs = this.headerInputs.slice(0, 1 + headerFieldCount);
    }

    this.ctx.editor.runtime.registerBinding(this.binding);
  }

  private mountChildRegion(kind: "table" | "slider") {
    const id = this.focus.id;
    const focus: Focus = {
      containerId: this.focus.containerId,
      id: this.focus.id,
    };

    const region =
      kind === "table"
        ? createTableRegion({ editor: this.ctx.editor }, id, focus)
        : createSliderRegion({ editor: this.ctx.editor }, id, focus);

    this.mounted = replaceMountedRegion(
      this.ctx.editor.runtime,
      this.contentHost,
      this.mounted,
      region,
    );

    if (this.mounted) {
      this.contentTarget = this.mounted.region.root;

      this.contentCleanup.add(
        on(this.mounted.region.root, "mousedown", (e: any) => {
          this.setFocusedSelection({ kind: "content" });
          e.stopPropagation();
        }),
      );
    }
  }

  private unmountChildRegion() {
    if (!this.mounted) return;
    this.mounted.unmount();
    this.mounted = null;
  }
}

function headerFieldValue(
  info: ReturnType<Store["sel"]["item"]>,
  key: string,
): string {
  if (info.contentKind === "derived") {
    if (key === "derived.expr") return info.derivedExpr ?? "";
  }
  if (info.contentKind === "lens") {
    if (key === "lens.from") return info.lensSpec?.from ?? "";
    if (key === "lens.where") return info.lensSpec?.where ?? "";
    if (key === "lens.orderBy") return info.lensSpec?.orderBy ?? "";
  }
  return "";
}
