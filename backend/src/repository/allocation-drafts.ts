import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseState, AllocationDraftRecord, AllocationDraftItemRecord } from '../domain/records.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { ApplicationQueries } from './applications.ts';
import { ApplicationChoiceQueries } from './application-choices.ts';
import { AllocationDraftItemQueries } from './allocation-draft-items.ts';
import { readDrafts, writeDrafts } from './relational-store.ts';
import { validateRecord } from './validation.ts';

export type AllocationContext = Pick<DatabaseState,
  'meta' | 'semesters' | 'members' | 'courses' | 'semesterCourses' | 'applications' |
  'applicationChoices' | 'enrollments' | 'allocationDrafts' | 'allocationDraftItems'
> & { stagedApplicationIds: Set<string> };

export type DraftSummaryRecord = Pick<AllocationDraftRecord,
  'id' | 'semesterId' | 'status' | 'revision' | 'mode' | 'policyId' | 'policyVersion' |
  'engineVersion' | 'createdAt' | 'updatedAt' | 'enrollmentReportDownloadedAt' | 'enrollmentReportStoreRevision'>;

export class AllocationDraftQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  get({ id }: { id: string }): AllocationDraftRecord | undefined {
    return readDrafts(this.db, id).drafts[0];
  }

  getContext({ draftId, semesterId }: { draftId?: string; semesterId?: string } = {}): AllocationContext {
    const context = new EnrollmentQueries(this.db).getContext();
    const applications = new ApplicationQueries(this.db);
    const choices = new ApplicationChoiceQueries(this.db);
    const persisted = draftId ? readDrafts(this.db, draftId) : { drafts: [], items: [] };
    const target = semesterId ?? persisted.drafts[0]?.semesterId;
    return {
      ...context,
      applications: applications.listRecords(target ? { semesterId: target } : {}),
      applicationChoices: choices.list(),
      allocationDrafts: persisted.drafts,
      allocationDraftItems: persisted.items,
      stagedApplicationIds: choices.stagedApplicationIds(),
    };
  }

  list(): DraftSummaryRecord[] {
    const rows = this.db.prepare(`
      SELECT id, semester_id AS semesterId, status, revision, mode,
        policy_id AS policyId, policy_version AS policyVersion, engine_version AS engineVersion,
        created_at AS createdAt, updated_at AS updatedAt,
        enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
        enrollment_report_store_revision AS enrollmentReportStoreRevision
      FROM allocation_drafts WHERE status = 'DRAFT' ORDER BY created_at DESC, id
    `).all();
    return rows.map((row) => ({ ...row })) as DraftSummaryRecord[];
  }

  listPage({ semesterId, query = '', page, limit }: { semesterId?: string; query?: string; page: number; limit: number }) {
    const target = semesterId || null;
    if (query.trim()) return { items: [], total: 0, page, limit };
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM allocation_drafts
      WHERE status = 'DRAFT' AND (? IS NULL OR semester_id = ?)`).get(target, target)!.count);
    const rows = this.db.prepare(`SELECT id, semester_id AS semesterId, status, revision, mode,
        policy_id AS policyId, policy_version AS policyVersion, engine_version AS engineVersion,
        created_at AS createdAt, updated_at AS updatedAt,
        enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
        enrollment_report_store_revision AS enrollmentReportStoreRevision
      FROM allocation_drafts WHERE status = 'DRAFT' AND (? IS NULL OR semester_id = ?)
      ORDER BY created_at DESC, id LIMIT ? OFFSET ?`).all(target, target, limit, (page - 1) * limit);
    return { items: rows.map((row) => ({ ...row })) as DraftSummaryRecord[], total, page, limit };
  }

  save({ draft, items }: { draft: AllocationDraftRecord; items: AllocationDraftItemRecord[] }): void {
    validateRecord('allocationDrafts', draft);
    for (const item of items) validateRecord('allocationDraftItems', item);
    const previous = readDrafts(this.db, draft.id);
    const byId = new Map(items.map((item) => [item.id, item]));
    const savedItems = previous.items.map((item) => byId.get(item.id) ?? item);
    const oldIds = new Set(previous.items.map(({ id }) => id));
    savedItems.push(...items.filter(({ id }) => !oldIds.has(id)));
    const storedDraft = this.db.prepare('SELECT position FROM allocation_drafts WHERE id = ?').get(draft.id);
    const draftPosition = storedDraft ? Number(storedDraft.position)
      : Number(this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS position FROM allocation_drafts').get()!.position);
    const itemQueries = new AllocationDraftItemQueries(this.db);
    const itemPositions = itemQueries.positions({ draftId: draft.id });
    let nextPosition = itemQueries.nextPosition();
    for (const item of savedItems) {
      if (!itemPositions.has(item.id)) itemPositions.set(item.id, nextPosition++);
    }
    writeDrafts(this.db, [draft], savedItems, {
      allocationDrafts: previous.drafts, allocationDraftItems: previous.items,
    }, { draftPositions: new Map([[draft.id, draftPosition]]), itemPositions });
  }

  delete({ id }: { id: string }): void {
    this.db.prepare('DELETE FROM allocation_drafts WHERE id = ?').run(id);
  }
}

export const readSnapshotRows = (db: DatabaseSync, parentId: string | null = null): (Omit<import('../domain/records.ts').AllocationDraftRecord, 'policySettings' | 'inputSnapshot' | 'finalization'>)[] => (
  db.prepare(`SELECT id, semester_id AS semesterId, status, revision, mode,
    policy_id AS policyId, policy_version AS policyVersion, engine_version AS engineVersion,
    random_seed AS randomSeed, source_revision AS sourceRevision, input_fingerprint AS inputFingerprint,
    created_at AS createdAt, updated_at AS updatedAt, finalized_at AS finalizedAt,
    enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
    enrollment_report_store_revision AS enrollmentReportStoreRevision
    FROM allocation_drafts WHERE (? IS NULL OR id = ?)
    ORDER BY position`).all(parentId, parentId).map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').AllocationDraftRecord, 'policySettings' | 'inputSnapshot' | 'finalization'>)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['allocationDrafts'][number])[], previous: (import('../domain/records.ts').DatabaseState['allocationDrafts'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM allocation_drafts WHERE id = ?');
  const move = db.prepare('UPDATE allocation_drafts SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM allocation_drafts').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM allocation_drafts').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [];
  const changes = planRowChanges(records, previous, maximum, positions, [], 'Duplicate allocation_drafts key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO allocation_drafts (id, position, semester_id, status, revision, mode, policy_id, policy_version, engine_version, random_seed, source_revision, input_fingerprint, created_at, updated_at, finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, semester_id, status, revision, mode, policy_id, policy_version, engine_version, random_seed, source_revision, input_fingerprint, created_at, updated_at, finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision
      FROM allocation_drafts WHERE id = ?`);
  const update = db.prepare(`UPDATE allocation_drafts SET position = ?, semester_id = ?, status = ?, revision = ?, mode = ?, policy_id = ?, policy_version = ?, engine_version = ?, random_seed = ?, source_revision = ?, input_fingerprint = ?, created_at = ?, updated_at = ?, finalized_at = ?, enrollment_report_downloaded_at = ?, enrollment_report_store_revision = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate allocation_drafts key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
