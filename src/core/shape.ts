import { CoreInvariantError } from "../dev";
import type { EntryId, Model, Op, ViewName } from "./model";
import { isGroupContent, makeBlankEntry, normalizeLabel } from "./model";
import { CoreReadError } from "./read";
import type { ItemId, ReadApi } from "./read";

export type ViewShape = { type: "any" } | { type: "value" } | GroupViewShape;

type GroupViewShape =
  | { type: "group"; children: ViewShape; nonEmpty?: true }
  | {
      type: "group";
      children: GroupViewShape;
      nonEmpty?: true;
      alignChildren?: true;
    };

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];
type ChildListForGroup<G extends GroupViewShape, T> = G extends {
  nonEmpty: true;
}
  ? NonEmptyReadonlyArray<T>
  : readonly T[];
type ChildShapeOfGroup<G extends GroupViewShape> = G["children"];
type ReadChildOfGroup<G extends GroupViewShape> = ReadFromShape<G["children"]>;

type ReadShapeAny = { type: "any"; id: ItemId };

type ReadShapeValue = {
  type: "value";
  id: ItemId;
  value: true | number | string | null;
};

type ReadShapeGroup<G extends GroupViewShape, Child> = {
  type: "group";
  id: ItemId;
  children: ChildListForGroup<G, Child>;
};

export type ReadFromShape<S extends ViewShape> = S extends { type: "any" }
  ? ReadShapeAny
  : S extends { type: "value" }
    ? ReadShapeValue
    : S extends GroupViewShape
      ? ReadShapeGroup<S, ReadChildOfGroup<S>>
      : never;

type BaseShapeReader = { readonly id: ItemId; label(): string | null };

export type AnyShapeReader = BaseShapeReader;

export type ValueShapeReader = BaseShapeReader & {
  value(): ReadShapeValue["value"];
};

export type GroupShapeReader<G extends GroupViewShape> = BaseShapeReader & {
  childIds(): ChildListForGroup<G, ItemId>;
  child(id: ItemId): ReaderForShape<ChildShapeOfGroup<G>>;
};

export type ReaderForShape<S extends ViewShape> = S extends { type: "any" }
  ? AnyShapeReader
  : S extends { type: "value" }
    ? ValueShapeReader
    : S extends GroupViewShape
      ? GroupShapeReader<S>
      : never;

export function defineShape<const S extends ViewShape>(shape: S): S {
  return shape;
}

