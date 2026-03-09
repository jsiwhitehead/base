import { describe, expect, test } from "bun:test";

import type { Core, ItemId, Intent, Transaction } from "../src/core";
import { CoreApiError, CoreOpError, createCore } from "../src/core";
import { splitViewRegistrations, viewRegistrations } from "../src/views";
import {
  assertCoreInvariants,
  expectThrowsWithCode,
  makePureCore,
  mkBlank,
  mkGroup,
} from "./core-test-utils";

type Rng = {
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(arr: readonly T[]): T;
  chance(probability: number): boolean;
};

function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  return {
    next,
    int(maxExclusive: number): number {
      return Math.floor(next() * maxExclusive);
    },
    pick<T>(arr: readonly T[]): T {
      return arr[this.int(arr.length)]!;
    },
    chance(probability: number): boolean {
      return next() < probability;
    },
  };
}

function reachableIds(core: Core, rootId: ItemId): ItemId[] {
  const out: ItemId[] = [];
  const stack: ItemId[] = [rootId];
  const seen = new Set<ItemId>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const item = core.item(id);
    if (item.content.type !== "group") continue;
    for (const childId of item.content.children) stack.push(childId);
  }
  return out;
}

function editableIds(core: Core, rootId: ItemId): ItemId[] {
  return reachableIds(core, rootId).filter((id) => {
    const item = core.item(id);
    return item.mode.type !== "readonly";
  });
}

function editableGroupIds(core: Core, rootId: ItemId): ItemId[] {
  return editableIds(core, rootId).filter(
    (id) => core.item(id).content.type === "group",
  );
}

function plainGroupIds(core: Core, rootId: ItemId): ItemId[] {
  return editableIds(core, rootId).filter((id) => {
    const item = core.item(id);
    return item.mode.type === "plain" && item.content.type === "group";
  });
}

function isAncestor(core: Core, ancestor: ItemId, node: ItemId): boolean {
  let cur: ItemId | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    const loc = core.locate(cur);
    cur = loc ? loc.parentId : null;
  }
  return false;
}

function assertSelectionValid(core: Core): void {
  const selection = core.selection();
  if (selection.type === "idle") return;

  if (selection.type === "editing") {
    core.item(selection.location.item);
    for (const portalId of selection.location.portals) {
      expect(core.item(portalId).mode.type).toBe("connected");
    }
    return;
  }

  core.item(selection.head.item);
  for (const portalId of selection.head.portals) {
    expect(core.item(portalId).mode.type).toBe("connected");
  }
}

function randomValue(rng: Rng): true | number | string | null {
  const k = rng.int(6);
  if (k === 0) return null;
  if (k === 1) return true;
  if (k === 2) return rng.int(10_000) - 5_000;
  if (k === 3) return `${rng.int(1000)}.${rng.int(1000)}`;
  if (k === 4) return `text-${rng.int(1000)}`;
  return rng.chance(0.5) ? "" : "  spaced  ";
}

function randomIntent(rng: Rng): Intent {
  const intents: Intent[] = [
    { type: "NAV", dir: "left" },
    { type: "NAV", dir: "right" },
    { type: "NAV", dir: "up" },
    { type: "NAV", dir: "down" },
    { type: "NAV", dir: "out" },
    { type: "ENTER" },
    { type: "DELETE", dir: "backward" },
    { type: "DELETE", dir: "forward" },
    { type: "TYPE", char: "x" },
  ];
  return rng.pick(intents);
}

function isExpectedCommitRejection(err: unknown): boolean {
  if (err instanceof CoreApiError) {
    return (
      err.code === "INVALID_ITEM_ID" ||
      err.code === "DERIVED_ITEM_ID" ||
      err.code === "UNKNOWN_ITEM_ID"
    );
  }
  if (err instanceof CoreOpError) {
    return (
      err.code === "DUPLICATE_CHILD_LABEL" ||
      err.code === "CANNOT_MOVE_INTO_SELF" ||
      err.code === "CANNOT_MOVE_INTO_DESCENDANT" ||
      err.code === "PARENT_NOT_GROUP" ||
      err.code === "CANNOT_CONVERT_NONEMPTY_GROUP"
    );
  }
  return false;
}

