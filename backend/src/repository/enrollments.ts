import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';

import type { DatabaseState, EnrollmentRecord } from '../domain/records.ts';
import type { EnrollmentListFilters, EnrollmentView } from '../domain/query-models.ts';
import { MemberQueries } from './members.ts';
import { CourseQueries } from './courses.ts';
import { SemesterQueries } from './semesters.ts';
import { SemesterCourseQueries } from './semester-courses.ts';
import { StoreMetaQueries } from './store-meta.ts';
import { EnrollmentAcknowledgementQueries } from './enrollment-acknowledgements.ts';
import { validateRecord } from './validation.ts';

export type EnrollmentContext = Pick<DatabaseState,
  'meta' | 'semesters' | 'members' | 'courses' | 'semesterCourses' | 'enrollments'
>;

type EnrollmentRow = Omit<EnrollmentRecord, 'exceptionAcknowledgement'> & {
  warningDigest: string | null;
  note: string | null;
  acknowledgedAt: string | null;
};
type ViewRow = EnrollmentRow & {
  semesterName: string;
  semesterOrder: number | null;
  courseName: string;
  memberName: string;
};

const enrollmentRecord = ({ warningDigest, note, acknowledgedAt, ...record }: EnrollmentRow): EnrollmentRecord => ({
  ...record,
  exceptionAcknowledgement: warningDigest === null ? null : {
    warningDigest, note: note!, acknowledgedAt: acknowledgedAt!,
  },
});

const enrollmentView = (row: ViewRow): EnrollmentView => ({
  id: row.id,
  semesterCourseId: row.semesterCourseId,
  memberId: row.memberId,
  ministry: row.ministry,
  revision: row.revision,
  semesterName: row.semesterName,
  courseName: row.courseName,
  memberName: row.memberName,
  exceptionAcknowledgement: enrollmentRecord(row).exceptionAcknowledgement,
});

