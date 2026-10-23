import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';

import type { ApplicationListFilters, ApplicationView } from '../domain/query-models.ts';
import type { ApplicationRecord } from '../domain/records.ts';
import { ApplicationChoiceQueries } from './application-choices.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { validateRecord } from './validation.ts';

type ApplicationData = Omit<ApplicationView, 'warnings' | 'reviewStatus'>;
type ApplicationRow = Omit<ApplicationData, 'choices'>;
type ApplicationQueryFilters = Omit<ApplicationListFilters, 'reviewStatus'>;

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

  listViews(filters: ApplicationQueryFilters & { id?: string } = {}): ApplicationData[] {
    return this.#withChoices(this.#listRows(filters));
  }

  listPage({ page, limit, ...filters }: ApplicationQueryFilters & { page: number; limit: number }) {
    const rows = this.#listRows(filters);
    const start = (page - 1) * limit;
    return { items: this.#withChoices(rows.slice(start, start + limit)), page, limit, total: rows.length };
  }

  #listRows(filters: ApplicationQueryFilters & { id?: string }): ApplicationRow[] {
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
    const choices = new ApplicationChoiceQueries(this.db).listViewRows({ applicationIds: result.map(({ id }) => id) });
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
    const history = new EnrollmentQueries(this.db).applicationHistory({ applicationIds });
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

  delete({ id }: { id: string }): void {
    this.db.prepare('DELETE FROM applications WHERE id = ?').run(id);
  }

  deleteSemester({ semesterId }: { semesterId: string }): void {
    this.db.prepare('DELETE FROM applications WHERE semester_id = ?').run(semesterId);
  }
  deleteEmpty({ applicationIds }: { applicationIds: string[] }): void {
    this.db.prepare(`DELETE FROM applications WHERE id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM application_choices WHERE application_id = applications.id)`).run(JSON.stringify(applicationIds));
  }

  bumpMany({ applicationIds, now }: { applicationIds: string[]; now: string }): void {
    if (applicationIds.length) this.db.prepare(`UPDATE applications SET revision = revision + 1, updated_at = ?
      WHERE id IN (SELECT value FROM json_each(?))`).run(now, JSON.stringify(applicationIds));
  }
}

export const readSnapshotRows = (db: DatabaseSync): (import('../domain/records.ts').ApplicationRecord)[] => (
  db.prepare(`SELECT id, semester_id AS semesterId, member_id AS memberId,
    ministry, applicant_note AS applicantNote,
    application_order AS applicationOrder, application_order_status AS applicationOrderStatus,
    order_resolution AS orderResolution, order_resolution_note AS orderResolutionNote, revision,
    created_at AS createdAt, updated_at AS updatedAt FROM applications ORDER BY position`).all().map((row) => ({ ...row })) as (import('../domain/records.ts').ApplicationRecord)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['applications'][number])[], previous: (import('../domain/records.ts').DatabaseState['applications'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM applications WHERE id = ?');
  const move = db.prepare('UPDATE applications SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM applications').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM applications').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [db.prepare('UPDATE applications SET semester_id = ? WHERE id = ?')];
  const changes = planRowChanges(records, previous, maximum, positions, [(item) => JSON.stringify([item.semesterId, item.memberId])], 'Duplicate applications key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO applications (id, position, semester_id, member_id, application_order, application_order_status, order_resolution, order_resolution_note, revision, created_at, updated_at, ministry, applicant_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, semester_id, member_id, application_order, application_order_status, order_resolution, order_resolution_note, revision, created_at, updated_at, ministry, applicant_note
      FROM applications WHERE id = ?`);
  const update = db.prepare(`UPDATE applications SET position = ?, semester_id = ?, member_id = ?, application_order = ?, application_order_status = ?, order_resolution = ?, order_resolution_note = ?, revision = ?, created_at = ?, updated_at = ?, ministry = ?, applicant_note = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate applications key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
