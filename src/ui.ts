import { computed, effect } from "@preact/signals-core";
import type { Store, ItemId, Scalar, StoredContent, Value } from "./store";
import type { Editor, Focus, FocusTarget } from "./editor";

export function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function on<T extends HTMLElement, K extends keyof HTMLElementEventMap>(
  el: T,
  type: K,
  handler: (e: HTMLElementEventMap[K]) => void,
  opts?: AddEventListenerOptions,
) {
  el.addEventListener(type, handler as any, opts);
  return () => el.removeEventListener(type, handler as any, opts as any);
}

export function textInput(
  multiline: boolean,
): HTMLInputElement | HTMLTextAreaElement {
  const n = document.createElement(multiline ? "textarea" : "input") as
    | HTMLInputElement
    | HTMLTextAreaElement;

  if (n instanceof HTMLInputElement) n.type = "text";
  n.autocapitalize = "off";
  n.autocomplete = "off";
  n.autocorrect = "off" as any;
  n.spellcheck = false;
  if (n instanceof HTMLTextAreaElement) n.rows = 1;
  return n;
}

export function syncValue(
  inp: HTMLInputElement | HTMLTextAreaElement,
  text: string,
) {
  if (inp.value !== text) inp.value = text;
}

export function syncText(el: HTMLElement, text: string) {
  if (el.textContent !== text) el.textContent = text;
}

export const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));

export function reconcileChildren(parent: HTMLElement, desired: HTMLElement[]) {
  for (let i = 0; i < desired.length; i++) {
    const child = desired[i];
    const cur = parent.children[i];
    if (cur !== child) parent.insertBefore(child, cur || null);
  }
  while (parent.children.length > desired.length) {
    parent.lastElementChild?.remove();
  }
}

type ChildRec = { element: HTMLElement; dispose: () => void };

export class ChildManager<Id extends string | number> {
  private cache = new Map<Id, ChildRec>();

  constructor(
    private container: HTMLElement,
    private create: (id: Id) => { element: HTMLElement; dispose(): void },
  ) {}

  setContainer(next: HTMLElement) {
    if (this.container === next) return;
    for (const { element } of this.cache.values()) next.append(element);
    this.container = next;
  }

  update(ids: Id[]) {
    const keep = new Set(ids);

    for (const [id, rec] of this.cache) {
      if (!keep.has(id)) {
        rec.dispose();
        this.cache.delete(id);
      }
    }

    const desired = ids.map((id) => {
      let rec = this.cache.get(id);
      if (!rec) {
        const v = this.create(id);
        rec = { element: v.element, dispose: v.dispose.bind(v) };
        this.cache.set(id, rec);
      }
      return rec.element;
    });

    reconcileChildren(this.container, desired);
  }

  dispose() {
    for (const rec of this.cache.values()) rec.dispose();
    this.cache.clear();
  }
}

export class CleanupBag {
  private fns: (() => void)[] = [];

  add(fn: (() => void) | null | undefined) {
    if (!fn) return fn ?? undefined;
    this.fns.push(fn);
    return fn;
  }

  run() {
    for (const fn of this.fns.toReversed()) fn();
    this.fns = [];
  }
}

const NUM_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function parseScalar(text: string): Scalar {
  const t = text.trim();
  if (NUM_RE.test(t)) {
    const n = Number(t);
    if (Number.isFinite(n)) return n;
  }
  if (t === "true") return true;
  return text;
}

export type DisplayText =
  | { kind: "blank"; text: "" }
  | { kind: "issue"; text: string }
  | { kind: "scalar"; text: string }
  | { kind: "other"; text: string };

export function getDisplayText(v: Value): DisplayText {
  switch (v.kind) {
    case "blank":
      return { kind: "blank", text: "" };
    case "issue":
      return { kind: "issue", text: v.message };
    case "scalar":
      return { kind: "scalar", text: String(v.value) };
    default:
      return { kind: "other", text: "" };
  }
}

export type EditableText =
  | { kind: "editable"; text: string }
  | { kind: "readonly"; text: string };

function storedScalarTextForEdit(
  store: Store,
  id: ItemId,
): { kind: "editable"; text: string } | null {
  const it = store.sel.item(id);
  if (!it.contentSettable) return null;

  if (it.contentKind === "blank") return { kind: "editable", text: "" };

  if (it.contentKind === "scalar") {
    const c = it.content as Extract<StoredContent, { kind: "scalar" }>;
    return { kind: "editable", text: String(c.value) };
  }

  return null;
}

