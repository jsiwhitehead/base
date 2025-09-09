import { effect, signal } from "@preact/signals-core";

import type { DataNode } from "./code";
import { render } from "./code";

// const leaf1 = signal<DataNode[] | string>("hello");
// const leaf2 = signal<DataNode[] | string>("world");
// const parent = signal<DataNode[] | string>([leaf1, leaf2]);

const parent = signal({
  values: {},
  items: [
    signal({ values: {}, items: [signal("hi"), signal("there")] }),
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

function snapshot(node: DataNode): any {
  const v = node.value;
  return Array.isArray(v) ? v.map(snapshot) : v;
}
effect(() => {
  const snap = snapshot(parent);
  console.log(JSON.stringify(snap, null, 2));
});
