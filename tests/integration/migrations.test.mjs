import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { migrateDatabase } from '../../backend/src/storage/migrations.ts';
import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';
import { openStore } from '../../backend/src/storage/store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const initName = '1790294400_init.sql';
const init = resolve(`schema/migrations/${initName}`);
const baseNames = (await readdir(resolve('schema/migrations'))).filter((name) => name.endsWith('.sql')).sort();
const nextVersion = Number(baseNames.at(-1).slice(0, 10)) + 86_400;
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

test('adds blank affiliations to populated records while retaining existing draft snapshots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-affiliation-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const when = '2026-10-04T00:00:00.000Z';
  const legacyNames = baseNames.filter((name) => Number(name.slice(0, 10)) < 1791072000);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const name of legacyNames) {
      const sql = await readFile(resolve('schema/migrations', name));
      db.exec(sql.toString('utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)')
        .run(Number(name.slice(0, 10)), name, hash(sql), when, '0.2.1');
    }
    db.exec("INSERT INTO store_meta VALUES (1, 'legacy-epoch', 9)");
    db.prepare('INSERT INTO semesters VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('semester', 0, 'Fall', 'Fall', 1, 0, when, when);
    db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)')
      .run('member', 0, 'Alice', 'Alice', when, when);
    db.prepare('INSERT INTO courses VALUES (?, ?, ?, ?, ?, ?)')
      .run('course', 0, 'Art', 'Art', when, when);
    db.prepare('INSERT INTO semester_courses VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('sc', 0, 'semester', 'course', 3, when, when);
    db.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('application', 0, 'semester', 'member', 1, 'NORMAL', 'ADMIN_CONFIRMED', null, 0, when, when);
    db.prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('enrollment', 0, 'sc', 'member', 0, when, when);
    db.prepare('INSERT INTO allocation_drafts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('draft', 0, 'semester', 'DRAFT', 0, 'AUTO', 'policy', '1', '1.0.0', 'seed', 0, 'legacy-fingerprint', when, when, null, null, null);
    db.prepare('INSERT INTO allocation_draft_policy_settings VALUES (?, ?, ?)')
      .run('draft', 'NEW_FIRST', 'MAX_CARDINALITY_PRIORITIZED');
    db.prepare('INSERT INTO allocation_snapshot_semesters VALUES (?, ?, ?, ?)')
      .run('draft', 'semester', 'Fall at generation', 1);
    db.prepare('INSERT INTO allocation_snapshot_applications VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('draft', 0, 'application', 'member', 'Alice at generation', 1, 'NORMAL');
    db.prepare('INSERT INTO allocation_snapshot_existing_enrollments VALUES (?, ?, ?, ?, ?, ?)')
      .run('draft', 0, 'enrollment', 'member', 'Alice at generation', 'sc');
    db.prepare('INSERT INTO allocation_draft_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('item', 0, 'draft', 'member', 'application', 'Alice at generation', null, 'NOT_EVALUATED', 'MANUAL_ONLY', null, 'REJECTED', null, when);
  } finally { db.close(); }

  const result = await migrateDatabase(file);
  assert.deepEqual(result.applied, baseNames.filter((name) => !legacyNames.includes(name)));
  const store = await openStore(file, empty);
  const upgraded = store.read();
  for (const records of [upgraded.applications, upgraded.enrollments, upgraded.allocationDraftItems,
    upgraded.allocationDrafts[0].inputSnapshot.applications, upgraded.allocationDrafts[0].inputSnapshot.existingEnrollments]) {
    assert.equal(records.length, 1);
    assert.equal(records[0].affiliation, null);
  }
  assert.equal(upgraded.meta.storeRevision, 9);
  assert.equal(upgraded.allocationDrafts[0].inputFingerprint, 'legacy-fingerprint');
  assert.equal(upgraded.allocationDrafts[0].inputSnapshot.semester.name, 'Fall at generation');
  assert.equal(upgraded.allocationDraftItems[0].memberNameAtGeneration, 'Alice at generation');
  const after = new DatabaseSync(file, { readOnly: true });
  try { assert.equal(after.prepare('PRAGMA table_info(members)').all().some(({ name }) => name === 'affiliation'), false); }
  finally { after.close(); }
  await store.write({}, (data) => { data.applications[0].affiliation = 'New school'; });
  assert.equal((await openStore(file, empty)).read().applications[0].affiliation, 'New school');
});

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
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    const when = '2026-09-25T00:00:00.000Z';
    for (const name of baseNames.filter((name) => Number(name.slice(0, 10)) < 1790336872)) {
      const sql = await readFile(resolve('schema/migrations', name));
      db.exec(sql.toString('utf8'));
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?, ?, ?)')
        .run(Number(name.slice(0, 10)), name, hash(sql), when, '0.1.0');
    }
    db.exec("INSERT INTO store_meta VALUES (1, 'legacy-epoch', 0)");
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
    affiliation: null, revision: 0, createdAt: when, updatedAt: when,
    exceptionAcknowledgement: { warningDigest: 'b'.repeat(64), note: '확인한 이력', acknowledgedAt: when } }]);
  assert.deepEqual(data.allocationDrafts, []);
  assert.deepEqual(data.finalizationReceipts[0].receipt, { draftId: 'draft-1', receiptId: 'receipt-1',
    createdCount: 1, createdEnrollmentIds: ['enrollment-1'], finalizedAt: when });
  const backupBytes = await readFile(result.backupFile);
  const copy = join(directory, 'update-copy.sqlite');
  await cp(result.backupFile, copy);
  const restored = (await openStore(copy, empty)).read();
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
  const first = `${nextVersion}_rename_member.sql`;
  const second = `${nextVersion + 86_400}_add_index.sql`;
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
  const first = `${nextVersion}_add_index.sql`;
  const second = `${nextVersion + 86_400}_invalid.sql`;
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
      nextVersion, `${nextVersion}_future.sql`, 'a'.repeat(64), '2026-09-27T09:00:00.000Z', '9.0.0',
    );
  } finally { db.close(); }
  await assert.rejects(openStore(file, empty), /newer migration/);
  assert.equal(history(file).length, baseNames.length + 1);
});

test('refuses a migration that controls the transaction before touching the database', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const migrationDirectory = join(directory, 'migrations');
  await copyBase(migrationDirectory);
  const unsafe = `${nextVersion}_unsafe.sql`;
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
  const copy = join(directory, 'update-copy.sqlite');
  await cp(result.backupFile, copy);
  const candidate = (await openStore(copy, empty)).read();
  assert.equal(candidate.members[0].name, '회원');
  assert.notEqual(candidate.meta.storeEpoch, 'before-receipts');
  assert.deepEqual(candidate.restoreReceipts, []);
  assert.deepEqual(await readFile(result.backupFile), before);
});
