import { createRoot } from "react-dom/client";
import { signal, Signal, useComputed } from "@preact/signals-react";
import { useSignals } from "@preact/signals-react/runtime";

function uid(): string {
  return (
    "b_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  );
}

const data: Node = signal([signal("Hi"), signal("There")]);
const keys: any = [uid(), uid()];

type Node = Signal<Node[] | string>;

function RenderValue({
  path,
  value,
  insert,
  remove,
}: {
  path: number[];
  value: Signal<string>;
  insert: (text: string) => void;
  remove: (text: string) => void;
}) {
  useSignals();
  const k = path.reduce((res, p) => res[p], keys);
  return (
    <input
      id={k}
      type="text"
      value={value.value}
      onInput={(e) => {
        const elem = e.target as HTMLInputElement;
        value.value = elem.value;
      }}
      onKeyDown={(e) => {
        const elem = e.target as HTMLInputElement;
        if (e.key === "Enter") {
          const start = elem.selectionStart ?? value.value.length;
          const end = elem.selectionEnd ?? value.value.length;
          insert(value.value.slice(end));
          value.value = value.value.slice(0, start);
        }
        if (e.key === "Backspace" && elem.selectionStart === 0) {
          remove(value.value);
        }
      }}
    />
  );
}

function RenderBlock({
  path,
  value,
}: {
  path: number[];
  value: Signal<Node[]>;
}) {
  useSignals();
  const k = path.reduce((res, p) => res[p], keys);
  return (
    <div className="node">
      {(value.value as Node[]).map((x, i) => (
        <RenderNode
          key={k[i]}
          path={[...path, i]}
          value={x}
          insert={(text: string) => {
            k.splice(i + 1, 0, uid());
            value.value = (value.value as Node[]).toSpliced(
              i + 1,
              0,
              signal(text)
            );
            setTimeout(() => {
              const el = document.getElementById(k[i + 1]) as HTMLInputElement;
              el.focus();
              el.setSelectionRange(0, 0);
            });
          }}
          remove={(text: string) => {
            k.splice(i, 1);
            value.value = (value.value as Node[]).toSpliced(i, 1);
            if (i > 0) {
              const pos = value.value[i - 1]!.value.length;
              value.value[i - 1]!.value += text;
              setTimeout(() => {
                const el = document.getElementById(
                  k[i - 1]
                ) as HTMLInputElement;
                el.focus();
                el.setSelectionRange(pos, pos);
              });
            }
          }}
        />
      ))}
    </div>
  );
}

function RenderNode({
  path,
  value,
  insert,
  remove,
}: {
  path: number[];
  value: Node;
  insert: (text: string) => void;
  remove: (text: string) => void;
}) {
  const isValue = useComputed(() => typeof value.value === "string");
  if (isValue.value) {
    return (
      <RenderValue
        path={path}
        value={value as Signal<string>}
        insert={insert}
        remove={remove}
      />
    );
  }
  return <RenderBlock path={path} value={value as Signal<Node[]>} />;
}

function App() {
  return (
    <RenderNode path={[]} value={data} insert={() => {}} remove={() => {}} />
  );
}

createRoot(document.getElementById("root")!).render(<App />);
