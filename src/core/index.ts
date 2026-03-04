import type { ReadonlySignal } from "@preact/signals-core";
import { computed } from "@preact/signals-core";

import { createCommitController } from "./commit";
import type { Tx } from "./commit";
import { createEvaluator } from "./eval";
import { interpretExpr } from "./lang";
import type { EntryId, SnapshotData, Transaction, ViewName } from "./model";
import { CoreApiError, createModel, makeGroupEntry } from "./model";
import type {
  Connected,
  Content,
  Item,
  ItemId,
  Mode,
  Value,
  ValueOrBlank,
} from "./read";
import {
  CoreReadError,
  createReadApi,
  entryIdFromItemId,
  isCoreReadError,
  itemIdOf,
  parseItemId,
  refFromItemId,
} from "./read";
import {
  connTarget,
  createSelectionController,
  ITEM_TARGET,
  LABEL_TARGET,
  VALUE_TARGET,
} from "./select";
import type {
  FocusOpts,
  Location,
  NonEditingFocusSelection,
  Selection,
} from "./select";
import type {
  AnyShapeReader,
  GroupShapeReader,
  ReadFromShape,
  ReaderForShape,
  ValueShapeReader,
  ViewShape,
} from "./shape";
import { createShapeReader, defineShape, isShapeCompatible } from "./shape";

type NavDir = "left" | "right" | "up" | "down" | "out";

type Intent =
  | { type: "NAV"; dir: NavDir; mode: "step" | "jump" }
  | { type: "CONFIRM"; caret?: number }
  | { type: "TAB"; shift: boolean; caret?: number }
  | { type: "TYPE"; char: string }
  | { type: "DELETE"; dir: "backward" | "forward" };

type KeyIntentInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

function parseKeyIntent(input: KeyIntentInput): Intent | null {
  if (input.key === "Escape") {
    return {
      type: "NAV",
      dir: "out",
      mode: input.metaKey || input.ctrlKey ? "jump" : "step",
    };
  }
  if (input.key === "Tab") return { type: "TAB", shift: !!input.shiftKey };
  if (input.key === "Enter") return { type: "CONFIRM" };

  if (input.key === "Backspace") return { type: "DELETE", dir: "backward" };
  if (input.key === "Delete") return { type: "DELETE", dir: "forward" };

  let dir: "left" | "right" | "up" | "down" | null = null;
  switch (input.key) {
    case "ArrowLeft":
      dir = "left";
      break;
    case "ArrowRight":
      dir = "right";
      break;
    case "ArrowUp":
      dir = "up";
      break;
    case "ArrowDown":
      dir = "down";
      break;
  }
  if (dir) {
    return {
      type: "NAV",
      dir,
      mode: input.metaKey || input.ctrlKey ? "jump" : "step",
    };
  }

  if (
    !(input.ctrlKey || input.metaKey || input.altKey) &&
    input.key.length === 1
  ) {
    return { type: "TYPE", char: input.key };
  }

  return null;
}

const NUMERIC_VALUE_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function isNumericLikeValue(value: ValueOrBlank): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return false;
  if (!NUMERIC_VALUE_RE.test(t)) return false;
  return Number.isFinite(Number(t));
}

type LocateResult = {
  parentId: ItemId;
  index: number;
  siblings: readonly ItemId[];
};

export type Core = {
  dispose(): void;

  item(id: ItemId): Item;
  reader<S extends ViewShape>(id: ItemId, shape: S): ReaderForShape<S>;
  view(id: ItemId): ViewName;
  locate(id: ItemId): LocateResult | null;
  selection(): Selection;

  focus(
    selection: Extract<Selection, { type: "editing" }>,
    opts?: FocusOpts,
  ): void;
  focus(selection: NonEditingFocusSelection, opts?: never): void;
  dispatch(intent: Intent): void;

  commit(run: (t: Tx) => void): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undoBoundary(): void;

  exportSnapshot(): SnapshotData;
  importSnapshot(snapshot: SnapshotData): void;
};

type ConnField = {
  key: string;
  label: string;
  multiline: boolean;
  text: string;
};

export function fieldsFromConn(conn: Connected): ConnField[] {
  if (conn.type === "formula") {
    return [
      { key: "expr", label: "=", multiline: false, text: conn.expr ?? "" },
    ];
  }
  return [
    { key: "from", label: "~", multiline: false, text: conn.from ?? "" },
    { key: "where", label: "where:", multiline: false, text: conn.where ?? "" },
    {
      key: "orderBy",
      label: "orderBy:",
      multiline: false,
      text: conn.orderBy ?? "",
    },
  ];
}

