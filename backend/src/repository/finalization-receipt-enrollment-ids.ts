import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

export class FinalizationReceiptEnrollmentIdQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  list({ idempotencyKey }: { idempotencyKey: string }): string[] {
    return this.db.prepare(`
      SELECT enrollment_id AS enrollmentId FROM finalization_receipt_enrollment_ids
      WHERE idempotency_key = ? ORDER BY position
    `).all(idempotencyKey).map(({ enrollmentId }) => String(enrollmentId));
  }

  insert({ idempotencyKey, enrollmentIds }: { idempotencyKey: string; enrollmentIds: string[] }): void {
    const insert = this.db.prepare(`
      INSERT INTO finalization_receipt_enrollment_ids (idempotency_key, position, enrollment_id) VALUES (?, ?, ?)
    `);
    enrollmentIds.forEach((id, position) => insert.run(idempotencyKey, position, id));
  }
}

export const readSnapshotRows = (db: DatabaseSync): ({ parentId: string; enrollmentId: string })[] => (
  db.prepare(`SELECT
    idempotency_key AS parentId, enrollment_id AS enrollmentId
    FROM finalization_receipt_enrollment_ids ORDER BY idempotency_key, position`).all().map((row) => ({ ...row })) as ({ parentId: string; enrollmentId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO finalization_receipt_enrollment_ids
    (idempotency_key, position, enrollment_id) VALUES (?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM finalization_receipt_enrollment_ids WHERE idempotency_key = ?').run(parentId);
  return true;
};
