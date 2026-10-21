import type { DatabaseSync } from 'node:sqlite';

import type { ApplicationListFilters, ApplicationView } from '../domain/query-models.ts';
import type { ApplicationChoiceRecord, ApplicationRecord } from '../domain/records.ts';
import { validateRecord } from './validation.ts';

type ApplicationData = Omit<ApplicationView, 'warnings'>;
type ApplicationRow = Omit<ApplicationData, 'choices'>;

export class ApplicationQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  listRecords({ semesterId = null }: { semesterId?: string | null } = {}): ApplicationRecord[] {
    return this.db.prepare(`SELECT id, semester_id AS semesterId, member_id AS memberId, ministry, applicant_note AS applicantNote,
      application_order AS applicationOrder, application_order_status AS applicationOrderStatus,
      order_resolution AS orderResolution, order_resolution_note AS orderResolutionNote, revision,
      created_at AS createdAt, updated_at AS updatedAt FROM applications
      WHERE (? IS NULL OR semester_id = ?) ORDER BY position`).all(semesterId, semesterId)
      .map((row) => ({ ...row })) as ApplicationRecord[];
  }

  listChoices({ applicationId = null }: { applicationId?: string | null } = {}): ApplicationChoiceRecord[] {
    const choices = this.db.prepare(`SELECT id, application_id AS applicationId, semester_course_id AS semesterCourseId,
      preference, created_at AS createdAt, updated_at AS updatedAt FROM application_choices
      WHERE (? IS NULL OR application_id = ?) ORDER BY position`).all(applicationId, applicationId)
      .map((row) => ({ ...row, sourceRefs: [] })) as unknown as ApplicationChoiceRecord[];
    if (!choices.length) return choices;
    const byId = new Map(choices.map((choice) => [choice.id, choice]));
    const refs = this.db.prepare(`SELECT application_choice_id AS choiceId, import_batch_id AS importBatchId,
      sheet, row_number AS row FROM application_choice_source_refs
      WHERE application_choice_id IN (SELECT value FROM json_each(?)) ORDER BY application_choice_id, position`)
      .all(JSON.stringify(choices.map(({ id }) => id))) as (ApplicationChoiceRecord['sourceRefs'][number] & { choiceId: string })[];
    for (const { choiceId, ...ref } of refs) byId.get(choiceId)!.sourceRefs.push(ref);
    return choices;
  }

  get({ id }: { id: string }): ApplicationRecord | undefined {
    const row = this.db.prepare(`SELECT id, semester_id AS semesterId, member_id AS memberId, ministry, applicant_note AS applicantNote,
      application_order AS applicationOrder, application_order_status AS applicationOrderStatus,
      order_resolution AS orderResolution, order_resolution_note AS orderResolutionNote, revision,
      created_at AS createdAt, updated_at AS updatedAt FROM applications WHERE id = ?`).get(id);
    return row ? { ...row } as ApplicationRecord : undefined;
  }

  findBySemesterMember({ semesterId, memberId, excludeId = null }: { semesterId: string; memberId: string; excludeId?: string | null }): ApplicationRecord | undefined {
    const row = this.db.prepare(`SELECT id, semester_id AS semesterId, member_id AS memberId, ministry, applicant_note AS applicantNote,
      application_order AS applicationOrder, application_order_status AS applicationOrderStatus,
      order_resolution AS orderResolution, order_resolution_note AS orderResolutionNote, revision,
      created_at AS createdAt, updated_at AS updatedAt FROM applications
      WHERE semester_id = ? AND member_id = ? AND (? IS NULL OR id <> ?)`)
      .get(semesterId, memberId, excludeId, excludeId);
    return row ? { ...row } as ApplicationRecord : undefined;
  }

  getView({ id }: { id: string }): ApplicationData | undefined {
    return this.listViews({ id })[0];
  }

  listViews(filters: ApplicationListFilters & { id?: string } = {}): ApplicationData[] {
    return this.#withChoices(this.#listRows(filters));
  }

  listPage({ page, limit, ...filters }: ApplicationListFilters & { page: number; limit: number }) {
    const rows = this.#listRows(filters);
    const start = (page - 1) * limit;
    return { items: this.#withChoices(rows.slice(start, start + limit)), page, limit, total: rows.length };
  }

  #listRows(filters: ApplicationListFilters & { id?: string }): ApplicationRow[] {
    const memberName = filters.memberName?.trim().normalize('NFC') || null;
    const rows = this.db.prepare(`SELECT a.id, a.semester_id AS semesterId, a.member_id AS memberId,
      s.name AS semesterName, m.name AS memberName, a.ministry, a.applicant_note AS applicantNote, a.application_order AS applicationOrder,
      a.application_order_status AS applicationOrderStatus, a.order_resolution AS orderResolution, a.revision
      FROM applications AS a JOIN semesters AS s ON s.id = a.semester_id JOIN members AS m ON m.id = a.member_id
      WHERE (? IS NULL OR a.id = ?) AND (? IS NULL OR a.semester_id = ?)
        AND (? IS NULL OR instr(m.name_key, ?) > 0)
        AND (? IS NULL OR EXISTS (
          SELECT 1 FROM application_choices AS ac JOIN semester_courses AS sc ON sc.id = ac.semester_course_id
          WHERE ac.application_id = a.id AND sc.course_id = ?
        )) ORDER BY a.position`).all(filters.id ?? null, filters.id ?? null, filters.semesterId || null,
      filters.semesterId || null, memberName, memberName, filters.courseId || null, filters.courseId || null)
      .map((row) => ({ ...row })) as ApplicationRow[];
    if (!filters.sort) return rows;
    // SQLite's built-in collations differ from the existing Korean user-visible order.
    return rows.sort((left, right) => {
      const leftOrder = left.applicationOrder ?? Infinity;
      const rightOrder = right.applicationOrder ?? Infinity;
      const orderDifference = leftOrder === rightOrder ? 0 : leftOrder - rightOrder;
      const nameDifference = left.memberName.localeCompare(right.memberName, 'ko');
      const selectedDifference = filters.sort === 'ORDER_DESC'
        ? (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) ? -orderDifference : orderDifference)
        : filters.sort === 'NAME_ASC' ? nameDifference
          : filters.sort === 'NAME_DESC' ? -nameDifference : orderDifference;
      return selectedDifference || orderDifference || nameDifference || left.id.localeCompare(right.id);
    });
  }

  #withChoices(rows: ApplicationRow[]): ApplicationData[] {
    const result = rows.map((row) => ({ ...row, choices: [] as ApplicationView['choices'] }));
    if (!result.length) return result;
    const byId = new Map(result.map((row) => [row.id, row]));
    // One child query for all selected applications; JSON avoids SQLite's bind-variable limit.
    const choices = this.db.prepare(`SELECT ac.application_id AS applicationId, ac.id,
      ac.semester_course_id AS semesterCourseId, c.name AS courseName, ac.preference
      FROM application_choices AS ac JOIN semester_courses AS sc ON sc.id = ac.semester_course_id
      JOIN courses AS c ON c.id = sc.course_id
      WHERE ac.application_id IN (SELECT value FROM json_each(?)) ORDER BY ac.position`)
      .all(JSON.stringify(result.map(({ id }) => id))) as (ApplicationView['choices'][number] & { applicationId: string })[];
    for (const { applicationId, ...choice } of choices) byId.get(applicationId)!.choices.push(choice);
    return result;
  }

  warningContext({ applicationIds }: { applicationIds: string[] }) {
    const targets = this.db.prepare(`SELECT a.id AS applicationId, a.member_id AS memberId,
      s.semester_order AS semesterOrder, ac.semester_course_id AS semesterCourseId,
      sc.course_id AS courseId, c.name AS courseName, ac.preference
      FROM applications AS a JOIN semesters AS s ON s.id = a.semester_id
      JOIN application_choices AS ac ON ac.application_id = a.id
      JOIN semester_courses AS sc ON sc.id = ac.semester_course_id JOIN courses AS c ON c.id = sc.course_id
      WHERE a.id IN (SELECT value FROM json_each(?)) ORDER BY ac.position`)
      .all(JSON.stringify(applicationIds)) as {
        applicationId: string; memberId: string; semesterOrder: number | null;
        semesterCourseId: string; courseId: string; courseName: string; preference: number | null;
      }[];
    const history = this.db.prepare(`SELECT e.member_id AS memberId, sc.course_id AS courseId, sc.semester_id AS semesterId,
      s.semester_order AS semesterOrder FROM enrollments AS e
      JOIN semester_courses AS sc ON sc.id = e.semester_course_id JOIN semesters AS s ON s.id = sc.semester_id
      WHERE e.member_id IN (SELECT member_id FROM applications WHERE id IN (SELECT value FROM json_each(?)))`)
      .all(JSON.stringify(applicationIds)) as { memberId: string; courseId: string; semesterId: string; semesterOrder: number | null }[];
    return { targets, history };
  }

  count({ semesterId }: { semesterId: string }): number {
    return this.db.prepare('SELECT COUNT(*) AS count FROM applications WHERE semester_id = ?').get(semesterId)!.count as number;
  }

  insert({ record }: { record: ApplicationRecord }): void {
    validateRecord('applications', record);
    this.db.prepare(`INSERT INTO applications (id, position, semester_id, member_id, ministry, applicant_note, application_order,
      application_order_status, order_resolution, order_resolution_note, revision, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM applications), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.semesterId, record.memberId, record.ministry, record.applicantNote, record.applicationOrder, record.applicationOrderStatus,
        record.orderResolution, record.orderResolutionNote, record.revision, record.createdAt, record.updatedAt);
  }

  update({ record }: { record: ApplicationRecord }): void {
    validateRecord('applications', record);
    this.db.prepare(`UPDATE applications SET semester_id = ?, member_id = ?, ministry = ?, applicant_note = ?, application_order = ?,
      application_order_status = ?, order_resolution = ?, order_resolution_note = ?, revision = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .run(record.semesterId, record.memberId, record.ministry, record.applicantNote, record.applicationOrder, record.applicationOrderStatus,
        record.orderResolution, record.orderResolutionNote, record.revision, record.createdAt, record.updatedAt, record.id);
  }

  insertChoice({ record }: { record: ApplicationChoiceRecord }): void {
    validateRecord('applicationChoices', record);
    this.db.prepare(`INSERT INTO application_choices (id, position, application_id, semester_course_id, preference, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM application_choices), ?, ?, ?, ?, ?)`)
      .run(record.id, record.applicationId, record.semesterCourseId, record.preference, record.createdAt, record.updatedAt);
    const source = this.db.prepare(`INSERT INTO application_choice_source_refs
      (application_choice_id, position, import_batch_id, sheet, row_number) VALUES (?, ?, ?, ?, ?)`);
    record.sourceRefs.forEach((ref, position) => source.run(record.id, position, ref.importBatchId, ref.sheet, ref.row));
  }

  replaceChoices({ applicationId, records }: { applicationId: string; records: ApplicationChoiceRecord[] }): void {
    this.db.prepare('DELETE FROM application_choices WHERE application_id = ?').run(applicationId);
    for (const record of records) this.insertChoice({ record });
  }

  delete({ id }: { id: string }): void {
    this.db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  }

  deleteSemester({ semesterId }: { semesterId: string }): void {
    this.db.prepare('DELETE FROM applications WHERE semester_id = ?').run(semesterId);
  }

  countCourseChoices({ semesterCourseId }: { semesterCourseId: string }): number {
    return this.db.prepare('SELECT COUNT(DISTINCT application_id) AS count FROM application_choices WHERE semester_course_id = ?').get(semesterCourseId)!.count as number;
  }

  removeCourseChoices({ semesterCourseId, now }: { semesterCourseId: string; now: string }): void {
    const affected = this.db.prepare('SELECT DISTINCT application_id AS id FROM application_choices WHERE semester_course_id = ?').all(semesterCourseId);
    this.db.prepare('DELETE FROM application_choices WHERE semester_course_id = ?').run(semesterCourseId);
    const removeEmpty = this.db.prepare(`DELETE FROM applications WHERE id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM application_choices WHERE application_id = applications.id)`);
    const ids = JSON.stringify(affected.map(({ id }) => id));
    removeEmpty.run(ids);
    this.db.prepare(`UPDATE applications SET revision = revision + 1, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`).run(now, ids);
  }
}
