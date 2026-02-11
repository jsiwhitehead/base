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
  input: ApplyResult,
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
  const groups = new Set<EntryId>();

  const rule: Rule = (m, input) => {
    if (groups.size <= 1) return [];

    const candidatesTo = new Set<EntryId>();
    const candidatesFrom = new Set<EntryId>();
    const candidatesTouched = new Set<EntryId>();

    for (const r of input.moved) {
      if (r.toParentId != null && groups.has(r.toParentId))
        candidatesTo.add(r.toParentId);
      if (r.fromParentId != null && groups.has(r.fromParentId))
        candidatesFrom.add(r.fromParentId);
    }

    for (const id of input.touched) {
      if (input.moved.length === 0 && groups.has(id)) {
        candidatesTouched.add(id);
        continue;
      }
      if (!m.hasEntry(id)) continue;
      const parentId = m.peekEntry(id).parentId;
      if (parentId != null && groups.has(parentId))
        candidatesTouched.add(parentId);
    }

    const leaderId =
      minId(candidatesTo) ?? minId(candidatesTouched) ?? minId(candidatesFrom);
    if (leaderId == null || !groups.has(leaderId) || !m.hasEntry(leaderId))
      return [];

    const leaderChildIds = m.childIdsOf(leaderId);
    const desiredLabels: string[] = [];
    for (const cid of leaderChildIds) {
      if (!m.hasEntry(cid)) continue;
      const nm = normalizeLabel(m.readEntry(cid).label);
      if (nm) desiredLabels.push(nm);
    }

    const desiredSet = new Set(desiredLabels);
    const targetGroupIds = [...groups]
      .filter((gid) => gid !== leaderId)
      .sort((a, b) => a - b);

    const ops: Op[] = [];

    for (const gid of targetGroupIds) {
      if (!m.hasEntry(gid)) continue;

      const childIds = m.childIdsOf(gid);
      const byLabel = new Map<string, EntryId>();
      const indexOf = new Map<EntryId, number>();

      for (let i = 0; i < childIds.length; i++) {
        const cid = childIds[i]!;
        indexOf.set(cid, i);
        if (!m.hasEntry(cid)) continue;
        const nm = normalizeLabel(m.readEntry(cid).label);
        if (nm) byLabel.set(nm, cid);
      }

      for (let i = 0; i < desiredLabels.length; i++) {
        const label = desiredLabels[i]!;
        const existing = byLabel.get(label) ?? null;

        if (existing != null) {
          const curIdx = indexOf.get(existing);
          if (curIdx != null && curIdx !== i) {
            ops.push(
              m.ops.move({ childId: existing, toParentId: gid, toIndex: i }),
            );
          }
          continue;
        }

        const id = m.createId();
        const entry: Entry = { ...makeBlankEntry(id), label };
        ops.push(m.ops.create(entry));
        ops.push(m.ops.move({ childId: id, toParentId: gid, toIndex: i }));
      }

      for (const cid of childIds) {
        if (!m.hasEntry(cid)) continue;
        const nm = normalizeLabel(m.readEntry(cid).label);
        if (!nm) continue;
        if (!desiredSet.has(nm)) {
          ops.push(m.ops.move({ childId: cid, toParentId: null }));
        }
      }
    }

    return ops;
  };

  const removeRule = opts.addRule(rule);

  const pruneMissing = (): EntryId[] => {
    const removed: EntryId[] = [];
    for (const id of groups) {
      if (!model.hasEntry(id)) {
        groups.delete(id);
        removed.push(id);
      }
    }
    return removed;
  };

  return {
    add(id: EntryId) {
      groups.add(id);
    },
    remove(id: EntryId) {
      groups.delete(id);
    },
    has(id: EntryId) {
      return groups.has(id);
    },
    clear() {
      groups.clear();
    },
    pruneMissing,
    dispose() {
      groups.clear();
      removeRule();
    },
  };
}
