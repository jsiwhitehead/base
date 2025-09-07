import { useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  signal,
  Signal,
  useComputed,
  useSignalEffect,
} from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";

type Id = { id: string; children?: Id[] };
type Node = Signal<Node[] | string>;

function uid(): string {
  return (
    "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

function pathsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const data: Node = signal([
  signal([signal("Hi"), signal("You")]),
  signal("There"),
]);

const id: Id = {
  id: uid(),
  children: [
    { id: uid(), children: [{ id: uid() }, { id: uid() }] },
    { id: uid() },
  ],
};

const active = signal({ path: [0], edit: false });

function RenderValue({
  path,
  value,
  prev,
  next,
  insert,
  remove,
}: {
  path: number[];
  value: Signal<string>;
  prev: () => void;
  next: () => void;
  insert: () => void;
  remove: () => void;
}) {
  useSignals();
  const isActive = useComputed(() =>
    pathsEqual(active.value.path, path) ? active.value.edit : null
  );
  const inputRef = useRef<HTMLInputElement>(null);
  useSignalEffect(() => {
    if (isActive.value !== null) {
      setTimeout(() => {
        if (inputRef.current && document.activeElement !== inputRef.current) {
          inputRef.current.focus();
        }
      });
    }
  });
  if (isActive.value !== true) {
    return (
      <p
        ref={inputRef}
        tabIndex={0}
        className={isActive.value !== null ? "active" : ""}
        onClick={() => {
          active.value = { path, edit: false };
        }}
        onDoubleClick={() => {
          active.value = { path, edit: true };
        }}
        onMouseDown={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            prev();
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            next();
          }
          if (e.key === "Enter") {
            active.value = { path, edit: true };
          }
        }}
      >
        {value.value}
      </p>
    );
  }
  return (
    <div className="active">
      <input
        ref={inputRef}
        type="text"
        value={value.value}
        onInput={(e) => {
          const elem = e.target as HTMLInputElement;
          value.value = elem.value;
        }}
        onKeyDown={(e) => {
          const elem = e.target as HTMLInputElement;
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
          if (e.key === "Enter") {
            e.preventDefault();
            insert();
          }
          if (e.key === "Backspace" && elem.selectionStart === 0) {
            e.preventDefault();
            remove();
          }
        }}
      />
    </div>
  );
}

function RenderBlock({
  ids,
  path,
  value,
}: {
  ids: Id[];
  path: number[];
  value: Signal<Node[]>;
}) {
  useSignals();
  return (
    <div className="node">
      {value.value.map((x, i) => (
        <div className="cell" key={ids[i]!.id}>
          <RenderNode
            id={ids[i]!}
            path={[...path, i]}
            value={x}
            prev={() => {
              if (i > 0) active.value = { path: [...path, i - 1], edit: false };
            }}
            next={() => {
              if (i < ids.length - 1)
                active.value = { path: [...path, i + 1], edit: false };
            }}
            insert={() => {
              value.value = value.value.toSpliced(i + 1, 0, signal(""));
              ids.splice(i + 1, 0, { id: uid() });
              active.value = { path: [...path, i + 1], edit: true };
            }}
            remove={() => {
              value.value = value.value.toSpliced(i, 1);
              ids.splice(i, 1);
              if (i > 0) active.value = { path: [...path, i - 1], edit: false };
            }}
          />
        </div>
      ))}
    </div>
  );
}

function RenderNode({
  id,
  path,
  value,
  prev,
  next,
  insert,
  remove,
}: {
  id: Id;
  path: number[];
  value: Node;
  prev: () => void;
  next: () => void;
  insert: () => void;
  remove: () => void;
}) {
  const isValue = useComputed(() => typeof value.value === "string");
  if (isValue.value) {
    return (
      <RenderValue
        path={path}
        value={value as Signal<string>}
        prev={prev}
        next={next}
        insert={insert}
        remove={remove}
      />
    );
  }
  return (
    <RenderBlock
      ids={id.children!}
      path={path}
      value={value as Signal<Node[]>}
    />
  );
}

function App() {
  return (
    <RenderNode
      id={id}
      path={[]}
      value={data}
      prev={() => {}}
      next={() => {}}
      insert={() => {}}
      remove={() => {}}
    />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