function commitMaybeReject(
  core: Core,
  run: Parameters<Core["commit"]>[0],
  context: string,
): void {
  const before = core.exportSnapshot();
  try {
    core.commit(run);
  } catch (err) {
    if (!isExpectedCommitRejection(err)) throw err;
    const after = core.exportSnapshot();
    try {
      expect(after).toEqual(before);
    } catch {
      const code =
        err instanceof CoreApiError || err instanceof CoreOpError
          ? err.code
          : "UNKNOWN";
      throw new Error(
        `Rejected commit mutated state (context=${context}, code=${code})`,
      );
    }
  }
}

function seedBaseTree(core: Core, rootId: ItemId): void {
  const alpha = mkGroup(core, rootId, { label: "alpha" });
  const beta = mkGroup(core, rootId, { label: "beta" });
  const gamma = mkGroup(core, rootId, { label: "gamma" });

  for (let i = 0; i < 8; i += 1) {
    mkBlank(core, alpha, { label: `a${i}`, value: i });
    mkBlank(core, beta, { label: `b${i}`, value: i * 10 });
  }

  const nested = mkGroup(core, gamma, { label: "nested" });
  for (let i = 0; i < 5; i += 1) {
    mkBlank(core, nested, { label: `n${i}`, value: `v${i}` });
  }
}

function nonGroupEditableIds(core: Core, rootId: ItemId): ItemId[] {
  return editableIds(core, rootId).filter(
    (id) => core.item(id).content.type !== "group",
  );
}

function applyValidDeterministicStep(
  core: Core,
  rootId: ItemId,
  rng: Rng,
): void {
  const groups = plainGroupIds(core, rootId);
  const editable = editableIds(core, rootId);
  const nonRootEditable = editable.filter((id) => id !== rootId);
  const nonGroupEditable = nonGroupEditableIds(core, rootId);

  const action = rng.int(8);
  if (action === 0 && groups.length > 0) {
    const parent = rng.pick(groups);
    core.commit((t) => {
      const id = t.insertChild(parent, { at: rng.int(8) });
      t.setValue(id, randomValue(rng));
    });
    return;
  }
  if (action === 1 && nonGroupEditable.length > 0) {
    const id = rng.pick(nonGroupEditable);
    core.commit((t) => t.setValue(id, randomValue(rng)));
    return;
  }
  if (action === 2 && editable.length > 0) {
    const id = rng.pick(editable);
    core.commit((t) => t.setGroup(id));
    return;
  }
  if (action === 3 && nonRootEditable.length > 0) {
    const id = rng.pick(nonRootEditable);
    core.commit((t) => t.remove(id));
    return;
  }
  if (action === 4 && nonGroupEditable.length > 0) {
    const id = rng.pick(nonGroupEditable);
    const expr = rng.chance(0.5) ? "1 + 2" : `${rng.int(500)}`;
    core.commit((t) => t.setConnected(id, { type: "formula", expr }));
    return;
  }
  if (action === 5 && nonGroupEditable.length > 0) {
    const id = rng.pick(nonGroupEditable);
    core.commit((t) =>
      t.setConnected(id, {
        type: "query",
        from: rng.chance(0.5) ? "alpha" : "beta",
        where: "",
        orderBy: "",
      }),
    );
    return;
  }
  if (action === 6 && editable.length > 0) {
    const id = rng.pick(editable);
    const views = [null, "outline", "table", "slider"] as const;
    core.commit((t) => t.setView(id, rng.pick(views)));
    return;
  }
  if (rng.chance(0.5)) core.undo();
  else core.redo();
}

function replayUndoAll(core: Core): void {
  while (core.canUndo()) {
    core.undo();
  }
}

function replayRedoAll(core: Core): void {
  while (core.canRedo()) {
    core.redo();
  }
}

function assertUndoRedoRoundtripNoChange(core: Core): void {
  const before = core.exportSnapshot();
  core.undo();
  const afterUndo = core.exportSnapshot();
  if (JSON.stringify(afterUndo) === JSON.stringify(before)) return;
  core.redo();
  expect(core.exportSnapshot()).toEqual(before);
}

function assertHistoryAlgebraIdentity(core: Core): void {
  const checkpoint = core.exportSnapshot();

  core.undo();
  const afterUndo = core.exportSnapshot();
  if (JSON.stringify(afterUndo) === JSON.stringify(checkpoint)) return;

  core.redo();
  expect(core.exportSnapshot()).toEqual(checkpoint);

  core.undo();
  expect(core.exportSnapshot()).toEqual(afterUndo);

  core.redo();
  expect(core.exportSnapshot()).toEqual(checkpoint);
}

