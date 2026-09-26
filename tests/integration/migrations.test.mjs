import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { migrateDatabase } from '../../backend/src/storage/migrations.ts';
import { createBackup, readBackupFile } from '../../backend/src/storage/backup.ts';
import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';
import { openStore } from '../../backend/src/storage/store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const initName = '1790294400_init.sql';
const init = resolve(`schema/migrations/${initName}`);
const baseNames = (await readdir(resolve('schema/migrations'))).filter((name) => name.endsWith('.sql')).sort();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const history = (file) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all(); }
  finally { db.close(); }
};
const manifest = async (directory, names) => {
  const migrations = [];
  for (const name of names) migrations.push({ version: Number(name.slice(0, 10)), name, checksum: hash(await readFile(join(directory, name))) });
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({ targetVersion: migrations.at(-1).version, migrations }));
};
const copyBase = async (directory) => {
  await mkdir(directory);
  for (const name of baseNames) await cp(resolve('schema/migrations', name), join(directory, name));
  await manifest(directory, baseNames);
};

test('first start creates the SQLite schema and repeats without another migration', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-new-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, empty);
  assert.deepEqual(store.read(), empty);
  assert.deepEqual(history(file).map(({ version, name }) => ({ version, name })), baseNames.map((name) => ({ version: Number(name.slice(0, 10)), name })));
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x47434f55);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  } finally { db.close(); }
  const before = history(file);
  assert.deepEqual((await openStore(file, empty)).read(), empty);
  assert.deepEqual(history(file), before);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.sqlite')).length, 1);
});

test('upgrades an existing finalized draft into an independent receipt and removes its snapshot', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-finalized-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, empty);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const when = '2026-09-25T00:00:00.000Z';
    db.prepare(`INSERT INTO semesters (id, position, name, name_key, semester_order,
      allocation_input_revision, created_at, updated_at) VALUES ('semester-1', 0, '새 학기', '새 학기', 1, 0, ?, ?)`)
      .run(when, when);
    db.prepare(`INSERT INTO allocation_drafts (id, position, semester_id, status, revision, mode,
      policy_id, policy_version, engine_version, random_seed, source_revision, input_fingerprint,
      created_at, updated_at, finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision)
      VALUES ('draft-1', 0, 'semester-1', 'FINALIZED', 1, 'AUTO', 'policy-1', '1', '1',
        'seed', 0, 'fingerprint', ?, ?, ?, ?, 0)`).run(when, when, when, when);
    db.prepare(`INSERT INTO allocation_finalizations (allocation_draft_id, idempotency_key, request_hash)
      VALUES ('draft-1', 'request-1', ?)`).run('a'.repeat(64));
    db.prepare(`INSERT INTO allocation_finalization_receipts (allocation_draft_id, receipt_id, created_count, finalized_at)
      VALUES ('draft-1', 'receipt-1', 0, ?)`).run(when);
    db.exec(`DROP TABLE finalization_receipt_enrollment_ids;
      DROP TABLE finalization_receipts;
      DELETE FROM schema_migrations WHERE version = 1790336872;`);
  } finally { db.close(); }

  await migrateDatabase(file, empty, { skipBackup: true });
  const upgraded = (await openStore(file, empty)).read();
  assert.deepEqual(upgraded.allocationDrafts, []);
  assert.deepEqual(upgraded.allocationDraftItems, []);
  assert.equal(upgraded.finalizationReceipts[0].receipt.draftId, 'draft-1');
  assert.equal(upgraded.finalizationReceipts[0].semesterId, 'semester-1');
  assert.equal(upgraded.finalizationReceipts[0].enrollmentReportDownloadedAt, '2026-09-25T00:00:00.000Z');
});

