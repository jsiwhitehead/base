import type { EntryId, Model, Op, ViewName } from "./model";
import { isGroupContent, makeBlankEntry, normalizeLabel } from "./model";

export type ViewConstraint = {
  content: "group" | "value" | "any";
  nonEmpty?: true;
  children?: {
    content: "group" | "value" | "any";
    viewLocked?: true;
  };
  shapeSync?: true;
};

function assertNever(_exhaustive: never, message: string): never {
  throw new Error(message);
}

export function contentSatisfiesConstraint(
  facts: { isGroup: boolean; childCount: number },
  constraint: ViewConstraint | undefined,
): boolean {
  if (!constraint) return true;

  switch (constraint.content) {
    case "any":
      break;
    case "group":
      if (!facts.isGroup) return false;
      break;
    case "value":
      if (facts.isGroup) return false;
      break;
    default:
      return assertNever(
        constraint.content,
        "Unhandled constraint content type",
      );
  }

  if (constraint.nonEmpty && facts.isGroup) {
    return facts.childCount > 0;
  }

  return true;
}

export function enforceViewConstraints(
  model: Model,
  constraints: Partial<Record<ViewName, ViewConstraint>>,
  touched: readonly EntryId[],
  applyOps: (ops: Op[]) => void,
): void {
  const relevant = new Set<EntryId>();
  for (const id of touched) {
    if (!model.hasEntry(id)) continue;
    relevant.add(id);
    const parentId = model.peekEntry(id).parentId;
    if (parentId != null && model.hasEntry(parentId)) {
      relevant.add(parentId);
    }
  }

  const constrained: { id: EntryId; constraint: ViewConstraint }[] = [];
  for (const id of relevant) {
    const entry = model.peekEntry(id);
    if (!entry.view) continue;
    const constraint = constraints[entry.view];
    if (!constraint) continue;
    constrained.push({ id, constraint });
  }

  const isPlain = (id: EntryId): boolean => {
    const content = model.peekEntry(id).content;
    return (
      content.type === "blank" ||
      content.type === "scalar" ||
      content.type === "group"
    );
  };

  const contentOps: Op[] = [];
  for (const { id, constraint } of constrained) {
    if (constraint.content === "any") continue;
    if (!isPlain(id)) continue;

    const content = model.peekEntry(id).content;

    if (constraint.content === "group" && !isGroupContent(content)) {
      contentOps.push(
        model.ops.patch(id, { content: { type: "group", childIds: [] } }),
      );
    } else if (constraint.content === "value" && isGroupContent(content)) {
      if (content.childIds.length === 0) {
        contentOps.push(model.ops.patch(id, { content: { type: "blank" } }));
      } else {
        contentOps.push(model.ops.patch(id, { view: null }));
      }
    }
  }

  if (contentOps.length) applyOps(contentOps);

  const nonEmptyOps: Op[] = [];
  for (const { id, constraint } of constrained) {
    if (!constraint.nonEmpty) continue;
    if (!model.hasEntry(id)) continue;

    const entry = model.peekEntry(id);
    if (!isGroupContent(entry.content)) continue;
    if (entry.content.childIds.length > 0) continue;

    const newId = model.createId();
    nonEmptyOps.push(model.ops.create(makeBlankEntry(newId)));
    nonEmptyOps.push(model.ops.move({ childId: newId, toParentId: id }));
  }

  if (nonEmptyOps.length) applyOps(nonEmptyOps);

  const childOps: Op[] = [];
  for (const { id, constraint } of constrained) {
    if (!constraint.children) continue;
    if (!model.hasEntry(id)) continue;

    const entry = model.peekEntry(id);
    if (!isGroupContent(entry.content)) continue;

    for (const childId of entry.content.childIds) {
      if (!model.hasEntry(childId)) continue;

      if (
        constraint.children.viewLocked &&
        model.peekEntry(childId).view != null
      ) {
        childOps.push(model.ops.patch(childId, { view: null }));
      }

      if (constraint.children.content === "any") continue;
      if (!isPlain(childId)) continue;

      const childContent = model.peekEntry(childId).content;

      if (
        constraint.children.content === "group" &&
        !isGroupContent(childContent)
      ) {
        childOps.push(
          model.ops.patch(childId, {
            content: { type: "group", childIds: [] },
          }),
        );
      } else if (
        constraint.children.content === "value" &&
        isGroupContent(childContent)
      ) {
        if (childContent.childIds.length === 0) {
          childOps.push(
            model.ops.patch(childId, { content: { type: "blank" } }),
          );
        }
      }
    }
  }

  if (childOps.length) applyOps(childOps);

  const touchedSet = new Set(touched);
  const syncOps: Op[] = [];

  for (const { id, constraint } of constrained) {
    if (!constraint.shapeSync) continue;
    if (!model.hasEntry(id)) continue;

    const entry = model.peekEntry(id);
    if (!isGroupContent(entry.content)) continue;

    const rowIds = entry.content.childIds.filter((rid) => model.hasEntry(rid));
    if (rowIds.length === 0) continue;

    const touchedWithChildren = rowIds.find(
      (rid) => touchedSet.has(rid) && model.childIdsOf(rid).length > 0,
    );
    const anyWithChildren = rowIds.find(
      (rid) => model.childIdsOf(rid).length > 0,
    );
    const leaderId =
      touchedWithChildren ??
      anyWithChildren ??
      rowIds.find((rid) => touchedSet.has(rid)) ??
      rowIds[0]!;
    const leaderChildIds = model.childIdsOf(leaderId);

    const schema: string[] = [];
    for (const cid of leaderChildIds) {
      if (!model.hasEntry(cid)) continue;
      const label = normalizeLabel(model.peekEntry(cid).label);
      if (label) schema.push(label);
    }

    const schemaSet = new Set(schema);

    for (const rowId of rowIds) {
      if (rowId === leaderId) continue;
      if (!model.hasEntry(rowId)) continue;

      const childIds = model.childIdsOf(rowId);
      const byLabel = new Map<string, EntryId>();
      const indexOf = new Map<EntryId, number>();

      for (let i = 0; i < childIds.length; i++) {
        const cid = childIds[i]!;
        indexOf.set(cid, i);
        if (!model.hasEntry(cid)) continue;
        const label = normalizeLabel(model.peekEntry(cid).label);
        if (label) byLabel.set(label, cid);
      }

      for (let i = 0; i < schema.length; i++) {
        const label = schema[i]!;
        const existing = byLabel.get(label);

        if (existing != null) {
          if (indexOf.get(existing) !== i) {
            syncOps.push(
              model.ops.move({
                childId: existing,
                toParentId: rowId,
                toIndex: i,
              }),
            );
          }
          continue;
        }

        const newId = model.createId();
        syncOps.push(model.ops.create({ ...makeBlankEntry(newId), label }));
        syncOps.push(
          model.ops.move({ childId: newId, toParentId: rowId, toIndex: i }),
        );
      }

      for (const cid of childIds) {
        if (!model.hasEntry(cid)) continue;
        const label = normalizeLabel(model.peekEntry(cid).label);
        if (label && !schemaSet.has(label)) {
          syncOps.push(model.ops.move({ childId: cid, toParentId: null }));
        }
      }
    }
  }

  if (syncOps.length) applyOps(syncOps);
}
