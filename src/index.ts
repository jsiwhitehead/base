import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type BlockNode,
  type DataSignal,
  createLiteral,
  createCode,
  createSignal,
  createBlockSignal,
  resolveData,
} from "./data";
import "./library";
import { onRootDblClick, onRootKeyDown } from "./input";
import { SignalMount } from "./render";

export function render(
  rootSignal: DataSignal<BlockNode>,
  rootElement: HTMLElement
) {
  const { element, dispose } = new SignalMount(rootSignal);
  rootElement.appendChild(element);
  queueMicrotask(() => element.focus());

  rootElement.addEventListener("dblclick", onRootDblClick);
  rootElement.addEventListener("keydown", onRootKeyDown);

  return () => {
    dispose();
    rootElement.removeEventListener("dblclick", onRootDblClick);
    rootElement.removeEventListener("keydown", onRootKeyDown);
    rootElement.textContent = "";
  };
}

/* Test */

const literalSig = (v: Primitive) => createSignal(createLiteral(v));
const codeSig = (src: string) => createSignal(createCode(src));

const root = createBlockSignal(
  [["x", createBlockSignal([], [literalSig("10"), literalSig("20")])]],
  [createBlockSignal([], [literalSig("10"), literalSig("20")]), codeSig("x")]
);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveData(root.get()), null, 2));
});
