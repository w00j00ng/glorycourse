import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (Omit<import('../domain/records.ts').FinalizationRecord['receipt'], 'draftId' | 'createdEnrollmentIds'> & { draftId: string })[] => (
  db.prepare(`SELECT allocation_draft_id AS draftId,
    receipt_id AS receiptId, created_count AS createdCount, finalized_at AS finalizedAt
    FROM allocation_finalization_receipts
    WHERE (? IS NULL OR allocation_draft_id = ?)`).all(parentId, parentId).map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').FinalizationRecord['receipt'], 'draftId' | 'createdEnrollmentIds'> & { draftId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_finalization_receipts
    (allocation_draft_id, receipt_id, created_count, finalized_at) VALUES (?, ?, ?, ?)`);
