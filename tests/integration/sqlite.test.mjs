import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openStore } from '../../backend/src/storage/store.ts';
import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';
import { readRelationalStore, writeRelationalStore } from '../../backend/src/storage/queries/relational-store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const member = { id: 'member-1', name: '이관 회원', nameKey: '이관 회원', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z' };

test('creates a managed SQLite database and reopens committed records', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, empty);
  await store.write({}, (data) => { data.members.push(member); });
  assert.equal((await readFile(file)).subarray(0, 16).toString(), 'SQLite format 3\0');
  await store.write({}, (data) => { data.members[0].name = '수정 회원'; });
  const reopened = await openStore(file, empty);
  assert.equal(reopened.read().members[0].name, '수정 회원');
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM members').get().count, 1); }
  finally { db.close(); }
});

test('stores business data in explicit relational columns without JSON documents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-sqlite-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, empty);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    assert.ok(tables.some(({ name }) => name === 'application_choice_source_refs'));
    assert.ok(tables.some(({ name }) => name === 'allocation_snapshot_applications'));
    assert.ok(tables.some(({ name }) => name === 'import_raw_cells'));
    assert.doesNotMatch(tables.map(({ sql }) => sql).join('\n'), /\bdocument\b|json_valid/i);
    for (const { name } of tables.filter(({ name }) => name !== 'schema_migrations')) {
      assert.ok(db.prepare(`PRAGMA table_info(${name})`).all().every(({ name: column }) => column !== 'document'), name);
    }
    assert.deepEqual(
      db.prepare('PRAGMA table_info(enrollments)').all().map(({ name }) => name),
      ['id', 'position', 'semester_course_id', 'member_id', 'revision', 'created_at', 'updated_at'],
    );
    assert.ok(db.prepare('PRAGMA foreign_key_list(semester_courses)').all().some(({ table }) => table === 'semesters'));
  } finally { db.close(); }
});

test('leaves an old JSON file untouched and rolls back a failed SQLite transaction', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const legacyFile = join(directory, 'db.json');
  const file = join(directory, 'db.sqlite');
  await writeFile(legacyFile, '{broken');
  await openStore(file, empty);
  assert.equal(await readFile(legacyFile, 'utf8'), '{broken');
  const adapter = new SQLiteAdapter(file);
  await assert.rejects(adapter.write({ ...structuredClone(empty), members: [member, member] }));
  assert.deepEqual(await adapter.read(), empty);
});

test('rejects a record whose foreign keys do not exist and keeps committed data intact', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-sqlite-foreign-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, empty);
  await assert.rejects(store.write({}, (data) => {
    data.semesterCourses.push({
      id: 'semester-course-1', semesterId: 'missing-semester', courseId: 'missing-course', capacity: 1,
      createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
    });
  }), /FOREIGN KEY/);
  assert.deepEqual((await openStore(file, empty)).read(), empty);
});

test('reopens a maximum-size import with every row and cell in order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-import-scale-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, empty);
  const data = structuredClone(empty);
  data.importBatches.push({
    id: 'large-import', kind: 'APPLICATIONS', templateVersion: '1', fileHash: 'hash',
    importedAt: '2026-09-25T00:00:00.000Z', status: 'STAGED', resolutions: [], receipt: null,
    rawRows: Array.from({ length: 99_994 }, (_, index) => ({
      sheet: '신청', row: index + 2,
      cells: { 학기: '가을', 이름: `회원 ${index}`, 강좌: '국어', 순위: String(index + 1), 비고: null },
    })),
  });
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    writeRelationalStore(db, data);
    db.exec('COMMIT');
    const started = performance.now();
    const reopened = readRelationalStore(db);
    const elapsed = performance.now() - started;
    assert.deepEqual(reopened, data);
    t.diagnostic(`99,994 rows read in ${Math.round(elapsed)} ms`);
    assert.ok(elapsed < 15_000, `Import read blocked for ${Math.round(elapsed)} ms`);
  } finally { db.close(); }
});
