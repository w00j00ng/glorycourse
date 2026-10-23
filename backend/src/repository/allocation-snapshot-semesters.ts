import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeSnapshot = import('../allocation/engine.ts').AllocationSnapshot;

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeSnapshot['semester'] & { draftId: string })[] => (
  db.prepare(`SELECT allocation_draft_id AS draftId,
    semester_id AS id, name, semester_order AS "order" FROM allocation_snapshot_semesters
    WHERE (? IS NULL OR allocation_draft_id = ?)`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeSnapshot['semester'] & { draftId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_snapshot_semesters
    (allocation_draft_id, semester_id, name, semester_order) VALUES (?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_snapshot_semesters WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
