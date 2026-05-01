import type { ReadonlySignal } from "@preact/signals-core";
import { computed } from "@preact/signals-core";

import { createCommitController } from "./commit";
import type { Tx } from "./commit";
import { createEvaluator } from "./eval";
import { interpretExpr } from "./lang";
import type { EntryId, SnapshotData, Transaction, ViewName } from "./model";
import { CoreApiError, createModel, makeItemEntry } from "./model";
import type {
  Connected,
  Content,
  Node,
  NodeId,
  Mode,
  Value,
  ValueOrBlank,
} from "./read";
import {
  CoreReadError,
  createReadApi,
  isCoreReadError,
  nodeIdOf,
  parseNodeId,
  refFromNodeId,
} from "./read";
import {
  createSelectionController,
  LABEL_TARGET,
  sameLocation,
} from "./select";
import type {
  CaretPlacement,
  FocusOpts,
  Location,
  NonEditingFocusSelection,
  Selection,
} from "./select";
import type {
  AnyShapeReader,
  ItemShapeReader,
  ReadFromShape,
  ReaderForShape,
  ValueShapeReader,
  ViewShape,
} from "./shape";
import { createShapeReader, defineShape, isShapeCompatible } from "./shape";
import { primaryHeaderTargetForConn } from "./editing";
import { CONTENT_TEXT_TARGET } from "./select";

export type NavDirection = "left" | "right" | "up" | "down" | "out";

export type IntentRangePoint = { nodeId: NodeId; offset: number };

export type EnterIntentRange = {
  start: IntentRangePoint;
  end: IntentRangePoint;
};

export type Intent =
  | { type: "TYPE"; char: string }
  | { type: "ENTER"; range?: EnterIntentRange | undefined }
  | { type: "NAV"; dir: NavDirection }
  | { type: "DELETE"; dir: "backward" | "forward" }
  | { type: "INSERT"; scope: "after-parent" | "sibling" }
  | { type: "LABEL" }
  | { type: "HISTORY"; action: "undo" | "redo" };

export type KeyIntentInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

export function parseGlobalKeyIntent(input: KeyIntentInput): Intent | null {
  const isMod = input.metaKey || input.ctrlKey;
  const key = input.key.toLowerCase();

  if (isMod && !input.altKey) {
    if (input.key === "Enter") {
      return {
        type: "INSERT",
        scope: input.shiftKey ? "after-parent" : "sibling",
      };
    }
    if (key === "z") {
      return {
        type: "HISTORY",
        action: input.shiftKey ? "redo" : "undo",
      };
    }
    if (key === "y") {
      return { type: "HISTORY", action: "redo" };
    }
    if (key === ".") {
      return { type: "LABEL" };
    }
  }

  if (input.key === "Escape") {
    return {
      type: "NAV",
      dir: "out",
    };
  }
  if (input.key === "Enter") return { type: "ENTER" };

  if (
    !(input.ctrlKey || input.metaKey || input.altKey) &&
    input.key.length === 1
  ) {
    return { type: "TYPE", char: input.key };
  }

  return null;
}

type LocateResult = {
  parentId: NodeId;
  index: number;
  siblings: readonly NodeId[];
};

type SetSelection = (selection: Selection, caret?: CaretPlacement) => void;

function handleNavOut(
  core: Pick<Core, "locate">,
  selection: Selection,
  setSelection: SetSelection,
): boolean {
  if (selection.type === "idle") return true;

  if (selection.type === "editing") {
    setSelection({
      type: "node",
      anchor: selection.location,
      head: selection.location,
    });
    return true;
  }

  if (selection.type === "node") {
    const parentLocation = core.locate(selection.head.node);
    if (!parentLocation) {
      setSelection({ type: "idle" });
      return true;
    }
    setSelection({
      type: "node",
      anchor: {
        node: parentLocation.parentId,
        portals: selection.head.portals,
      },
      head: { node: parentLocation.parentId, portals: selection.head.portals },
    });
    return true;
  }

  return false;
}

export type Core = {
  dispose(): void;

  node(id: NodeId): Node;
  reader<S extends ViewShape>(id: NodeId, shape: S): ReaderForShape<S>;
  view(id: NodeId): ViewName;
  locate(id: NodeId): LocateResult | null;
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
  primaryContentTarget?: (location: Location) => string | null;
  onSelectionChange?: (selection: Selection, caret?: CaretPlacement) => void;
  readCurrentCaret?: () => number | undefined;
  handleIntent?: (selection: Selection, intent: Intent) => void;
  hasTarget?: (location: Location, target: string) => boolean;
};

export type { CorePlatformHooks };

export type CreateCoreOptions = {
  shapes?: Partial<Record<ViewName, ViewShape>>;
  collab?: CollabWire;
  platform?: CorePlatformHooks;
};

