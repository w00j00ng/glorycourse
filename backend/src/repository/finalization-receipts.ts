import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { FinalizationReceiptRecord } from '../domain/records.ts';
import { FinalizationReceiptEnrollmentIdQueries } from './finalization-receipt-enrollment-ids.ts';
import { validateRecord } from './validation.ts';

type ReceiptRow = Omit<FinalizationReceiptRecord, 'receipt'> &
  Omit<FinalizationReceiptRecord['receipt'], 'createdEnrollmentIds'>;

export class FinalizationReceiptQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  get({ idempotencyKey }: { idempotencyKey: string }): FinalizationReceiptRecord | undefined {
    const row = this.db.prepare(`
      SELECT idempotency_key AS idempotencyKey, request_hash AS requestHash, semester_id AS semesterId,
        draft_id AS draftId, receipt_id AS receiptId, created_count AS createdCount,
        finalized_at AS finalizedAt, enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
        enrollment_report_store_revision AS enrollmentReportStoreRevision
      FROM finalization_receipts WHERE idempotency_key = ?
    `).get(idempotencyKey) as ReceiptRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  latest({ semesterId }: { semesterId: string }): FinalizationReceiptRecord | undefined {
    const row = this.db.prepare(`
      SELECT idempotency_key AS idempotencyKey, request_hash AS requestHash, semester_id AS semesterId,
        draft_id AS draftId, receipt_id AS receiptId, created_count AS createdCount,
        finalized_at AS finalizedAt, enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
        enrollment_report_store_revision AS enrollmentReportStoreRevision
      FROM finalization_receipts WHERE semester_id = ? ORDER BY position DESC LIMIT 1
    `).get(semesterId) as ReceiptRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  insert({ record }: { record: FinalizationReceiptRecord }): void {
    validateRecord('finalizationReceipts', record);
    this.db.prepare(`
      INSERT INTO finalization_receipts
        (idempotency_key, position, request_hash, semester_id, draft_id, receipt_id, created_count,
         finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM finalization_receipts), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.idempotencyKey, record.requestHash, record.semesterId, record.receipt.draftId,
      record.receipt.receiptId, record.receipt.createdCount, record.receipt.finalizedAt,
      record.enrollmentReportDownloadedAt, record.enrollmentReportStoreRevision);
    new FinalizationReceiptEnrollmentIdQueries(this.db).insert({
      idempotencyKey: record.idempotencyKey, enrollmentIds: record.receipt.createdEnrollmentIds,
    });
  }

  markReportDownloaded(input: { idempotencyKey: string; downloadedAt: string; storeRevision: number }): void {
    this.db.prepare(`
      UPDATE finalization_receipts
      SET enrollment_report_downloaded_at = ?, enrollment_report_store_revision = ?
      WHERE idempotency_key = ?
    `).run(input.downloadedAt, input.storeRevision, input.idempotencyKey);
  }

  private hydrate(row: ReceiptRow): FinalizationReceiptRecord {
    const { draftId, receiptId, createdCount, finalizedAt, ...record } = row;
    const ids = new FinalizationReceiptEnrollmentIdQueries(this.db).list({ idempotencyKey: record.idempotencyKey });
    return { ...record, receipt: { draftId, receiptId, createdCount, finalizedAt,
      createdEnrollmentIds: ids } };
  }
}

export const readSnapshotRows = (db: DatabaseSync): (Omit<import('../domain/records.ts').FinalizationReceiptRecord, 'receipt'> &
    Omit<import('../domain/records.ts').FinalizationReceiptRecord['receipt'], 'createdEnrollmentIds'>)[] => (
  db.prepare(`SELECT
    idempotency_key AS idempotencyKey, request_hash AS requestHash, semester_id AS semesterId,
    draft_id AS draftId, receipt_id AS receiptId, created_count AS createdCount,
    finalized_at AS finalizedAt, enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
    enrollment_report_store_revision AS enrollmentReportStoreRevision
    FROM finalization_receipts ORDER BY position`).all().map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').FinalizationReceiptRecord, 'receipt'> &
    Omit<import('../domain/records.ts').FinalizationReceiptRecord['receipt'], 'createdEnrollmentIds'>)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['finalizationReceipts'][number])[], previous: (import('../domain/records.ts').DatabaseState['finalizationReceipts'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM finalization_receipts WHERE idempotency_key = ?');
  const move = db.prepare('UPDATE finalization_receipts SET position = ? WHERE idempotency_key = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM finalization_receipts').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT idempotency_key AS key, position FROM finalization_receipts').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [db.prepare('UPDATE finalization_receipts SET receipt_id = ? WHERE idempotency_key = ?')];
  const changes = planRowChanges(records, previous, maximum, positions, [(item) => item.receipt.receiptId], 'Duplicate finalization_receipts key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO finalization_receipts (idempotency_key, position, request_hash, semester_id, draft_id, receipt_id, created_count, finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT idempotency_key, position, request_hash, semester_id, draft_id, receipt_id, created_count, finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision
      FROM finalization_receipts WHERE idempotency_key = ?`);
  const update = db.prepare(`UPDATE finalization_receipts SET position = ?, request_hash = ?, semester_id = ?, draft_id = ?, receipt_id = ?, created_count = ?, finalized_at = ?, enrollment_report_downloaded_at = ?, enrollment_report_store_revision = ?
      WHERE idempotency_key = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate finalization_receipts key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
