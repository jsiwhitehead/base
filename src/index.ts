import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type BlockNode,
  type Box,
  makeLiteral,
  makeBlock,
  makeCode,
  makeBox,
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

function makeLiteralBox(value: Primitive) {
  return makeBox(makeLiteral(value));
}

function makeBlockBox(
  values: [string, Box][] = [],
  items: Box[] = []
): Box<BlockNode> {
  const blockBox = makeBox(makeBlock([], []));
  for (const [, child] of values) child.parent = blockBox;
  for (const child of items) child.parent = blockBox;
  blockBox.value.value = makeBlock(values, items);
  return blockBox;
}

const root = makeBlockBox(
  [["x", makeBlockBox([], [makeLiteralBox("10"), makeLiteralBox("20")])]],
  [makeBox(makeCode("x"))]
);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveDeep(root), null, 2));
});
