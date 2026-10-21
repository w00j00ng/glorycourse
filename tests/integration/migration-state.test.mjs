import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { inspectMigrationHistory } from '../../backend/src/storage/migrations.ts';
import { migrateDatabase } from '../../backend/src/bootstrap/database.ts';
import { migrateDatabase as migrateWithSnapshot } from '../../backend/src/storage/migrations.ts';
import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { readRelationalStore, writeRelationalStore } from '../../backend/src/repository/relational-store.ts';
import { acquireInstanceLock } from '../../backend/src/storage/instance-lock.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));

const readDatabase = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return readRelationalStore(db); }
  finally { db.close(); }
};
const current = JSON.parse(await readFile(new URL('../../schema/migrations/manifest.json', import.meta.url), 'utf8'));
const target = current.targetVersion;
const hash = (text) => createHash('sha256').update(text).digest('hex');
const state = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return { ...db.prepare('SELECT version, dirty FROM schema_migrations').get() }; }
  finally { db.close(); }
};
const temporary = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'db.sqlite') };
};
const customMigrations = async (directory, up, down) => {
  const destination = join(directory, 'migrations');
  await cp(resolve('schema/migrations'), destination, { recursive: true });
  const version = target + 86_400;
  const name = `${version}_test.up.sql`;
  const downName = `${version}_test.down.sql`;
  await writeFile(join(destination, name), up);
  await writeFile(join(destination, downName), down);
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({
    targetVersion: version,
    migrations: [...current.migrations, { version, name, checksum: hash(up), down: { name: downName, checksum: hash(down) } }],
  }));
  return { destination, version, name };
};

test('startup stores exactly one version-dirty row and repeats without executing DDL', async (t) => {
  const { file } = await temporary(t);
  await openRepository(file, empty);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(schema_migrations)').all().map(({ name }) => name), ['version', 'dirty']);
    assert.equal(db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, 1);
  } finally { db.close(); }
  assert.deepEqual(state(file), { version: target, dirty: 0 });
  assert.deepEqual(await inspectMigrationHistory(file), { databaseVersion: String(target), dirty: false, pending: 0 });
  const before = await readFile(file);
  assert.deepEqual(await migrateDatabase(file, empty), { applied: [] });
  assert.deepEqual(await readFile(file), before);
});

test('upgrades populated note-free records and source evidence, then refuses a lossy duplicate-choice downgrade', async (t) => {
  const { file } = await temporary(t);
  const original = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
  original.importBatches.push({
    id: 'source', kind: 'APPLICATIONS', templateVersion: '3', fileHash: 'a'.repeat(64),
    importedAt: '2026-10-04T00:00:00.000Z', status: 'STAGED', resolutions: [], receipt: null,
    rawRows: [{ sheet: '수강신청', row: 2, cells: { 회원명: 'Alice', '1순위 강좌': 'Art' } }],
  });
  original.applicationChoices[0].sourceRefs = [{ importBatchId: 'source', sheet: '수강신청', row: 2 }];
  let repository = await openRepository(file, original);
  repository.close();
  await migrateDatabase(file, undefined, { targetVersion: 1791158400, rotateEpoch: false });
  const old = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(old.prepare('SELECT COUNT(*) AS count FROM application_choice_source_refs').get().count, 1);
    assert.equal(old.prepare('PRAGMA table_info(applications)').all().some(({ name }) => name === 'applicant_note'), false);
    assert.equal(old.prepare('SELECT member_name FROM allocation_snapshot_applications').get().member_name, 'Alice at generation');
  } finally { old.close(); }
  repository = await openRepository(file, empty);
  let saved = repository.snapshot();
  assert.deepEqual(saved, { ...original, meta: saved.meta });
  assert.equal(saved.allocationDrafts[0].inputSnapshot.applications[0].applicantNote, null);
  const candidate = structuredClone(saved);
  candidate.applications[0].applicantNote = '신청자 메모\n줄바꿈 보존';
  candidate.applicationChoices.push({ ...structuredClone(candidate.applicationChoices[0]), id: 'repeated-choice', preference: 2 });
  await repository.restore(candidate, { expectedEpoch: saved.meta.storeEpoch, expectedRevision: saved.meta.storeRevision, backup: async () => {} });
  repository.close();
  repository = await openRepository(file, empty);
  saved = repository.snapshot();
  assert.deepEqual(saved.applicationChoices.map(({ preference, sourceRefs }) => ({ preference, sourceRefs })), [
    { preference: 1, sourceRefs: original.applicationChoices[0].sourceRefs },
    { preference: 2, sourceRefs: original.applicationChoices[0].sourceRefs },
  ]);
  assert.equal(saved.applications[0].applicantNote, candidate.applications[0].applicantNote);
  assert.equal(saved.allocationDrafts[0].inputSnapshot.applications[0].applicantNote, null);
  repository.close();
  await assert.rejects(migrateDatabase(file, undefined, { targetVersion: 1791158400 }), /UNIQUE constraint failed/);
  assert.deepEqual(state(file), { version: 1791158400, dirty: 1 });
  assert.deepEqual(readDatabase(file), saved);
  await assert.rejects(openRepository(file, empty), /dirty/i);
});

