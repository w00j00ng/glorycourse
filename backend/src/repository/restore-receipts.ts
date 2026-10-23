import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync): (import('../domain/records.ts').RestoreReceiptRecord)[] => (
  db.prepare(`SELECT idempotency_key AS idempotencyKey,
    request_hash AS requestHash, receipt_id AS receiptId, previous_backup_id AS previousBackupId,
    store_revision AS storeRevision, store_epoch AS storeEpoch, restored_at AS restoredAt
    FROM restore_receipts ORDER BY position`).all().map((row) => ({ ...row })) as (import('../domain/records.ts').RestoreReceiptRecord)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['restoreReceipts'][number])[], previous: (import('../domain/records.ts').DatabaseState['restoreReceipts'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM restore_receipts WHERE idempotency_key = ?');
  const move = db.prepare('UPDATE restore_receipts SET position = ? WHERE idempotency_key = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM restore_receipts').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT idempotency_key AS key, position FROM restore_receipts').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [db.prepare('UPDATE restore_receipts SET receipt_id = ? WHERE idempotency_key = ?')];
  const changes = planRowChanges(records, previous, maximum, positions, [(item) => item.receiptId], 'Duplicate restore_receipts key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO restore_receipts (idempotency_key, position, request_hash, receipt_id, previous_backup_id, store_revision, store_epoch, restored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT idempotency_key, position, request_hash, receipt_id, previous_backup_id, store_revision, store_epoch, restored_at
      FROM restore_receipts WHERE idempotency_key = ?`);
  const update = db.prepare(`UPDATE restore_receipts SET position = ?, request_hash = ?, receipt_id = ?, previous_backup_id = ?, store_revision = ?, store_epoch = ?, restored_at = ?
      WHERE idempotency_key = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate restore_receipts key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
