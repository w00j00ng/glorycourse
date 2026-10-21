import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { ApplicationChoiceRecord } from '../domain/records.ts';

export class ApplicationChoiceSourceRefQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  list({ choiceIds }: { choiceIds: string[] }): (ApplicationChoiceRecord['sourceRefs'][number] & { choiceId: string })[] {
    return this.db.prepare(`SELECT application_choice_id AS choiceId, import_batch_id AS importBatchId,
      sheet, row_number AS row FROM application_choice_source_refs
      WHERE application_choice_id IN (SELECT value FROM json_each(?)) ORDER BY application_choice_id, position`)
      .all(JSON.stringify(choiceIds)).map(row => ({ ...row })) as (ApplicationChoiceRecord['sourceRefs'][number] & { choiceId: string })[];
  }

  insert({ choiceId, records }: { choiceId: string; records: ApplicationChoiceRecord['sourceRefs'] }): void {
    const insert = this.db.prepare(`INSERT INTO application_choice_source_refs
      (application_choice_id, position, import_batch_id, sheet, row_number) VALUES (?, ?, ?, ?, ?)`);
    records.forEach((ref, position) => insert.run(choiceId, position, ref.importBatchId, ref.sheet, ref.row));
  }
}

type SnapshotTypeSourceRef = { importBatchId: string; sheet: string; row: number };

export const readSnapshotRows = (db: DatabaseSync): (SnapshotTypeSourceRef & { parentId: string })[] => (
  db.prepare(`SELECT application_choice_id AS parentId,
    import_batch_id AS importBatchId, sheet, row_number AS row FROM application_choice_source_refs
    ORDER BY application_choice_id, position`).all().map((row) => ({ ...row })) as (SnapshotTypeSourceRef & { parentId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO application_choice_source_refs
    (application_choice_id, position, import_batch_id, sheet, row_number) VALUES (?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM application_choice_source_refs WHERE application_choice_id = ?').run(parentId);
  return true;
};