function makeCollabFuzzCore(): {
  core: Core;
  rootId: ItemId;
  deliverRemote: (txn: Transaction) => void;
} {
  let onRemote: ((txn: Transaction) => void) | undefined;
  const collab = {
    origin: "local",
    send(_txn: Transaction) {},
    subscribe(fn: (txn: Transaction) => void) {
      onRemote = fn;
      return () => {
        onRemote = undefined;
      };
    },
  };
  const { shapes } = splitViewRegistrations(viewRegistrations);
  const { core, rootId } = createCore({ shapes, collab });
  const deliverRemote = (txn: Transaction): void => {
    if (!onRemote) throw new Error("No collab subscriber");
    onRemote(txn);
  };
  return { core, rootId, deliverRemote };
}

function entryIdOf(itemId: ItemId): number {
  return Number(itemId.slice(0, itemId.indexOf(":")));
}

function runCollabInterleavingProgram(
  seed: number,
): ReturnType<Core["exportSnapshot"]> {
  const rng = createRng(seed);
  const { core, rootId, deliverRemote } = makeCollabFuzzCore();
  seedBaseTree(core, rootId);

  for (let step = 0; step < 420; step += 1) {
    if (rng.chance(0.65)) {
      applyValidDeterministicStep(core, rootId, rng);
    } else if (rng.chance(0.75)) {
      const ids = editableIds(core, rootId);
      const id = rng.pick(ids);
      const eid = entryIdOf(id);
      deliverRemote({
        ops: [
          {
            type: "patch",
            id: eid,
            next: { label: `remote_${seed}_${step}_${rng.int(1000)}` },
          },
        ],
        meta: { origin: "peer", source: "remote" },
      });
    } else {
      const before = core.exportSnapshot();
      expect(() =>
        deliverRemote({
          ops: [{ type: "patch", id: 9_999_999, next: { label: "bad" } }],
          meta: { origin: "peer", source: "remote" },
        }),
      ).toThrow();
      expect(core.exportSnapshot()).toEqual(before);
    }

    if (step % 30 === 0) {
      assertCoreInvariants(core, rootId);
      assertSelectionValid(core);
      assertUndoRedoRoundtripNoChange(core);
    }
  }

  const snapshot = core.exportSnapshot();
  core.dispose();
  return snapshot;
}

type LoggedCommitAction =
  | {
      type: "insert";
      parentId: ItemId;
      at: number;
      value: true | number | string | null;
      label: string;
    }
  | { type: "setValue"; id: ItemId; value: true | number | string | null }
  | { type: "setGroup"; id: ItemId }
  | { type: "remove"; id: ItemId }
  | { type: "move"; id: ItemId; toParentId: ItemId; at: number }
  | { type: "setFormula"; id: ItemId; expr: string }
  | {
      type: "setQuery";
      id: ItemId;
      from: string;
      where: string;
      orderBy: string;
    }
  | {
      type: "setView";
      id: ItemId;
      view: "outline" | "table" | "slider" | null;
    };
type LoggedCommitOutcome = {
  action: LoggedCommitAction;
  ok: boolean;
  code?: string;
  snapshot: ReturnType<Core["exportSnapshot"]>;
};

function applyLoggedCommitAction(core: Core, action: LoggedCommitAction): void {
  core.commit((t) => {
    if (action.type === "insert") {
      const id = t.insertChild(action.parentId, { at: action.at });
      t.setLabel(id, action.label);
      t.setValue(id, action.value);
      return;
    }
    if (action.type === "setValue") {
      t.setValue(action.id, action.value);
      return;
    }
    if (action.type === "setGroup") {
      t.setGroup(action.id);
      return;
    }
    if (action.type === "remove") {
      t.remove(action.id);
      return;
    }
    if (action.type === "move") {
      t.move(action.id, action.toParentId, { at: action.at });
      return;
    }
    if (action.type === "setFormula") {
      t.setConnected(action.id, { type: "formula", expr: action.expr });
      return;
    }
    if (action.type === "setQuery") {
      t.setConnected(action.id, {
        type: "query",
        from: action.from,
        where: action.where,
        orderBy: action.orderBy,
      });
      return;
    }
    t.setView(action.id, action.view);
  });
}

function executeLoggedCommitAction(
  core: Core,
  action: LoggedCommitAction,
): { ok: boolean; code?: string } {
  const before = core.exportSnapshot();
  try {
    applyLoggedCommitAction(core, action);
    return { ok: true };
  } catch (err) {
    if (!isExpectedCommitRejection(err)) throw err;
    expect(core.exportSnapshot()).toEqual(before);
    const code =
      err instanceof CoreApiError || err instanceof CoreOpError
        ? err.code
        : "UNKNOWN";
    return { ok: false, code };
  }
}

