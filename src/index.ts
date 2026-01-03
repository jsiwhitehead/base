import { effect } from "@preact/signals-core";

import {
  type ScalarPrimitive,
  type ListValue,
  type DataValue,
  type EvalValue,
  type ValueSignal,
  type CellValueSignal,
  createBlank,
  createScalar,
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

const literalSig = (v: ScalarPrimitive) => createSignal(createScalar(v));

const flowSig = (code: string) => {
  const s: CellValueSignal = createSignal<DataValue | EvalValue>(
    createScalar("")
  );
  s.set(createFlow(s, code));
  return s;
};

const linkSig = (source: string, filter: string = "") => {
  const s: CellValueSignal = createSignal<DataValue | EvalValue>(
    createScalar("")
  );
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
  { value: literalSig(10) },
  { value: literalSig(20) },
  { value: literalSig(30) },
  // { value: createSignal(createBlank()) },
  // {
  //   name: "f",
  //   value: createTemplateListSignal(
  //     ["arg1", "arg2"],
  //     [
  //       { value: literalSig(10) },
  //       { value: literalSig(20) },
  //       { value: flowSig("arg1 * arg2 * 3") },
  //     ]
  //   ),
  // },
  // { value: createSignal(createBlank()) },
  // { value: flowSig("f(10, 20)") },
  // { value: createSignal(createBlank()) },
  // {
  //   value: resultListSig(
  //     [
  //       { name: "a", value: literalSig(10) },
  //       { name: "b", value: literalSig(20) },
  //       { value: flowSig("a * b") },
  //     ],
  //     2
  //   ),
  // },
  // {
  //   name: "x",
  //   view: "bar",
  //   value: createListSignal([
  //     { value: literalSig(10) },
  //     { value: literalSig(20) },
  //     { value: literalSig(30) },
  //   ]),
  // },
  // {
  //   value: linkSig("x", "a => a > 15"),
  // },
  // {
  //   value: createListSignal([
  //     { value: literalSig(10) },
  //     { value: literalSig(20) },
  //   ]),
  // },
  // { value: literalSig(10) },
  // {
  //   name: "data",
  //   view: "table",
  //   value: createListSignal([
  //     {
  //       value: createListSignal([
  //         { name: "Name", value: literalSig("Steve") },
  //         { name: "Age", value: literalSig(25) },
  //       ]),
  //     },
  //     {
  //       value: createListSignal([
  //         { name: "Name", value: literalSig("Lucy") },
  //         { name: "Age", value: literalSig(32) },
  //       ]),
  //     },
  //     {
  //       value: createListSignal([
  //         { name: "Name", value: literalSig("James") },
  //         { name: "Age", value: literalSig(18) },
  //       ]),
  //     },
  //   ]),
  // },
  // { value: createSignal(createBlank()) },
  // { value: flowSig("data:map(d -> d.Age):avg()") },
  // { name: "y", view: "slider", value: literalSig(50) },
  // { name: "z", value: flowSig("x") },
  // { value: literalSig(10) },
  // {
  //   value: createListSignal([
  //     { value: literalSig("Hello") },
  //     { value: literalSig("World!") },
  //   ]),
  // },
  // { value: literalSig(30) },
]);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveValue(root.get()), null, 2));
});
