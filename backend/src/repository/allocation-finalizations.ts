import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (Pick<import('../domain/records.ts').FinalizationRecord, 'idempotencyKey' | 'requestHash'> & { draftId: string })[] => (
  db.prepare(`SELECT allocation_draft_id AS draftId,
    idempotency_key AS idempotencyKey, request_hash AS requestHash FROM allocation_finalizations
    WHERE (? IS NULL OR allocation_draft_id = ?)`).all(parentId, parentId).map((row) => ({ ...row })) as (Pick<import('../domain/records.ts').FinalizationRecord, 'idempotencyKey' | 'requestHash'> & { draftId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_finalizations
    (allocation_draft_id, idempotency_key, request_hash) VALUES (?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_finalizations WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