function buildLoggedCommitAction(
  core: Core,
  rootId: ItemId,
  rng: Rng,
  step: number,
): LoggedCommitAction | null {
  const groups = plainGroupIds(core, rootId);
  const editable = editableIds(core, rootId);
  const nonRootEditable = editable.filter((id) => id !== rootId);
  const nonGroupEditable = nonGroupEditableIds(core, rootId);

  const action = rng.int(8);
  if (action === 0 && groups.length > 0) {
    return {
      type: "insert",
      parentId: rng.pick(groups),
      at: rng.int(8),
      value: randomValue(rng),
      label: `lg_${step}_${rng.int(1000)}`,
    };
  }
  if (action === 1 && nonGroupEditable.length > 0) {
    return {
      type: "setValue",
      id: rng.pick(nonGroupEditable),
      value: randomValue(rng),
    };
  }
  if (action === 2 && editable.length > 0) {
    return { type: "setGroup", id: rng.pick(editable) };
  }
  if (action === 3 && nonRootEditable.length > 0) {
    return { type: "remove", id: rng.pick(nonRootEditable) };
  }
  if (action === 4 && nonGroupEditable.length > 0) {
    return {
      type: "setFormula",
      id: rng.pick(nonGroupEditable),
      expr: rng.chance(0.5) ? "1 + 2" : `${rng.int(1000)}`,
    };
  }
  if (action === 5 && nonGroupEditable.length > 0) {
    return {
      type: "setQuery",
      id: rng.pick(nonGroupEditable),
      from: rng.chance(0.5) ? "alpha" : "beta",
      where: rng.chance(0.5) ? "" : "@value > 5",
      orderBy: rng.chance(0.5) ? "" : "@value",
    };
  }
  if (action === 6 && editable.length > 0) {
    const views = [null, "outline", "table", "slider"] as const;
    return { type: "setView", id: rng.pick(editable), view: rng.pick(views) };
  }
  if (nonRootEditable.length > 0 && groups.length > 0) {
    const id = rng.pick(nonRootEditable);
    const toParentId = rng.pick(groups);
    if (id !== toParentId && !isAncestor(core, id, toParentId)) {
      return { type: "move", id, toParentId, at: rng.int(6) };
    }
  }
  return null;
}

function seedScaledTree(
  core: Core,
  rootId: ItemId,
  opts: { groups: number; perGroup: number; depth: number },
): void {
  const makeLevel = (parent: ItemId, depth: number, prefix: string): void => {
    for (let g = 0; g < opts.groups; g += 1) {
      const group = mkGroup(core, parent, { label: `${prefix}g${depth}_${g}` });
      for (let i = 0; i < opts.perGroup; i += 1) {
        mkBlank(core, group, {
          label: `${prefix}v${depth}_${g}_${i}`,
          value: i,
        });
      }
      if (depth > 0) makeLevel(group, depth - 1, `${prefix}${g}_`);
    }
  };
  makeLevel(rootId, opts.depth, "s_");
}