export class EnrollmentQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  getContext(): EnrollmentContext {
    const meta = new StoreMetaQueries(this.db).get();
    return {
      meta: { ...meta },
      semesters: new SemesterQueries(this.db).list(),
      members: new MemberQueries(this.db).list(),
      courses: new CourseQueries(this.db).list(),
      semesterCourses: new SemesterCourseQueries(this.db).list(),
      enrollments: this.db.prepare(`
        SELECT e.id, e.semester_course_id AS semesterCourseId, e.member_id AS memberId,
               e.ministry, e.revision, e.created_at AS createdAt, e.updated_at AS updatedAt,
               a.warning_digest AS warningDigest, a.note, a.acknowledged_at AS acknowledgedAt
        FROM enrollments AS e
        LEFT JOIN enrollment_acknowledgements AS a ON a.enrollment_id = e.id
        ORDER BY e.position
      `).all().map((row) => enrollmentRecord(row as EnrollmentRow)),
    };
  }

  get({ id }: { id: string }): EnrollmentRecord | undefined {
    const row = this.db.prepare(`
      SELECT e.id, e.semester_course_id AS semesterCourseId, e.member_id AS memberId,
             e.ministry, e.revision, e.created_at AS createdAt, e.updated_at AS updatedAt,
             a.warning_digest AS warningDigest, a.note, a.acknowledged_at AS acknowledgedAt
      FROM enrollments AS e
      LEFT JOIN enrollment_acknowledgements AS a ON a.enrollment_id = e.id
      WHERE e.id = ?
    `).get(id);
    return row ? enrollmentRecord(row as EnrollmentRow) : undefined;
  }

  getView({ id }: { id: string }): EnrollmentView | undefined {
    const row = this.db.prepare(`
      SELECT e.id, e.semester_course_id AS semesterCourseId, e.member_id AS memberId,
             e.ministry, e.revision, e.created_at AS createdAt, e.updated_at AS updatedAt,
             a.warning_digest AS warningDigest, a.note, a.acknowledged_at AS acknowledgedAt,
             s.name AS semesterName, s.semester_order AS semesterOrder,
             c.name AS courseName, m.name AS memberName
      FROM enrollments AS e
      JOIN semester_courses AS sc ON sc.id = e.semester_course_id
      JOIN semesters AS s ON s.id = sc.semester_id
      JOIN courses AS c ON c.id = sc.course_id
      JOIN members AS m ON m.id = e.member_id
      LEFT JOIN enrollment_acknowledgements AS a ON a.enrollment_id = e.id
      WHERE e.id = ?
    `).get(id);
    return row ? enrollmentView(row as ViewRow) : undefined;
  }

  list(filters: EnrollmentListFilters = {}): EnrollmentView[] {
    const rows = this.db.prepare(`
      SELECT e.id, e.semester_course_id AS semesterCourseId, e.member_id AS memberId,
             e.ministry, e.revision, e.created_at AS createdAt, e.updated_at AS updatedAt,
             a.warning_digest AS warningDigest, a.note, a.acknowledged_at AS acknowledgedAt,
             s.name AS semesterName, s.semester_order AS semesterOrder,
             c.name AS courseName, m.name AS memberName
      FROM enrollments AS e
      JOIN semester_courses AS sc ON sc.id = e.semester_course_id
      JOIN semesters AS s ON s.id = sc.semester_id
      JOIN courses AS c ON c.id = sc.course_id
      JOIN members AS m ON m.id = e.member_id
      LEFT JOIN enrollment_acknowledgements AS a ON a.enrollment_id = e.id
      WHERE (? IS NULL OR sc.semester_id = ?)
        AND (? IS NULL OR sc.course_id = ?)
        AND (? IS NULL OR instr(m.name_key, ?) > 0)
      ORDER BY e.position
    `).all(
      filters.semesterId || null, filters.semesterId || null,
      filters.courseId || null, filters.courseId || null,
      filters.memberName?.trim().normalize('NFC') || null,
      filters.memberName?.trim().normalize('NFC') || null,
    ) as ViewRow[];
    if (filters.sort) {
      // SQLite's built-in collation differs from the existing Korean UI ordering.
      rows.sort((left, right) => {
        const leftOrder = left.semesterOrder;
        const rightOrder = right.semesterOrder;
        const semesterDifference = leftOrder === rightOrder ? 0
          : leftOrder === null ? 1 : rightOrder === null ? -1 : rightOrder - leftOrder;
        const nameDifference = left.memberName.localeCompare(right.memberName, 'ko');
        const courseDifference = left.courseName.localeCompare(right.courseName, 'ko');
        const selectedDifference = filters.sort === 'SEMESTER_ASC'
          ? (leftOrder !== null && rightOrder !== null ? -semesterDifference : semesterDifference)
          : filters.sort === 'SEMESTER_DESC' ? semesterDifference
            : filters.sort === 'NAME_ASC' ? nameDifference
              : filters.sort === 'NAME_DESC' ? -nameDifference
                : filters.sort === 'COURSE_DESC' ? -courseDifference : courseDifference;
        return selectedDifference || semesterDifference || nameDifference || courseDifference || left.id.localeCompare(right.id);
      });
    }
    return rows.map(enrollmentView);
  }

  listPage({ page, limit, ...filters }: EnrollmentListFilters & { page: number; limit: number }) {
    const items = this.list(filters);
    const start = (page - 1) * limit;
    return { items: items.slice(start, start + limit), page, limit, total: items.length };
  }

  insert({ record }: { record: EnrollmentRecord }): void {
    validateRecord('enrollments', record);
    this.db.prepare(`
      INSERT INTO enrollments
        (id, position, semester_course_id, member_id, ministry, revision, created_at, updated_at)
      VALUES (?, COALESCE((SELECT max(position) + 1 FROM enrollments), 0), ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.semesterCourseId, record.memberId, record.ministry,
      record.revision, record.createdAt, record.updatedAt);
    this.saveAcknowledgement(record);
  }

  update({ record }: { record: EnrollmentRecord }): void {
    validateRecord('enrollments', record);
    this.db.prepare(`
      UPDATE enrollments
      SET semester_course_id = ?, member_id = ?, ministry = ?, revision = ?,
          created_at = ?, updated_at = ?
      WHERE id = ?
    `).run(record.semesterCourseId, record.memberId, record.ministry, record.revision,
      record.createdAt, record.updatedAt, record.id);
    this.saveAcknowledgement(record);
  }

  delete({ id }: { id: string }): void {
    this.db.prepare('DELETE FROM enrollments WHERE id = ?').run(id);
  }

  deleteSemester({ semesterId }: { semesterId: string }): number {
    return Number(this.db.prepare(`
      DELETE FROM enrollments
      WHERE semester_course_id IN (SELECT id FROM semester_courses WHERE semester_id = ?)
    `).run(semesterId).changes);
  }

  applyCandidate({ previous, candidate }: { previous: EnrollmentContext; candidate: EnrollmentContext }): void {
    const semesters = new Map(previous.semesters.map((record) => [record.id, record]));
    for (const record of candidate.semesters) {
      const old = semesters.get(record.id);
      if (!old) new SemesterQueries(this.db).insert({ record });
      else if (!isDeepStrictEqual(old, record)) new SemesterQueries(this.db).update({ record });
    }
    const memberIds = new Set(previous.members.map(({ id }) => id));
    for (const record of candidate.members) if (!memberIds.has(record.id)) new MemberQueries(this.db).insert({ record });
    const courseIds = new Set(previous.courses.map(({ id }) => id));
    for (const record of candidate.courses) if (!courseIds.has(record.id)) new CourseQueries(this.db).insert({ record });
    const courses = new Map(previous.semesterCourses.map((record) => [record.id, record]));
    for (const record of candidate.semesterCourses) {
      const old = courses.get(record.id);
      if (!old) new SemesterCourseQueries(this.db).insert({ record });
      else if (!isDeepStrictEqual(old, record)) new SemesterCourseQueries(this.db).update({ record });
    }
    const enrollments = new Map(previous.enrollments.map((record) => [record.id, record]));
    for (const record of candidate.enrollments) {
      const old = enrollments.get(record.id);
      if (!old) this.insert({ record });
      else if (!isDeepStrictEqual(old, record)) this.update({ record });
      enrollments.delete(record.id);
    }
    for (const id of enrollments.keys()) this.delete({ id });
  }

  private saveAcknowledgement(record: EnrollmentRecord): void {
    const acknowledgements = new EnrollmentAcknowledgementQueries(this.db);
    acknowledgements.delete({ enrollmentId: record.id });
    if (record.exceptionAcknowledgement) acknowledgements.insert({ enrollmentId: record.id, record: record.exceptionAcknowledgement });
  }

  hasForCourse({ semesterCourseId }: { semesterCourseId: string }): boolean {
    return Boolean(this.db.prepare('SELECT EXISTS(SELECT 1 FROM enrollments WHERE semester_course_id = ?) AS found').get(semesterCourseId)!.found);
  }

  hasSemesterMember({ semesterId, memberId }: { semesterId: string; memberId: string }): boolean {
    return this.db.prepare(`SELECT 1 FROM enrollments AS e JOIN semester_courses AS sc ON sc.id = e.semester_course_id
      WHERE sc.semester_id = ? AND e.member_id = ? LIMIT 1`).get(semesterId, memberId) !== undefined;
  }

  applicationHistory({ applicationIds }: { applicationIds: string[] }) {
    return this.db.prepare(`SELECT e.member_id AS memberId, sc.course_id AS courseId, sc.semester_id AS semesterId,
      s.semester_order AS semesterOrder FROM enrollments AS e
      JOIN semester_courses AS sc ON sc.id = e.semester_course_id JOIN semesters AS s ON s.id = sc.semester_id
      WHERE e.member_id IN (SELECT member_id FROM applications WHERE id IN (SELECT value FROM json_each(?)))`)
      .all(JSON.stringify(applicationIds)) as { memberId: string; courseId: string; semesterId: string; semesterOrder: number | null }[];
  }
}

export const readSnapshotRows = (db: DatabaseSync): (Omit<import('../domain/records.ts').EnrollmentRecord, 'exceptionAcknowledgement'>)[] => (
  db.prepare(`SELECT id,
    semester_course_id AS semesterCourseId, member_id AS memberId, ministry, revision,
    created_at AS createdAt, updated_at AS updatedAt
    FROM enrollments ORDER BY position`).all().map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').EnrollmentRecord, 'exceptionAcknowledgement'>)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['enrollments'][number])[], previous: (import('../domain/records.ts').DatabaseState['enrollments'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM enrollments WHERE id = ?');
  const move = db.prepare('UPDATE enrollments SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM enrollments').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM enrollments').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [];
  const changes = planRowChanges(records, previous, maximum, positions, [], 'Duplicate enrollments key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO enrollments (id, position, semester_course_id, member_id, revision, created_at, updated_at, ministry)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, semester_course_id, member_id, revision, created_at, updated_at, ministry
      FROM enrollments WHERE id = ?`);
  const update = db.prepare(`UPDATE enrollments SET position = ?, semester_course_id = ?, member_id = ?, revision = ?, created_at = ?, updated_at = ?, ministry = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate enrollments key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
