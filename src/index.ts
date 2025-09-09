import { Signal, effect, signal } from "@preact/signals-core";

export type DataNode = Signal<DataNode[] | string>;

type Mount = { el: HTMLElement; dispose: () => void };

type ElInfo = {
  node: DataNode;
  parent: DataNode | null;
  setEditing?: (v: boolean) => void;
};

const elInfo = new WeakMap<HTMLElement, ElInfo>();

export function render(data: DataNode, root: HTMLElement): () => void {
  const { el, dispose } = mountNode(data, null);
  root.appendChild(el);

  const arrowTarget = (a: HTMLElement, key: string): HTMLElement | null => {
    switch (key) {
      case "ArrowUp":
        return a.previousElementSibling as HTMLElement | null;
      case "ArrowDown":
        return a.nextElementSibling as HTMLElement | null;
      case "ArrowLeft":
        return a.parentElement !== root
          ? (a.parentElement as HTMLElement)
          : null;
      case "ArrowRight":
        return a.firstElementChild as HTMLElement | null;
      default:
        return null;
    }
  };

  const onKey = (e: KeyboardEvent) => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || !root.contains(active)) return;
    if (active.tagName === "INPUT") return;

    const target = arrowTarget(active, e.key);
    if (target) {
      e.preventDefault();
      target.focus();
      return;
    }

    const info = elInfo.get(active);
    if (!info) return;

    if (e.key === "Enter" && info.setEditing) {
      e.preventDefault();
      info.setEditing(true);
      return;
    }

    const { node, parent } = info;
    if (!parent) return;

    const parentVal = parent.peek() as DataNode[];
    const idx = parentVal.indexOf(node);

    if (e.key === "Enter") {
      e.preventDefault();
      parent.value = parentVal.toSpliced(idx + 1, 0, signal(""));
      queueMicrotask(() => {
        (active.nextElementSibling as HTMLElement | null)?.focus();
      });
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      const next =
        active.previousElementSibling ||
        active.nextElementSibling ||
        active.parentElement;
      parent.value = parentVal.toSpliced(idx, 1);
      queueMicrotask(() => {
        (next as HTMLElement | null)?.focus();
      });
      return;
    }
  };

  root.addEventListener("keydown", onKey);

  return () => {
    dispose();
    root.removeEventListener("keydown", onKey);
    root.textContent = "";
  };
}

function mountNode(node: DataNode, parent: DataNode | null): Mount {
  let el!: HTMLElement;
  let mode: "array" | "text" | null = null;

  const children = new Map<DataNode, Mount>();

  const clearChildren = () => {
    for (const m of children.values()) m.dispose();
    children.clear();
    el.textContent = "";
  };

  const setElInfo = () => {
    const info: ElInfo = { node, parent };
    if (mode === "text") info.setEditing = toggleEditing;
    elInfo.set(el, info);
  };

  const replaceEl = (nextEl: HTMLElement, focus = false) => {
    nextEl.tabIndex = 0;
    if (el) el.replaceWith(nextEl);
    el = nextEl;
    setElInfo();
    if (focus) el.focus();
  };

  const toggleEditing = (next: boolean) => {
    const wantTag = next ? "input" : "p";
    const v = node.peek() as string;
    const nextEl = document.createElement(wantTag);

    if (wantTag === "input") {
      const input = nextEl as HTMLInputElement;
      input.value = v;
      input.addEventListener("input", () => {
        node.value = input.value;
      });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          toggleEditing(false);
        }
      });
    } else {
      nextEl.textContent = v;
    }

    replaceEl(nextEl, true);
  };

  const setMode = (next: "array" | "text") => {
    if (mode === next) return;
    if (mode === "array") clearChildren();
    mode = next;
    replaceEl(document.createElement(next === "array" ? "div" : "p"));
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
          m = mountNode(sig, node);
          children.set(sig, m);
        }
        frag.appendChild(m.el);
      }
      el.appendChild(frag);
    } else {
      setMode("text");
      if (el.tagName === "INPUT") {
        (el as HTMLInputElement).value = v;
      } else {
        el.textContent = v;
      }
    }
  });

  const dispose = () => {
    stop();
    clearChildren();
  };

  return { el, dispose };
}

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
