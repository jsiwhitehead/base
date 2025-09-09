import { Signal, effect, signal } from "@preact/signals-core";

export type DataNode = Signal<DataNode[] | string>;

type Mount = { readonly el: HTMLElement; dispose: () => void };

type ElInfo = {
  node: DataNode;
  parent: DataNode | null;
  setEditing?: (v: boolean, focus?: boolean) => void;
};

const elInfo = new WeakMap<HTMLElement, ElInfo>();

type ParentIndex = {
  info: ElInfo;
  parent: DataNode;
  parentVal: DataNode[];
  idx: number;
};

function getParentIndex(fromEl: HTMLElement): ParentIndex | null {
  const info = elInfo.get(fromEl);
  if (!info || !info.parent) return null;
  const parent = info.parent;
  const parentVal = parent.peek() as DataNode[];
  const idx = parentVal.indexOf(info.node);
  if (idx < 0) return null;
  return { info, parent, parentVal, idx };
}

function insertEmptySiblingAfter(el: HTMLElement) {
  const ctx = getParentIndex(el);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = parentVal.toSpliced(idx + 1, 0, signal(""));

  queueMicrotask(() => {
    const target = container?.children.item(idx + 1) as HTMLElement | null;
    target?.focus();
  });
}

function removeNodeAtElement(el: HTMLElement) {
  const ctx = getParentIndex(el);
  if (!ctx) return;
  const { parent, parentVal, idx } = ctx;

  const next =
    el.previousElementSibling || el.nextElementSibling || el.parentElement;
  parent.value = parentVal.toSpliced(idx, 1);

  queueMicrotask(() => {
    (next as HTMLElement | null)?.focus();
  });
}

function wrapNodeInBlock(el: HTMLElement) {
  const ctx = getParentIndex(el);
  if (!ctx) return;
  const { info, parent, parentVal, idx } = ctx;

  const container = el.parentElement;

  parent.value = parentVal.toSpliced(idx, 1, signal([info.node]));

  queueMicrotask(() => {
    const blockEl = container?.children
      .item(idx)!
      .children.item(0) as HTMLElement | null;
    blockEl?.focus();
  });
}

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

  const onKeyDown = (e: KeyboardEvent) => {
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

    if (e.key === "Enter") {
      e.preventDefault();
      if (info.setEditing) info.setEditing(true);
      else insertEmptySiblingAfter(active);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      removeNodeAtElement(active);
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      wrapNodeInBlock(active);
      return;
    }
  };

  root.addEventListener("keydown", onKeyDown);

  return () => {
    dispose();
    root.removeEventListener("keydown", onKeyDown);
    root.textContent = "";
  };
}

function mountNode(node: DataNode, parent: DataNode | null): Mount {
  let el!: HTMLElement;
  let mode: "block" | "value" | null = null;

  const children = new Map<DataNode, Mount>();

  const clearChildren = () => {
    for (const m of children.values()) m.dispose();
    children.clear();
    el.textContent = "";
  };

  const replaceEl = (nextEl: HTMLElement, focus = false) => {
    nextEl.tabIndex = 0;
    if (el) el.replaceWith(nextEl);
    el = nextEl;
    const info: ElInfo = { node, parent };
    if (mode === "value") info.setEditing = setEditing;
    elInfo.set(el, info);
    if (focus) el.focus();
  };

  const setEditing = (next: boolean, focus = true) => {
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
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          insertEmptySiblingAfter(input);
          setEditing(false, false);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          setEditing(false);
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
          wrapNodeInBlock(input);
          return;
        }
      });
    } else {
      nextEl.textContent = v;
    }

    replaceEl(nextEl, focus);
  };

  const setMode = (next: "block" | "value") => {
    if (mode === next) return;
    if (mode === "block") clearChildren();
    mode = next;
    replaceEl(document.createElement(next === "block" ? "div" : "p"));
  };

  const stop = effect(() => {
    const v = node.value;
    if (Array.isArray(v)) {
      setMode("block");
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
      setMode("value");
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

  return {
    get el() {
      return el;
    },
    dispose,
  };
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

function snapshot(node: DataNode): any {
  const v = node.value;
  return Array.isArray(v) ? v.map(snapshot) : v;
}
effect(() => {
  const snap = snapshot(parent);
  console.log(JSON.stringify(snap, null, 2));
});
