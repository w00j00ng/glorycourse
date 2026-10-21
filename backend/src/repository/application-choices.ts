import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ApplicationChoiceRecord } from '../domain/records.ts';
import type { ApplicationView } from '../domain/query-models.ts';
import { ApplicationQueries } from './applications.ts';
import { ApplicationChoiceSourceRefQueries } from './application-choice-source-refs.ts';
import { validateRecord } from './validation.ts';

export class ApplicationChoiceQueries {
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  list({ applicationId = null }: { applicationId?: string | null } = {}): ApplicationChoiceRecord[] {
    const choices = this.db.prepare(`SELECT id, application_id AS applicationId, semester_course_id AS semesterCourseId,
      preference, created_at AS createdAt, updated_at AS updatedAt FROM application_choices
      WHERE (? IS NULL OR application_id = ?) ORDER BY position`).all(applicationId, applicationId)
      .map((row) => ({ ...row, sourceRefs: [] })) as unknown as ApplicationChoiceRecord[];
    if (!choices.length) return choices;
    const byId = new Map(choices.map((choice) => [choice.id, choice]));
    const refs = new ApplicationChoiceSourceRefQueries(this.db).list({ choiceIds: choices.map(({ id }) => id) });
    for (const { choiceId, ...ref } of refs) byId.get(choiceId)!.sourceRefs.push(ref);
    return choices;
  }

  insert({ record }: { record: ApplicationChoiceRecord }): void {
    validateRecord('applicationChoices', record);
    this.db.prepare(`INSERT INTO application_choices (id, position, application_id, semester_course_id, preference, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM application_choices), ?, ?, ?, ?, ?)`)
      .run(record.id, record.applicationId, record.semesterCourseId, record.preference, record.createdAt, record.updatedAt);
    new ApplicationChoiceSourceRefQueries(this.db).insert({ choiceId: record.id, records: record.sourceRefs });
  }

  replaceForApplication({ applicationId, records }: { applicationId: string; records: ApplicationChoiceRecord[] }): void {
    this.db.prepare('DELETE FROM application_choices WHERE application_id = ?').run(applicationId);
    for (const record of records) this.insert({ record });
  }

  countForCourse({ semesterCourseId }: { semesterCourseId: string }): number {
    return this.db.prepare('SELECT COUNT(DISTINCT application_id) AS count FROM application_choices WHERE semester_course_id = ?').get(semesterCourseId)!.count as number;
  }

  removeCourseChoices({ semesterCourseId, now }: { semesterCourseId: string; now: string }): void {
    const affected = this.db.prepare('SELECT DISTINCT application_id AS id FROM application_choices WHERE semester_course_id = ?').all(semesterCourseId);
    this.db.prepare('DELETE FROM application_choices WHERE semester_course_id = ?').run(semesterCourseId);
    const applicationIds = affected.map(({ id }) => String(id));
    new ApplicationQueries(this.db).deleteEmpty({ applicationIds });
    new ApplicationQueries(this.db).bumpMany({ applicationIds, now });
  }

  listViewRows({ applicationIds }: { applicationIds: string[] }) {
    return this.db.prepare(`SELECT ac.application_id AS applicationId, ac.id,
      ac.semester_course_id AS semesterCourseId, c.name AS courseName, ac.preference
      FROM application_choices AS ac JOIN semester_courses AS sc ON sc.id = ac.semester_course_id
      JOIN courses AS c ON c.id = sc.course_id
      WHERE ac.application_id IN (SELECT value FROM json_each(?)) ORDER BY ac.position`)
      .all(JSON.stringify(applicationIds)) as (ApplicationView['choices'][number] & { applicationId: string })[];
  }

  stagedApplicationIds(): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT c.application_id AS applicationId
      FROM application_choices AS c JOIN application_choice_source_refs AS r ON r.application_choice_id = c.id
      JOIN import_batches AS b ON b.id = r.import_batch_id WHERE b.status = 'STAGED'`).all();
    return new Set(rows.map(({ applicationId }) => String(applicationId)));
  }
}

export const readSnapshotRows = (db: DatabaseSync): (Omit<import('../domain/records.ts').ApplicationChoiceRecord, 'sourceRefs'>)[] => (
  db.prepare(`SELECT id, application_id AS applicationId,
    semester_course_id AS semesterCourseId, preference, created_at AS createdAt, updated_at AS updatedAt
    FROM application_choices ORDER BY position`).all().map((row) => ({ ...row })) as (Omit<import('../domain/records.ts').ApplicationChoiceRecord, 'sourceRefs'>)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['applicationChoices'][number])[], previous: (import('../domain/records.ts').DatabaseState['applicationChoices'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM application_choices WHERE id = ?');
  const move = db.prepare('UPDATE application_choices SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM application_choices').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM application_choices').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [];
  const changes = planRowChanges(records, previous, maximum, positions, [], 'Duplicate application_choices key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO application_choices (id, position, application_id, semester_course_id, preference, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, application_id, semester_course_id, preference, created_at, updated_at
      FROM application_choices WHERE id = ?`);
  const update = db.prepare(`UPDATE application_choices SET position = ?, application_id = ?, semester_course_id = ?, preference = ?, created_at = ?, updated_at = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate application_choices key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
