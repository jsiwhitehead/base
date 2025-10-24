import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type ListValue,
  type ValueSignal,
  createLiteral,
  createFlowSignal,
  createSignal,
  createListSignal,
  resolveValue,
  setGlobalLibrary,
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

  const keydownHandler = (e: KeyboardEvent) => onRootKeyDown(e);
  rootElement.addEventListener("keydown", keydownHandler);

  return () => {
    dispose();
    rootElement.removeEventListener("keydown", keydownHandler);
    rootElement.textContent = "";
  };
}

/* Test */

const literalSig = (v: Primitive) => createSignal(createLiteral(v));

const root = createListSignal([
  {
    name: "x",
    child: createListSignal([
      { child: literalSig(10) },
      { child: literalSig(20) },
    ]),
  },
  { name: "y", child: literalSig(50) },
  { name: "z", child: createFlowSignal("x") },
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
