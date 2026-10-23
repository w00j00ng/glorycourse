import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeSnapshot = import('../allocation/engine.ts').AllocationSnapshot;
type SnapshotTypeWithParent<T> = T & { parentId: string };

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeWithParent<SnapshotTypeSnapshot['choices'][number]>)[] => (
  db.prepare(`SELECT allocation_draft_id AS parentId,
    choice_id AS id, application_id AS applicationId, semester_course_id AS semesterCourseId, preference
    FROM allocation_snapshot_choices WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY allocation_draft_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeWithParent<SnapshotTypeSnapshot['choices'][number]>)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_snapshot_choices
    (allocation_draft_id, position, choice_id, application_id, semester_course_id, preference)
    VALUES (?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_snapshot_choices WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
