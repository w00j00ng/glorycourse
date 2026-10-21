import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import type { DatabaseState, ImportBatchRecord } from '../domain/records.ts';
import { ApplicationQueries } from './applications.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { validateRecord } from './validation.ts';

export type ImportContext = Pick<DatabaseState,
  'meta' | 'semesters' | 'members' | 'courses' | 'semesterCourses' | 'applications' | 'applicationChoices' | 'enrollments'
>;
type ImportReceipt = NonNullable<ImportBatchRecord['receipt']>;

export class ImportQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  getContext(): ImportContext {
    const applications = new ApplicationQueries(this.db);
    return {
      ...new EnrollmentQueries(this.db).getContext(),
      applications: applications.listRecords(),
      applicationChoices: applications.listChoices(),
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
    for (const cell of this.db.prepare(`
      SELECT row_position AS rowPosition, column_name AS columnName, cell_value AS cellValue
      FROM import_raw_cells WHERE import_batch_id = ? ORDER BY row_position, position
    `).all(id)) {
      const position = Number(cell.rowPosition);
      const rowCells = cells.get(position) ?? {};
      rowCells[String(cell.columnName)] = cell.cellValue as string | null;
      cells.set(position, rowCells);
    }
    const rawRows = this.db.prepare(`
      SELECT position, sheet, row_number AS row
      FROM import_raw_rows WHERE import_batch_id = ? ORDER BY position
    `).all(id).map(({ position, ...row }) => ({
      ...row, cells: cells.get(Number(position)) ?? {},
    })) as ImportBatchRecord['rawRows'];
    const resolutions = this.db.prepare(`
      SELECT entity, action, field, semester_name AS semesterName, member_name AS memberName,
             course_name AS courseName, application_order AS applicationOrder,
             warning_digest AS warningDigest, acknowledgement_note AS acknowledgementNote
      FROM import_resolutions WHERE import_batch_id = ? ORDER BY position
    `).all(id).map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))) as ImportBatchRecord['resolutions'];
    const receipt = this.db.prepare(`
      SELECT receipt_id AS receiptId, import_batch_id AS importBatchId, preview_id AS previewId,
             store_epoch AS storeEpoch, idempotency_key AS idempotencyKey, request_hash AS requestHash,
             inserted_count AS inserted, updated_count AS updated, skipped_count AS skipped,
             committed_at AS committedAt
      FROM import_receipts WHERE import_batch_id = ?
    `).get(id);
    return { ...batch, rawRows, resolutions, receipt: receipt ? { ...receipt } : null } as ImportBatchRecord;
  }

  findReceipt({ previewId, storeEpoch, idempotencyKey }: {
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
      this.db.prepare('DELETE FROM import_raw_rows WHERE import_batch_id = ?').run(record.id);
      const insertRow = this.db.prepare(`
        INSERT INTO import_raw_rows (import_batch_id, position, sheet, row_number) VALUES (?, ?, ?, ?)
      `);
      const insertCell = this.db.prepare(`
        INSERT INTO import_raw_cells (import_batch_id, row_position, position, column_name, cell_value)
        VALUES (?, ?, ?, ?, ?)
      `);
      record.rawRows.forEach((row, position) => {
        insertRow.run(record.id, position, row.sheet, row.row);
        Object.entries(row.cells).forEach(([column, value], cellPosition) => {
          insertCell.run(record.id, position, cellPosition, column, value);
        });
      });
    }
    if (!isDeepStrictEqual(previous?.resolutions, record.resolutions)) {
      this.db.prepare('DELETE FROM import_resolutions WHERE import_batch_id = ?').run(record.id);
      const insertResolution = this.db.prepare(`
        INSERT INTO import_resolutions
          (import_batch_id, position, entity, action, field, semester_name, member_name, course_name,
           application_order, warning_digest, acknowledgement_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      record.resolutions.forEach((resolution, position) => {
        insertResolution.run(record.id, position, resolution.entity, resolution.action,
          resolution.field ?? null, resolution.semesterName ?? null, resolution.memberName ?? null,
          resolution.courseName ?? null, resolution.applicationOrder ?? null,
          resolution.warningDigest ?? null, resolution.acknowledgementNote ?? null);
      });
    }
    if (!isDeepStrictEqual(previous?.receipt, record.receipt)) {
      this.db.prepare('DELETE FROM import_receipts WHERE import_batch_id = ?').run(record.id);
      if (record.receipt) {
        const receipt = record.receipt;
        this.db.prepare(`
          INSERT INTO import_receipts
            (import_batch_id, receipt_id, preview_id, store_epoch, idempotency_key, request_hash,
             inserted_count, updated_count, skipped_count, committed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(record.id, receipt.receiptId, receipt.previewId, receipt.storeEpoch, receipt.idempotencyKey,
          receipt.requestHash, receipt.inserted, receipt.updated, receipt.skipped, receipt.committedAt);
      }
    }
  }

  applyCandidate({ previous, candidate }: { previous: ImportContext; candidate: ImportContext }): void {
    new EnrollmentQueries(this.db).applyCandidate({ previous, candidate });
    const queries = new ApplicationQueries(this.db);
    const oldApplications = new Map(previous.applications.map((record) => [record.id, record]));
    for (const record of candidate.applications) {
      const old = oldApplications.get(record.id);
      if (!old) queries.insert({ record });
      else if (!isDeepStrictEqual(old, record)) queries.update({ record });
      oldApplications.delete(record.id);
    }
    const previousChoices = new Map<string, ImportContext['applicationChoices']>();
    for (const record of previous.applicationChoices) {
      const choices = previousChoices.get(record.applicationId) ?? [];
      choices.push(record);
      previousChoices.set(record.applicationId, choices);
    }
    const candidateChoices = new Map<string, ImportContext['applicationChoices']>();
    for (const record of candidate.applicationChoices) {
      const choices = candidateChoices.get(record.applicationId) ?? [];
      choices.push(record);
      candidateChoices.set(record.applicationId, choices);
    }
    const changed = new Set<string>();
    for (const record of candidate.applications) {
      if (!isDeepStrictEqual(previousChoices.get(record.id) ?? [], candidateChoices.get(record.id) ?? [])) {
        changed.add(record.id);
        queries.replaceChoices({ applicationId: record.id, records: [] });
      }
    }
    for (const record of candidate.applicationChoices) {
      if (changed.has(record.applicationId)) queries.insertChoice({ record });
    }
    for (const id of oldApplications.keys()) queries.delete({ id });
  }
}
