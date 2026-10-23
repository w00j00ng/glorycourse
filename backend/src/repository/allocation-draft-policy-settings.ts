import { isDeepStrictEqual } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (import('../allocation/engine.ts').PolicySettings & { draftId: string })[] => (
  db.prepare(`SELECT allocation_draft_id AS draftId,
    preference_mode AS preferenceMode, fallback_mode AS fallbackMode FROM allocation_draft_policy_settings
    WHERE (? IS NULL OR allocation_draft_id = ?)`).all(parentId, parentId).map((row) => ({ ...row })) as (import('../allocation/engine.ts').PolicySettings & { draftId: string })[]
);

export const prepareSnapshotInsert = (db: DatabaseSync) => db.prepare(`INSERT INTO allocation_draft_policy_settings
    (allocation_draft_id, preference_mode, fallback_mode) VALUES (?, ?, ?)`);

export const replaceSnapshotChildren = (
  db: DatabaseSync, parentId: string, before: unknown, after: unknown,
): boolean => {
  if (isDeepStrictEqual(before, after)) return false;
  if (before !== undefined) db.prepare('DELETE FROM allocation_draft_policy_settings WHERE allocation_draft_id = ?').run(parentId);
  return true;
};
