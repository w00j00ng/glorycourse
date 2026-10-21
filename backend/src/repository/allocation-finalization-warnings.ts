import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeFinalizationWarningRow = Pick<import('../domain/records.ts').FinalizationWarningRecord, 'code' | 'message' | 'severity' | 'note' | 'acknowledgedAt'> & {
  parentId: string;
  subjectEntityType: string;
  subjectEntityId: string | null;
  subjectMemberId: string | null;
  subjectCourseId: string | null;
  changeCode: string | null;
};

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeFinalizationWarningRow)[] => (
  db.prepare(`SELECT allocation_draft_id AS parentId,
    code, message, severity, subject_entity_type AS subjectEntityType, subject_entity_id AS subjectEntityId,
    subject_member_id AS subjectMemberId, subject_course_id AS subjectCourseId, change_code AS changeCode,
    note, acknowledged_at AS acknowledgedAt FROM allocation_finalization_warnings
    WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY allocation_draft_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeFinalizationWarningRow)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_finalization_warnings
    (allocation_draft_id, position, code, message, severity, subject_entity_type, subject_entity_id,
      subject_member_id, subject_course_id, change_code, note, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
