import { signal, computed, effect, Signal } from "@preact/signals-core";

type CodeNode = CodeNode[] | {};
type DataNode = Signal<DataNode[] | string>;

function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const code: CodeNode = [[{}, {}], {}];

const data: DataNode = signal([
  signal([signal("Hi"), signal("You")]),
  signal("There"),
]);

const active = signal({ path: [0], edit: false });

const prev = () => {
  const path = [...active.peek().path];
  const last = path.pop()!;
  if (last > 0) {
    active.value = { path: [...path, last - 1], edit: false };
  } else {
    active.value = { path: path, edit: false };
  }
};
const next = () => {
  const path = [...active.peek().path];
  const last = path.pop()!;
  const parent = path.reduce(
    (res, p) => (res as CodeNode[])[p]!,
    code
  ) as CodeNode[];
  if (last < parent.length - 1) {
    active.value = { path: [...path, last + 1], edit: false };
  } else {
    active.value = { path: path, edit: false };
  }
};
const up = () => {
  const path = [...active.peek().path];
  if (path.length > 0) {
    active.value = { path: path.slice(0, -1), edit: false };
  }
};
const down = () => {
  const path = [...active.peek().path];
  const item = path.reduce((res, p) => (res as CodeNode[])[p]!, code);
  if (Array.isArray(item)) {
    active.value = { path: [...path, 0], edit: false };
  }
};

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

function RenderValue({
  path,
  value,
}: {
  path: number[];
  value: Signal<string>;
}): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.classList.add("value");
  const isActive = computed(() =>
    pathsEqual(active.value.path, path) ? active.value.edit : null
  );
  effect(() => {
    if (isActive.value === true) {
      let input = wrapper.firstElementChild as HTMLInputElement | null;
      if (!input || input.tagName !== "INPUT") {
        input = document.createElement("input");
        input.setAttribute("type", "text");
        input.addEventListener("input", () => {
          value.value = input!.value;
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Escape") {
            active.value = { path, edit: false };
          }
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
          // if (e.key === "Enter") {
          //   e.preventDefault();
          //   insert();
          // }
          // if (e.key === "Backspace" && input!.selectionStart === 0) {
          //   e.preventDefault();
          //   remove();
          // }
        });
        wrapper.replaceChildren(input);
      }
      if (input!.value !== value.value) input!.value = value.value;
      // // Focus only if not already focused; put caret at end, no selection flash.
      // if (document.activeElement !== input) {
      //   // Clear any prior selection the dblclick might have created
      //   window.getSelection()?.removeAllRanges();
      //   input!.focus({ preventScroll: true });
      //   const end = input!.value.length;
      //   input!.setSelectionRange(end, end);
      // }
      wrapper.classList.add("edit");
    } else {
      let p = wrapper.firstElementChild as HTMLParagraphElement | null;
      if (!p || p.tagName !== "P") {
        wrapper.replaceChildren();
        p = document.createElement("p");
        p.setAttribute("tabIndex", "0");
        p.addEventListener("click", () => {
          active.value = { path, edit: false };
        });
        p.addEventListener("dblclick", () => {
          // window.getSelection()?.removeAllRanges();
          active.value = { path, edit: true };
        });
        // p.addEventListener("mousedown", (e) => e.preventDefault());
        p.addEventListener("keydown", (e) => {
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
            active.value = { path, edit: true };
          }
        });
        wrapper.appendChild(p);
      }
      p.textContent = value.value;
      if (isActive.value !== null) p.classList.add("active");
      else p.classList.remove("active");
      // if (document.activeElement !== p) {
      //   p.focus({ preventScroll: true });
      // }
      wrapper.classList.remove("edit");
    }
  });

  return wrapper;
}

function RenderBlock({
  path,
  value,
}: {
  path: number[];
  value: Signal<DataNode[]>;
}): HTMLDivElement {
  const container = document.createElement("div");
  container.classList.add("node");
  const isActive = computed(() =>
    pathsEqual(active.value.path, path) ? active.value.edit : null
  );
  effect(() => {
    if (isActive.value !== null) container.classList.add("active");
    else container.classList.remove("active");
  });
  effect(() => {
    container.replaceChildren(
      ...value.value.map((v, i) => {
        const cell = document.createElement("div");
        cell.classList.add("cell");
        const childPath = [...path, i];
        cell.appendChild(RenderNode({ path: childPath, value: v }));
        return cell;
      })
    );
  });
  return container;
}

function RenderNode({
  path,
  value,
}: {
  path: number[];
  value: DataNode;
}): HTMLDivElement {
  const isValue = computed(() => typeof value.value === "string");
  return isValue.value
    ? RenderValue({ path, value: value as Signal<string> })
    : RenderBlock({ path, value: value as Signal<DataNode[]> });
}

document
  .getElementById("root")!
  .appendChild(RenderNode({ path: [], value: data }));
