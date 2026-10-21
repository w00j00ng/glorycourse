import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';

import type { SemesterRecord } from '../domain/records.ts';
import { SemesterCourseQueries, type SemesterCourseContextRow } from './semester-courses.ts';
import { validateRecord } from './validation.ts';

export type SemesterContext = {
  semester: { id: string; name: string };
  order: number | null;
  allocationInputRevision: number;
  semesterCourses: SemesterCourseContextRow[];
  readyForAutoAllocation: boolean;
  issues: { code: string }[];
};

export class SemesterQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  list({ query = '' }: { query?: string } = {}): SemesterRecord[] {
    const search = query.trim().normalize('NFC');
    return this.db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
      allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM semesters WHERE (? = '' OR instr(name, ?) > 0) ORDER BY position`)
      .all(search, search).map((row) => ({ ...row })) as SemesterRecord[];
  }

  listPage({ query, page, limit }: { query?: string; page: number; limit: number }) {
    const records = this.list({ query }).sort((left, right) => (
      (right.order ?? 0) - (left.order ?? 0)
      || right.createdAt.localeCompare(left.createdAt)
      || left.name.localeCompare(right.name)
    ));
    const start = (page - 1) * limit;
    const items = records.slice(start, start + limit).map(({ id, name, order }) => ({ id, name, order: order ?? null }));
    return { items, page, limit, total: records.length };
  }

  get({ id }: { id: string }): SemesterRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
      allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM semesters WHERE id = ?`).get(id);
    return row ? { ...row } as SemesterRecord : undefined;
  }

  getByNameKey({ nameKey }: { nameKey: string }): SemesterRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
      allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM semesters WHERE name_key = ?`).get(nameKey);
    return row ? { ...row } as SemesterRecord : undefined;
  }

  insert({ record }: { record: SemesterRecord }): void {
    validateRecord('semesters', record);
    this.db.prepare(`INSERT INTO semesters (id, position, name, name_key, semester_order,
      allocation_input_revision, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM semesters), ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.name, record.nameKey, record.order, record.allocationInputRevision, record.createdAt, record.updatedAt);
  }

  update({ record }: { record: SemesterRecord }): void {
    validateRecord('semesters', record);
    this.db.prepare(`UPDATE semesters SET name = ?, name_key = ?, semester_order = ?,
      allocation_input_revision = ?, created_at = ?, updated_at = ? WHERE id = ?`)
      .run(record.name, record.nameKey, record.order, record.allocationInputRevision, record.createdAt, record.updatedAt, record.id);
  }

  nextOrder(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(semester_order), 0) AS maximum FROM semesters').get()!;
    const next = Number(row.maximum) + 1;
    if (!Number.isSafeInteger(next)) throw new RangeError('No semester order is available');
    return next;
  }

  findAdjacent({ semesterId, direction }: { semesterId: string; direction: 'UP' | 'DOWN' }): SemesterRecord | undefined {
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

  findByOrder({ order, excludeId = null }: { order: number; excludeId?: string | null }): SemesterRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
      allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
      FROM semesters WHERE semester_order = ? AND (? IS NULL OR id <> ?)`)
      .get(order, excludeId, excludeId);
    return row ? { ...row } as SemesterRecord : undefined;
  }

  bump({ id, now }: { id: string; now: string }): void {
    const current = this.get({ id });
    if (!current) throw new Error('Semester was not found');
    this.update({ record: { ...current, allocationInputRevision: current.allocationInputRevision + 1, updatedAt: now } });
  }

  swapOrders({ left, right, now }: { left: SemesterRecord; right: SemesterRecord; now: string }): void {
    // The temporary NULL avoids the immediate UNIQUE constraint during the swap.
    this.db.prepare('UPDATE semesters SET semester_order = NULL WHERE id = ?').run(left.id);
    this.update({ record: { ...right, order: left.order, allocationInputRevision: right.allocationInputRevision + 1, updatedAt: now } });
    this.update({ record: { ...left, order: right.order, allocationInputRevision: left.allocationInputRevision + 1, updatedAt: now } });
  }

  context({ id }: { id: string }): SemesterContext | undefined {
    const semester = this.get({ id });
    if (!semester) return undefined;
    const semesterCourses = new SemesterCourseQueries(this.db).contextRows({ semesterId: id });
    const issues = semesterCourses.some(({ capacity }) => capacity === null) ? [{ code: 'CAPACITY_UNRESOLVED' }] : [];
    return { semester: { id: semester.id, name: semester.name }, order: semester.order,
      allocationInputRevision: semester.allocationInputRevision, semesterCourses, readyForAutoAllocation: issues.length === 0, issues };
  }

  usage({ id }: { id: string }): { applications: boolean; enrollments: boolean; drafts: boolean; receipts: boolean } {
    const row = this.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM applications WHERE semester_id = ?) AS applications,
      EXISTS(SELECT 1 FROM enrollments AS e JOIN semester_courses AS sc ON sc.id = e.semester_course_id WHERE sc.semester_id = ?) AS enrollments,
      EXISTS(SELECT 1 FROM allocation_drafts WHERE semester_id = ?) AS drafts,
      EXISTS(SELECT 1 FROM finalization_receipts WHERE semester_id = ?) AS receipts`).get(id, id, id, id)!;
    return { applications: Boolean(row.applications), enrollments: Boolean(row.enrollments), drafts: Boolean(row.drafts), receipts: Boolean(row.receipts) };
  }

  delete({ id }: { id: string }): void {
    new SemesterCourseQueries(this.db).deleteForSemester({ semesterId: id });
    this.db.prepare('DELETE FROM semesters WHERE id = ?').run(id);
  }

  enrollmentSummary({ semesterId }: { semesterId: string }): {
    semesterName: string; count: number; storeRevision: number; storeEpoch: string;
  } | undefined {
    const row = this.db.prepare(`
      SELECT s.name AS semesterName, meta.store_revision AS storeRevision,
             meta.store_epoch AS storeEpoch,
             (SELECT count(*) FROM enrollments AS e
              JOIN semester_courses AS sc ON sc.id = e.semester_course_id
              WHERE sc.semester_id = s.id) AS count
      FROM semesters AS s CROSS JOIN store_meta AS meta
      WHERE s.id = ? AND meta.id = 1
    `).get(semesterId);
    return row ? { ...row } as { semesterName: string; count: number; storeRevision: number; storeEpoch: string } : undefined;
  }
}

export const readSnapshotRows = (db: DatabaseSync): (import('../domain/records.ts').SemesterRecord)[] => (
  db.prepare(`SELECT id, name, name_key AS nameKey, semester_order AS "order",
    allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
    FROM semesters ORDER BY position`).all().map((row) => ({ ...row })) as (import('../domain/records.ts').SemesterRecord)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['semesters'][number])[], previous: (import('../domain/records.ts').DatabaseState['semesters'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM semesters WHERE id = ?');
  const move = db.prepare('UPDATE semesters SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM semesters').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM semesters').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [db.prepare('UPDATE semesters SET name_key = ? WHERE id = ?')];
  const changes = planRowChanges(records, previous, maximum, positions, [(item) => item.nameKey], 'Duplicate semesters key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO semesters (id, position, name, name_key, semester_order, allocation_input_revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, name, name_key, semester_order, allocation_input_revision, created_at, updated_at
      FROM semesters WHERE id = ?`);
  const update = db.prepare(`UPDATE semesters SET position = ?, name = ?, name_key = ?, semester_order = ?, allocation_input_revision = ?, created_at = ?, updated_at = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate semesters key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
