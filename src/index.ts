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
import { onRootKeyDown } from "./input";
import renderRoot from "./render";

export function render(
  rootSignal: ValueSignal<ListValue>,
  rootElement: HTMLElement
) {
  setGlobalLibrary(library);
  setDataRoot(rootSignal);

  const { mount, dispose } = renderRoot(rootSignal, []);

  rootElement.replaceChildren(mount.element);

  queueMicrotask(() => {
    mount.view.focusEl.focus();
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

const root = createListSignal(
  [["x", createListSignal([], [literalSig(10), literalSig(20)])]],
  [createFlowSignal("x")]
);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveValue(root.get()), null, 2));
});
