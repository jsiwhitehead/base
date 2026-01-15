import { effect } from "@preact/signals-core";

import {
  type ScalarPrimitive,
  type GroupContent,
  type StoredContent,
  type ContentSignal,
  type ItemContentSignal,
  createBlank,
  createScalar,
  createGroup,
  createDerived,
  createSignal,
  createGroupSignal,
  createLens,
  toStatic,
  setInterpreter,
} from "./model";
import { interpretExpr } from "./interpret";
import { setModelRoot } from "./interact";
import { onRootKeyDown, focusFirstRootCell } from "./inputs";
import mountRoot from "./views";

export function mount(
  rootSignal: ContentSignal<GroupContent>,
  rootElement: HTMLElement
) {
  setInterpreter(interpretExpr);
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
  const s: ItemContentSignal = createSignal<StoredContent>(createScalar(""));
  s.set(createDerived(s, code));
  return s;
};

const lensSig = (source: string, filter: string = "", sort: string = "") => {
  const s: ItemContentSignal = createSignal<StoredContent>(createScalar(""));
  s.set(createLens(s, source, filter, sort));
  return s;
};

const root = createGroupSignal([
  { content: literalSig(10) },
  { content: literalSig(20) },
  { content: literalSig(30) },

  // Example group
  // {
  //   label: "x",
  //   content: createGroupSignal([
  //     { content: literalSig(10) },
  //     { content: literalSig(20) },
  //     { content: literalSig(30) },
  //   ]),
  // },

  // Example lens filtering + sorting over x
  // { content: lensSig("x", "_.[1] > 15", "_.[1]") },

  // Example table
  // {
  //   label: "people",
  //   view: "table",
  //   content: createGroupSignal([
  //     {
  //       content: createGroupSignal([
  //         { label: "Name", content: literalSig("Steve") },
  //         { label: "Age", content: literalSig(25) },
  //       ]),
  //     },
  //     {
  //       content: createGroupSignal([
  //         { label: "Name", content: literalSig("Lucy") },
  //         { label: "Age", content: literalSig(32) },
  //       ]),
  //     },
  //     {
  //       content: createGroupSignal([
  //         { label: "Name", content: literalSig("James") },
  //         { label: "Age", content: literalSig(18) },
  //       ]),
  //     },
  //   ]),
  // },

  // Example derived call to builtins (min/max/etc)
  // { content: derivedSig("min(10, 20, 5)") },
]);

const unmount = mount(root, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(toStatic(root.get()), null, 2));
});
