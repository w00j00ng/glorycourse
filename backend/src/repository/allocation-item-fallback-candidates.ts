import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): ({ parentId: string; semesterCourseId: string })[] => (
  db.prepare(`SELECT
    allocation_draft_item_id AS parentId, semester_course_id AS semesterCourseId
    FROM allocation_item_fallback_candidates WHERE allocation_draft_item_id IN (SELECT id FROM allocation_draft_items WHERE (? IS NULL OR allocation_draft_id = ?))
    ORDER BY allocation_draft_item_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as ({ parentId: string; semesterCourseId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_item_fallback_candidates
    (allocation_draft_item_id, position, semester_course_id) VALUES (?, ?, ?)`);
