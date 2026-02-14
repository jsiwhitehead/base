import type {
  ApplyResult,
  Entry,
  EntryId,
  Model,
  Op,
  Transaction,
} from "./model";
import { makeBlankEntry, normalizeLabel } from "./model";

export type Rule = (
  model: Model,
  applyResult: ApplyResult,
  meta?: Transaction["meta"],
) => readonly Op[];

type SyncGroup = {
  add(id: EntryId): void;
  remove(id: EntryId): void;
  has(id: EntryId): boolean;
  clear(): void;
  pruneMissing(): EntryId[];
  dispose(): void;
};

const minId = (ids: Iterable<EntryId>): EntryId | null => {
  let out: EntryId | null = null;
  for (const id of ids) out = out == null ? id : Math.min(out, id);
  return out;
};

export function createShapeSyncGroup(opts: {
  model: Model;
  addRule: (rule: Rule) => () => void;
}): SyncGroup {
  const { model } = opts;
  const groupIds = new Set<EntryId>();

  const rule: Rule = (model, applyResult) => {
    if (groupIds.size <= 1) return [];

    const candidatesTo = new Set<EntryId>();
    const candidatesFrom = new Set<EntryId>();
    const candidatesTouched = new Set<EntryId>();

    for (const moved of applyResult.moved) {
      if (moved.toParentId != null && groupIds.has(moved.toParentId))
        candidatesTo.add(moved.toParentId);
      if (moved.fromParentId != null && groupIds.has(moved.fromParentId))
        candidatesFrom.add(moved.fromParentId);
    }

    for (const id of applyResult.touched) {
      if (applyResult.moved.length === 0 && groupIds.has(id)) {
        candidatesTouched.add(id);
        continue;
      }
      if (!model.hasEntry(id)) continue;
      const parentId = model.peekEntry(id).parentId;
      if (parentId != null && groupIds.has(parentId))
        candidatesTouched.add(parentId);
    }

    const leaderId =
      minId(candidatesTo) ?? minId(candidatesTouched) ?? minId(candidatesFrom);
    if (
      leaderId == null ||
      !groupIds.has(leaderId) ||
      !model.hasEntry(leaderId)
    )
      return [];

    const leaderChildIds = model.childIdsOf(leaderId);
    const desiredLabels: string[] = [];
    for (const childId of leaderChildIds) {
      if (!model.hasEntry(childId)) continue;
      const normalized = normalizeLabel(model.readEntry(childId).label);
      if (normalized) desiredLabels.push(normalized);
    }

    const desiredSet = new Set(desiredLabels);
    const targetGroupIds = [...groupIds]
      .filter((groupId) => groupId !== leaderId)
      .sort((a, b) => a - b);

    const ops: Op[] = [];

    for (const groupId of targetGroupIds) {
      if (!model.hasEntry(groupId)) continue;

      const childIds = model.childIdsOf(groupId);
      const byLabel = new Map<string, EntryId>();
      const indexOf = new Map<EntryId, number>();

      for (let i = 0; i < childIds.length; i++) {
        const childId = childIds[i]!;
        indexOf.set(childId, i);
        if (!model.hasEntry(childId)) continue;
        const normalized = normalizeLabel(model.readEntry(childId).label);
        if (normalized) byLabel.set(normalized, childId);
      }

      for (let i = 0; i < desiredLabels.length; i++) {
        const label = desiredLabels[i]!;
        const existing = byLabel.get(label) ?? null;

        if (existing != null) {
          const currentIndex = indexOf.get(existing);
          if (currentIndex != null && currentIndex !== i) {
            ops.push(
              model.ops.move({
                childId: existing,
                toParentId: groupId,
                toIndex: i,
              }),
            );
          }
          continue;
        }

        const id = model.createId();
        const entry: Entry = { ...makeBlankEntry(id), label };
        ops.push(model.ops.create(entry));
        ops.push(
          model.ops.move({ childId: id, toParentId: groupId, toIndex: i }),
        );
      }

      for (const childId of childIds) {
        if (!model.hasEntry(childId)) continue;
        const normalized = normalizeLabel(model.readEntry(childId).label);
        if (!normalized) continue;
        if (!desiredSet.has(normalized)) {
          ops.push(model.ops.move({ childId, toParentId: null }));
        }
      }
    }

    return ops;
  };

  const removeRule = opts.addRule(rule);

  const pruneMissing = (): EntryId[] => {
    const removed: EntryId[] = [];
    for (const id of groupIds) {
      if (!model.hasEntry(id)) {
        groupIds.delete(id);
        removed.push(id);
      }
    }
    return removed;
  };

  return {
    add(id: EntryId) {
      groupIds.add(id);
    },
    remove(id: EntryId) {
      groupIds.delete(id);
    },
    has(id: EntryId) {
      return groupIds.has(id);
    },
    clear() {
      groupIds.clear();
    },
    pruneMissing,
    dispose() {
      groupIds.clear();
      removeRule();
    },
  };
}
