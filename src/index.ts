import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type ListValue,
  type Value,
  type EvalValue,
  type ValueSignal,
  type ChildSignal,
  createBlank,
  createLiteral,
  createFlow,
  createSignal,
  createListSignal,
  setGlobalLibrary,
  resolveValue,
} from "./data";
import { setDataRoot } from "./tree";
import { library } from "./library";
import { onRootKeyDown, focusFirstRootCell } from "./input";
import renderRoot from "./render";

export function render(
  rootSignal: ValueSignal<ListValue>,
  rootElement: HTMLElement
) {
  setGlobalLibrary(library);
  setDataRoot(rootSignal);

  const { element, dispose } = renderRoot(rootSignal, []);

  rootElement.replaceChildren(element);

  queueMicrotask(() => {
    focusFirstRootCell();
  });

  rootElement.addEventListener("keydown", onRootKeyDown);

  return () => {
    dispose();
    rootElement.removeEventListener("keydown", onRootKeyDown);
    rootElement.textContent = "";
  };
}

/* Test */

const literalSig = (v: Primitive) => createSignal(createLiteral(v));

const flowSig = (code: string) => {
  const s: ChildSignal = createSignal<Value | EvalValue>(createLiteral(""));
  s.set(createFlow(s, code));
  return s;
};

const root = createListSignal([
  {
    name: "x",
    child: createListSignal([
      { child: literalSig(10) },
      { child: literalSig(20) },
    ]),
  },
  {
    view: "styled",
    child: createListSignal([
      { name: "color", child: literalSig("red") },
      { name: "fill", child: flowSig("if(hover, 'lightblue', 'lightpink')") },
      { name: "round", child: literalSig(10) },
      { name: "pad", child: literalSig(10) },
      { name: "gap", child: literalSig(5) },
      { name: "hover", child: createSignal(createBlank()) },
      { child: literalSig("Hello") },
      { child: literalSig("World") },
    ]),
  },
  { name: "y", child: literalSig(50) },
  { name: "z", child: flowSig("x") },
  { child: literalSig(10) },
  {
    child: createListSignal([
      { child: literalSig("Hello") },
      { child: literalSig("World!") },
    ]),
  },
  { child: literalSig(30) },
]);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveValue(root.get()), null, 2));
});
