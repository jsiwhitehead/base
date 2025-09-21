import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type BlockNode,
  type Box,
  makeLiteral,
  makeCode,
  makeBox,
  makeBlockBox,
  resolveDeep,
} from "./data";
import { onRootDblClick, onRootKeyDown } from "./input";
import { BoxMount } from "./render";

export function render(
  rootBox: Box<BlockNode>,
  rootElement: HTMLElement
): () => void {
  const { element, dispose } = new BoxMount(rootBox);
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

const literalBox = (v: Primitive): Box => makeBox(makeLiteral(v));
const codeBox = (src: string): Box => makeBox(makeCode(src));

const root = makeBlockBox(
  [["x", makeBlockBox([], [literalBox("10"), literalBox("20")])]],
  [makeBlockBox([], [literalBox("10"), literalBox("20")]), codeBox("x")]
);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveDeep(root), null, 2));
});
