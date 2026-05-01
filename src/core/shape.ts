import { CoreInvariantError } from "../dev";
import type { EntryContent, EntryId, Model, Op, ViewName } from "./model";
import {
  isFormulaContent,
  isItemContent,
  isQueryContent,
  makeBlankEntry,
  normalizeLabel,
} from "./model";
import { CoreReadError } from "./read";
import type { NodeId, ReadApi } from "./read";

type ChildSlotSchema = {
  label: string | null;
  normalizedLabel: string | null;
};

export type ViewShape = { type: "any" } | { type: "value" } | ItemViewShape;

type ItemViewShape =
  | { type: "item"; children: ViewShape; nonEmpty?: true }
  | {
      type: "item";
      children: ItemViewShape;
      nonEmpty?: true;
      alignChildren?: true;
    };

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
type ChildListForGroup<G extends ItemViewShape, T> = G extends {
  nonEmpty: true;
}
  ? NonEmptyReadonlyArray<T>
  : readonly T[];
type ChildShapeOfGroup<G extends ItemViewShape> = G["children"];
type ReadChildOfGroup<G extends ItemViewShape> = ReadFromShape<G["children"]>;

type ReadShapeAny = { type: "any"; id: NodeId };

type ReadShapeValue = {
  type: "value";
  id: NodeId;
  value: true | number | string | null;
};

type ReadShapeItem<G extends ItemViewShape, Child> = {
  type: "item";
  id: NodeId;
  children: ChildListForGroup<G, Child>;
};

export type ReadFromShape<S extends ViewShape> = S extends { type: "any" }
  ? ReadShapeAny
  : S extends { type: "value" }
    ? ReadShapeValue
    : S extends ItemViewShape
      ? ReadShapeItem<S, ReadChildOfGroup<S>>
      : never;

type BaseShapeReader = { readonly id: NodeId; label(): string | null };

export type AnyShapeReader = BaseShapeReader;

export type ValueShapeReader = BaseShapeReader & {
  value(): ReadShapeValue["value"];
};

export type ItemShapeReader<G extends ItemViewShape> = BaseShapeReader & {
  childIds(): ChildListForGroup<G, NodeId>;
  child(id: NodeId): ReaderForShape<ChildShapeOfGroup<G>>;
};

export type ReaderForShape<S extends ViewShape> = S extends { type: "any" }
  ? AnyShapeReader
  : S extends { type: "value" }
    ? ValueShapeReader
    : S extends ItemViewShape
      ? ItemShapeReader<S>
      : never;

export function defineShape<const S extends ViewShape>(shape: S): S {
  return shape;
}

export function createShapeReader<S extends ViewShape>(
  read: ReadApi,
  id: NodeId,
  shape: S,
): ReaderForShape<S> {
  const readLabel = (nodeId: NodeId): string | null =>
    read.node(nodeId).label ?? null;

  const readValue = (nodeId: NodeId): ReadShapeValue["value"] => {
    const node = read.node(nodeId);
    if (node.content.type === "value") return node.content.value;
    throw new CoreReadError(
      "CONTENT_MISMATCH",
      "Shape reader expected value content",
    );
  };

  const childIdsOfGroup = (nodeId: NodeId): readonly NodeId[] => {
    const node = read.node(nodeId);
    if (node.content.type !== "item")
      throw new CoreReadError(
        "CONTENT_MISMATCH",
        "Shape reader expected item content",
      );
    return node.content.children;
  };

  const build = <T extends ViewShape>(
    nodeId: NodeId,
    nodeShape: T,
  ): ReaderForShape<T> => {
    if (nodeShape.type === "any") {
      return {
        id: nodeId,
        label: () => readLabel(nodeId),
      } as ReaderForShape<T>;
    }

    if (nodeShape.type === "value") {
      return {
        id: nodeId,
        label: () => readLabel(nodeId),
        value: () => readValue(nodeId),
      } as ReaderForShape<T>;
    }

    const childShape = nodeShape.children;
    return {
      id: nodeId,
      label: () => readLabel(nodeId),
      childIds: () =>
        childIdsOfGroup(nodeId) as ChildListForGroup<
          Extract<T, ItemViewShape>,
          NodeId
        >,
      child: (cid: NodeId) => {
        if (!childIdsOfGroup(nodeId).includes(cid))
          throw new CoreReadError(
            "SHAPE_CHILD_NOT_FOUND",
            "Shape reader child id not found",
          );
        return build(cid, childShape);
      },
    } as unknown as ReaderForShape<T>;
  };

  return build(id, shape);
}

