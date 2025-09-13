import { effect } from "@preact/signals-core";

import {
  type Value,
  makeLiteral,
  makeBlock,
  makeSignal,
  resolveDeep,
} from "./data";
import { onRootMouseDown, onRootDblClick, onRootKeyDown } from "./input";
import { contextByNode, NodeMount } from "./render";

export function render(data: Value, rootElement: HTMLElement): () => void {
  contextByNode.set(data, { parent: null, scope: {} });

  const { element, dispose } = new NodeMount(data);
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

// TEST

const value = makeBlock({}, [
  makeBlock({ x: makeSignal(makeLiteral("test")) }, [
    makeSignal(makeLiteral("hi")),
    makeSignal(makeLiteral("there")),
  ]),
  makeSignal(makeLiteral("world")),
]);

const unmount = render(value, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveDeep(value), null, 2));
});