test('dirty, unknown, future, duplicate and zero-version business databases block startup unchanged', async (t) => {
  const cases = [
    { version: target, dirty: 1, message: /dirty/i },
    { version: target - 1, dirty: 0, message: /unknown|known/i },
    { version: target + 86_400, dirty: 0, message: /newer/i },
    { version: target, dirty: 0, duplicate: true, message: /single|one|state/i },
    { version: 0, dirty: 0, message: /empty|zero/i },
  ];
  for (const input of cases) {
    const { file } = await temporary(t);
    await openRepository(file, empty);
    const db = new DatabaseSync(file);
    try {
      db.prepare('UPDATE schema_migrations SET version = ?, dirty = ?').run(input.version, input.dirty);
      if (input.duplicate) db.prepare('INSERT INTO schema_migrations VALUES (?, 0)').run(target - 86_400);
    } finally { db.close(); }
    const before = await readFile(file);
    await assert.rejects(openRepository(file, empty), input.message);
    assert.deepEqual(await readFile(file), before);
  }
});

test('failed DDL rolls back the batch but keeps dirty on disk and blocks the next startup', async (t) => {
  const { directory, file } = await temporary(t);
  await openRepository(file, empty);
  const { destination, version } = await customMigrations(directory,
    'CREATE INDEX temporary_members_index ON members(position);\nINSERT INTO missing_table VALUES (1);\n',
    'DROP INDEX temporary_members_index;\n');
  await assert.rejects(migrateDatabase(file, empty, { directory: destination }), /missing_table/);
  assert.deepEqual(state(file), { version, dirty: 1 });
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'temporary_members_index'").get().count, 0); }
  finally { db.close(); }
  assert.deepEqual(readDatabase(file), empty);
  const before = await readFile(file);
  await assert.rejects(migrateDatabase(file, empty, { directory: destination }), /dirty/i);
  assert.deepEqual(await readFile(file), before);
});

test('malformed migration state rejects text and null dirty values without changing the database', async (t) => {
  const cases = [
    { dirty: '1' },
    { dirty: '0' },
    { dirty: null },
  ];
  for (const input of cases) {
    const { file } = await temporary(t);
    await openRepository(file, empty);
    const db = new DatabaseSync(file);
    try {
      db.exec('DROP TABLE schema_migrations; CREATE TABLE schema_migrations (version INTEGER, dirty TEXT)');
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(target, input.dirty);
    } finally { db.close(); }
    const before = await readFile(file);
    await assert.rejects(inspectMigrationHistory(file), /valid row|state columns/i);
    await assert.rejects(openRepository(file, empty), /valid row|state columns/i);
    assert.deepEqual(await readFile(file), before);
  }
});

test('failed fresh initialization leaves only its dirty state and blocks automatic retry', async (t) => {
  const { directory, file } = await temporary(t);
  const { destination, version } = await customMigrations(directory, 'INSERT INTO missing_table VALUES (1);\n', 'SELECT 1;\n');
  await assert.rejects(migrateDatabase(file, empty, { directory: destination }), /missing_table/);
  assert.deepEqual(state(file), { version, dirty: 1 });
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(({ name }) => name), ['schema_migrations']); }
  finally { db.close(); }
  await assert.rejects(migrateDatabase(file, empty, { directory: destination }), /dirty/i);
});

test('explicit down preserves renamed ministries, permits their loss, and supports down to zero then up', async (t) => {
  const { file } = await temporary(t);
  const original = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
  await openRepository(file, original);
  const renamed = await migrateDatabase(file, undefined, { targetVersion: 1791072000 });
  assert.deepEqual(renamed.applied, [...current.migrations].reverse().filter(({ version }) => version > 1791072000).map(({ down }) => down.name));
  assert.deepEqual(state(file), { version: 1791072000, dirty: 0 });
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare('SELECT affiliation FROM applications').get().affiliation, original.applications[0].ministry); }
  finally { db.close(); }
  await migrateDatabase(file, empty);
  assert.deepEqual((await openRepository(file, empty)).snapshot().applications, original.applications);
  await migrateDatabase(file, undefined, { targetVersion: 1790336872 });
  await migrateDatabase(file, empty);
  assert.equal((await openRepository(file, empty)).snapshot().applications[0].ministry, null);
  await migrateDatabase(file, undefined, { targetVersion: 0 });
  assert.deepEqual(state(file), { version: 0, dirty: 0 });
  const cleared = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(cleared.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name <> 'schema_migrations'").get().count, 0); }
  finally { cleared.close(); }
  assert.deepEqual((await openRepository(file, empty)).snapshot(), empty);
});