export function isShapeCompatible(
  read: ReadApi,
  id: NodeId,
  shape: ViewShape,
): boolean {
  const childSlotSchema = (itemId: NodeId): ChildSlotSchema[] => {
    const item = read.node(itemId);
    if (item.content.type !== "item") return [];
    const out: ChildSlotSchema[] = [];
    for (const childId of item.content.children) {
      const rawLabel = read.node(childId).label ?? null;
      const normalizedLabel = normalizeLabel(rawLabel ?? "");
      out.push({
        label: rawLabel,
        normalizedLabel: normalizedLabel || null,
      });
    }
    return out;
  };

  const node = read.node(id);

  if (shape.type === "any") return true;
  if (shape.type === "value") return node.content.type === "value";
  if (node.content.type !== "item") return false;
  if (shape.nonEmpty && node.content.children.length === 0) return false;

  if ("alignChildren" in shape && shape.alignChildren) {
    const childItemIds = node.content.children;
    const leaderChildItemId = childItemIds[0] ?? null;
    if (!leaderChildItemId) return true;
    const schema = childSlotSchema(leaderChildItemId);

    for (let i = 1; i < childItemIds.length; i += 1) {
      const childItemId = childItemIds[i]!;
      const slots = childSlotSchema(childItemId);
      if (slots.length !== schema.length) return false;
      for (let j = 0; j < schema.length; j += 1) {
        if (slots[j]!.normalizedLabel !== schema[j]!.normalizedLabel) {
          return false;
        }
      }
    }
  }

  for (const childId of node.content.children) {
    if (!isShapeCompatible(read, childId, shape.children)) return false;
  }

  return true;
}

