import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import type { DatabaseState, ImportBatchRecord } from '../domain/records.ts';
import { ApplicationChoiceQueries } from './application-choices.ts';
import { ApplicationQueries } from './applications.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { ImportRawCellQueries } from './import-raw-cells.ts';
import { ImportRawRowQueries } from './import-raw-rows.ts';
import { ImportReceiptQueries } from './import-receipts.ts';
import { ImportResolutionQueries } from './import-resolutions.ts';
import { validateRecord } from './validation.ts';

export type ImportContext = Pick<DatabaseState,
  'meta' | 'semesters' | 'members' | 'courses' | 'semesterCourses' | 'applications' | 'applicationChoices' | 'enrollments'
>;

export class ImportBatchQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  getContext(): ImportContext {
    return {
      ...new EnrollmentQueries(this.db).getContext(),
      applications: new ApplicationQueries(this.db).listRecords(),
      applicationChoices: new ApplicationChoiceQueries(this.db).list(),
    };
  }

  getBatch({ id }: { id: string }): ImportBatchRecord | undefined {
    const batch = this.db.prepare(`
      SELECT id, kind, template_version AS templateVersion, file_hash AS fileHash,
             imported_at AS importedAt, status
      FROM import_batches WHERE id = ?
    `).get(id);
    if (!batch) return undefined;
    const cells = new Map<number, Record<string, string | null>>();
    for (const cell of new ImportRawCellQueries(this.db).listForBatch({ importBatchId: id })) {
      const position = Number(cell.rowPosition);
      const rowCells = cells.get(position) ?? {};
      rowCells[cell.columnName] = cell.cellValue;
      cells.set(position, rowCells);
    }
    const rawRows = new ImportRawRowQueries(this.db).listForBatch({ importBatchId: id })
      .map(({ position, ...row }) => ({ ...row, cells: cells.get(Number(position)) ?? {} }));
    const resolutions = new ImportResolutionQueries(this.db).listForBatch({ importBatchId: id });
    const receipt = new ImportReceiptQueries(this.db).getForBatch({ importBatchId: id });
    return { ...batch, rawRows, resolutions, receipt: receipt ?? null } as ImportBatchRecord;
  }

  saveBatch({ record }: { record: ImportBatchRecord }): void {
    validateRecord('importBatches', record);
    const previous = this.getBatch({ id: record.id });
    if (previous) {
      this.db.prepare(`
        UPDATE import_batches SET kind = ?, template_version = ?, file_hash = ?, imported_at = ?, status = ?
        WHERE id = ?
      `).run(record.kind, record.templateVersion, record.fileHash, record.importedAt, record.status, record.id);
    } else {
      this.db.prepare(`
        INSERT INTO import_batches (id, position, kind, template_version, file_hash, imported_at, status)
        VALUES (?, COALESCE((SELECT max(position) + 1 FROM import_batches), 0), ?, ?, ?, ?, ?)
      `).run(record.id, record.kind, record.templateVersion, record.fileHash, record.importedAt, record.status);
    }
    if (!isDeepStrictEqual(previous?.rawRows, record.rawRows)) {
      const rows = new ImportRawRowQueries(this.db);
      const cells = new ImportRawCellQueries(this.db);
      rows.deleteForBatch({ importBatchId: record.id });
      record.rawRows.forEach((row, position) => {
        rows.insert({ importBatchId: record.id, position, record: row });
        Object.entries(row.cells).forEach(([columnName, cellValue], cellPosition) => {
          cells.insert({ importBatchId: record.id, position: cellPosition, record: { rowPosition: position, columnName, cellValue } });
        });
      });
    }
    if (!isDeepStrictEqual(previous?.resolutions, record.resolutions)) {
      const resolutions = new ImportResolutionQueries(this.db);
      resolutions.deleteForBatch({ importBatchId: record.id });
      record.resolutions.forEach((resolution, position) => {
        resolutions.insert({ importBatchId: record.id, position, record: resolution });
      });
    }
    if (!isDeepStrictEqual(previous?.receipt, record.receipt)) {
      const receipts = new ImportReceiptQueries(this.db);
      receipts.deleteForBatch({ importBatchId: record.id });
      if (record.receipt) receipts.insert({ importBatchId: record.id, record: record.receipt });
    }
  }

  applyCandidate({ previous, candidate }: { previous: ImportContext; candidate: ImportContext }): void {
    new EnrollmentQueries(this.db).applyCandidate({ previous, candidate });
    const queries = new ApplicationQueries(this.db);
    const choices = new ApplicationChoiceQueries(this.db);
    const oldApplications = new Map(previous.applications.map((record) => [record.id, record]));
    for (const record of candidate.applications) {
      const old = oldApplications.get(record.id);
      if (!old) queries.insert({ record });
      else if (!isDeepStrictEqual(old, record)) queries.update({ record });
      oldApplications.delete(record.id);
    }
    const previousChoices = new Map<string, ImportContext['applicationChoices']>();
    for (const record of previous.applicationChoices) {
      const records = previousChoices.get(record.applicationId) ?? [];
      records.push(record);
      previousChoices.set(record.applicationId, records);
    }
    const candidateChoices = new Map<string, ImportContext['applicationChoices']>();
    for (const record of candidate.applicationChoices) {
      const records = candidateChoices.get(record.applicationId) ?? [];
      records.push(record);
      candidateChoices.set(record.applicationId, records);
    }
    const changed = new Set<string>();
    for (const record of candidate.applications) {
      if (!isDeepStrictEqual(previousChoices.get(record.id) ?? [], candidateChoices.get(record.id) ?? [])) {
        changed.add(record.id);
        choices.replaceForApplication({ applicationId: record.id, records: [] });
      }
    }
    for (const record of candidate.applicationChoices) {
      if (changed.has(record.applicationId)) choices.insert({ record });
    }
    for (const id of oldApplications.keys()) queries.delete({ id });
  }
}

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (Omit<import('../domain/records.ts').ImportBatchRecord, 'rawRows' | 'resolutions' | 'receipt'>)[] => (
  db.prepare(`SELECT id, kind,
    template_version AS templateVersion, file_hash AS fileHash, imported_at AS importedAt, status
    FROM import_batches WHERE (? IS NULL OR id = ?)
    ORDER BY position`).all(parentId, parentId).map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').ImportBatchRecord, 'rawRows' | 'resolutions' | 'receipt'>)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['importBatches'][number])[], previous: (import('../domain/records.ts').DatabaseState['importBatches'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM import_batches WHERE id = ?');
  const move = db.prepare('UPDATE import_batches SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM import_batches').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM import_batches').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [];
  const changes = planRowChanges(records, previous, maximum, positions, [], 'Duplicate import_batches key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO import_batches (id, position, kind, template_version, file_hash, imported_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, kind, template_version, file_hash, imported_at, status
      FROM import_batches WHERE id = ?`);
  const update = db.prepare(`UPDATE import_batches SET position = ?, kind = ?, template_version = ?, file_hash = ?, imported_at = ?, status = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate import_batches key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
