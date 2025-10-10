import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type BlockNode,
  type DataSignal,
  createLiteral,
  createCodeSignal,
  createSignal,
  createBlockSignal,
  resolveData,
  setGlobalLibrary,
} from "./data";
import { setDataRoot } from "./tree";
import { library } from "./library";
import { onRootKeyDown } from "./input";
import renderRoot from "./render";

export function render(
  rootSignal: DataSignal<BlockNode>,
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

const root = createBlockSignal(
  [["x", createBlockSignal([], [literalSig(10), literalSig(20)])]],
  [createCodeSignal("x")]
);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveData(root.get()), null, 2));
});
