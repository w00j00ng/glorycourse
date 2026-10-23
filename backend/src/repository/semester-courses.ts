import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';

import type { SemesterCourseRecord } from '../domain/records.ts';
import { CourseQueries } from './courses.ts';
import { validateRecord } from './validation.ts';

export type SemesterCourseContextRow = {
  id: string; courseId: string; courseName: string; capacity: number | null;
  applicationCount: number; enrollmentCount: number;
};

export class SemesterCourseQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  list({ semesterId = null, courseId = null }: { semesterId?: string | null; courseId?: string | null } = {}): SemesterCourseRecord[] {
    return this.db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId, capacity,
      created_at AS createdAt, updated_at AS updatedAt FROM semester_courses
      WHERE (? IS NULL OR semester_id = ?) AND (? IS NULL OR course_id = ?) ORDER BY position`)
      .all(semesterId, semesterId, courseId, courseId).map((row) => ({ ...row })) as SemesterCourseRecord[];
  }

  get({ id }: { id: string }): SemesterCourseRecord | undefined {
    const row = this.db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId, capacity,
      created_at AS createdAt, updated_at AS updatedAt FROM semester_courses WHERE id = ?`).get(id);
    return row ? { ...row } as SemesterCourseRecord : undefined;
  }

  getByPair({ semesterId, courseId }: { semesterId: string; courseId: string }): SemesterCourseRecord | undefined {
    const row = this.db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId, capacity,
      created_at AS createdAt, updated_at AS updatedAt FROM semester_courses
      WHERE semester_id = ? AND course_id = ?`).get(semesterId, courseId);
    return row ? { ...row } as SemesterCourseRecord : undefined;
  }

  insert({ record }: { record: SemesterCourseRecord }): void {
    validateRecord('semesterCourses', record);
    this.db.prepare(`INSERT INTO semester_courses (id, position, semester_id, course_id, capacity, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM semester_courses), ?, ?, ?, ?, ?)`)
      .run(record.id, record.semesterId, record.courseId, record.capacity, record.createdAt, record.updatedAt);
  }

  update({ record }: { record: SemesterCourseRecord }): void {
    validateRecord('semesterCourses', record);
    this.db.prepare(`UPDATE semester_courses SET semester_id = ?, course_id = ?, capacity = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .run(record.semesterId, record.courseId, record.capacity, record.createdAt, record.updatedAt, record.id);
  }

  contextRows({ semesterId }: { semesterId: string }): SemesterCourseContextRow[] {
    return this.db.prepare(`SELECT sc.id, sc.course_id AS courseId, c.name AS courseName, sc.capacity,
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
      WHERE sc.semester_id = ? ORDER BY sc.position`).all(semesterId, semesterId, semesterId)
      .map((row) => ({ ...row })) as SemesterCourseContextRow[];
  }

  delete({ id }: { id: string }): void {
    const course = this.get({ id });
    this.db.prepare('DELETE FROM semester_courses WHERE id = ?').run(id);
    if (course) new CourseQueries(this.db).deleteUnused({ id: course.courseId });
  }

  deleteForSemester({ semesterId }: { semesterId: string }): void {
    const semesterCourses = this.list({ semesterId });
    this.db.prepare('DELETE FROM semester_courses WHERE semester_id = ?').run(semesterId);
    const courses = new CourseQueries(this.db);
    for (const { courseId } of semesterCourses) courses.deleteUnused({ id: courseId });
  }
}

export const readSnapshotRows = (db: DatabaseSync): (import('../domain/records.ts').SemesterCourseRecord)[] => (
  db.prepare(`SELECT id, semester_id AS semesterId, course_id AS courseId,
    capacity, created_at AS createdAt, updated_at AS updatedAt FROM semester_courses ORDER BY position`).all().map((row) => ({ ...row })) as (import('../domain/records.ts').SemesterCourseRecord)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['semesterCourses'][number])[], previous: (import('../domain/records.ts').DatabaseState['semesterCourses'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM semester_courses WHERE id = ?');
  const move = db.prepare('UPDATE semester_courses SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM semester_courses').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM semester_courses').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [db.prepare('UPDATE semester_courses SET semester_id = ? WHERE id = ?')];
  const changes = planRowChanges(records, previous, maximum, positions, [(item) => JSON.stringify([item.semesterId, item.courseId])], 'Duplicate semester_courses key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO semester_courses (id, position, semester_id, course_id, capacity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, semester_id, course_id, capacity, created_at, updated_at
      FROM semester_courses WHERE id = ?`);
  const update = db.prepare(`UPDATE semester_courses SET position = ?, semester_id = ?, course_id = ?, capacity = ?, created_at = ?, updated_at = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate semester_courses key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