test('failed down rolls back destructive SQL while its requested version stays dirty', async (t) => {
  const { directory, file } = await temporary(t);
  await openRepository(file, empty);
  const { destination, version } = await customMigrations(directory,
    'CREATE TABLE temporary_data (value TEXT);\nINSERT INTO temporary_data VALUES (\'keep\');\n',
    'DROP TABLE temporary_data;\nINSERT INTO missing_table VALUES (1);\n');
  await migrateDatabase(file, empty, { directory: destination });
  assert.deepEqual(state(file), { version, dirty: 0 });
  await assert.rejects(migrateDatabase(file, undefined, { directory: destination, targetVersion: target }), /missing_table/);
  assert.deepEqual(state(file), { version: target, dirty: 1 });
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare('SELECT value FROM temporary_data').get().value, 'keep'); }
  finally { db.close(); }
});

test('legacy history is verified before conversion even when business DDL is already current', async (t) => {
  const legacy = JSON.parse(await readFile(new URL('../../schema/migrations/legacy-manifest.json', import.meta.url), 'utf8'));
  const original = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
  const cases = [
    { sql: '', valid: true },
    { sql: "UPDATE schema_migrations SET checksum = '" + 'b'.repeat(64) + "' WHERE version = 1791072000", valid: false },
    { sql: 'DELETE FROM schema_migrations WHERE version = 1790314390', valid: false },
    { sql: "UPDATE schema_migrations SET name = 'unexpected.sql' WHERE version = 1790294400", valid: false },
  ];
  for (const input of cases) {
    const { file } = await temporary(t);
    const repository = await openRepository(file, original);
    repository.close();
    await migrateDatabase(file, undefined, { targetVersion: legacy.migrations.at(-1).version, rotateEpoch: false });
    const db = new DatabaseSync(file);
    try {
      const legacyInit = await readFile(resolve('tests/fixtures/migrations/1790294400_init.sql'), 'utf8');
      db.exec('PRAGMA foreign_keys = ON; DROP TABLE schema_migrations');
      db.exec(legacyInit.match(/CREATE TABLE schema_migrations \([\s\S]*?\) STRICT;/)[0]);
      for (const entry of legacy.migrations) {
        const sql = await readFile(entry.version === legacy.migrations[0].version
          ? resolve('tests/fixtures/migrations/1790294400_init.sql')
          : resolve('schema/migrations', entry.name.replace('.sql', '.up.sql')), 'utf8');
        assert.equal(hash(sql), entry.checksum);
        db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)').run(entry.version, entry.name, entry.checksum, '2026-10-05T00:00:00.000Z', '0.2.2');
      }
      if (input.sql) db.exec(input.sql);
    } finally { db.close(); }
    const before = await readFile(file);
    if (input.valid) {
      const result = await migrateDatabase(file);
      assert.deepEqual(result.applied, current.migrations.filter(({ version }) => version > legacy.migrations.at(-1).version).map(({ name }) => name));
      assert.deepEqual(state(file), { version: target, dirty: 0 });
      const saved = readDatabase(file);
      assert.deepEqual(saved, { ...original, meta: saved.meta });
      assert.equal(saved.meta.storeRevision, original.meta.storeRevision);
      const backup = new DatabaseSync(result.backupFile, { readOnly: true });
      try { assert.equal(backup.prepare('SELECT count(*) AS count FROM schema_migrations').get().count, legacy.migrations.length); }
      finally { backup.close(); }
    } else {
      await assert.rejects(migrateDatabase(file), /legacy migration history differs/);
      assert.deepEqual(await readFile(file), before);
    }
  }
});

test('down command rejects an active server or an unknown target and performs an explicit stopped-DB down', async (t) => {
  const { directory, file } = await temporary(t);
  await openRepository(file, empty);
  const run = (destination) => spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    resolve('scripts/migrations-down.mjs'), file, String(destination)], { encoding: 'utf8' });
  const lock = await acquireInstanceLock(directory);
  try {
    const result = run(1791072000);
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.match(result.stderr, /Another Glorycourse process/);
    assert.deepEqual(state(file), { version: target, dirty: 0 });
  } finally { await lock.release(); }
  const before = await readFile(file);
  const invalid = run(target - 1);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /unknown/);
  assert.deepEqual(await readFile(file), before);
  const result = run(1791072000);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.deepEqual(state(file), { version: 1791072000, dirty: 0 });
});

for (const stage of ['read', 'write']) {
  test(`snapshot ${stage} failure rolls back migration data and keeps recovery required`, async (t) => {
    const { file } = await temporary(t);
    const failure = new Error(`snapshot ${stage} failed`);
    const snapshot = {
      read: (db) => {
        if (stage === 'read') throw failure;
        return readRelationalStore(db);
      },
      write: (db, data) => {
        writeRelationalStore(db, data);
        if (stage === 'write') throw failure;
      },
    };
    await assert.rejects(migrateWithSnapshot(file, empty, { snapshot }), failure);
    assert.deepEqual(state(file), { version: target, dirty: 1 });
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'members'").get().count, 0);
    } finally { db.close(); }
    await assert.rejects(openRepository(file, empty), /dirty/i);
  });
}