function resolvePrimaryTarget(
  core: Core,
  platform: CorePlatformHooks | undefined,
  location: Location,
): string | null {
  const target = platform?.primaryContentTarget?.(location);
  if (target) return target;

  const node = core.node(location.node);
  if (node.mode.type !== "connected") return null;
  return primaryHeaderTargetForConn(node.mode.conn);
}

export function createCore(opts: CreateCoreOptions): {
  core: Core;
  rootId: NodeId;
} {
  const shapes = opts.shapes ?? {};

  const model = createModel();

  const rootEntryId = model.createId();
  model.setRoot(rootEntryId);
  model.apply(
    model.ops.transaction([model.ops.create(makeItemEntry(rootEntryId))]),
  );

  const evaluator = createEvaluator({ model, interpret: interpretExpr });

  let core!: Core;

  const rootId = nodeIdOf(rootEntryId);
  const rootLocation: Location = { node: rootId, portals: [] };
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
    coerceEditingToNode,
    coerceAfterRemoteApply,
    resetToRoot,
  } = selectionController;

  const read = createReadApi({ evaluator, model });

  const node = (id: NodeId): Node => read.node(id);

  const viewSignalCache = new Map<EntryId, ReadonlySignal<ViewName>>();

  const view = (id: NodeId): ViewName => {
    const ref = refFromNodeId(id);
    if (ref.path.length) {
      node(id);
      return "outline";
    }
    const eid = ref.entryId;
    if (!model.hasEntry(eid))
      throw new CoreReadError("UNKNOWN_NODE_ID", "Unknown node id");

    let sig = viewSignalCache.get(eid);
    if (!sig) {
      sig = computed(() => {
        if (!model.hasEntry(eid)) return "outline";

        const vk = model.entrySignal(eid).value.view;
        const wanted = vk ?? "outline";
        if (wanted === "outline") return "outline";
        const shape = shapes[wanted];
        if (!shape) return wanted;
        return isShapeCompatible(read, nodeIdOf(eid), shape)
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
    coerceEditingToNode,
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
    id: NodeId,
    shape: S,
  ): ReaderForShape<S> => createShapeReader(read, id, shape);

  const locate = (id: NodeId): LocateResult | null => {
    const ref = parseNodeId(id);
    if (!ref || ref.path.length) return null;

    const loc = model.locateInParent(ref.entryId);
    if (!loc) return null;

    return {
      parentId: nodeIdOf(loc.parentId),
      index: loc.index,
      siblings: loc.childIds.map((eid) => nodeIdOf(eid)),
    };
  };

  const unsubscribeCollab = opts.collab
    ? opts.collab.subscribe((txn) => {
        applyRemote(txn);
      })
    : null;

  const dispatch = (intent: Intent): void => {
    const sel = peekSelection();
    const location =
      sel.type === "editing"
        ? sel.location
        : sel.type === "node"
          ? sel.head
          : null;

    if (intent.type === "HISTORY") {
      if (intent.action === "undo") undo();
      else redo();
      return;
    }

    if (intent.type === "LABEL") {
      if (!location) return;
      if (opts.platform?.hasTarget?.(location, LABEL_TARGET) ?? true) {
        focus(
          { type: "editing", location, target: LABEL_TARGET },
          { caret: "end" },
        );
      } else {
        opts.platform?.handleIntent?.(sel, intent);
      }
      return;
    }

    if (
      intent.type === "NAV" &&
      intent.dir === "out" &&
      handleNavOut(core, sel, setSelection)
    ) {
      return;
    }

    if (sel.type === "node" && location) {
      const primaryTarget = resolvePrimaryTarget(core, opts.platform, location);

      if (intent.type === "TYPE" && primaryTarget === CONTENT_TEXT_TARGET) {
        core.commit((t) => t.setValue(location.node, intent.char));
        core.focus(
          { type: "editing", location, target: primaryTarget },
          { caret: intent.char.length },
        );
        return;
      }

      if (intent.type === "ENTER" && primaryTarget) {
        core.focus(
          { type: "editing", location, target: primaryTarget },
          { caret: "end" },
        );
        return;
      }
    }

    opts.platform?.handleIntent?.(sel, intent);
  };

  core = {
    dispose() {
      unsubscribeCollab?.();
      evaluator.dispose();
      viewSignalCache.clear();
    },

    node,
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
  CaretPlacement,
  Connected,
  Content,
  FocusOpts,
  Location,
  ItemShapeReader,
  Node,
  NodeId,
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

export {
  CONTENT_TEXT_TARGET,
  contentTarget,
  NODE_TARGET,
  LABEL_TARGET,
  connTarget,
} from "./select";
export { sameLocation };
export {
  indentNodeInPlace,
  isNumericLikeValue,
  patchConn,
  primaryHeaderTargetForConn,
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
