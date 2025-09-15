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
import { onRootKeyDown } from "./input";
import { BoxMount } from "./render";

export function render(
  rootBox: Box<BlockNode>,
  rootElement: HTMLElement
): () => void {
  const { element, dispose } = new BoxMount(rootBox);
  rootElement.appendChild(element);
  queueMicrotask(() => element.focus());

  const onKeyDown = (e: KeyboardEvent) => onRootKeyDown(e, rootElement);
  rootElement.addEventListener("keydown", onKeyDown);

  return () => {
    dispose();
    rootElement.removeEventListener("keydown", onKeyDown);
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
  [],
  [makeBlockBox([["x", makeLiteralBox("10")]], [makeBox(makeCode("x + 10"))])]
);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveDeep(root), null, 2));
});
