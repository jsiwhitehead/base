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
import { SignalMount } from "./render";

export function render(
  rootSignal: DataSignal<BlockNode>,
  rootElement: HTMLElement
) {
  const mount = new SignalMount(rootSignal, []);
  const { element } = mount;

  rootElement.appendChild(element);
  queueMicrotask(() => element.focus());

  rootElement.addEventListener("keydown", onRootKeyDown);

  return () => {
    mount.dispose();
    rootElement.removeEventListener("keydown", onRootKeyDown);
    rootElement.textContent = "";
  };
}

/* Test */

setGlobalLibrary(library);

const literalSig = (v: Primitive) => createSignal(createLiteral(v));
const codeSig = (src: string) => createCodeSignal(src);

const root = createBlockSignal(
  [["x", createBlockSignal([], [literalSig(10), literalSig(20)])]],
  [codeSig("sum(x)")]
);

setDataRoot(root);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveData(root.get()), null, 2));
});
