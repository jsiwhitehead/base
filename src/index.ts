import { signal, computed, effect, Signal } from "@preact/signals-core";

const root = document.getElementById("root")!;

type DataNode = Signal<DataNode[] | string>;

const data: DataNode = signal([
  signal([signal("Hi"), signal("You")]),
  signal("There"),
]);

const signalMap = new WeakMap<HTMLElement, Signal<string>>();

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
    (res, i) => res.childNodes[i]!.firstElementChild!,
    root.firstElementChild! as any
  );
}

function setActive(path: number[], edit: boolean) {
  console.log(path);

  const prev = getElementFromPath(active.path);
  prev.classList.remove("active");

  if (prev.classList.contains("value")) {
    setValueInner(prev, false);
  }

  active = { path, edit };
  const next = getElementFromPath(path);
  next.classList.add("active");

  if (edit && next.classList.contains("value")) {
    setValueInner(next, edit);
  }

  const elem = next.classList.contains("value")
    ? (next.firstElementChild! as HTMLElement)
    : next;
  elem.focus();
}

const prev = () => {
  const path = [...active.path];
  const last = path.pop()!;
  if (last > 0) setActive([...path, last - 1], false);
  // else setActive(path, false);
};
const next = () => {
  const path = [...active.path];
  const last = path.pop()!;
  const len = getElementFromPath(path).childNodes.length;
  if (last < len - 1) setActive([...path, last + 1], false);
  // else setActive(path, false);
};
const up = () => {
  const path = [...active.path];
  if (path.length > 0) setActive(path.slice(0, -1), false);
};
const down = () => {
  const path = [...active.path];
  const parent = getElementFromPath(path);
  if (!parent.classList.contains("value")) setActive([...path, 0], false);
};

root.addEventListener("click", () => {
  setActive(active.path, false);
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
  if (e.key === "Enter") {
    e.preventDefault();
    setActive(active.path, true);
  }
  if (e.key === "Escape") {
    e.preventDefault();
    setActive(active.path, false);
  }
});

// insert: () => {
//   // Insert new empty value AFTER i
//   // value.value = [...value.value.slice(0, i + 1), signal(""), ...value.value.slice(i + 1)]; // (fallback for older targets)
//   // value.value = value.value.toSpliced(i + 1, 0, signal(""));
//   // ids.splice(i + 1, 0, { id: uid() });
//   // active.value = { path: [...path, i + 1], edit: true };
// },
// remove: () => {
//   // value.value = [...value.value.slice(0, i), ...value.value.slice(i + 1)]; // (fallback)
//   // value.value = value.value.toSpliced(i, 1);
//   // ids.splice(i, 1);
//   // if (i > 0) active.value = { path: [...path, i - 1], edit: false };
// },

function setValueInner(wrapper: HTMLElement, edit: boolean) {
  if (
    (wrapper.firstElementChild as HTMLElement)?.tagName !==
    (edit ? "INPUT" : "P")
  ) {
    const value = signalMap.get(wrapper)!;
    const elem = document.createElement(edit ? "input" : "p") as HTMLElement;
    if (edit) {
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
      });
      (elem as HTMLInputElement).value = value.peek();
    } else {
      elem.setAttribute("tabIndex", "0");
      elem.addEventListener("click", () => {
        setActive(getPathFromElement(elem), false);
      });
      elem.addEventListener("dblclick", () => {
        setActive(getPathFromElement(elem), true);
      });
      elem.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      elem.textContent = value.peek();
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
  effect(() => {
    container.replaceChildren(
      ...value.value.map((v) => {
        const cell = document.createElement("div");
        cell.classList.add("cell");
        cell.appendChild(RenderNode({ value: v }));
        return cell;
      })
    );
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
setActive(active.path, active.edit);
