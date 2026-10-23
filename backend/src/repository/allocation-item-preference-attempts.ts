import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeWithParent<T> = T & { parentId: string };
type SnapshotTypePreferenceAttempt = import('../domain/records.ts').AllocationDraftItemRecord['autoReasonDetail']['preferenceAttempts'][number];

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeWithParent<SnapshotTypePreferenceAttempt>)[] => (
  db.prepare(`SELECT allocation_draft_item_id AS parentId,
    choice_id_at_generation AS choiceIdAtGeneration, semester_course_id AS semesterCourseId,
    course_name_at_generation AS courseNameAtGeneration, preference, decision, reason_code AS reasonCode
    FROM allocation_item_preference_attempts WHERE allocation_draft_item_id IN (SELECT id FROM allocation_draft_items WHERE (? IS NULL OR allocation_draft_id = ?))
    ORDER BY allocation_draft_item_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeWithParent<SnapshotTypePreferenceAttempt>)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_item_preference_attempts
    (allocation_draft_item_id, position, choice_id_at_generation, semester_course_id,
      course_name_at_generation, preference, decision, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_item_preference_attempts WHERE allocation_draft_item_id = ?').run(parentId);
  return true;
};
