import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

type SnapshotTypeSnapshot = import('../allocation/engine.ts').AllocationSnapshot;
type SnapshotTypeWithParent<T> = T & { parentId: string };

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (SnapshotTypeWithParent<SnapshotTypeSnapshot['applications'][number]>)[] => (
  db.prepare(`SELECT allocation_draft_id AS parentId,
    application_id AS id, member_id AS memberId, member_name AS memberName, ministry, applicant_note AS applicantNote,
    application_order AS applicationOrder, application_order_status AS applicationOrderStatus
    FROM allocation_snapshot_applications WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY allocation_draft_id, position`).all(parentId, parentId).map((row) => ({ ...row })) as (SnapshotTypeWithParent<SnapshotTypeSnapshot['applications'][number]>)[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_snapshot_applications
    (allocation_draft_id, position, application_id, member_id, member_name, application_order,
      application_order_status, ministry, applicant_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_snapshot_applications WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