test('upgrades populated v0.1.0 data without losing applications, enrollments, or finalization retries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-v010-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const when = '2026-09-25T00:00:00.000Z';
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of [initName, '1790314390_restore_receipts.sql']) {
      const sql = await readFile(resolve('schema/migrations', name));
      db.exec(sql.toString('utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)')
        .run(Number(name.slice(0, 10)), name, hash(sql), when, '0.1.0');
    }
    db.exec("INSERT INTO store_meta VALUES (1, 'v010-epoch', 7)");
    db.prepare('INSERT INTO semesters VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('semester-1', 0, '가을 학기', '가을 학기', 1, 2, when, when);
    db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)')
      .run('member-1', 0, '시험 회원', '시험 회원', when, when);
    db.prepare('INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?)')
      .run('course-1', 0, '창세기', '창세기', when, when);
    db.prepare('INSERT INTO semester_courses VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('sc-1', 0, 'semester-1', 'course-1', 10, when, when);
    db.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('app-1', 0, 'semester-1', 'member-1', 1, 'NORMAL', 'ADMIN_CONFIRMED', null, 0, when, when);
    db.prepare('INSERT INTO application_choices VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('choice-1', 0, 'app-1', 'sc-1', 1, when, when);
    db.prepare('INSERT INTO allocation_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('draft-1', 0, 'semester-1', 'FINALIZED', 1, 'AUTO', 'policy-1', '1', '1', 'seed', 2, 'fingerprint', when, when, when);
    db.prepare('INSERT INTO allocation_snapshot_semesters VALUES (?, ?, ?, ?)')
      .run('draft-1', 'semester-1', '가을 학기', 1);
    db.prepare('INSERT INTO allocation_finalizations VALUES (?, ?, ?)')
      .run('draft-1', 'finalize-1', 'a'.repeat(64));
    db.prepare('INSERT INTO allocation_finalization_receipts VALUES (?, ?, ?, ?)')
      .run('draft-1', 'receipt-1', 1, when);
    db.prepare('INSERT INTO allocation_finalization_enrollment_ids VALUES (?, ?, ?)')
      .run('draft-1', 0, 'enrollment-1');
    db.prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('enrollment-1', 0, 'sc-1', 'member-1', 'draft-1', 'item-1', 0, when, when);
    db.prepare('INSERT INTO enrollment_acknowledgements VALUES (?, ?, ?, ?)')
      .run('enrollment-1', 'b'.repeat(64), '확인한 이력', when);
  } finally { db.close(); }

  const result = await migrateDatabase(file);
  assert.deepEqual(result.applied, baseNames.slice(2));
  assert.equal(history(result.backupFile).length, 2);
  const upgraded = await openStore(file, empty);
  const data = upgraded.read();
  assert.equal(data.meta.storeRevision, 7);
  assert.equal(data.applications[0].id, 'app-1');
  assert.equal(data.applicationChoices[0].semesterCourseId, 'sc-1');
  assert.deepEqual(data.enrollments, [{ id: 'enrollment-1', semesterCourseId: 'sc-1', memberId: 'member-1',
    revision: 0, createdAt: when, updatedAt: when,
    exceptionAcknowledgement: { warningDigest: 'b'.repeat(64), note: '확인한 이력', acknowledgedAt: when } }]);
  assert.deepEqual(data.allocationDrafts, []);
  assert.deepEqual(data.finalizationReceipts[0].receipt, { draftId: 'draft-1', receiptId: 'receipt-1',
    createdCount: 1, createdEnrollmentIds: ['enrollment-1'], finalizedAt: when });
  const backupBytes = await readFile(result.backupFile);
  const restored = await readBackupFile(result.backupFile, join(directory, 'restore'));
  assert.deepEqual(restored.enrollments, data.enrollments);
  assert.deepEqual(restored.finalizationReceipts, data.finalizationReceipts);
  assert.deepEqual(await readFile(result.backupFile), backupBytes);
  await upgraded.write({}, (candidate) => { candidate.members[0].name = '변경한 회원'; });
  const reopened = (await openStore(file, empty)).read();
  assert.equal(reopened.members[0].name, '변경한 회원');
  assert.deepEqual(reopened.enrollments, data.enrollments);
  assert.deepEqual(reopened.finalizationReceipts, data.finalizationReceipts);
});

test('skipped-release migrations run in order and retain a pre-upgrade SQLite backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationDirectory = join(directory, 'migrations');
  const file = join(directory, 'db.sqlite');
  await copyBase(migrationDirectory);
  await migrateDatabase(file, empty, { directory: migrationDirectory });
  const original = { ...structuredClone(empty), members: [{
    id: 'member-1', name: '이전 이름', nameKey: '이전 이름',
    createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
  }] };
  await new SQLiteAdapter(file).write(original, empty);
  const first = '1790380800_rename_member.sql';
  const second = '1790467200_add_index.sql';
  await writeFile(join(migrationDirectory, first), "UPDATE members SET name = '새 이름', name_key = '새 이름' WHERE id = 'member-1';\n");
  await writeFile(join(migrationDirectory, second), 'CREATE INDEX members_position_idx ON members(position);\n');
  await manifest(migrationDirectory, [...baseNames, first, second]);
  const result = await migrateDatabase(file, empty, { directory: migrationDirectory, backupDirectory: join(directory, 'update-backups') });
  assert.deepEqual(result.applied, [first, second]);
  assert.equal(history(file).length, baseNames.length + 2);
  assert.equal((await new SQLiteAdapter(file).read()).members[0].name, '새 이름');
  const backups = await readdir(join(directory, 'update-backups'));
  assert.equal(backups.filter((name) => name.endsWith('.sqlite')).length, 1);
  assert.equal(history(join(directory, 'update-backups', backups[0])).length, baseNames.length);
  assert.equal((await new SQLiteAdapter(join(directory, 'update-backups', backups[0])).read()).members[0].name, '이전 이름');
});

