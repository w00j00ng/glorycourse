import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

import type { ImportBatchRecord } from '../domain/records.ts';

type ImportRawRow = Pick<ImportBatchRecord['rawRows'][number], 'sheet' | 'row'>;

export class ImportRawRowQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  listForBatch({ importBatchId }: { importBatchId: string }): (ImportRawRow & { position: number })[] {
    return this.db.prepare(`
      SELECT position, sheet, row_number AS row
      FROM import_raw_rows WHERE import_batch_id = ? ORDER BY position
    `).all(importBatchId).map((row) => ({ ...row })) as (ImportRawRow & { position: number })[];
  }

  insert({ importBatchId, position, record }: { importBatchId: string; position: number; record: ImportRawRow }): void {
    this.db.prepare(`
      INSERT INTO import_raw_rows (import_batch_id, position, sheet, row_number) VALUES (?, ?, ?, ?)
    `).run(importBatchId, position, record.sheet, record.row);
  }

  deleteForBatch({ importBatchId }: { importBatchId: string }): void {
    this.db.prepare('DELETE FROM import_raw_rows WHERE import_batch_id = ?').run(importBatchId);
  }
}

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): ({ parentId: string; position: number; sheet: string; row: number })[] => (
  db.prepare(`SELECT
    import_batch_id AS parentId, position, sheet, row_number AS row FROM import_raw_rows
    WHERE (? IS NULL OR import_batch_id = ?)
    ORDER BY import_batch_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as ({ parentId: string; position: number; sheet: string; row: number })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO import_raw_rows
    (import_batch_id, position, sheet, row_number) VALUES (?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM import_raw_rows WHERE import_batch_id = ?').run(parentId);
  return true;
};