describe("core fuzz/mixed operations", () => {
  test("core-fuzz: deterministic mixed edits, intents, and history preserve invariants", () => {
    const seeds = [0x1234567, 0x89abcde, 0xfeed123, 0x10203040];

    for (const seed of seeds) {
      const rng = createRng(seed);
      const { core, rootId } = makePureCore();
      seedBaseTree(core, rootId);

      for (let step = 0; step < 700; step += 1) {
        const action = rng.int(12);
        const ids = editableIds(core, rootId);
        const groups = editableGroupIds(core, rootId);

        if (action <= 1 && groups.length > 0) {
          const parent = rng.pick(groups);
          commitMaybeReject(
            core,
            (t) => {
              const id = t.insertChild(parent, { at: rng.int(8) });
              t.setLabel(id, `z_${seed}_${step}_${rng.int(100)}`);
              t.setValue(id, randomValue(rng));
            },
            "insert+set",
          );
        } else if (action === 2 && ids.length > 0) {
          const id = rng.pick(ids);
          commitMaybeReject(
            core,
            (t) => t.setLabel(id, `l_${seed}_${step}_${rng.int(1000)}`),
            "setLabel",
          );
        } else if (action === 3 && ids.length > 0) {
          const id = rng.pick(ids);
          commitMaybeReject(
            core,
            (t) => t.setValue(id, randomValue(rng)),
            "setValue",
          );
        } else if (action === 4 && ids.length > 0) {
          const id = rng.pick(ids);
          commitMaybeReject(core, (t) => t.setGroup(id), "setGroup");
        } else if (action === 5 && ids.length > 1 && groups.length > 0) {
          const id = rng.pick(ids.filter((x) => x !== rootId));
          const target = rng.pick(groups);
          if (id && target && id !== target && !isAncestor(core, id, target)) {
            commitMaybeReject(
              core,
              (t) => t.move(id, target, { at: rng.int(6) }),
              "move",
            );
          }
        } else if (action === 6 && ids.length > 1) {
          const id = rng.pick(ids.filter((x) => x !== rootId));
          if (id) commitMaybeReject(core, (t) => t.remove(id), "remove");
        } else if (action === 7 && ids.length > 0) {
          const id = rng.pick(ids);
          const expr = rng.chance(0.4)
            ? "1 + 2"
            : rng.chance(0.5)
              ? "@missing + 1"
              : `${rng.int(20)}`;
          commitMaybeReject(
            core,
            (t) => t.setConnected(id, { type: "formula", expr }),
            "setConnected(formula)",
          );
        } else if (action === 8 && ids.length > 0) {
          const id = rng.pick(ids);
          const from = rng.chance(0.5) ? "alpha" : "beta";
          commitMaybeReject(
            core,
            (t) =>
              t.setConnected(id, {
                type: "query",
                from,
                where: rng.chance(0.5) ? "" : "@value > 10",
                orderBy: rng.chance(0.5) ? "" : "@value",
              }),
            "setConnected(query)",
          );
        } else if (action === 9 && ids.length > 0) {
          const id = rng.pick(ids);
          const views = [null, "outline", "table", "slider"] as const;
          commitMaybeReject(
            core,
            (t) => t.setView(id, rng.pick(views)),
            "setView",
          );
        } else if (action === 10) {
          const selectable = reachableIds(core, rootId);
          const focusId = rng.pick(selectable);
          core.focus({
            type: "item",
            location: { item: focusId, portals: [] },
          });
          core.dispatch(randomIntent(rng));
        } else {
          if (rng.chance(0.5)) core.undo();
          else core.redo();
        }

        if (step % 5 === 0) {
          assertCoreInvariants(core, rootId);
          assertSelectionValid(core);
        }
      }

      assertCoreInvariants(core, rootId);
      assertSelectionValid(core);
      core.dispose();
    }
  });
});

describe("core fuzz/determinism parity", () => {
  test("core-fuzz: same seeded valid program stays identical across two cores", () => {
    const seeds = [0x999001, 0x999002, 0x999003];

    for (const seed of seeds) {
      const a = makePureCore();
      const b = makePureCore();
      seedBaseTree(a.core, a.rootId);
      seedBaseTree(b.core, b.rootId);

      const rngA = createRng(seed);
      const rngB = createRng(seed);
      for (let step = 0; step < 800; step += 1) {
        applyValidDeterministicStep(a.core, a.rootId, rngA);
        applyValidDeterministicStep(b.core, b.rootId, rngB);
        if (step % 25 === 0) {
          expect(a.core.exportSnapshot()).toEqual(b.core.exportSnapshot());
          assertCoreInvariants(a.core, a.rootId);
          assertCoreInvariants(b.core, b.rootId);
          assertSelectionValid(a.core);
          assertSelectionValid(b.core);
        }
      }

      expect(a.core.exportSnapshot()).toEqual(b.core.exportSnapshot());
      a.core.dispose();
      b.core.dispose();
    }
  });
});

describe("core fuzz/snapshot churn", () => {
  test("core-fuzz: repeated export/import roundtrips stay exact under heavy churn", () => {
    const { core, rootId } = makePureCore();
    seedBaseTree(core, rootId);
    const rng = createRng(0xabc12345);

    for (let step = 0; step < 600; step += 1) {
      applyValidDeterministicStep(core, rootId, rng);

      if (step % 20 === 0) {
        const snapshot = core.exportSnapshot();
        const imported = makePureCore();
        imported.core.importSnapshot(snapshot);
        expect(imported.core.exportSnapshot()).toEqual(snapshot);
        assertCoreInvariants(imported.core, imported.rootId);
        assertSelectionValid(imported.core);
        imported.core.dispose();
      }
    }

    assertCoreInvariants(core, rootId);
    assertSelectionValid(core);
    core.dispose();
  });
});