test('a later invalid SQL rolls back the whole batch and leaves the original usable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-rollback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationDirectory = join(directory, 'migrations');
  const file = join(directory, 'db.sqlite');
  await copyBase(migrationDirectory);
  await migrateDatabase(file, empty, { directory: migrationDirectory });
  const first = '1790380800_add_index.sql';
  const second = '1790467200_invalid.sql';
  await writeFile(join(migrationDirectory, first), 'CREATE INDEX members_position_idx ON members(position);\n');
  await writeFile(join(migrationDirectory, second), 'INSERT INTO missing_table VALUES (1);\n');
  await manifest(migrationDirectory, [...baseNames, first, second]);
  await assert.rejects(migrateDatabase(file, empty, { directory: migrationDirectory, backupDirectory: join(directory, 'update-backups') }), /missing_table/);
  assert.equal(history(file).length, baseNames.length);
  const db = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'members_position_idx'").get().count, 0); }
  finally { db.close(); }
  assert.deepEqual(await new SQLiteAdapter(file).read(), empty);
});

test('changed, missing, or newer migration history blocks startup without modifying data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, empty);
  const migrationDirectory = join(directory, 'migrations');
  await copyBase(migrationDirectory);
  await writeFile(join(migrationDirectory, initName), 'SELECT 1;\n');
  await assert.rejects(migrateDatabase(file, empty, { directory: migrationDirectory }), /checksum|manifest/i);
  await rm(join(migrationDirectory, initName));
  await assert.rejects(migrateDatabase(file, empty, { directory: migrationDirectory }), /missing|manifest/i);
  const db = new DatabaseSync(file);
  try {
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)').run(
      1790467200, '1790467200_future.sql', 'a'.repeat(64), '2026-09-27T09:00:00.000Z', '9.0.0',
    );
  } finally { db.close(); }
  await assert.rejects(openStore(file, empty), /newer migration/);
  assert.equal(history(file).length, baseNames.length + 1);
});

test('an old SQLite backup is upgraded on a temporary copy for restore review', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-old-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const source = { ...structuredClone(empty), members: [{
    id: 'member-1', name: '백업 이름', nameKey: '백업 이름',
    createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z',
  }] };
  await openStore(file, source);
  const backup = await createBackup(file, join(directory, 'backups'), {
    id: 'before-update', now: new Date('2026-09-25T01:00:00.000Z'),
  });
  const originalBytes = await readFile(backup.file);
  const migrationDirectory = join(directory, 'migrations');
  await copyBase(migrationDirectory);
  const update = '1790380800_update_name.sql';
  await writeFile(join(migrationDirectory, update), "UPDATE members SET name = '새 이름' WHERE id = 'member-1';\n");
  await manifest(migrationDirectory, [...baseNames, update]);
  const candidate = await readBackupFile(backup.file, join(directory, 'recovery-work'), migrationDirectory);
  assert.equal(candidate.members[0].name, '새 이름');
  assert.equal(candidate.meta.storeEpoch, source.meta.storeEpoch);
  assert.deepEqual(await readFile(backup.file), originalBytes);
  assert.equal((await readdir(join(directory, 'recovery-work'))).length, 0);
});

test('refuses a migration that controls the transaction before touching the database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationDirectory = join(directory, 'migrations');
  await copyBase(migrationDirectory);
  const unsafe = '1790380800_unsafe.sql';
  await writeFile(join(migrationDirectory, unsafe), 'COMMIT; CREATE TABLE partial_change (id INTEGER);\n');
  await manifest(migrationDirectory, [...baseNames, unsafe]);
  const file = join(directory, 'db.sqlite');
  await assert.rejects(migrateDatabase(file, empty, { directory: migrationDirectory }), /transaction|unsafe/i);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('upgrades a database and backup from before restore receipts without losing members', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-receipt-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const initialSql = await readFile(init);
  const db = new DatabaseSync(file);
  try {
    db.exec(initialSql.toString('utf8'));
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)').run(
      1790294400, initName, hash(initialSql), '2026-09-25T00:00:00.000Z', '0.1.0',
    );
    db.exec("INSERT INTO store_meta VALUES (1, 'before-receipts', 7)");
    db.exec("INSERT INTO members VALUES ('member', 0, '회원', '회원', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')");
  } finally { db.close(); }
  const result = await migrateDatabase(file);
  assert.deepEqual(result.applied, baseNames.slice(1));
  const upgraded = await openStore(file, empty);
  assert.equal(upgraded.read().members[0].name, '회원');
  assert.equal(upgraded.read().meta.storeRevision, 7);
  assert.notEqual(upgraded.read().meta.storeEpoch, 'before-receipts');
  assert.deepEqual(upgraded.read().restoreReceipts, []);
  assert.equal(history(result.backupFile).length, 1);
  const before = await readFile(result.backupFile);
  const candidate = await readBackupFile(result.backupFile, join(directory, 'recovery-work'));
  assert.equal(candidate.members[0].name, '회원');
  assert.equal(candidate.meta.storeEpoch, 'before-receipts');
  assert.deepEqual(candidate.restoreReceipts, []);
  assert.deepEqual(await readFile(result.backupFile), before);
});
