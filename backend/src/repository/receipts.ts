import type { DatabaseSync } from 'node:sqlite';
import type { FinalizationReceiptRecord } from '../domain/records.ts';
import { validateRecord } from './validation.ts';

type ReceiptRow = Omit<FinalizationReceiptRecord, 'receipt'> &
  Omit<FinalizationReceiptRecord['receipt'], 'createdEnrollmentIds'>;

export class ReceiptQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  getFinalization({ idempotencyKey }: { idempotencyKey: string }): FinalizationReceiptRecord | undefined {
    const row = this.db.prepare(`
      SELECT idempotency_key AS idempotencyKey, request_hash AS requestHash, semester_id AS semesterId,
        draft_id AS draftId, receipt_id AS receiptId, created_count AS createdCount,
        finalized_at AS finalizedAt, enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
        enrollment_report_store_revision AS enrollmentReportStoreRevision
      FROM finalization_receipts WHERE idempotency_key = ?
    `).get(idempotencyKey) as ReceiptRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  latestFinalization({ semesterId }: { semesterId: string }): FinalizationReceiptRecord | undefined {
    const row = this.db.prepare(`
      SELECT idempotency_key AS idempotencyKey, request_hash AS requestHash, semester_id AS semesterId,
        draft_id AS draftId, receipt_id AS receiptId, created_count AS createdCount,
        finalized_at AS finalizedAt, enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
        enrollment_report_store_revision AS enrollmentReportStoreRevision
      FROM finalization_receipts WHERE semester_id = ? ORDER BY position DESC LIMIT 1
    `).get(semesterId) as ReceiptRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  insertFinalization({ record }: { record: FinalizationReceiptRecord }): void {
    validateRecord('finalizationReceipts', record);
    this.db.prepare(`
      INSERT INTO finalization_receipts
        (idempotency_key, position, request_hash, semester_id, draft_id, receipt_id, created_count,
         finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM finalization_receipts), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.idempotencyKey, record.requestHash, record.semesterId, record.receipt.draftId,
      record.receipt.receiptId, record.receipt.createdCount, record.receipt.finalizedAt,
      record.enrollmentReportDownloadedAt, record.enrollmentReportStoreRevision);
    const insert = this.db.prepare(`
      INSERT INTO finalization_receipt_enrollment_ids (idempotency_key, position, enrollment_id) VALUES (?, ?, ?)
    `);
    record.receipt.createdEnrollmentIds.forEach((id, position) => insert.run(record.idempotencyKey, position, id));
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
    const ids = this.db.prepare(`
      SELECT enrollment_id AS enrollmentId FROM finalization_receipt_enrollment_ids
      WHERE idempotency_key = ? ORDER BY position
    `).all(record.idempotencyKey);
    return { ...record, receipt: { draftId, receiptId, createdCount, finalizedAt,
      createdEnrollmentIds: ids.map(({ enrollmentId }) => String(enrollmentId)) } };
  }
}