export function getEditableText(store: Store, id: ItemId): EditableText {
  return (
    storedScalarTextForEdit(store, id) ?? {
      kind: "readonly",
      text: getDisplayText(store.sel.value(id)).text,
    }
  );
}

export type EditableModel = {
  kind: "editable" | "readonly";
  text: string;
  display: DisplayText;
};

export function getEditableModel(store: Store, id: ItemId): EditableModel {
  const editable = getEditableText(store, id);
  const display = getDisplayText(store.sel.value(id));
  return {
    kind: editable.kind === "editable" ? "editable" : "readonly",
    text: editable.kind === "editable" ? editable.text : display.text,
    display,
  };
}

export const displayText = (v: Value) => getDisplayText(v).text;

export const scalarTextForEdit = (store: Store, id: ItemId) =>
  getEditableText(store, id).text;

export function renderValueReadonly(v: Value): HTMLElement {
  if (v.kind === "blank") return el("div", "item readonly");
  if (v.kind === "issue") {
    const d = el("div", "item readonly issue");
    d.textContent = v.message;
    return d;
  }
  if (v.kind === "scalar") {
    const d = el("div", "item readonly");
    d.textContent = String(v.value);
    return d;
  }
  if (v.kind === "item-group") {
    const d = el("div", "item readonly issue");
    d.textContent = "[item-group]";
    return d;
  }

  const wrap = el("div", "group readonly");
  for (const it of v.items)
    wrap.append(renderLabeledValueReadonly(it.label, it.value));
  return wrap;
}

export function renderLabeledValueReadonly(
  label: string | undefined,
  v: Value,
): HTMLElement {
  if (!label) return renderValueReadonly(v);
  const row = el("div", "row readonly");
  const lab = el("div", "label");
  lab.textContent = label;
  const val = renderValueReadonly(v);
  val.classList.add("item");
  row.append(lab, val);
  return row;
}

export type CommitBindingOpts = {
  commit: (text: string) => void;
};

export function bindCommitTextInput(
  inp: HTMLInputElement | HTMLTextAreaElement,
  opts: CommitBindingOpts,
): () => void {
  const onInput = () => opts.commit(inp.value);
  const onBlur = () => opts.commit(inp.value);

  inp.addEventListener("input", onInput);
  inp.addEventListener("blur", onBlur);

  return () => {
    inp.removeEventListener("input", onInput);
    inp.removeEventListener("blur", onBlur);
  };
}

export function bindReadonlyItemText(
  el0: HTMLElement,
  store: Store,
  id: ItemId,
): () => void {
  const sig = computed(() => {
    const v = store.sel.value(id);
    return { text: getDisplayText(v).text, isIssue: v.kind === "issue" };
  });

  const stop = effect(() => {
    const cur = sig.value;
    el0.textContent = cur.text;
    el0.classList.toggle("issue", cur.isIssue);
  });

  return () => {
    stop();
    el0.replaceChildren();
  };
}

export type ScalarEditBindingOpts = {
  editor: Editor;
  id: ItemId;
  commit?: (text: string) => void;
};

export function bindScalarTextInput(
  inp: HTMLInputElement | HTMLTextAreaElement,
  opts: ScalarEditBindingOpts,
): () => void {
  const bag = new CleanupBag();
  const { editor, id } = opts;

  const doCommit =
    opts.commit ??
    ((text: string) => {
      if (!editor.store.sel.canEditScalarText(id)) return;
      editor.apply({
        ops: [
          {
            kind: "patch",
            id,
            next: { content: { kind: "scalar", value: parseScalar(text) } },
          },
        ],
      });
    });

  bag.add(
    bindCommitTextInput(inp, {
      commit: (text) => doCommit(text),
    }),
  );

  bag.add(
    effect(() => {
      const store = editor.store;
      const m = getEditableModel(store, id);
      inp.readOnly = m.kind !== "editable";
      inp.classList.toggle("issue", m.display.kind === "issue");
      syncValue(inp, m.text);
    }),
  );

  return () => bag.run();
}

export function bindFocusOnMouseDown(
  host: HTMLElement,
  editor: Editor,
  focus: Focus,
  target: FocusTarget,
  opts: { stopPropagation?: boolean } = {},
): () => void {
  return on(host, "mousedown", (e: MouseEvent) => {
    const res = editor.runtime ? editor.runtime : (null as unknown as never);

    void res;

    const { mkFocusSelection } =
      require("./editor") as typeof import("./editor");
    const out = mkFocusSelection(focus, target, 0);
    editor.setSelection(out.selection, out.effects);
    if (opts.stopPropagation !== false) e.stopPropagation();
  });
}
