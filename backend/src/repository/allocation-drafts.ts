import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseState, AllocationDraftRecord, AllocationDraftItemRecord } from '../domain/records.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { ApplicationQueries } from './applications.ts';
import { readDrafts, writeDrafts } from './relational-store.ts';
import { validateRecord } from './validation.ts';

export type AllocationContext = Pick<DatabaseState,
  'meta' | 'semesters' | 'members' | 'courses' | 'semesterCourses' | 'applications' |
  'applicationChoices' | 'enrollments' | 'allocationDrafts' | 'allocationDraftItems'
> & { stagedApplicationIds: Set<string> };

export type DraftSummaryRecord = Pick<AllocationDraftRecord,
  'id' | 'semesterId' | 'status' | 'revision' | 'mode' | 'policyId' | 'policyVersion' |
  'engineVersion' | 'createdAt' | 'updatedAt' | 'enrollmentReportDownloadedAt' | 'enrollmentReportStoreRevision'>;

export class AllocationQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  get({ id }: { id: string }): AllocationDraftRecord | undefined {
    return readDrafts(this.db, id).drafts[0];
  }

  getItem({ draftId, memberId }: { draftId: string; memberId: string }): AllocationDraftItemRecord | undefined {
    return readDrafts(this.db, draftId).items.find((item) => item.memberId === memberId);
  }

  hasEnrollment({ semesterId, memberId }: { semesterId: string; memberId: string }): boolean {
    return this.db.prepare(`SELECT 1 FROM enrollments AS e
      JOIN semester_courses AS sc ON sc.id = e.semester_course_id
      WHERE sc.semester_id = ? AND e.member_id = ? LIMIT 1`).get(semesterId, memberId) !== undefined;
  }

  getContext({ draftId, semesterId }: { draftId?: string; semesterId?: string } = {}): AllocationContext {
    const context = new EnrollmentQueries(this.db).getContext();
    const applications = new ApplicationQueries(this.db);
    const persisted = draftId ? readDrafts(this.db, draftId) : { drafts: [], items: [] };
    const target = semesterId ?? persisted.drafts[0]?.semesterId;
    const staged = this.db.prepare(`
      SELECT DISTINCT c.application_id AS applicationId
      FROM application_choices AS c
      JOIN application_choice_source_refs AS r ON r.application_choice_id = c.id
      JOIN import_batches AS b ON b.id = r.import_batch_id
      WHERE b.status = 'STAGED'
    `).all();
    return {
      ...context,
      applications: applications.listRecords(target ? { semesterId: target } : {}),
      applicationChoices: applications.listChoices(),
      allocationDrafts: persisted.drafts,
      allocationDraftItems: persisted.items,
      stagedApplicationIds: new Set(staged.map(({ applicationId }) => String(applicationId))),
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
    const itemPositions = new Map(this.db.prepare(`
      SELECT id, position FROM allocation_draft_items WHERE allocation_draft_id = ?
    `).all(draft.id).map(({ id, position }) => [String(id), Number(position)]));
    let nextPosition = Number(this.db.prepare(`
      SELECT COALESCE(MAX(position), -1) + 1 AS position FROM allocation_draft_items
    `).get()!.position);
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

  currentEnrolledMembers({ semesterId }: { semesterId: string }): Array<{ id: string; name: string }> {
    return this.db.prepare(`
      SELECT m.id, m.name FROM members AS m
      WHERE EXISTS (
        SELECT 1 FROM enrollments AS e JOIN semester_courses AS sc ON sc.id = e.semester_course_id
        WHERE e.member_id = m.id AND sc.semester_id = ?
      ) ORDER BY m.position
    `).all(semesterId).map((row) => ({ ...row })) as Array<{ id: string; name: string }>;
  }
}
