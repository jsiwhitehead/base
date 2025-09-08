import { signal, computed, effect, Signal } from "@preact/signals-core";

const root = document.getElementById("root")!;

type DataNode = Signal<DataNode[] | string>;

const data: DataNode = signal([
  signal([signal("Hi"), signal("You")]),
  signal("There"),
]);

const signalMap = new WeakMap<HTMLElement, DataNode>();

let active = { path: [0], edit: false };

function getPathFromElement(start: HTMLElement): number[] {
  const path: number[] = [];
  let cell = start.closest(".cell") as HTMLElement | null;
  while (cell) {
    const parent = cell.parentElement!;
    const i = Array.prototype.indexOf.call(parent.children, cell);
    path.unshift(i);
    cell = parent.closest(".cell") as HTMLElement | null;
  }
  return path;
}

function getElementFromPath(path: number[]): HTMLElement {
  return path.reduce(
    (res, i) => res.children[i]!.firstElementChild!,
    root.firstElementChild! as any
  );
}

function doUpdate(
  newActive: { path: number[]; edit: boolean },
  update?: () => void
) {
  const prev = getElementFromPath(active.path);
  prev.classList.remove("active");
  if (prev.classList.contains("value")) {
    setValueInner(prev, false);
  }

  active = newActive;
  if (update) update();

  const next = getElementFromPath(active.path);
  next.classList.add("active");
  if (active.edit && next.classList.contains("value")) {
    setValueInner(next, active.edit);
  }
  const elem = next.classList.contains("value")
    ? (next.firstElementChild! as HTMLElement)
    : next;
  elem.focus();
}

function prev() {
  const path = [...active.path];
  const last = path.pop()!;
  if (last > 0) {
    doUpdate({ path: [...path, last - 1], edit: false });
  }
}
function next() {
  const path = [...active.path];
  const last = path.pop()!;
  const len = getElementFromPath(path).childElementCount;
  if (last < len - 1) {
    doUpdate({ path: [...path, last + 1], edit: false });
  }
}
function up() {
  const path = [...active.path];
  if (path.length > 0) {
    doUpdate({ path: path.slice(0, -1), edit: false });
  }
}
function down() {
  const path = [...active.path];
  const parent = getElementFromPath(path);
  if (!parent.classList.contains("value")) {
    doUpdate({ path: [...path, 0], edit: false });
  }
}

function insert(child: HTMLElement) {
  const path = getPathFromElement(child);
  if (path.length > 0) {
    const index = path.pop()!;
    const parent = child.closest(".cell")!.parentElement as HTMLElement;
    const value = signalMap.get(parent)! as Signal<DataNode[]>;
    doUpdate(
      {
        path: [...path, index + 1],
        edit: true,
      },
      () => {
        value.value = value.value.toSpliced(index + 1, 0, signal(""));
      }
    );
  }
}
function remove(child: HTMLElement) {
  const path = getPathFromElement(child);
  if (path.length > 0) {
    const index = path.pop()!;
    const parent = child.closest(".cell")!.parentElement as HTMLElement;
    const value = signalMap.get(parent)! as Signal<DataNode[]>;
    const len = parent.childElementCount;
    doUpdate(
      {
        path: len === 1 ? path : [...path, Math.max(0, index - 1)],
        edit: false,
      },
      () => {
        value.value = value.value.toSpliced(index, 1);
      }
    );
  }
}

root.addEventListener("click", () => {
  doUpdate({ path: active.path, edit: false });
});

root.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp") {
    e.preventDefault();
    prev();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    next();
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    up();
  }
  if (e.key === "ArrowRight") {
    e.preventDefault();
    down();
  }
});

function setValueInner(wrapper: HTMLElement, edit: boolean) {
  if (
    (wrapper.firstElementChild as HTMLElement)?.tagName !==
    (edit ? "INPUT" : "P")
  ) {
    const value = signalMap.get(wrapper)!;
    const elem = document.createElement(!edit ? "p" : "input") as HTMLElement;
    if (!edit) {
      elem.setAttribute("tabIndex", "0");
      elem.addEventListener("click", () => {
        doUpdate({ path: getPathFromElement(elem), edit: false });
      });
      elem.addEventListener("dblclick", () => {
        doUpdate({ path: getPathFromElement(elem), edit: true });
      });
      elem.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      elem.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          doUpdate({ path: active.path, edit: true });
        }
        if (e.key === "Backspace") {
          e.stopPropagation();
          remove(wrapper);
        }
      });
      elem.textContent = (value as Signal<string>).peek();
    } else {
      elem.setAttribute("type", "text");
      elem.addEventListener(
        "input",
        () => (value.value = (elem as HTMLInputElement).value)
      );
      elem.addEventListener("keydown", (e) => {
        if (e.key === "ArrowLeft") {
          e.stopPropagation();
        }
        if (e.key === "ArrowRight") {
          e.stopPropagation();
        }
        if (e.key === "Enter") {
          e.stopPropagation();
          insert(wrapper);
        }
        if (e.key === "Backspace") {
          e.stopPropagation();
          remove(wrapper);
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          doUpdate({ path: active.path, edit: false });
        }
      });
      (elem as HTMLInputElement).value = (value as Signal<string>).peek();
    }
    wrapper.replaceChildren(elem);
  }
}

function RenderValue({ value }: { value: Signal<string> }): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.classList.add("value");

  signalMap.set(wrapper, value);

  setValueInner(wrapper, false);

  effect(() => {
    const elem = wrapper.firstElementChild! as HTMLElement;
    if (elem.tagName === "INPUT") {
      if ((elem as HTMLInputElement).value !== value.value) {
        (elem as HTMLInputElement).value = value.value;
      }
    } else {
      (elem as HTMLParagraphElement).textContent = value.value;
    }
  });
  return wrapper;
}

function RenderBlock({ value }: { value: Signal<DataNode[]> }): HTMLDivElement {
  const container = document.createElement("div");
  container.classList.add("node");
  container.setAttribute("tabIndex", "0");

  container.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.stopPropagation();
      insert(container);
    }
    if (e.key === "Backspace") {
      e.stopPropagation();
      remove(container);
    }
  });

  signalMap.set(container, value);

  const byKey = new Map<DataNode, HTMLElement>();
  effect(() => {
    const unseen = new Set(byKey.keys());
    const orderedCells: HTMLElement[] = [];

    value.value.forEach((v, i) => {
      let cell = byKey.get(v);
      if (!cell) {
        cell = document.createElement("div");
        cell.classList.add("cell");
        cell.appendChild(RenderNode({ value: v }));
        byKey.set(v, cell);
      } else {
        unseen.delete(v);
      }
      orderedCells.push(cell);
    });

    for (const gone of unseen) {
      const cell = byKey.get(gone)!;
      cell.remove();
      byKey.delete(gone);
    }

    for (const cell of orderedCells) {
      container.appendChild(cell);
    }
  });
  return container;
}

function RenderNode({ value }: { value: DataNode }): HTMLDivElement {
  const isValue = computed(() => typeof value.value === "string");
  return isValue.value
    ? RenderValue({ value: value as Signal<string> })
    : RenderBlock({ value: value as Signal<DataNode[]> });
}

document.getElementById("root")!.appendChild(RenderNode({ value: data }));
doUpdate(active);
