import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeSnapshot = import('../allocation/engine.ts').AllocationSnapshot;
type SnapshotTypeWithParent<T> = T & { parentId: string };

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeWithParent<SnapshotTypeSnapshot['relevantPastEnrollments'][number]>)[] => (
  db.prepare(`SELECT allocation_draft_id AS parentId,
    enrollment_id AS id, member_id AS memberId, course_id AS courseId, semester_id AS semesterId,
    semester_order AS semesterOrder FROM allocation_snapshot_past_enrollments WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY allocation_draft_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeWithParent<SnapshotTypeSnapshot['relevantPastEnrollments'][number]>)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_snapshot_past_enrollments
    (allocation_draft_id, position, enrollment_id, member_id, course_id, semester_id, semester_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_snapshot_past_enrollments WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
