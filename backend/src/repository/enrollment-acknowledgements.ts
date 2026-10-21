import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { EnrollmentRecord } from '../domain/records.ts';

export class EnrollmentAcknowledgementQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  delete({ enrollmentId }: { enrollmentId: string }): void {
    this.db.prepare('DELETE FROM enrollment_acknowledgements WHERE enrollment_id = ?').run(enrollmentId);
  }

  insert({ enrollmentId, record }: { enrollmentId: string; record: NonNullable<EnrollmentRecord['exceptionAcknowledgement']> }): void {
    this.db.prepare(`INSERT INTO enrollment_acknowledgements (enrollment_id, warning_digest, note, acknowledged_at)
      VALUES (?, ?, ?, ?)`).run(enrollmentId, record.warningDigest, record.note, record.acknowledgedAt);
  }
}

type SnapshotTypeAcknowledgement = { warningDigest: string; note: string; acknowledgedAt: string };

export const readSnapshotRows = (db: DatabaseSync): (SnapshotTypeAcknowledgement & { enrollmentId: string })[] => (
  db.prepare(`SELECT enrollment_id AS enrollmentId,
    warning_digest AS warningDigest, note, acknowledged_at AS acknowledgedAt FROM enrollment_acknowledgements`).all().map((row) => ({ ...row })) as (SnapshotTypeAcknowledgement & { enrollmentId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO enrollment_acknowledgements
    (enrollment_id, warning_digest, note, acknowledged_at) VALUES (?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM enrollment_acknowledgements WHERE enrollment_id = ?').run(parentId);
  return true;
};