export function enforceViewShapes(
  model: Model,
  shapes: Partial<Record<ViewName, ViewShape>>,
  touched: readonly EntryId[],
  applyOps: (ops: Op[]) => void,
): void {
  const MAX_ENFORCE_PASSES_PER_ROOT = 64;
  const relevantRootCandidates = new Set<EntryId>();
  for (const id of touched) {
    let cur: EntryId | null = id;
    while (cur != null && model.hasEntry(cur)) {
      relevantRootCandidates.add(cur);
      cur = model.peekEntry(cur).parentId;
    }
  }

  const isPlain = (id: EntryId): boolean => {
    const content = model.peekEntry(id).content;
    return (
      content.type === "blank" ||
      content.type === "scalar" ||
      content.type === "item"
    );
  };

  let appliedInPass = false;
  const applyIfAny = (ops: Op[]): void => {
    if (!ops.length) return;
    appliedInPass = true;
    applyOps(ops);
  };

  const clearConstraintRootView = (constraintRootId: EntryId): boolean => {
    if (!model.hasEntry(constraintRootId)) return false;
    if (model.peekEntry(constraintRootId).view == null) return false;
    applyOps([model.ops.patch(constraintRootId, { view: null })]);
    return true;
  };

  const childIdsOfGroup = (itemId: EntryId): EntryId[] => {
    if (!model.hasEntry(itemId)) return [];
    const entry = model.peekEntry(itemId);
    if (!isItemContent(entry.content)) return [];
    const out: EntryId[] = [];
    for (const childId of entry.content.childIds) {
      if (!model.hasEntry(childId)) continue;
      out.push(childId);
    }
    return out;
  };

  const childSlotSchema = (itemId: EntryId): ChildSlotSchema[] => {
    const schema: ChildSlotSchema[] = [];
    for (const cid of childIdsOfGroup(itemId)) {
      const rawLabel = model.peekEntry(cid).label;
      const normalizedLabel = normalizeLabel(rawLabel);
      schema.push({
        label: rawLabel,
        normalizedLabel: normalizedLabel || null,
      });
    }
    return schema;
  };

  const constraintRootStillConstrained = (
    constraintRootId: EntryId,
  ): boolean => {
    if (!model.hasEntry(constraintRootId)) return false;
    return model.peekEntry(constraintRootId).view != null;
  };

  const enforceNodeType = (
    constraintRootId: EntryId,
    id: EntryId,
    shape: ViewShape,
  ): boolean => {
    if (!constraintRootStillConstrained(constraintRootId)) return false;
    if (!model.hasEntry(id)) return true;
    if (shape.type === "any") return true;

    if (!isPlain(id)) return constraintRootStillConstrained(constraintRootId);

    const content = model.peekEntry(id).content;

    if (shape.type === "item" && !isItemContent(content)) {
      applyOps([
        model.ops.patch(id, { content: { type: "item", childIds: [] } }),
      ]);
      return constraintRootStillConstrained(constraintRootId);
    }

    if (shape.type === "value" && isItemContent(content)) {
      if (content.childIds.length === 0) {
        applyOps([model.ops.patch(id, { content: { type: "blank" } })]);
      } else {
        clearConstraintRootView(constraintRootId);
        return false;
      }
    }

    return constraintRootStillConstrained(constraintRootId);
  };

  const enforceNonEmpty = (
    id: EntryId,
    shape: Extract<ViewShape, { type: "item" }>,
  ): void => {
    if (!model.hasEntry(id)) return;
    const entry = model.peekEntry(id);
    if (!isItemContent(entry.content)) return;

    if (shape.nonEmpty && entry.content.childIds.length === 0) {
      const newId = model.createId();
      applyOps([
        model.ops.create(makeBlankEntry(newId)),
        model.ops.move({ childId: newId, toParentId: id }),
      ]);
    }
  };

  const contentMatches = (a: EntryContent, b: EntryContent): boolean => {
    if (a.type !== b.type) return false;
    if (isFormulaContent(a) && isFormulaContent(b)) return a.expr === b.expr;
    if (isQueryContent(a) && isQueryContent(b))
      return (
        a.from === b.from && a.where === b.where && a.orderBy === b.orderBy
      );
    return true;
  };

  const enqueueAlignChildrenOps = (itemId: EntryId, out: Op[]): void => {
    const childItemIds = childIdsOfGroup(itemId).filter((childItemId) =>
      isItemContent(model.peekEntry(childItemId).content),
    );
    if (childItemIds.length < 2) return;
    const childItemIdSet = new Set(childItemIds);

    const touchedChildItems = new Set<EntryId>();
    for (const touchedId of touched) {
      let cur: EntryId | null = touchedId;
      while (cur != null && model.hasEntry(cur)) {
        if (childItemIdSet.has(cur)) {
          touchedChildItems.add(cur);
          break;
        }
        const parentId: EntryId | null = model.peekEntry(cur).parentId;
        if (parentId === itemId) break;
        cur = parentId;
      }
    }

    const touchedChildItemWithChildren = childItemIds.find(
      (childItemId) =>
        touchedChildItems.has(childItemId) &&
        model.childIdsOf(childItemId).length > 0,
    );
    const touchedChildItem = childItemIds.find((childItemId) =>
      touchedChildItems.has(childItemId),
    );
    const childItemWithChildren = childItemIds.find(
      (childItemId) => model.childIdsOf(childItemId).length > 0,
    );
    const leaderChildItemId =
      touchedChildItemWithChildren ??
      touchedChildItem ??
      childItemWithChildren ??
      childItemIds[0]!;
    const schema = childSlotSchema(leaderChildItemId);

    const leaderFormulaCols = new Map<number, EntryContent>();
    const leaderCells = model.childIdsOf(leaderChildItemId);
    for (let i = 0; i < leaderCells.length; i += 1) {
      const cellId = leaderCells[i]!;
      if (!model.hasEntry(cellId)) continue;
      const content = model.peekEntry(cellId).content;
      if (isFormulaContent(content) || isQueryContent(content)) {
        leaderFormulaCols.set(i, content);
      }
    }

    for (const childItemId of childItemIds) {
      if (childItemId === leaderChildItemId) continue;

      const childIds = model.childIdsOf(childItemId);
      const byLabel = new Map<string, EntryId>();
      const unlabeled: EntryId[] = [];
      const desiredIds: EntryId[] = [];
      const matched = new Set<EntryId>();

      for (const cid of childIds) {
        if (!model.hasEntry(cid)) continue;
        const label = normalizeLabel(model.peekEntry(cid).label);
        if (label) byLabel.set(label, cid);
        else unlabeled.push(cid);
      }

      let nextUnlabeledIdx = 0;

      for (let i = 0; i < schema.length; i += 1) {
        const slot = schema[i]!;
        let matchId: EntryId | null = null;

        if (slot.normalizedLabel) {
          const labeledMatch = byLabel.get(slot.normalizedLabel);
          if (labeledMatch != null && !matched.has(labeledMatch)) {
            matchId = labeledMatch;
          }
        } else {
          while (nextUnlabeledIdx < unlabeled.length) {
            const unlabeledId = unlabeled[nextUnlabeledIdx++]!;
            if (matched.has(unlabeledId)) continue;
            matchId = unlabeledId;
            break;
          }
        }

        if (matchId == null) {
          matchId = model.createId();
          out.push(
            model.ops.create({
              ...makeBlankEntry(matchId),
              ...(slot.label != null ? { label: slot.label } : {}),
            }),
          );
        }

        matched.add(matchId);
        desiredIds.push(matchId);
      }

      for (let i = 0; i < desiredIds.length; i += 1) {
        const childId = desiredIds[i]!;
        if (childIds[i] === childId) continue;
        out.push(
          model.ops.move({
            childId,
            toParentId: childItemId,
            toIndex: i,
          }),
        );
      }

      for (const cid of childIds) {
        if (!model.hasEntry(cid)) continue;
        if (matched.has(cid)) continue;
        out.push(model.ops.remove(cid));
      }

      for (const [colIdx, leaderContent] of leaderFormulaCols) {
        const followerCellId = desiredIds[colIdx];
        if (!followerCellId) continue;
        if (model.hasEntry(followerCellId)) {
          const followerContent = model.peekEntry(followerCellId).content;
          if (
            isItemContent(followerContent) &&
            followerContent.childIds.length > 0
          )
            continue;
          if (contentMatches(followerContent, leaderContent)) continue;
        }
        out.push(model.ops.patch(followerCellId, { content: leaderContent }));
      }
    }
  };

  const enforceNode = (
    constraintRootId: EntryId,
    id: EntryId,
    shape: ViewShape,
  ): boolean => {
    if (!enforceNodeType(constraintRootId, id, shape)) return false;
    if (!model.hasEntry(id))
      return constraintRootStillConstrained(constraintRootId);
    if (shape.type !== "item")
      return constraintRootStillConstrained(constraintRootId);

    enforceNonEmpty(id, shape);
    if (!constraintRootStillConstrained(constraintRootId)) return false;
    if (!model.hasEntry(id)) return true;

    if (shape.children.type !== "any") {
      const lockOps: Op[] = [];
      for (const childId of childIdsOfGroup(id)) {
        if (model.peekEntry(childId).view != null) {
          lockOps.push(model.ops.patch(childId, { view: null }));
        }
      }
      applyIfAny(lockOps);
      if (!constraintRootStillConstrained(constraintRootId)) return false;
    }

    const entry = model.peekEntry(id);
    if (!isItemContent(entry.content))
      return constraintRootStillConstrained(constraintRootId);
    for (const childId of childIdsOfGroup(id)) {
      if (!enforceNode(constraintRootId, childId, shape.children)) return false;
    }

    if ("alignChildren" in shape && shape.alignChildren) {
      const ops: Op[] = [];
      enqueueAlignChildrenOps(id, ops);
      applyIfAny(ops);
      if (!constraintRootStillConstrained(constraintRootId)) return false;
      if (!model.hasEntry(id)) return true;
      const refreshed = model.peekEntry(id);
      if (!isItemContent(refreshed.content))
        return constraintRootStillConstrained(constraintRootId);
    }

    return constraintRootStillConstrained(constraintRootId);
  };

  for (const rootId of relevantRootCandidates) {
    if (!model.hasEntry(rootId)) continue;
    const entry = model.peekEntry(rootId);
    if (!entry.view) continue;
    const shape = shapes[entry.view];
    if (!shape) continue;

    let converged = false;
    for (let pass = 0; pass < MAX_ENFORCE_PASSES_PER_ROOT; pass += 1) {
      appliedInPass = false;
      if (!enforceNode(rootId, rootId, shape)) {
        converged = true;
        break;
      }
      if (!appliedInPass) {
        converged = true;
        break;
      }
    }

    if (!converged) {
      throw new CoreInvariantError(
        "Shape enforcement did not converge within max passes",
      );
    }
  }
}
