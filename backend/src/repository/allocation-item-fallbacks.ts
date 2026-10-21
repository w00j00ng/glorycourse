import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeFallback = NonNullable<import('../domain/records.ts').AllocationDraftItemRecord['autoReasonDetail']['fallback']>;

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (Omit<SnapshotTypeFallback, 'stageCandidateSemesterCourseIds'> & { itemId: string })[] => (
  db.prepare(`SELECT allocation_draft_item_id AS itemId,
    selected_semester_course_id AS selectedSemesterCourseId, reason_code AS reasonCode,
    total_assigned_in_stage AS totalAssignedInStage FROM allocation_item_fallbacks
    WHERE allocation_draft_item_id IN (SELECT id FROM allocation_draft_items WHERE (? IS NULL OR allocation_draft_id = ?))`).all(parentId, parentId).map((row) => ({ ...row })) as (Omit<SnapshotTypeFallback, 'stageCandidateSemesterCourseIds'> & { itemId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_item_fallbacks
    (allocation_draft_item_id, selected_semester_course_id, reason_code, total_assigned_in_stage)
    VALUES (?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_item_fallbacks WHERE allocation_draft_item_id = ?').run(parentId);
  return true;
};