export function editTargetsForItem(core: Core, id: ItemId): string[] {
  const snapshot = core.item(id);
  if (snapshot.mode.type === "connected") {
    return fieldsFromConn(snapshot.mode.conn).map((field) =>
      connTarget(field.key),
    );
  }
  if (snapshot.mode.type === "plain" && snapshot.content.type === "value")
    return [VALUE_TARGET];
  return [];
}

export function primaryEditTarget(core: Core, id: ItemId): string | null {
  return editTargetsForItem(core, id)[0] ?? null;
}

export function getTextForTarget(
  core: Core,
  id: ItemId,
  target: string,
): string {
  const snapshot = core.item(id);
  if (target === VALUE_TARGET) {
    return snapshot.content.type === "value"
      ? String(snapshot.content.value ?? "")
      : "";
  }
  if (target === LABEL_TARGET) return snapshot.label ?? "";
  if (!target.startsWith("conn:") || snapshot.mode.type !== "connected")
    return "";
  const key = target.slice("conn:".length);
  return (
    fieldsFromConn(snapshot.mode.conn).find((field) => field.key === key)
      ?.text ?? ""
  );
}

export function indentItemInPlace(core: Core, id: ItemId): ItemId | null {
  const snap = core.item(id);
  if (snap.mode.type !== "plain") return null;
  if (snap.content.type === "issue") return null;

  const value = snap.content.type === "value" ? snap.content.value : null;
  const children =
    snap.content.type === "group" ? [...snap.content.children] : null;

  let childId: ItemId | null = null;
  core.commit((t) => {
    t.setGroup(id);
    childId = t.insertChild(id, { at: 0 });
    if (!children) {
      t.setValue(childId, value);
      return;
    }
    t.setGroup(childId);
    for (let i = 0; i < children.length; i += 1) {
      t.move(children[i]!, childId, { at: i });
    }
  });

  return childId;
}

export function patchConn(
  conn: Connected,
  key: string,
  text: string,
): Connected {
  if (conn.type === "formula") {
    if (key !== "expr") return conn;
    return { type: "formula", expr: text };
  }
  if (key === "from") return { ...conn, from: text };
  if (key === "where") return { ...conn, where: text };
  if (key === "orderBy") return { ...conn, orderBy: text };
  return conn;
}

export function applyTypeToPrimaryTarget(
  core: Core,
  id: ItemId,
  char: string,
): { target: string; caret: number } | null {
  const target = primaryEditTarget(core, id);
  if (!target) return null;
  const caret = char.length;

  if (target === VALUE_TARGET) {
    core.commit((t) => t.setValue(id, char));
    return { target, caret };
  }

  if (!target.startsWith("conn:")) return null;

  const key = target.slice("conn:".length);
  const snap = core.item(id);
  if (snap.mode.type !== "connected") return null;

  const nextConn = patchConn(snap.mode.conn, key, char);
  core.commit((t) => t.setConnected(id, nextConn));

  return { target, caret };
}

export type CollabWire = {
  origin: string;
  send(txn: Transaction): void;
  subscribe(onTxn: (txn: Transaction) => void): () => void;
};

type CorePlatformHooks = {
  onSelectionChange?: (selection: Selection, caret?: number) => void;
  readCurrentCaret?: () => number | undefined;
  resolveIntentHandler?: (
    selection: Selection,
  ) => ((intent: Intent) => void) | null;
};

export type { CorePlatformHooks };

export type CreateCoreOptions = {
  shapes?: Partial<Record<ViewName, ViewShape>>;
  collab?: CollabWire;
  platform?: CorePlatformHooks;
};