describe("core fuzz/history roundtrip", () => {
  test("core-fuzz: full undo then full redo returns to exact end snapshot", () => {
    const seeds = [0x700001, 0x700002, 0x700003];

    for (const seed of seeds) {
      const { core, rootId } = makePureCore();
      seedBaseTree(core, rootId);
      const rng = createRng(seed);

      for (let step = 0; step < 550; step += 1) {
        applyValidDeterministicStep(core, rootId, rng);
      }

      replayRedoAll(core);
      const end = core.exportSnapshot();
      replayUndoAll(core);
      replayRedoAll(core);
      expect(core.exportSnapshot()).toEqual(end);
      assertCoreInvariants(core, rootId);
      assertSelectionValid(core);
      core.dispose();
    }
  });
});

describe("core fuzz/metamorphic equivalence", () => {
  test("core-fuzz: idempotent and no-op-equivalent programs converge to same state", () => {
    const a = makePureCore();
    const b = makePureCore();
    seedBaseTree(a.core, a.rootId);
    seedBaseTree(b.core, b.rootId);

    const rootA = a.rootId;
    const rootB = b.rootId;

    a.core.commit((t) => t.setGroup(rootA));

    a.core.commit((t) => t.setView(rootA, "table"));
    a.core.commit((t) => t.setView(rootA, "table"));

    b.core.commit((t) => t.setView(rootB, "table"));

    expect(a.core.exportSnapshot()).toEqual(b.core.exportSnapshot());
    assertCoreInvariants(a.core, rootA);
    assertCoreInvariants(b.core, rootB);
    a.core.dispose();
    b.core.dispose();
  });
});

describe("core fuzz/collab interleaving", () => {
  test("core-fuzz: local and remote interleaving remains deterministic and atomically rejects malformed remote txns", () => {
    const s1 = runCollabInterleavingProgram(0xc011ab1);
    const s2 = runCollabInterleavingProgram(0xc011ab1);
    expect(s1).toEqual(s2);
  });
});

describe("core fuzz/seed matrix", () => {
  test("core-fuzz: 25-seed matrix with periodic history sanity checks", () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const { core, rootId } = makePureCore();
      seedBaseTree(core, rootId);
      const rng = createRng(0x500000 + seed);

      for (let step = 0; step < 120; step += 1) {
        applyValidDeterministicStep(core, rootId, rng);
        if (step % 15 === 0) {
          assertCoreInvariants(core, rootId);
          assertSelectionValid(core);
          assertUndoRedoRoundtripNoChange(core);
        }
      }

      core.dispose();
    }
  });
});

describe("core fuzz/atomic failures", () => {
  test("core-fuzz: invalid operations throw and state remains unchanged", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: 1 });
    const b = mkBlank(core, g, { label: "b", value: 2 });

    const beforeDuplicate = core.exportSnapshot();
    expectThrowsWithCode(CoreOpError, "DUPLICATE_CHILD_LABEL", () => {
      core.commit((t) => t.setLabel(b, "a"));
    });
    expect(core.exportSnapshot()).toEqual(beforeDuplicate);

    const beforeSelfMove = core.exportSnapshot();
    expectThrowsWithCode(CoreOpError, "CANNOT_MOVE_INTO_SELF", () => {
      core.commit((t) => t.move(g, g));
    });
    expect(core.exportSnapshot()).toEqual(beforeSelfMove);

    const child = mkGroup(core, g, { label: "child" });
    const beforeDescendantMove = core.exportSnapshot();
    expectThrowsWithCode(CoreOpError, "CANNOT_MOVE_INTO_DESCENDANT", () => {
      core.commit((t) => t.move(g, child));
    });
    expect(core.exportSnapshot()).toEqual(beforeDescendantMove);

    assertCoreInvariants(core, rootId);
    core.dispose();
  });

  test("core-fuzz: failed commit does not advance nextId or leak created ids", () => {
    const { core, rootId } = makePureCore();
    const g = mkGroup(core, rootId, { label: "g" });
    mkBlank(core, g, { label: "a", value: 1 });

    const before = core.exportSnapshot();
    expectThrowsWithCode(CoreOpError, "CANNOT_CONVERT_NONEMPTY_GROUP", () => {
      core.commit((t) => {
        t.insertChild(g);
        t.setConnected(g, { type: "formula", expr: "1" });
      });
    });

    expect(core.exportSnapshot()).toEqual(before);
    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core fuzz/history oracle", () => {
  test("core-fuzz: logged commit program replays exactly on fresh core", () => {
    const seed = 0x44aa77;
    const rng = createRng(seed);
    const a = makePureCore();
    seedBaseTree(a.core, a.rootId);

    const outcomes: LoggedCommitOutcome[] = [];

    for (let step = 0; step < 240; step += 1) {
      const action = buildLoggedCommitAction(a.core, a.rootId, rng, step);
      if (!action) continue;
      const result = executeLoggedCommitAction(a.core, action);
      outcomes.push({
        action,
        ok: result.ok,
        ...(result.code ? { code: result.code } : {}),
        snapshot: a.core.exportSnapshot(),
      });
    }

    const b = makePureCore();
    seedBaseTree(b.core, b.rootId);
    for (const outcome of outcomes) {
      const replayed = executeLoggedCommitAction(b.core, outcome.action);
      expect(replayed.ok).toBe(outcome.ok);
      if (!outcome.ok) expect(replayed.code).toBe(outcome.code);
      expect(b.core.exportSnapshot()).toEqual(outcome.snapshot);
    }
    expect(b.core.exportSnapshot()).toEqual(a.core.exportSnapshot());
    assertCoreInvariants(a.core, a.rootId);
    assertCoreInvariants(b.core, b.rootId);
    a.core.dispose();
    b.core.dispose();
  });
});

