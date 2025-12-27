import { effect } from "@preact/signals-core";

import {
  type Primitive,
  type ListValue,
  type DataValue,
  type EvalValue,
  type ValueSignal,
  type ChildSignal,
  createBlank,
  createLiteral,
  createList,
  createFlow,
  createSignal,
  createListSignal,
  createLink,
  setGlobalLibrary,
  resolveValue,
  createTemplateListSignal,
} from "./data";
import { setDataRoot } from "./tree";
import { library } from "./library";
import { onRootKeyDown, focusFirstRootCell } from "./input";
import renderRoot from "./render";

export function render(
  rootSignal: ValueSignal<ListValue>,
  rootElement: HTMLElement
) {
  setGlobalLibrary(library);
  setDataRoot(rootSignal);

  const { element, dispose } = renderRoot(rootSignal, []);

  rootElement.replaceChildren(element);

  queueMicrotask(() => {
    focusFirstRootCell();
  });

  rootElement.addEventListener("keydown", onRootKeyDown);

  return () => {
    dispose();
    rootElement.removeEventListener("keydown", onRootKeyDown);
    rootElement.textContent = "";
  };
}

/* Test */

const literalSig = (v: Primitive) => createSignal(createLiteral(v));

const flowSig = (code: string) => {
  const s: ChildSignal = createSignal<DataValue | EvalValue>(createLiteral(""));
  s.set(createFlow(s, code));
  return s;
};

const linkSig = (source: string, filter: string = "") => {
  const s: ChildSignal = createSignal<DataValue | EvalValue>(createLiteral(""));
  s.set(createLink(s, source, filter));
  return s;
};

function resultListSig(
  cells: Parameters<typeof createList>[0],
  resultIndex1: number
) {
  const base = createList(cells);
  return createListSignal(base.cells, base.cells[resultIndex1]!.uid);
}

const root = createListSignal([
  { child: literalSig(10) },
  { child: literalSig(20) },
  { child: literalSig(30) },
  { child: createSignal(createBlank()) },
  {
    name: "f",
    child: createTemplateListSignal("arg", [
      { child: literalSig(10) },
      { child: literalSig(20) },
      { child: flowSig("arg * 3") },
    ]),
  },
  { child: createSignal(createBlank()) },
  { child: flowSig("f(10)") },
  { child: createSignal(createBlank()) },
  {
    child: resultListSig(
      [
        { name: "a", child: literalSig(10) },
        { name: "b", child: literalSig(20) },
        { child: flowSig("a * b") },
      ],
      2
    ),
  },
  // {
  //   name: "x",
  //   view: "bar",
  //   child: createListSignal([
  //     { child: literalSig(10) },
  //     { child: literalSig(20) },
  //     { child: literalSig(30) },
  //   ]),
  // },
  // {
  //   child: linkSig("x", "a => a > 15"),
  // },
  // {
  //   child: createListSignal([
  //     { child: literalSig(10) },
  //     { child: literalSig(20) },
  //   ]),
  // },
  // { child: literalSig(10) },
  // {
  //   name: "data",
  //   view: "table",
  //   child: createListSignal([
  //     {
  //       child: createListSignal([
  //         { name: "Name", child: literalSig("Steve") },
  //         { name: "Age", child: literalSig(25) },
  //       ]),
  //     },
  //     {
  //       child: createListSignal([
  //         { name: "Name", child: literalSig("Lucy") },
  //         { name: "Age", child: literalSig(32) },
  //       ]),
  //     },
  //     {
  //       child: createListSignal([
  //         { name: "Name", child: literalSig("James") },
  //         { name: "Age", child: literalSig(18) },
  //       ]),
  //     },
  //   ]),
  // },
  // { child: createSignal(createBlank()) },
  // { child: flowSig("data:map(d -> d.Age):avg()") },
  // { name: "y", view: "slider", child: literalSig(50) },
  // { name: "z", child: flowSig("x") },
  // { child: literalSig(10) },
  // {
  //   child: createListSignal([
  //     { child: literalSig("Hello") },
  //     { child: literalSig("World!") },
  //   ]),
  // },
  // { child: literalSig(30) },
]);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveValue(root.get()), null, 2));
});