export function createCore(opts: CreateCoreOptions): {
  core: Core;
  rootId: ItemId;
} {
  const shapes = opts.shapes ?? {};

  const model = createModel();

  const rootEntryId = model.createId();
  model.setRoot(rootEntryId);
  model.apply(
    model.ops.transaction([model.ops.create(makeGroupEntry(rootEntryId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const rootId = itemIdOf(rootEntryId);
  const rootFocus: Location = { item: rootId, portals: [] };
  const selectionController = createSelectionController({
    model,
    rootFocus,
    ...(opts.platform?.readCurrentCaret
      ? { readCurrentCaret: opts.platform.readCurrentCaret }
      : {}),
    ...(opts.platform?.onSelectionChange
      ? { onSelectionChange: opts.platform.onSelectionChange }
      : {}),
  });
  const {
    selection,
    focus,
    setSelection,
    peekSelection,
    captureRepairAnchor,
    repairAfterLocalApply,
    coerceEditingToItem,
    coerceAfterRemoteApply,
    resetToRoot,
  } = selectionController;

  const read = createReadApi({ evaluator, model });

  const item = (id: ItemId): Item => read.item(id);

  const viewSignalCache = new Map<EntryId, ReadonlySignal<ViewName>>();

  const view = (id: ItemId): ViewName => {
    const ref = refFromItemId(id);
    if (ref.path.length) {
      item(id);
      return "outline";
    }
    const eid = ref.entryId;
    if (!model.hasEntry(eid))
      throw new CoreReadError("UNKNOWN_ITEM_ID", "Unknown entry id");

    let sig = viewSignalCache.get(eid);
    if (!sig) {
      sig = computed(() => {
        if (!model.hasEntry(eid)) return "outline";

        const vk = model.entrySignal(eid).value.view;
        const wanted = vk ?? "outline";
        if (wanted === "outline") return "outline";
        const shape = shapes[wanted];
        if (!shape) return wanted;
        return isShapeCompatible(read, itemIdOf(eid), shape)
          ? wanted
          : "outline";
      });
      viewSignalCache.set(eid, sig);
    }

    return sig.value;
  };

  const clearCachesForRemovedEntries = (
    removedIds: readonly EntryId[],
  ): void => {
    if (!removedIds.length) return;
    evaluator.prune(removedIds);
    for (const id of removedIds) viewSignalCache.delete(id);
  };
  const {
    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    undoBoundary,
    applyRemote,
    resetState: resetCommitState,
  } = createCommitController({
    model,
    shapes,
    getSelection: () => peekSelection(),
    ...(opts.platform?.readCurrentCaret
      ? { readCurrentCaret: opts.platform.readCurrentCaret }
      : {}),
    restoreSelectionIfValid: (snapshot) => {
      if (snapshot.selection.type === "editing") {
        setSelection(snapshot.selection, snapshot.caret);
        return;
      }
      setSelection(snapshot.selection);
    },
    captureRepairAnchor,
    repairAfterLocalApply,
    coerceEditingToItem,
    coerceAfterRemoteApply,
    clearCachesForRemovedEntries,
    ...(opts.collab ? { collab: opts.collab } : {}),
  });

  const exportSnapshot = (): SnapshotData => model.exportSnapshot();

  const importSnapshot = (snapshot: SnapshotData): void => {
    if (snapshot.rootId !== rootEntryId) {
      throw new CoreApiError(
        "SNAPSHOT_ROOT_MISMATCH",
        "snapshot.rootId must match core root id",
      );
    }

    model.replaceState(snapshot);
    evaluator.dispose();
    viewSignalCache.clear();
    resetCommitState();
    resetToRoot();
  };

  const reader = <S extends ViewShape>(
    id: ItemId,
    shape: S,
  ): ReaderForShape<S> => {
    read.item(id);
    return createShapeReader(read, id, shape);
  };

  const locate = (id: ItemId): LocateResult | null => {
    const ref = parseItemId(id);
    if (!ref || ref.path.length) return null;

    const loc = model.locateInParent(ref.entryId);
    if (!loc) return null;

    return {
      parentId: itemIdOf(loc.parentId),
      index: loc.index,
      siblings: loc.childIds.map((eid) => itemIdOf(eid)),
    };
  };

  const unsubscribeCollab = opts.collab
    ? opts.collab.subscribe((txn) => {
        applyRemote(txn);
      })
    : null;

  const handleRootIntent = (intent: Intent, sel: Selection): boolean => {
    if (
      sel.type !== "item" ||
      sel.anchor.item !== rootId ||
      sel.anchor.portals.length !== 0 ||
      sel.head.item !== rootId ||
      sel.head.portals.length !== 0
    ) {
      return false;
    }
    const rootItem = item(rootId);

    switch (intent.type) {
      case "NAV": {
        if (intent.dir === "out") return false;
        if (intent.dir !== "right") return false;
        if (rootItem.content.type !== "group") return false;
        const firstChildId = rootItem.content.children[0] ?? null;
        if (!firstChildId) return false;
        const firstChild: Location = { item: firstChildId, portals: [] };

        setSelection({ type: "item", anchor: firstChild, head: firstChild });
        return true;
      }

      case "TAB": {
        if (intent.shift) return false;

        const wrappedId = indentItemInPlace(core, rootId);
        if (wrappedId) {
          setSelection({
            type: "item",
            anchor: { item: wrappedId, portals: [] },
            head: { item: wrappedId, portals: [] },
          });
        }
        return true;
      }

      case "CONFIRM":
      case "TYPE": {
        const rootIsEditable = rootItem.mode.type !== "readonly";
        const rootIsEmptyGroup =
          rootItem.content.type === "group" &&
          rootItem.content.children.length === 0;

        let target: string;
        let caret: number;

        if (rootIsEditable && rootIsEmptyGroup) {
          if (intent.type === "TYPE") {
            core.commit((t) => t.setValue(rootId, intent.char));
            target = VALUE_TARGET;
            caret = intent.char.length;
          } else {
            core.commit((t) => t.setValue(rootId, ""));
            target = VALUE_TARGET;
            caret = 0;
          }
        } else {
          const t = primaryEditTarget(core, rootId);
          if (!t) {
            if (
              intent.type === "CONFIRM" &&
              rootItem.content.type === "group"
            ) {
              const firstChildId = rootItem.content.children[0] ?? null;
              if (!firstChildId) return false;
              const firstChild: Location = { item: firstChildId, portals: [] };

              setSelection({
                type: "item",
                anchor: firstChild,
                head: firstChild,
              });
              return true;
            }
            return false;
          }

          target = t;
          if (intent.type === "CONFIRM") {
            const pos = getTextForTarget(core, rootId, target).length;
            caret = pos;
          } else {
            const applied = applyTypeToPrimaryTarget(core, rootId, intent.char);
            if (!applied) return false;
            target = applied.target;
            caret = applied.caret;
          }
        }

        setSelection({ type: "editing", location: rootFocus, target }, caret);

        return true;
      }

      default:
        return false;
    }
  };

  const handleNavOut = (sel: Selection): boolean => {
    if (sel.type === "idle") return true;

    if (sel.type === "editing") {
      setSelection({ type: "item", anchor: sel.location, head: sel.location });
      return true;
    }

    if (sel.type === "item") {
      const itemEid = entryIdFromItemId(sel.head.item);
      if (itemEid == null) {
        setSelection({ type: "idle" });
        return true;
      }
      const parentLoc = model.locateInParent(itemEid);
      if (!parentLoc) {
        setSelection({ type: "idle" });
        return true;
      }
      const parentId = itemIdOf(parentLoc.parentId);
      setSelection({
        type: "item",
        anchor: { item: parentId, portals: sel.head.portals },
        head: { item: parentId, portals: sel.head.portals },
      });
      return true;
    }

    return false;
  };

  const dispatch = (intent: Intent): void => {
    const sel = peekSelection();

    if (intent.type === "NAV" && intent.dir === "out" && handleNavOut(sel)) {
      return;
    }

    if (handleRootIntent(intent, sel)) return;

    opts.platform?.resolveIntentHandler?.(sel)?.(intent);
  };

  core = {
    dispose() {
      unsubscribeCollab?.();
      evaluator.dispose();
      viewSignalCache.clear();
    },

    item,
    reader,
    view,
    locate,
    selection,

    focus,
    dispatch,

    commit,
    undo,
    redo,
    canUndo,
    canRedo,
    undoBoundary,

    exportSnapshot,
    importSnapshot,
  };

  return { core, rootId };
}

export type {
  AnyShapeReader,
  Connected,
  Content,
  Location,
  GroupShapeReader,
  Intent,
  Item,
  ItemId,
  KeyIntentInput,
  Mode,
  NavDir,
  ReadFromShape,
  Selection,
  SnapshotData,
  ReaderForShape,
  Transaction,
  Tx,
  Value,
  ValueOrBlank,
  ValueShapeReader,
  ViewName,
  ViewShape,
};

export { LABEL_TARGET, VALUE_TARGET, connTarget, parseKeyIntent };
export { ITEM_TARGET };

export { isCoreReadError };
export type { CoreReadErrorCode } from "./read";
export { CoreReadError } from "./read";
export type { CoreApiErrorCode, CoreOpErrorCode } from "./model";
export {
  CoreApiError,
  CoreOpError,
  isCoreApiError,
  isCoreOpError,
} from "./model";
export { CoreInvariantError, isCoreInvariantError } from "../dev";
export { defineShape };
