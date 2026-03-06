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
  sameLocation,
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
import {
  applyTypeToPrimaryTarget,
  getTextForTarget,
  primaryEditTarget,
} from "./editing";

export type NavDirection = "left" | "right" | "up" | "down" | "out";

export type Intent =
  | { type: "NAV"; dir: NavDirection; mode: "step" | "jump" }
  | { type: "CONFIRM"; caret?: number }
  | { type: "TAB"; shift: boolean; caret?: number }
  | { type: "HISTORY"; action: "undo" | "redo" }
  | { type: "TYPE"; char: string }
  | { type: "DELETE"; dir: "backward" | "forward" };

export type KeyIntentInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export function parseKeyIntent(input: KeyIntentInput): Intent | null {
  const isMod = input.metaKey || input.ctrlKey;
  const key = input.key.toLowerCase();

  if (isMod && !input.altKey) {
    if (key === "z") {
      return {
        type: "HISTORY",
        action: input.shiftKey ? "redo" : "undo",
      };
    }
    if (key === "y") {
      return { type: "HISTORY", action: "redo" };
    }
  }

  if (input.key === "Escape") {
    return {
      type: "NAV",
      dir: "out",
      mode: isMod ? "jump" : "step",
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
      mode: isMod ? "jump" : "step",
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

type LocateResult = {
  parentId: ItemId;
  index: number;
  siblings: readonly ItemId[];
};

type SetSelection = (selection: Selection, caret?: number) => void;

function handleNavOut(
  core: Pick<Core, "locate">,
  selection: Selection,
  setSelection: SetSelection,
): boolean {
  if (selection.type === "idle") return true;

  if (selection.type === "editing") {
    setSelection({
      type: "item",
      anchor: selection.location,
      head: selection.location,
    });
    return true;
  }

  if (selection.type === "item") {
    const parentLocation = core.locate(selection.head.item);
    if (!parentLocation) {
      setSelection({ type: "idle" });
      return true;
    }
    setSelection({
      type: "item",
      anchor: {
        item: parentLocation.parentId,
        portals: selection.head.portals,
      },
      head: { item: parentLocation.parentId, portals: selection.head.portals },
    });
    return true;
  }

  return false;
}

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

export function handleItemIntent(args: {
  core: Core;
  sel: Extract<Selection, { type: "item" }>;
  intent: Extract<Intent, { type: "CONFIRM" | "TYPE" }>;
}): boolean {
  const { core, sel, intent } = args;

  const id = sel.head.item;
  const location: Location = sel.head;

  if (intent.type === "TYPE") {
    const item = core.item(id);
    const valueText =
      item.content.type === "value" ? String(item.content.value ?? "") : "";
    const isEmptyPlainValue =
      item.content.type === "value" && valueText.trim() === "";
    const isEmptyPlainGroup =
      item.content.type === "group" && item.content.children.length === 0;

    if (
      intent.char === "=" &&
      item.mode.type === "plain" &&
      (isEmptyPlainValue || isEmptyPlainGroup)
    ) {
      core.commit((t) => t.setConnected(id, { type: "formula", expr: "" }));
      core.focus(
        { type: "editing", location, target: connTarget("expr") },
        { caret: 0 },
      );
      return true;
    }

    const applied = applyTypeToPrimaryTarget(core, id, intent.char);
    if (!applied) return false;
    core.focus(
      { type: "editing", location, target: applied.target },
      { caret: applied.caret },
    );
    return true;
  }

  const target = primaryEditTarget(core, id);
  if (!target) return false;

  const text = getTextForTarget(core, id, target);
  core.focus({ type: "editing", location, target }, { caret: text.length });
  return true;
}

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
  const rootLocation: Location = { item: rootId, portals: [] };
  const selectionController = createSelectionController({
    model,
    rootLocation,
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

  const dispatch = (intent: Intent): void => {
    const sel = peekSelection();

    if (intent.type === "HISTORY") {
      if (intent.action === "undo") undo();
      else redo();
      return;
    }

    if (
      intent.type === "NAV" &&
      intent.dir === "out" &&
      handleNavOut(core, sel, setSelection)
    ) {
      return;
    }

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
  Item,
  ItemId,
  Mode,
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

export { LABEL_TARGET, VALUE_TARGET, connTarget };
export { ITEM_TARGET };
export { sameLocation };
export {
  applyTypeToPrimaryTarget,
  editTargetsForItem,
  fieldsFromConn,
  getTextForTarget,
  indentItemInPlace,
  isNumericLikeValue,
  patchConn,
  primaryEditTarget,
} from "./editing";

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