export function createShapeReader<S extends ViewShape>(
  read: ReadApi,
  id: ItemId,
  shape: S,
): ReaderForShape<S> {
  const readLabel = (itemId: ItemId): string | null =>
    read.item(itemId).label ?? null;

  const readValue = (itemId: ItemId): ReadShapeValue["value"] => {
    const item = read.item(itemId);
    if (item.content.type === "value") return item.content.value;
    throw new CoreReadError(
      "CONTENT_MISMATCH",
      "Shape reader expected value content",
    );
  };

  const childIdsOfGroup = (itemId: ItemId): readonly ItemId[] => {
    const item = read.item(itemId);
    if (item.content.type !== "group")
      throw new CoreReadError(
        "CONTENT_MISMATCH",
        "Shape reader expected group content",
      );
    return item.content.children;
  };

  const build = <T extends ViewShape>(
    itemId: ItemId,
    nodeShape: T,
  ): ReaderForShape<T> => {
    if (nodeShape.type === "any") {
      return {
        id: itemId,
        label: () => readLabel(itemId),
      } as ReaderForShape<T>;
    }

    if (nodeShape.type === "value") {
      return {
        id: itemId,
        label: () => readLabel(itemId),
        value: () => readValue(itemId),
      } as ReaderForShape<T>;
    }

    const childShape = nodeShape.children;
    return {
      id: itemId,
      label: () => readLabel(itemId),
      childIds: () =>
        childIdsOfGroup(itemId) as ChildListForGroup<
          Extract<T, GroupViewShape>,
          ItemId
        >,
      child: (cid: ItemId) => {
        if (!childIdsOfGroup(itemId).includes(cid))
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
  id: ItemId,
  shape: ViewShape,
): boolean {
  const normalizedChildLabelSchema = (groupId: ItemId): string[] => {
    const group = read.item(groupId);
    if (group.content.type !== "group") return [];
    const out: string[] = [];
    for (const childId of group.content.children) {
      const label = normalizeLabel(read.item(childId).label ?? "");
      if (label) out.push(label);
    }
    return out;
  };

  const item = read.item(id);

  if (shape.type === "any") return true;
  if (shape.type === "value") return item.content.type === "value";
  if (item.content.type !== "group") return false;
  if (shape.nonEmpty && item.content.children.length === 0) return false;

  if ("alignChildren" in shape && shape.alignChildren) {
    const childGroupIds = item.content.children;
    const leaderChildGroupId = childGroupIds[0] ?? null;
    if (!leaderChildGroupId) return true;
    const schema = normalizedChildLabelSchema(leaderChildGroupId);

    for (let i = 1; i < childGroupIds.length; i += 1) {
      const childGroupId = childGroupIds[i]!;
      const labels = normalizedChildLabelSchema(childGroupId);
      if (labels.length !== schema.length) return false;
      for (let j = 0; j < schema.length; j += 1) {
        if (labels[j] !== schema[j]) return false;
      }
    }
  }

  for (const childId of item.content.children) {
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
      content.type === "group"
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

  const childIdsOfGroup = (groupId: EntryId): EntryId[] => {
    if (!model.hasEntry(groupId)) return [];
    const entry = model.peekEntry(groupId);
    if (!isGroupContent(entry.content)) return [];
    const out: EntryId[] = [];
    for (const childId of entry.content.childIds) {
      if (!model.hasEntry(childId)) continue;
      out.push(childId);
    }
    return out;
  };

  const normalizedChildLabelSchema = (groupId: EntryId): string[] => {
    const schema: string[] = [];
    for (const cid of childIdsOfGroup(groupId)) {
      const label = normalizeLabel(model.peekEntry(cid).label);
      if (label) schema.push(label);
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

    if (shape.type === "group" && !isGroupContent(content)) {
      applyOps([
        model.ops.patch(id, { content: { type: "group", childIds: [] } }),
      ]);
      return constraintRootStillConstrained(constraintRootId);
    }

    if (shape.type === "value" && isGroupContent(content)) {
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
    shape: Extract<ViewShape, { type: "group" }>,
  ): void => {
    if (!model.hasEntry(id)) return;
    const entry = model.peekEntry(id);
    if (!isGroupContent(entry.content)) return;

    if (shape.nonEmpty && entry.content.childIds.length === 0) {
      const newId = model.createId();
      applyOps([
        model.ops.create(makeBlankEntry(newId)),
        model.ops.move({ childId: newId, toParentId: id }),
      ]);
    }
  };

  const enqueueAlignChildrenOps = (groupId: EntryId, out: Op[]): void => {
    const childGroupIds = childIdsOfGroup(groupId).filter((childGroupId) => {
      if (!model.hasEntry(childGroupId)) return false;
      return isGroupContent(model.peekEntry(childGroupId).content);
    });
    if (childGroupIds.length < 2) return;
    const childGroupIdSet = new Set(childGroupIds);

    const touchedChildGroups = new Set<EntryId>();
    for (const touchedId of touched) {
      let cur: EntryId | null = touchedId;
      while (cur != null && model.hasEntry(cur)) {
        if (childGroupIdSet.has(cur)) {
          touchedChildGroups.add(cur);
          break;
        }
        const parentId: EntryId | null = model.peekEntry(cur).parentId;
        if (parentId === groupId) break;
        cur = parentId;
      }
    }

    const touchedChildGroupWithChildren = childGroupIds.find(
      (childGroupId) =>
        touchedChildGroups.has(childGroupId) &&
        model.childIdsOf(childGroupId).length > 0,
    );
    const touchedChildGroup = childGroupIds.find((childGroupId) =>
      touchedChildGroups.has(childGroupId),
    );
    const childGroupWithChildren = childGroupIds.find(
      (childGroupId) => model.childIdsOf(childGroupId).length > 0,
    );
    const leaderChildGroupId =
      touchedChildGroupWithChildren ??
      touchedChildGroup ??
      childGroupWithChildren ??
      childGroupIds[0]!;
    const schema = normalizedChildLabelSchema(leaderChildGroupId);
    const schemaSet = new Set(schema);

    for (const childGroupId of childGroupIds) {
      if (childGroupId === leaderChildGroupId) continue;
      if (!model.hasEntry(childGroupId)) continue;
      if (!isGroupContent(model.peekEntry(childGroupId).content)) continue;

      const childIds = model.childIdsOf(childGroupId);
      const byLabel = new Map<string, EntryId>();
      const indexOf = new Map<EntryId, number>();

      for (let i = 0; i < childIds.length; i += 1) {
        const cid = childIds[i]!;
        indexOf.set(cid, i);
        if (!model.hasEntry(cid)) continue;
        const label = normalizeLabel(model.peekEntry(cid).label);
        if (label) byLabel.set(label, cid);
      }

      for (let i = 0; i < schema.length; i += 1) {
        const label = schema[i]!;
        const existing = byLabel.get(label);
        if (existing != null) {
          if (indexOf.get(existing) !== i) {
            out.push(
              model.ops.move({
                childId: existing,
                toParentId: childGroupId,
                toIndex: i,
              }),
            );
          }
          continue;
        }

        const newId = model.createId();
        out.push(model.ops.create({ ...makeBlankEntry(newId), label }));
        out.push(
          model.ops.move({
            childId: newId,
            toParentId: childGroupId,
            toIndex: i,
          }),
        );
      }

      for (const cid of childIds) {
        if (!model.hasEntry(cid)) continue;
        const label = normalizeLabel(model.peekEntry(cid).label);
        if (label && !schemaSet.has(label)) out.push(model.ops.remove(cid));
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
    if (shape.type !== "group")
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
    if (!isGroupContent(entry.content))
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
      if (!isGroupContent(refreshed.content))
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
