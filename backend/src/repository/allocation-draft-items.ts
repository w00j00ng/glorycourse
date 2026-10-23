import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { AllocationDraftItemRecord } from '../domain/records.ts';
import { readDrafts } from './relational-store.ts';

export class AllocationDraftItemQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  getForMember({ draftId, memberId }: { draftId: string; memberId: string }): AllocationDraftItemRecord | undefined {
    return readDrafts(this.db, draftId).items.find((item) => item.memberId === memberId);
  }

  positions({ draftId }: { draftId: string }): Map<string, number> {
    return new Map(this.db.prepare(`
      SELECT id, position FROM allocation_draft_items WHERE allocation_draft_id = ?
    `).all(draftId).map(({ id, position }) => [String(id), Number(position)]));
  }

  nextPosition(): number {
    return Number(this.db.prepare(`
      SELECT COALESCE(MAX(position), -1) + 1 AS position FROM allocation_draft_items
    `).get()!.position);
  }
}

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (Omit<import('../domain/records.ts').AllocationDraftItemRecord, 'autoReasonDetail' | 'finalReasonDetail'>)[] => (
  db.prepare(`SELECT id, allocation_draft_id AS draftId, member_id AS memberId,
    source_application_id AS sourceApplicationId, member_name_at_generation AS memberNameAtGeneration, ministry,
    auto_semester_course_id AS autoSemesterCourseId, auto_decision AS autoDecision,
    auto_reason_code AS autoReasonCode, final_semester_course_id AS finalSemesterCourseId,
    final_decision AS finalDecision, final_reason_code AS finalReasonCode, updated_at AS updatedAt
    FROM allocation_draft_items WHERE (? IS NULL OR allocation_draft_id = ?)
    ORDER BY position`).all(parentId, parentId).map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').AllocationDraftItemRecord, 'autoReasonDetail' | 'finalReasonDetail'>)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['allocationDraftItems'][number])[], previous: (import('../domain/records.ts').DatabaseState['allocationDraftItems'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM allocation_draft_items WHERE id = ?');
  const move = db.prepare('UPDATE allocation_draft_items SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM allocation_draft_items').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM allocation_draft_items').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [];
  const changes = planRowChanges(records, previous, maximum, positions, [], 'Duplicate allocation_draft_items key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO allocation_draft_items (id, position, allocation_draft_id, member_id, source_application_id, member_name_at_generation, auto_semester_course_id, auto_decision, auto_reason_code, final_semester_course_id, final_decision, final_reason_code, updated_at, ministry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, allocation_draft_id, member_id, source_application_id, member_name_at_generation, auto_semester_course_id, auto_decision, auto_reason_code, final_semester_course_id, final_decision, final_reason_code, updated_at, ministry
      FROM allocation_draft_items WHERE id = ?`);
  const update = db.prepare(`UPDATE allocation_draft_items SET position = ?, allocation_draft_id = ?, member_id = ?, source_application_id = ?, member_name_at_generation = ?, auto_semester_course_id = ?, auto_decision = ?, auto_reason_code = ?, final_semester_course_id = ?, final_decision = ?, final_reason_code = ?, updated_at = ?, ministry = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate allocation_draft_items key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
