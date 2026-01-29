import {
  createModel,
  type Item,
  type ItemId,
  type Scalar,
  type StoredContent,
  type StoredContentSettable,
  type ViewKind,
  type ViewName,
  type SnapshotContent,
  type SnapshotItem,
  type ReparentSpec,
  type ReparentResult,
  type ItemPatch,
  type Op,
  type Transaction,
  type ApplyResult,
  type LocateInOwnerResult,
  type Model,
  isBlankContent,
  isScalarContent,
  isGroupContent,
  isDerivedContent,
  isLensContent,
  isGroupItem,
  normalizeLabel,
} from "./model";

import {
  createEvaluator,
  type Evaluator,
  type Value,
  type LabeledValue,
  type EvalEnv,
  type Interpreter,
  V,
  isPresent,
  isTrue,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
} from "./compute";

import { interpretExpr, builtins } from "./lang";

import {
  createEditor,
  type Editor,
  type EditorRuntime,
  type Selection,
  type Focus,
  type FocusTarget,
  type Caret,
  type Anchor,
  type EditorEffect,
  type CommitHints,
  type NextSelection,
  type NavDir,
  type NavMode,
  type NavOut,
  type ViewKeyResult,
  type View,
  type ViewId,
  type Binding,
  type BindingHandle,
  type EffectsApplier,
  withSelection,
  focusSelection,
  ensureSelection,
  repairSelection,
  caret0,
  caretAt,
  caretRange,
  type CmdResult,
  safeIssue,
  tryCmd,
  applyCmd,
  setIdle,
} from "./runtime";

export type Core = {
  dispose(): void;

  rootId(): ItemId;

  has(id: ItemId): boolean;
  read(id: ItemId): Item;
  peek(id: ItemId): Item;

  contentKindOf(id: ItemId): StoredContent["kind"];
  canEditScalarText(id: ItemId): boolean;

  childIdsOf(groupId: ItemId): ItemId[];
  findChildIdByLabel(groupId: ItemId, label: string): ItemId | null;
  locateInOwner(childId: ItemId): LocateInOwnerResult | null;

  value(id: ItemId): Value;
  valueSignal(id: ItemId): ReturnType<Evaluator["valueSignal"]>;
  itemIdsOf(id: ItemId): ItemId[];

  createId(): ItemId;

  item: {
    blank(id: ItemId): Item;
    group(id: ItemId): Item;
  };

  op: {
    create(item: Item): Op;

    patch(id: ItemId, next: ItemPatch): Op;
    patchLabel(id: ItemId, label: string): Op;
    patchView(id: ItemId, view: ViewKind): Op;
    patchContent(id: ItemId, content: StoredContent): Op;

    reparent(spec: ReparentSpec): Op;
    detach(childId: ItemId): Op;
  };

  txn(ops: readonly Op[], meta?: Transaction["meta"]): Transaction;

  commit(txn: Transaction, hints?: CommitHints): ApplyResult;

  selection(): Selection;
  setSelection(next: Selection, effects?: EditorEffect[]): void;

  snapshot(id: ItemId): SnapshotItem;
  compactUnreachable(): { removed: number; removedIds: ItemId[] };

  normalizeLabel(s: string): string;

  advanced: {
    model: Model;
    evaluator: Evaluator;
    editor: Editor;
    runtime: EditorRuntime;
  };
};

export function createCore(
  opts: {
    model?: Model;
    interpreter?: Interpreter;
    editor?: { runtime?: EditorRuntime };
  } = {},
): Core {
  const model = opts.model ?? createModel();
  const evaluator = createEvaluator({
    model,
    interpret: opts.interpreter ?? interpretExpr,
  });
  const editor = createEditor(model, { runtime: opts.editor?.runtime });

  const api: Core = {
    dispose() {
      evaluator.dispose();
    },

    rootId: () => model.rootId(),

    has: (id) => model.hasItem(id),
    read: (id) => model.readItem(id),
    peek: (id) => model.peekItem(id),

    contentKindOf: (id) => model.contentKindOf(id),
    canEditScalarText: (id) => model.canEditScalarText(id),

    childIdsOf: (groupId) => model.childIdsOf(groupId),
    findChildIdByLabel: (groupId, label) =>
      model.findChildIdByLabel(groupId, label),
    locateInOwner: (childId) => model.locateInOwner(childId),

    value: (id) => evaluator.value(id),
    valueSignal: (id) => evaluator.valueSignal(id),
    itemIdsOf: (id) => evaluator.itemIds(id),

    createId: () => model.createId(),

    item: {
      blank: (id) => model.createItem.blank(id),
      group: (id) => model.createItem.group(id),
    },

    op: {
      create: (item) => model.op.create(item),

      patch: (id, next) => model.op.patch(id, next),
      patchLabel: (id, label) => model.op.patchLabel(id, label),
      patchView: (id, view) => model.op.patchView(id, view),
      patchContent: (id, content) => model.op.patchContent(id, content),

      reparent: (spec) => model.op.reparent(spec),
      detach: (childId) => model.op.detach(childId),
    },

    txn: (ops, meta) => model.op.transaction(ops, meta),

    commit: (txn, hints) => editor.commit(txn, hints),

    selection: () => editor.getSelection(),
    setSelection: (next, effects) => editor.setSelection(next, effects ?? []),

    snapshot: (id) => model.snapshot(id),
    compactUnreachable: () => model.compactUnreachable(),

    normalizeLabel: (s) => model.normalizeLabel(s),

    advanced: {
      model,
      evaluator,
      editor,
      runtime: editor.runtime,
    },
  };

  return api;
}

export type {
  Item,
  ItemId,
  Scalar,
  ViewName,
  ViewKind,
  StoredContent,
  StoredContentSettable,
  SnapshotContent,
  SnapshotItem,
  ItemPatch,
  Op,
  Transaction,
  ApplyResult,
  LocateInOwnerResult,
  ReparentSpec,
  ReparentResult,
  Model,
  Evaluator,
  Value,
  LabeledValue,
  EvalEnv,
  Interpreter,
  Selection,
  Focus,
  FocusTarget,
  Caret,
  Anchor,
  Editor,
  EditorRuntime,
  View,
  ViewId,
  Binding,
  BindingHandle,
  EditorEffect,
  CommitHints,
  NextSelection,
  NavDir,
  NavMode,
  NavOut,
  ViewKeyResult,
  EffectsApplier,
  CmdResult,
};

export {
  isBlankContent,
  isScalarContent,
  isGroupContent,
  isDerivedContent,
  isLensContent,
  isGroupItem,
  normalizeLabel,
  V,
  isPresent,
  isTrue,
  isBlankValue,
  isIssueValue,
  isScalarValue,
  isItemGroupValue,
  isValueGroupValue,
  interpretExpr,
  builtins,
  withSelection,
  focusSelection,
  ensureSelection,
  repairSelection,
  caret0,
  caretAt,
  caretRange,
  safeIssue,
  tryCmd,
  applyCmd,
  setIdle,
  createModel,
  createEvaluator,
  createEditor,
};
