import type { DatabaseSync } from 'node:sqlite';

type ImportRawCell = { rowPosition: number; columnName: string; cellValue: string | null };

export class ImportRawCellQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  listForBatch({ importBatchId }: { importBatchId: string }): ImportRawCell[] {
    return this.db.prepare(`
      SELECT row_position AS rowPosition, column_name AS columnName, cell_value AS cellValue
      FROM import_raw_cells WHERE import_batch_id = ? ORDER BY row_position, position
    `).all(importBatchId).map((row) => ({ ...row })) as ImportRawCell[];
  }

  insert({ importBatchId, position, record }: { importBatchId: string; position: number; record: ImportRawCell }): void {
    this.db.prepare(`
      INSERT INTO import_raw_cells (import_batch_id, row_position, position, column_name, cell_value)
      VALUES (?, ?, ?, ?, ?)
    `).run(importBatchId, record.rowPosition, position, record.columnName, record.cellValue);
  }

  deleteForBatch({ importBatchId }: { importBatchId: string }): void {
    this.db.prepare('DELETE FROM import_raw_cells WHERE import_batch_id = ?').run(importBatchId);
  }
}

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): ({ batchId: string; rowPosition: number; columnName: string; cellValue: string | null })[] => (
  db.prepare(`SELECT
    import_batch_id AS batchId, row_position AS rowPosition, column_name AS columnName, cell_value AS cellValue
    FROM import_raw_cells WHERE (? IS NULL OR import_batch_id = ?)
    ORDER BY import_batch_id, row_position, position`).all(parentId, parentId).map((row) => ({ ...row })) as ({ batchId: string; rowPosition: number; columnName: string; cellValue: string | null })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO import_raw_cells
    (import_batch_id, row_position, position, column_name, cell_value) VALUES (?, ?, ?, ?, ?)`);
