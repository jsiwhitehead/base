import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type Box,
  type BlockBox,
  makeLiteral,
  makeBlock,
  makeBox,
  resolveDeep,
} from "./data";
import { onRootMouseDown, onRootDblClick, onRootKeyDown } from "./input";
import { BoxMount } from "./render";

export function render(
  rootBox: BlockBox,
  rootElement: HTMLElement
): () => void {
  const { element, dispose } = new BoxMount(rootBox);
  rootElement.appendChild(element);
  queueMicrotask(() => element.focus());

  rootElement.addEventListener("mousedown", onRootMouseDown);
  rootElement.addEventListener("dblclick", onRootDblClick);

  const onKeyDown = (e: KeyboardEvent) => onRootKeyDown(e, rootElement);
  rootElement.addEventListener("keydown", onKeyDown);

  return () => {
    dispose();
    rootElement.removeEventListener("mousedown", onRootMouseDown);
    rootElement.removeEventListener("dblclick", onRootDblClick);
    rootElement.removeEventListener("keydown", onKeyDown);
    rootElement.textContent = "";
  };
}

/* Test */

function makeLiteralBox(value: Primitive) {
  return makeBox(makeLiteral(value));
}

function makeBlockBox(
  values: Record<string, Box> = {},
  items: Box[] = []
): BlockBox {
  const blockBox = makeBox(makeBlock()) as BlockBox;
  for (const child of Object.values(values)) child.parent = blockBox;
  for (const child of items) child.parent = blockBox;
  blockBox.value.value = makeBlock(values, items);
  return blockBox;
}

const root = makeBlockBox({}, [
  makeBlockBox({ x: makeLiteralBox("test") }, [
    makeLiteralBox("hi"),
    makeLiteralBox("there"),
  ]),
  makeLiteralBox("world"),
]);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveDeep(root), null, 2));
});
