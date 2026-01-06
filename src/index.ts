import { effect } from "@preact/signals-core";

import {
  type ScalarPrimitive,
  type GroupContent,
  type DataContent,
  type EvalContent,
  type ContentSignal,
  type ItemContentSignal,
  createBlank,
  createScalar,
  createGroup,
  createDerived,
  createSignal,
  createGroupSignal,
  createLens,
  setGlobalLibrary,
  resolveContent,
  createTemplateGroupSignal,
} from "./model";
import { setDataRoot } from "./interact";
import { library } from "./library";
import { onRootKeyDown, focusFirstRootCell } from "./inputs";
import renderRoot from "./views";

export function render(
  rootSignal: ContentSignal<GroupContent>,
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

const derivedSig = (code: string) => {
  const s: ItemContentSignal = createSignal<DataContent | EvalContent>(
    createScalar("")
  );
  s.set(createDerived(s, code));
  return s;
};

const lensSig = (source: string, filter: string = "") => {
  const s: ItemContentSignal = createSignal<DataContent | EvalContent>(
    createScalar("")
  );
  s.set(createLens(s, source, filter));
  return s;
};

function resultGroupSig(
  items: Parameters<typeof createGroup>[0],
  resultIndex1: number
) {
  const base = createGroup(items);
  return createGroupSignal(base.items, base.items[resultIndex1]!.uid);
}

const root = createGroupSignal([
  { content: literalSig(10) },
  { content: literalSig(20) },
  { content: literalSig(30) },
  // { content: createSignal(createBlank()) },
  // {
  //   name: "f",
  //   content: createTemplateGroupSignal(
  //     ["arg1", "arg2"],
  //     [
  //       { content: literalSig(10) },
  //       { content: literalSig(20) },
  //       { content: derivedSig("arg1 * arg2 * 3") },
  //     ]
  //   ),
  // },
  // { content: createSignal(createBlank()) },
  // { content: derivedSig("f(10, 20)") },
  // { content: createSignal(createBlank()) },
  // {
  //   content: resultGroupSig(
  //     [
  //       { name: "a", content: literalSig(10) },
  //       { name: "b", content: literalSig(20) },
  //       { content: derivedSig("a * b") },
  //     ],
  //     2
  //   ),
  // },
  // {
  //   name: "x",
  //   view: "bar",
  //   content: createGroupSignal([
  //     { content: literalSig(10) },
  //     { content: literalSig(20) },
  //     { content: literalSig(30) },
  //   ]),
  // },
  // {
  //   content: lensSig("x", "a => a > 15"),
  // },
  // {
  //   content: createGroupSignal([
  //     { content: literalSig(10) },
  //     { content: literalSig(20) },
  //   ]),
  // },
  // { content: literalSig(10) },
  // {
  //   name: "data",
  //   view: "table",
  //   content: createGroupSignal([
  //     {
  //       content: createGroupSignal([
  //         { name: "Name", content: literalSig("Steve") },
  //         { name: "Age", content: literalSig(25) },
  //       ]),
  //     },
  //     {
  //       content: createGroupSignal([
  //         { name: "Name", content: literalSig("Lucy") },
  //         { name: "Age", content: literalSig(32) },
  //       ]),
  //     },
  //     {
  //       content: createGroupSignal([
  //         { name: "Name", content: literalSig("James") },
  //         { name: "Age", content: literalSig(18) },
  //       ]),
  //     },
  //   ]),
  // },
  // { content: createSignal(createBlank()) },
  // { content: derivedSig("data:map(d -> d.Age):avg()") },
  // { name: "y", view: "slider", content: literalSig(50) },
  // { name: "z", content: derivedSig("x") },
  // { content: literalSig(10) },
  // {
  //   content: createGroupSignal([
  //     { content: literalSig("Hello") },
  //     { content: literalSig("World!") },
  //   ]),
  // },
  // { content: literalSig(30) },
]);

const unmount = render(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(resolveContent(root.get()), null, 2));
});
