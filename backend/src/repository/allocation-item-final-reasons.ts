import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): ({ itemId: string; note: string })[] => (
  db.prepare(`SELECT
    allocation_draft_item_id AS itemId, note FROM allocation_item_final_reasons
    WHERE allocation_draft_item_id IN (SELECT id FROM allocation_draft_items WHERE (? IS NULL OR allocation_draft_id = ?))`).all(parentId, parentId).map((row) => ({ ...row })) as ({ itemId: string; note: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_item_final_reasons
    (allocation_draft_item_id, note) VALUES (?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_item_final_reasons WHERE allocation_draft_item_id = ?').run(parentId);
  return true;
};
