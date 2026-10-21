import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): ({ parentId: string; enrollmentId: string })[] => (
  db.prepare(`SELECT
    allocation_draft_id AS parentId, enrollment_id AS enrollmentId
    FROM allocation_finalization_enrollment_ids WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY allocation_draft_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as ({ parentId: string; enrollmentId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_finalization_enrollment_ids
    (allocation_draft_id, position, enrollment_id) VALUES (?, ?, ?)`);
