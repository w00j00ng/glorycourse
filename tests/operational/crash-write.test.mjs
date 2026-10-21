import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openStore } from '../../backend/src/storage/store.ts';
import { migrateDatabase } from '../../backend/src/storage/migrations.ts';

const emptyStore = () => ({
  meta: { storeEpoch: 'epoch-before-write', storeRevision: 0 },
  semesters: [],
  members: [],
  courses: [],
  semesterCourses: [],
  applications: [],
  applicationChoices: [],
  enrollments: [],
  allocationDrafts: [],
  allocationDraftItems: [],
  importBatches: [],
  finalizationReceipts: [],
  restoreReceipts: [],
});

test('restarts with the complete old or new store after an incremental writer is terminated', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const journalFile = `${dataFile}-journal`;
  const initial = emptyStore();
  initial.members.push({
    id: 'original-member', name: '기존 회원', nameKey: '기존 회원',
    createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
  });
  await openStore(dataFile, initial);
  const child = spawn(process.execPath, [
    '--experimental-strip-types', '--disable-warning=ExperimentalWarning',
    fileURLToPath(new URL('./write-large-store.mjs', import.meta.url)),
    dataFile,
    '200000',
  ], { stdio: 'ignore' });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');

  let interrupted = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await access(journalFile);
      interrupted = child.kill('SIGKILL');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  if (child.exitCode === null) await exited;
  assert.equal(interrupted, true, 'writer did not expose an interruptible SQLite transaction');

  const reopened = await openStore(dataFile, emptyStore());
  const data = reopened.read();
  assert.ok([1, 200000].includes(data.members.length));
  if (data.members.length === 1) {
    assert.deepEqual(data, initial);
  } else {
    assert.deepEqual(data, {
      ...emptyStore(), meta: { storeEpoch: 'epoch-after-write', storeRevision: 1 }, members: data.members,
    });
    data.members.forEach((member, index) => assert.deepEqual(member, {
      id: `member-${index}`, name: `회원 ${index}`, nameKey: `회원 ${index}`,
      createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
    }));
  }
});

test('rolls back spilled uncommitted pages when restarting after a crash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-hot-journal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, emptyStore());
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size = 5; PRAGMA cache_spill = ON; BEGIN IMMEDIATE');
    db.exec('UPDATE store_meta SET store_revision = 1 WHERE id = 1');
    const insert = db.prepare('INSERT INTO members VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 10000; i++) insert.run(String(i), i, 'member' + i, 'member' + i,
      '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z');
    process.send('spilled');
    setInterval(() => {}, 1000);
  `, file], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      exited.then(() => { throw new Error('Writer exited before spilling its transaction'); }),
    ]);
    assert.equal(message, 'spilled');
    assert.ok((await stat(`${file}-journal`)).size > 512);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  assert.deepEqual((await openStore(file, emptyStore())).read(), emptyStore());
});

test('a terminated migration rolls back its DDL and keeps the committed dirty marker', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-migration-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, emptyStore());
  const migrations = join(directory, 'migrations');
  await cp(new URL('../../schema/migrations/', import.meta.url), migrations, { recursive: true });
  const manifest = JSON.parse(await readFile(join(migrations, 'manifest.json'), 'utf8'));
  const version = manifest.targetVersion + 86_400;
  const name = `${version}_crash.up.sql`;
  const downName = `${version}_crash.down.sql`;
  const up = "CREATE TABLE migration_crash_probe (value TEXT);\nWITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM rows WHERE n < 1000000) INSERT INTO migration_crash_probe SELECT printf('%0100d', n) FROM rows;\n";
  const down = 'DROP TABLE migration_crash_probe;\n';
  const hash = (sql) => createHash('sha256').update(sql).digest('hex');
  await writeFile(join(migrations, name), up);
  await writeFile(join(migrations, downName), down);
  await writeFile(join(migrations, 'manifest.json'), JSON.stringify({ targetVersion: version,
    migrations: [...manifest.migrations, { version, name, checksum: hash(up), down: { name: downName, checksum: hash(down) } }] }));
  const module = new URL('../../backend/src/storage/migrations.ts', import.meta.url).href;
  const child = spawn(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `
    import { migrateDatabase } from ${JSON.stringify(module)};
    await migrateDatabase(process.argv[1], undefined, { directory: process.argv[2], onProgress: (message) => {
      if (message.endsWith(process.argv[3])) process.send('ddl-start');
    } });
  `, file, migrations, name], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [message] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(15_000) }),
      exited.then(() => { throw new Error('Migration exited before its interruptible DDL'); }),
    ]);
    assert.equal(message, 'ddl-start');
    const deadline = Date.now() + 5_000;
    let interrupted = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        if ((await stat(`${file}-journal`)).size > 512) { interrupted = child.kill('SIGKILL'); break; }
      } catch { /* Wait for the DDL journal after the already committed state marker. */ }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(interrupted, true, 'Migration DDL did not expose an interruptible journal');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
  }
  await assert.rejects(migrateDatabase(file, undefined, { directory: migrations }), /dirty/i);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare('SELECT version, dirty FROM schema_migrations').get() }, { version, dirty: 1 });
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'migration_crash_probe'").get().count, 0);
    assert.equal(db.prepare('SELECT store_revision FROM store_meta').get().store_revision, 0);
  } finally { db.close(); }
});
