import { effect, signal } from "@preact/signals-core";

import type { Node } from "./data";
import { onRootMouseDown, onRootDblClick, onRootKeyDown } from "./input";
import { contextByNode, NodeMount } from "./render";

export function render(data: Node, rootElement: HTMLElement): () => void {
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

// const leaf1 = signal<Node[] | string>("hello");
// const leaf2 = signal<Node[] | string>("world");
// const parent = signal<Node[] | string>([leaf1, leaf2]);

const parent = signal({
  values: {},
  items: [
    signal({
      values: { x: signal("test") },
      items: [signal("hi"), signal("there")],
    }),
    signal("world"),
  ],
});

const unmount = render(parent, document.getElementById("root")!);

// setTimeout(() => {
//   leaf1.value = "hi";
// }, 2000);
// setTimeout(() => {
//   parent.value = [leaf2, leaf1];
// }, 4000);
// setTimeout(() => {
//   parent.value = [leaf1];
// }, 6000);
// setTimeout(() => {
//   parent.value = "now just text";
// }, 8000);
// setTimeout(() => {
//   parent.value = [leaf1, leaf2];
// }, 10000);

// setTimeout(() => {
//   unmount();
// }, 12000);

function snapshot(node: Node): any {
  const v = node.value;
  return Array.isArray(v) ? v.map(snapshot) : v;
}
effect(() => {
  const snap = snapshot(parent);
  console.log(JSON.stringify(snap, null, 2));
});
