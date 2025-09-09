import { Signal, effect } from "@preact/signals-core";

export type DataNode = Signal<DataNode[] | string>;

type Mount = { el: HTMLElement; dispose: () => void };

export function render(data: DataNode, root: HTMLElement): () => void {
  const { el, dispose } = mountNode(data);
  root.appendChild(el);

  const onKey = (e: KeyboardEvent) => {
    const a = document.activeElement as HTMLElement | null;
    if (!a || !root.contains(a)) return;

    const t =
      e.key === "ArrowUp"
        ? (a.previousElementSibling as HTMLElement | null)
        : e.key === "ArrowDown"
        ? (a.nextElementSibling as HTMLElement | null)
        : e.key === "ArrowLeft"
        ? a.parentElement !== root
          ? (a.parentElement as HTMLElement)
          : null
        : e.key === "ArrowRight"
        ? (a.firstElementChild as HTMLElement | null)
        : null;

    if (t) {
      e.preventDefault();
      t.focus();
    }
  };

  root.addEventListener("keydown", onKey);

  return () => {
    dispose();
    root.removeEventListener("keydown", onKey);
    root.textContent = "";
  };
}

function mountNode(node: DataNode): Mount {
  let el!: HTMLElement;
  let mode: "array" | "text" | null = null;

  const children = new Map<DataNode, Mount>();

  const clearChildren = () => {
    for (const m of children.values()) m.dispose();
    children.clear();
    el.textContent = "";
  };

  const setMode = (next: "array" | "text") => {
    if (mode === next) return;
    const nextEl = document.createElement(next === "array" ? "div" : "p");
    nextEl.tabIndex = 0;
    if (mode === "array") clearChildren();
    if (el) el.replaceWith(nextEl);
    el = nextEl;
    mode = next;
  };

  const stop = effect(() => {
    const v = node.value;
    if (Array.isArray(v)) {
      setMode("array");
      const nextSet = new Set(v);
      for (const [sig, m] of children) {
        if (!nextSet.has(sig)) {
          m.dispose();
          m.el.remove();
          children.delete(sig);
        }
      }
      const frag = document.createDocumentFragment();
      for (const sig of v) {
        let m = children.get(sig);
        if (!m) {
          m = mountNode(sig);
          children.set(sig, m);
        }
        frag.appendChild(m.el);
      }
      el.appendChild(frag);
    } else {
      setMode("text");
      el.textContent = v;
    }
  });

  const dispose = () => {
    stop();
    clearChildren();
  };

  return { el, dispose };
}

import { signal } from "@preact/signals-core";

// const leaf1 = signal<DataNode[] | string>("hello");
// const leaf2 = signal<DataNode[] | string>("world");
// const parent = signal<DataNode[] | string>([leaf1, leaf2]);

const parent = signal([
  signal([signal("hi"), signal("there")]),
  signal("world"),
]);

const unmount = render(parent, document.getElementById("root")!);

// setTimeout(() => {
//   leaf1.value = "hi";
// }, 2000);
// setTimeout(() => {
//   parent.value = [leaf2, leaf1];
// }, 4000);
// setTimeout(() => {
//   parent.value = [leaf1];
// }, 6000);
// setTimeout(() => {
//   parent.value = "now just text";
// }, 8000);
// setTimeout(() => {
//   parent.value = [leaf1, leaf2];
// }, 10000);

// setTimeout(() => {
//   unmount();
// }, 12000);
