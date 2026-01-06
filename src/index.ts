import { effect } from "@preact/signals-core";

import {
  type ScalarPrimitive,
  type GroupContent,
  type DirectContent,
  type RelationalContent,
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
  toStatic,
  createTemplateGroupSignal,
} from "./model";
import { setModelRoot } from "./interact";
import { library } from "./library";
import { onRootKeyDown, focusFirstRootCell } from "./inputs";
import mountRoot from "./views";

export function mount(
  rootSignal: ContentSignal<GroupContent>,
  rootElement: HTMLElement
) {
  setGlobalLibrary(library);
  setModelRoot(rootSignal);

  const { element, dispose } = mountRoot(rootSignal, []);

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
  const s: ItemContentSignal = createSignal<DirectContent | RelationalContent>(
    createScalar("")
  );
  s.set(createDerived(s, code));
  return s;
};

const lensSig = (source: string, filter: string = "") => {
  const s: ItemContentSignal = createSignal<DirectContent | RelationalContent>(
    createScalar("")
  );
  s.set(createLens(s, source, filter));
  return s;
};

function resultGroupSig(
  items: Parameters<typeof createGroup>[0],
  resultIndex: number
) {
  const base = createGroup(items);
  return createGroupSignal(base.items, base.items[resultIndex]!.uid);
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
  //   name: "people",
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
  // { content: derivedSig("people:map(d -> d.Age):avg()") },
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

const unmount = mount(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(toStatic(root.get()), null, 2));
});
