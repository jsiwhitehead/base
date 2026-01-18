import { effect } from "@preact/signals-core";

import {
  type ItemId,
  type Item,
  type Scalar,
  type StoredContent,
  createItem,
  setRoot,
  setInterpreter,
  selectValue,
  itemAtom,
} from "./model";

import { interpretExpr } from "./interpret";
import { focusFirstRootCell, onRootKeyDown } from "./inputs";
import mountRoot from "./views";

export function mount(rootId: ItemId, rootElement: HTMLElement) {
  setInterpreter(interpretExpr);
  setRoot(rootId);

  const view = mountRoot(rootId, []);

  rootElement.replaceChildren(view.element);

  queueMicrotask(() => {
    focusFirstRootCell();
  });

  rootElement.addEventListener("keydown", onRootKeyDown);

  return () => {
    view.dispose();
    rootElement.removeEventListener("keydown", onRootKeyDown);
    rootElement.textContent = "";
  };
}

let nextId = 1;
const newId = (): number => nextId++;

const blankItem = (ownerId: ItemId | null): Item => ({
  id: newId(),
  ownerId,
  label: "",
  view: "",
  content: { kind: "blank" },
});

const scalarItem = (
  ownerId: ItemId | null,
  value: Scalar,
  label = ""
): Item => ({
  id: newId(),
  ownerId,
  label,
  view: "",
  content: { kind: "scalar", value },
});

const derivedItem = (
  ownerId: ItemId | null,
  expr: string,
  label = ""
): Item => ({
  id: newId(),
  ownerId,
  label,
  view: "",
  content: { kind: "derived", expr },
});

const lensItem = (
  ownerId: ItemId | null,
  from: string,
  where = "",
  orderBy = "",
  label = ""
): Item => ({
  id: newId(),
  ownerId,
  label,
  view: "",
  content: { kind: "lens", from, where, orderBy },
});

const groupItem = (
  ownerId: ItemId | null,
  children: Item[],
  label = "",
  view = ""
): Item => {
  const id = newId();
  for (const c of children) c.ownerId = id;

  const group: Item = {
    id,
    ownerId,
    label,
    view,
    content: { kind: "group", items: children.map((c) => c.id) },
  };

  createItem(group);
  for (const c of children) createItem(c);

  return group;
};

const rootId = newId();

createItem({
  id: rootId,
  ownerId: null,
  label: "",
  view: "",
  content: { kind: "group", items: [] },
});

const a = scalarItem(rootId, 10);
const b = scalarItem(rootId, 20);
const c = scalarItem(rootId, 30);

createItem(a);
createItem(b);
createItem(c);

itemAtom(rootId).set({
  ...itemAtom(rootId).peek(),
  content: { kind: "group", items: [a.id, b.id, c.id] },
});

// Example group "x"
// const x = groupItem(rootId, [
//   scalarItem(null, 10),
//   scalarItem(null, 20),
//   scalarItem(null, 30),
// ], "x");
// itemAtom(rootId).set({
//   ...itemAtom(rootId).peek(),
//   content: {
//     kind: "group",
//     items: [...(itemAtom(rootId).peek().content as any).items, x.id],
//   },
// });

// Example lens filtering + sorting over x
// const ln = lensItem(rootId, "x", "_.[1] > 15", "_.[1]");
// createItem(ln);
// itemAtom(rootId).set({
//   ...itemAtom(rootId).peek(),
//   content: { kind: "group", items: [...(itemAtom(rootId).peek().content as any).items, ln.id] },
// });

// Example table
// const people = groupItem(rootId, [
//   groupItem(null, [scalarItem(null, "Steve", "Name"), scalarItem(null, 25, "Age")]),
//   groupItem(null, [scalarItem(null, "Lucy", "Name"), scalarItem(null, 32, "Age")]),
//   groupItem(null, [scalarItem(null, "James", "Name"), scalarItem(null, 18, "Age")]),
// ], "people", "table");
// itemAtom(rootId).set({
//   ...itemAtom(rootId).peek(),
//   content: { kind: "group", items: [...(itemAtom(rootId).peek().content as any).items, people.id] },
// });

// Example derived call to builtins
// const d = derivedItem(rootId, "min(10, 20, 5)");
// createItem(d);
// itemAtom(rootId).set({
//   ...itemAtom(rootId).peek(),
//   content: { kind: "group", items: [...(itemAtom(rootId).peek().content as any).items, d.id] },
// });

const unmount = mount(rootId, document.getElementById("root")!);

effect(() => {
  console.log(JSON.stringify(selectValue(rootId), null, 2));
});
