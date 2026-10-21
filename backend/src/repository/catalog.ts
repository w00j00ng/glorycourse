import type { DatabaseSync } from 'node:sqlite';

import type { NamedRecord, SemesterCourseRecord, SemesterRecord } from '../domain/records.ts';
import { validateRecord } from './validation.ts';

type NamedKind = 'members' | 'courses';
type CatalogKind = NamedKind | 'semesters';
type CatalogRecord<K extends CatalogKind> = K extends 'semesters' ? SemesterRecord : NamedRecord;
export type SemesterContext = {
  semester: { id: string; name: string };
  order: number | null;
  allocationInputRevision: number;
  semesterCourses: {
    id: string; courseId: string; courseName: string; capacity: number | null;
    applicationCount: number; enrollmentCount: number;
  }[];
  readyForAutoAllocation: boolean;
  issues: { code: string }[];
};

export class CatalogQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  listSemesters(): SemesterRecord[] { return this.listNamed({ kind: 'semesters' }); }

  nextSemesterOrder(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(semester_order), 0) AS maximum FROM semesters').get()!;
    const next = Number(row.maximum) + 1;
    if (!Number.isSafeInteger(next)) throw new RangeError('No semester order is available');
    return next;
  }

  findAdjacentSemester({ semesterId, direction }: { semesterId: string; direction: 'UP' | 'DOWN' }): SemesterRecord | undefined {
    const sql = direction === 'UP'
      ? `SELECT id, name, name_key AS nameKey, semester_order AS "order",
          allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
        FROM semesters WHERE semester_order > (SELECT semester_order FROM semesters WHERE id = ?)
        ORDER BY semester_order ASC LIMIT 1`
      : `SELECT id, name, name_key AS nameKey, semester_order AS "order",
          allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
        FROM semesters WHERE semester_order < (SELECT semester_order FROM semesters WHERE id = ?)
        ORDER BY semester_order DESC LIMIT 1`;
    const row = this.db.prepare(sql).get(semesterId);
    return row ? { ...row } as SemesterRecord : undefined;
  }

  listNamed<K extends CatalogKind>({ kind, query = '' }: { kind: K; query?: string }): CatalogRecord<K>[] {
    const search = query.trim().normalize('NFC');
    const sql = kind === 'semesters'
      ? `SELECT id, name, name_key AS nameKey, semester_order AS "order",
          allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
        FROM semesters WHERE (? = '' OR instr(name, ?) > 0) ORDER BY position`
      : kind === 'members'
        ? `SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
          FROM members WHERE (? = '' OR instr(name, ?) > 0) ORDER BY position`
        : `SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
          FROM courses WHERE (? = '' OR instr(name, ?) > 0) ORDER BY position`;
    return this.db.prepare(sql).all(search, search).map((row) => ({ ...row })) as CatalogRecord<K>[];
  }

  listPage({ kind, query, page, limit }: { kind: CatalogKind; query?: string; page: number; limit: number }) {
    const records = this.listNamed({ kind, query });
    const ordered = kind === 'semesters'
      ? (records as SemesterRecord[]).sort((left, right) => (
        (right.order ?? 0) - (left.order ?? 0)
        || right.createdAt.localeCompare(left.createdAt)
        || left.name.localeCompare(right.name)
      ))
      : records;
    const start = (page - 1) * limit;
    const items = ordered.slice(start, start + limit).map((record) => kind === 'semesters'
      ? { id: record.id, name: record.name, order: (record as SemesterRecord).order ?? null }
      : { id: record.id, name: record.name });
    return { items, page, limit, total: records.length };
  }

  getSemester({ id }: { id: string }): SemesterRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
      allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM semesters WHERE id = ?`).get(id);
    return row ? { ...row } as SemesterRecord : undefined;
  }

  getMember({ id }: { id: string }): NamedRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
      FROM members WHERE id = ?`).get(id);
    return row ? { ...row } as NamedRecord : undefined;
  }

  getCourse({ id }: { id: string }): NamedRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
      FROM courses WHERE id = ?`).get(id);
    return row ? { ...row } as NamedRecord : undefined;
  }

  getNamedByNameKey<K extends CatalogKind>({ kind, nameKey }: { kind: K; nameKey: string }): CatalogRecord<K> | undefined {
    const sql = kind === 'semesters'
      ? `SELECT id, name, name_key AS nameKey, semester_order AS "order",
          allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
        FROM semesters WHERE name_key = ?`
      : kind === 'members'
        ? `SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
          FROM members WHERE name_key = ?`
        : `SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
          FROM courses WHERE name_key = ?`;
    const row = this.db.prepare(sql).get(nameKey);
    return row ? { ...row } as CatalogRecord<K> : undefined;
  }

  findSemesterByOrder({ order, excludeId = null }: { order: number; excludeId?: string | null }): SemesterRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
      allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM semesters WHERE semester_order = ? AND (? IS NULL OR id <> ?)`)
      .get(order, excludeId, excludeId);
    return row ? { ...row } as SemesterRecord : undefined;
  }

  listSemesterCourses({ semesterId = null, courseId = null }: { semesterId?: string | null; courseId?: string | null } = {}): SemesterCourseRecord[] {
    return this.db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId, capacity,
      created_at AS createdAt, updated_at AS updatedAt FROM semester_courses
      WHERE (? IS NULL OR semester_id = ?) AND (? IS NULL OR course_id = ?) ORDER BY position`)
      .all(semesterId, semesterId, courseId, courseId).map((row) => ({ ...row })) as SemesterCourseRecord[];
  }

  getSemesterCourse({ id }: { id: string }): SemesterCourseRecord | undefined {
    const row = this.db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId, capacity,
      created_at AS createdAt, updated_at AS updatedAt FROM semester_courses WHERE id = ?`).get(id);
    return row ? { ...row } as SemesterCourseRecord : undefined;
  }

  getSemesterCourseByPair({ semesterId, courseId }: { semesterId: string; courseId: string }): SemesterCourseRecord | undefined {
    const row = this.db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId, capacity,
      created_at AS createdAt, updated_at AS updatedAt FROM semester_courses
      WHERE semester_id = ? AND course_id = ?`).get(semesterId, courseId);
    return row ? { ...row } as SemesterCourseRecord : undefined;
  }

  insertNamed({ kind, record }: { kind: NamedKind; record: NamedRecord }): void {
    validateRecord(kind, record);
    const sql = kind === 'members'
      ? `INSERT INTO members (id, position, name, name_key, created_at, updated_at)
        VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM members), ?, ?, ?, ?)`
      : `INSERT INTO courses (id, position, name, name_key, created_at, updated_at)
        VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM courses), ?, ?, ?, ?)`;
    this.db.prepare(sql).run(record.id, record.name, record.nameKey, record.createdAt, record.updatedAt);
  }

  updateNamed({ kind, record }: { kind: NamedKind; record: NamedRecord }): void {
    validateRecord(kind, record);
    const sql = kind === 'members'
      ? 'UPDATE members SET name = ?, name_key = ?, created_at = ?, updated_at = ? WHERE id = ?'
      : 'UPDATE courses SET name = ?, name_key = ?, created_at = ?, updated_at = ? WHERE id = ?';
    this.db.prepare(sql).run(record.name, record.nameKey, record.createdAt, record.updatedAt, record.id);
  }

  insertSemester({ record }: { record: SemesterRecord }): void {
    validateRecord('semesters', record);
    this.db.prepare(`INSERT INTO semesters (id, position, name, name_key, semester_order,
      allocation_input_revision, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM semesters), ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.name, record.nameKey, record.order, record.allocationInputRevision, record.createdAt, record.updatedAt);
  }

  updateSemester({ record }: { record: SemesterRecord }): void {
    validateRecord('semesters', record);
    this.db.prepare(`UPDATE semesters SET name = ?, name_key = ?, semester_order = ?,
      allocation_input_revision = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .run(record.name, record.nameKey, record.order, record.allocationInputRevision, record.createdAt, record.updatedAt, record.id);
  }

  insertSemesterCourse({ record }: { record: SemesterCourseRecord }): void {
    validateRecord('semesterCourses', record);
    this.db.prepare(`INSERT INTO semester_courses (id, position, semester_id, course_id, capacity, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM semester_courses), ?, ?, ?, ?, ?)`)
      .run(record.id, record.semesterId, record.courseId, record.capacity, record.createdAt, record.updatedAt);
  }

  updateSemesterCourse({ record }: { record: SemesterCourseRecord }): void {
    validateRecord('semesterCourses', record);
    this.db.prepare(`UPDATE semester_courses SET semester_id = ?, course_id = ?, capacity = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .run(record.semesterId, record.courseId, record.capacity, record.createdAt, record.updatedAt, record.id);
  }

  bumpSemester({ id, now }: { id: string; now: string }): void {
    const current = this.getSemester({ id });
    if (!current) throw new Error('Semester was not found');
    this.updateSemester({ record: { ...current, allocationInputRevision: current.allocationInputRevision + 1, updatedAt: now } });
  }

  swapSemesterOrders({ left, right, now }: { left: SemesterRecord; right: SemesterRecord; now: string }): void {
    // The temporary NULL avoids the immediate UNIQUE constraint during the swap.
    this.db.prepare('UPDATE semesters SET semester_order = NULL WHERE id = ?').run(left.id);
    this.updateSemester({ record: { ...right, order: left.order, allocationInputRevision: right.allocationInputRevision + 1, updatedAt: now } });
    this.updateSemester({ record: { ...left, order: right.order, allocationInputRevision: left.allocationInputRevision + 1, updatedAt: now } });
  }

  semesterContext({ id }: { id: string }): SemesterContext | undefined {
    const semester = this.getSemester({ id });
    if (!semester) return undefined;
    const semesterCourses = this.db.prepare(`SELECT sc.id, sc.course_id AS courseId, c.name AS courseName, sc.capacity,
        COALESCE(a.application_count, 0) AS applicationCount, COALESCE(e.enrollment_count, 0) AS enrollmentCount
      FROM semester_courses AS sc
      JOIN courses AS c ON c.id = sc.course_id
      LEFT JOIN (
        SELECT ac.semester_course_id, COUNT(DISTINCT ac.application_id) AS application_count FROM application_choices AS ac
        JOIN semester_courses AS target ON target.id = ac.semester_course_id
        WHERE target.semester_id = ? GROUP BY ac.semester_course_id
      ) AS a ON a.semester_course_id = sc.id
      LEFT JOIN (
        SELECT en.semester_course_id, COUNT(*) AS enrollment_count FROM enrollments AS en
        JOIN semester_courses AS target ON target.id = en.semester_course_id
        WHERE target.semester_id = ? GROUP BY en.semester_course_id
      ) AS e ON e.semester_course_id = sc.id
      WHERE sc.semester_id = ? ORDER BY sc.position`).all(id, id, id)
      .map((row) => ({ ...row })) as SemesterContext['semesterCourses'];
    const issues = semesterCourses.some(({ capacity }) => capacity === null) ? [{ code: 'CAPACITY_UNRESOLVED' }] : [];
    return { semester: { id: semester.id, name: semester.name }, order: semester.order,
      allocationInputRevision: semester.allocationInputRevision, semesterCourses, readyForAutoAllocation: issues.length === 0, issues };
  }

  semesterUsage({ id }: { id: string }): { applications: boolean; enrollments: boolean; drafts: boolean; receipts: boolean } {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM applications WHERE semester_id = ?) AS applications,
      EXISTS(SELECT 1 FROM enrollments AS e JOIN semester_courses AS sc ON sc.id = e.semester_course_id WHERE sc.semester_id = ?) AS enrollments,
      EXISTS(SELECT 1 FROM allocation_drafts WHERE semester_id = ?) AS drafts,
      EXISTS(SELECT 1 FROM finalization_receipts WHERE semester_id = ?) AS receipts`).get(id, id, id, id)!;
    return { applications: Boolean(row.applications), enrollments: Boolean(row.enrollments), drafts: Boolean(row.drafts), receipts: Boolean(row.receipts) };
  }

  hasCourseEnrollments({ semesterCourseId }: { semesterCourseId: string }): boolean {
    return Boolean(this.db.prepare('SELECT EXISTS(SELECT 1 FROM enrollments WHERE semester_course_id = ?) AS found').get(semesterCourseId)!.found);
  }

  deleteSemester({ id }: { id: string }): void {
    const courses = this.db.prepare('SELECT course_id AS id FROM semester_courses WHERE semester_id = ?').all(id);
    this.db.prepare('DELETE FROM semester_courses WHERE semester_id = ?').run(id);
    for (const course of courses) {
      this.db.prepare('DELETE FROM courses WHERE id = ? AND NOT EXISTS(SELECT 1 FROM semester_courses WHERE course_id = ?)').run(course.id!, course.id!);
    }
    this.db.prepare('DELETE FROM semesters WHERE id = ?').run(id);
  }

  deleteSemesterCourse({ id }: { id: string }): void {
    const course = this.getSemesterCourse({ id });
    this.db.prepare('DELETE FROM semester_courses WHERE id = ?').run(id);
    if (course) this.db.prepare('DELETE FROM courses WHERE id = ? AND NOT EXISTS(SELECT 1 FROM semester_courses WHERE course_id = ?)').run(course.courseId, course.courseId);
  }
}
