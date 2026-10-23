import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeSnapshot = import('../allocation/engine.ts').AllocationSnapshot;
type SnapshotTypeWithParent<T> = T & { parentId: string };

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeWithParent<SnapshotTypeSnapshot['semesterCourses'][number]>)[] => (
  db.prepare(`SELECT allocation_draft_id AS parentId,
    semester_course_id AS id, course_id AS courseId, course_name AS courseName, capacity
    FROM allocation_snapshot_semester_courses WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY allocation_draft_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeWithParent<SnapshotTypeSnapshot['semesterCourses'][number]>)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_snapshot_semester_courses
    (allocation_draft_id, position, semester_course_id, course_id, course_name, capacity)
    VALUES (?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_snapshot_semester_courses WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
