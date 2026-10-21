import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

import type { ImportResolutionRecord } from '../domain/records.ts';

export class ImportResolutionQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  listForBatch({ importBatchId }: { importBatchId: string }): ImportResolutionRecord[] {
    return this.db.prepare(`
      SELECT entity, action, field, semester_name AS semesterName, member_name AS memberName,
             course_name AS courseName, application_order AS applicationOrder,
             warning_digest AS warningDigest, acknowledgement_note AS acknowledgementNote
      FROM import_resolutions WHERE import_batch_id = ? ORDER BY position
    `).all(importBatchId).map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null))) as ImportResolutionRecord[];
  }

  insert({ importBatchId, position, record }: { importBatchId: string; position: number; record: ImportResolutionRecord }): void {
    this.db.prepare(`
      INSERT INTO import_resolutions
        (import_batch_id, position, entity, action, field, semester_name, member_name, course_name,
         application_order, warning_digest, acknowledgement_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(importBatchId, position, record.entity, record.action,
      record.field ?? null, record.semesterName ?? null, record.memberName ?? null,
      record.courseName ?? null, record.applicationOrder ?? null,
      record.warningDigest ?? null, record.acknowledgementNote ?? null);
  }

  deleteForBatch({ importBatchId }: { importBatchId: string }): void {
    this.db.prepare('DELETE FROM import_resolutions WHERE import_batch_id = ?').run(importBatchId);
  }
}

type SnapshotTypeWithParent<T> = T & { parentId: string };

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeWithParent<import('../domain/records.ts').ImportResolutionRecord>)[] => (
  db.prepare(`SELECT import_batch_id AS parentId,
    entity, action, field, semester_name AS semesterName, member_name AS memberName,
    course_name AS courseName, application_order AS applicationOrder, warning_digest AS warningDigest,
    acknowledgement_note AS acknowledgementNote FROM import_resolutions WHERE (? IS NULL OR import_batch_id = ?)
    ORDER BY import_batch_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeWithParent<import('../domain/records.ts').ImportResolutionRecord>)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO import_resolutions
    (import_batch_id, position, entity, action, field, semester_name, member_name, course_name,
      application_order, warning_digest, acknowledgement_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM import_resolutions WHERE import_batch_id = ?').run(parentId);
  return true;
};