describe("core fuzz/pathological transactions", () => {
  test("core-fuzz: long mixed single-commit chains remain atomic and undo-safe", () => {
    const { core, rootId } = makePureCore();
    seedBaseTree(core, rootId);

    for (let i = 0; i < 70; i += 1) {
      const groups = plainGroupIds(core, rootId);
      if (groups.length < 2) break;
      const left = groups[0]!;
      const right = groups[1]!;

      core.commit((t) => {
        const a = t.insertChild(left, { at: 0 });
        const b = t.insertChild(left, { at: 1 });
        t.setLabel(a, `pa_${i}`);
        t.setValue(a, i);
        t.setGroup(a);
        const c = t.insertChild(a, { at: 0 });
        t.setValue(c, `nested_${i}`);
        t.move(b, right, { at: 0 });
        t.setConnected(b, { type: "formula", expr: `${i} + 1` });
        t.remove(a);
        t.setView(right, i % 2 === 0 ? "table" : "outline");
      });

      if (i % 10 === 0) {
        assertCoreInvariants(core, rootId);
        assertSelectionValid(core);
        assertUndoRedoRoundtripNoChange(core);
      }
    }

    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core fuzz/remote malformed multi-op", () => {
  test("core-fuzz: malformed remote multi-op combinations rollback atomically", () => {
    const { core, rootId, deliverRemote } = makeCollabFuzzCore();
    seedBaseTree(core, rootId);
    const ids = editableIds(core, rootId);
    const target = ids.find((id) => id !== rootId)!;
    const targetEid = entryIdOf(target);

    const beforePatchThenBadMove = core.exportSnapshot();
    expect(() =>
      deliverRemote({
        ops: [
          { type: "patch", id: targetEid, next: { label: "remote_pre" } },
          {
            type: "move",
            spec: { childId: 99_999_001, toParentId: targetEid, toIndex: 0 },
          },
        ],
        meta: { origin: "peer", source: "remote" },
      }),
    ).toThrow();
    expect(core.exportSnapshot()).toEqual(beforePatchThenBadMove);

    const group = plainGroupIds(core, rootId).find((id) => id !== rootId)!;
    const child = mkBlank(core, group, { label: "tmp_child", value: 1 });
    const childEid = entryIdOf(child);
    const groupEid = entryIdOf(group);
    const beforeAncestorDescendantRemove = core.exportSnapshot();
    expect(() =>
      deliverRemote({
        ops: [
          { type: "remove", id: groupEid },
          { type: "remove", id: childEid },
        ],
        meta: { origin: "peer", source: "remote" },
      }),
    ).toThrow();
    expect(core.exportSnapshot()).toEqual(beforeAncestorDescendantRemove);

    const beforeDuplicateRemove = core.exportSnapshot();
    expect(() =>
      deliverRemote({
        ops: [
          { type: "remove", id: childEid },
          { type: "remove", id: childEid },
        ],
        meta: { origin: "peer", source: "remote" },
      }),
    ).toThrow();
    expect(core.exportSnapshot()).toEqual(beforeDuplicateRemove);

    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core fuzz/selection heavy", () => {
  test("core-fuzz: repeated focus/editing/navigation with interleaved structural changes keeps selection valid", () => {
    const { core, rootId } = makePureCore();
    seedBaseTree(core, rootId);
    const rng = createRng(0x16c0ffee);

    for (let step = 0; step < 420; step += 1) {
      const ids = reachableIds(core, rootId);
      const id = rng.pick(ids);
      core.focus({ type: "item", location: { item: id, portals: [] } });

      if (rng.chance(0.6)) {
        core.dispatch({ type: "ENTER" });
      }
      core.dispatch(randomIntent(rng));
      if (rng.chance(0.5)) core.dispatch(randomIntent(rng));

      if (rng.chance(0.45)) {
        applyValidDeterministicStep(core, rootId, rng);
      }

      if (step % 7 === 0) {
        assertSelectionValid(core);
        assertCoreInvariants(core, rootId);
      }
    }

    assertSelectionValid(core);
    assertCoreInvariants(core, rootId);
    core.dispose();
  });
});

describe("core fuzz/scale variance", () => {
  test("core-fuzz: same stress program remains valid across tree size/depth variants", () => {
    const configs = [
      { groups: 2, perGroup: 5, depth: 1, steps: 140 },
      { groups: 3, perGroup: 7, depth: 2, steps: 170 },
      { groups: 2, perGroup: 4, depth: 3, steps: 160 },
    ] as const;

    for (let c = 0; c < configs.length; c += 1) {
      for (let seed = 0; seed < 3; seed += 1) {
        const cfg = configs[c]!;
        const { core, rootId } = makePureCore();
        seedScaledTree(core, rootId, cfg);
        const rng = createRng(0x770000 + c * 100 + seed);

        for (let step = 0; step < cfg.steps; step += 1) {
          applyValidDeterministicStep(core, rootId, rng);
          if (step % 20 === 0) {
            assertCoreInvariants(core, rootId);
            assertSelectionValid(core);
          }
        }

        assertCoreInvariants(core, rootId);
        assertSelectionValid(core);
        core.dispose();
      }
    }
  });
});

describe("core fuzz/history algebra", () => {
  test("core-fuzz: randomized evolution preserves undo/redo algebra identities", () => {
    const seeds = [0x61aa01, 0x61aa02, 0x61aa03, 0x61aa04];

    for (const seed of seeds) {
      const { core, rootId } = makePureCore();
      seedBaseTree(core, rootId);
      const rng = createRng(seed);

      for (let step = 0; step < 900; step += 1) {
        applyValidDeterministicStep(core, rootId, rng);
        if (step % 18 === 0) {
          try {
            assertHistoryAlgebraIdentity(core);
          } catch (err) {
            throw new Error(
              `history algebra failed (seed=${seed}, step=${step}): ${String(err)}`,
            );
          }
          assertCoreInvariants(core, rootId);
          assertSelectionValid(core);
        }
      }

      try {
        assertHistoryAlgebraIdentity(core);
      } catch (err) {
        throw new Error(
          `history algebra failed (seed=${seed}, step=final): ${String(err)}`,
        );
      }
      assertCoreInvariants(core, rootId);
      assertSelectionValid(core);
      core.dispose();
    }
  });
});

describe("core fuzz/import reset under churn", () => {
  test("core-fuzz: import during heavy churn resets history cleanly and resumes deterministic evolution", () => {
    const seeds = [0x8c0101, 0x8c0102, 0x8c0103];

    for (const seed of seeds) {
      const { core, rootId } = makePureCore();
      seedBaseTree(core, rootId);
      const rng = createRng(seed);

      for (let step = 0; step < 320; step += 1) {
        applyValidDeterministicStep(core, rootId, rng);
        if (step % 25 === 0) {
          assertCoreInvariants(core, rootId);
          assertSelectionValid(core);
        }
      }

      const checkpoint = core.exportSnapshot();
      core.importSnapshot(checkpoint);
      expect(core.exportSnapshot()).toEqual(checkpoint);

      const afterImport = core.exportSnapshot();
      core.undo();
      expect(core.exportSnapshot()).toEqual(afterImport);
      core.redo();
      expect(core.exportSnapshot()).toEqual(afterImport);

      for (let step = 0; step < 220; step += 1) {
        applyValidDeterministicStep(core, rootId, rng);
        if (step % 20 === 0) {
          assertHistoryAlgebraIdentity(core);
          assertCoreInvariants(core, rootId);
          assertSelectionValid(core);
        }
      }

      assertCoreInvariants(core, rootId);
      assertSelectionValid(core);
      core.dispose();
    }
  });
});
