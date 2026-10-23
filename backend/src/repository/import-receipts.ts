import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

import type { ImportBatchRecord } from '../domain/records.ts';

type ImportReceipt = NonNullable<ImportBatchRecord['receipt']>;

export class ImportReceiptQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  getForBatch({ importBatchId }: { importBatchId: string }): ImportReceipt | undefined {
    const row = this.db.prepare(`
      SELECT receipt_id AS receiptId, import_batch_id AS importBatchId, preview_id AS previewId,
             store_epoch AS storeEpoch, idempotency_key AS idempotencyKey, request_hash AS requestHash,
             inserted_count AS inserted, updated_count AS updated, skipped_count AS skipped,
             committed_at AS committedAt
      FROM import_receipts WHERE import_batch_id = ?
    `).get(importBatchId);
    return row ? { ...row } as ImportReceipt : undefined;
  }

  find({ previewId, storeEpoch, idempotencyKey }: {
    previewId: string; storeEpoch: string; idempotencyKey: string;
  }): ImportReceipt | undefined {
    const row = this.db.prepare(`
      SELECT receipt_id AS receiptId, import_batch_id AS importBatchId, preview_id AS previewId,
             store_epoch AS storeEpoch, idempotency_key AS idempotencyKey, request_hash AS requestHash,
             inserted_count AS inserted, updated_count AS updated, skipped_count AS skipped,
             committed_at AS committedAt
      FROM import_receipts
      WHERE preview_id = ? AND store_epoch = ? AND idempotency_key = ?
    `).get(previewId, storeEpoch, idempotencyKey);
    return row ? { ...row } as ImportReceipt : undefined;
  }

  insert({ importBatchId, record }: { importBatchId: string; record: ImportReceipt }): void {
    this.db.prepare(`
      INSERT INTO import_receipts
        (import_batch_id, receipt_id, preview_id, store_epoch, idempotency_key, request_hash,
         inserted_count, updated_count, skipped_count, committed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(importBatchId, record.receiptId, record.previewId, record.storeEpoch, record.idempotencyKey,
      record.requestHash, record.inserted, record.updated, record.skipped, record.committedAt);
  }

  deleteForBatch({ importBatchId }: { importBatchId: string }): void {
    this.db.prepare('DELETE FROM import_receipts WHERE import_batch_id = ?').run(importBatchId);
  }
}

type SnapshotTypeImportReceipt = NonNullable<import('../domain/records.ts').ImportBatchRecord['receipt']>;

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeImportReceipt)[] => (
  db.prepare(`SELECT receipt_id AS receiptId, import_batch_id AS importBatchId,
    preview_id AS previewId, store_epoch AS storeEpoch, idempotency_key AS idempotencyKey,
    request_hash AS requestHash, inserted_count AS inserted, updated_count AS updated,
    skipped_count AS skipped, committed_at AS committedAt FROM import_receipts
    WHERE (? IS NULL OR import_batch_id = ?)`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeImportReceipt)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO import_receipts
    (import_batch_id, receipt_id, preview_id, store_epoch, idempotency_key, request_hash,
      inserted_count, updated_count, skipped_count, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM import_receipts WHERE import_batch_id = ?').run(parentId);
  return true;
};
