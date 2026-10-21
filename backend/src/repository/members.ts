import { planRowChanges } from './row-changes.ts';
import type { DatabaseSync } from 'node:sqlite';

import type { NamedRecord } from '../domain/records.ts';
import { validateRecord } from './validation.ts';

export class MemberQueries {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) { this.db = db; }

  list({ query = '' }: { query?: string } = {}): NamedRecord[] {
    const search = query.trim().normalize('NFC');
    return this.db.prepare(`SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
      FROM members WHERE (? = '' OR instr(name, ?) > 0) ORDER BY position`)
      .all(search, search).map((row) => ({ ...row })) as NamedRecord[];
  }

  listPage({ query, page, limit }: { query?: string; page: number; limit: number }) {
    const records = this.list({ query });
    const start = (page - 1) * limit;
    const items = records.slice(start, start + limit).map(({ id, name }) => ({ id, name }));
    return { items, page, limit, total: records.length };
  }

  get({ id }: { id: string }): NamedRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
      FROM members WHERE id = ?`).get(id);
    return row ? { ...row } as NamedRecord : undefined;
  }

  getByNameKey({ nameKey }: { nameKey: string }): NamedRecord | undefined {
    const row = this.db.prepare(`SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt
      FROM members WHERE name_key = ?`).get(nameKey);
    return row ? { ...row } as NamedRecord : undefined;
  }

  insert({ record }: { record: NamedRecord }): void {
    validateRecord('members', record);
    this.db.prepare(`INSERT INTO members (id, position, name, name_key, created_at, updated_at)
      VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM members), ?, ?, ?, ?)`)
      .run(record.id, record.name, record.nameKey, record.createdAt, record.updatedAt);
  }

  update({ record }: { record: NamedRecord }): void {
    validateRecord('members', record);
    this.db.prepare('UPDATE members SET name = ?, name_key = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run(record.name, record.nameKey, record.createdAt, record.updatedAt, record.id);
  }

  enrolledForSemester({ semesterId }: { semesterId: string }): { id: string; name: string }[] {
    return this.db.prepare(`SELECT m.id, m.name
      FROM members AS m WHERE EXISTS (
        SELECT 1 FROM enrollments AS e JOIN semester_courses AS sc ON sc.id = e.semester_course_id
        WHERE e.member_id = m.id AND sc.semester_id = ?
      ) ORDER BY m.position`).all(semesterId).map((row) => ({ ...row })) as { id: string; name: string }[];
  }
}

export const readSnapshotRows = (db: DatabaseSync): (import('../domain/records.ts').NamedRecord)[] => (
  db.prepare('SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt FROM members ORDER BY position').all().map((row) => ({ ...row })) as (import('../domain/records.ts').NamedRecord)[]
);

export const prepareSnapshotChanges = (
  db: DatabaseSync, records: (import('../domain/records.ts').DatabaseState['members'][number])[], previous: (import('../domain/records.ts').DatabaseState['members'][number])[],
): void => {
  if (records === previous || previous.length === 0) return;
  const remove = db.prepare('DELETE FROM members WHERE id = ?');
  const move = db.prepare('UPDATE members SET position = ? WHERE id = ?');
  const maximum = Number(db.prepare('SELECT MAX(position) AS maximum FROM members').get()?.maximum ?? -1);
  const positions = maximum === previous.length - 1 ? undefined : new Map(
    db.prepare('SELECT id AS key, position FROM members').all().map(row => [String(row.key), Number(row.position)]),
  );
  const uniqueUpdates: import('node:sqlite').StatementSync[] = [db.prepare('UPDATE members SET name_key = ? WHERE id = ?')];
  const changes = planRowChanges(records, previous, maximum, positions, [(item) => item.nameKey], 'Duplicate members key');
  for (const change of changes) {
    if (change.type === 'remove') remove.run(change.key);
    else if (change.type === 'move') move.run(change.position, change.key);
    else uniqueUpdates[change.index].run(change.value, change.key);
  }
};

export const prepareSnapshotWrite = (db: DatabaseSync) => {
  const insert = db.prepare(`INSERT INTO members (id, position, name, name_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
  const read = db.prepare(`SELECT id, position, name, name_key, created_at, updated_at
      FROM members WHERE id = ?`);
  const update = db.prepare(`UPDATE members SET position = ?, name = ?, name_key = ?, created_at = ?, updated_at = ?
      WHERE id = ?`);
  const written = new Set<string | number | null>();
  return { run: (...values: (string | number | null)[]): void => {
    if (written.has(values[0])) throw new Error('Duplicate members key');
    written.add(values[0]);
    const stored = read.get(values[0]);
    if (!stored) { insert.run(...values); return; }
    if (Object.values(stored).some((value, index) => value !== values[index])) update.run(...values.slice(1), values[0]);
  } };
};
