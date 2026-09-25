import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openStore } from '../../backend/src/storage/store.ts';

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

test('restarts with the complete old or new store after the writer process is terminated', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-crash-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const journalFile = `${dataFile}-journal`;
  await openStore(dataFile, emptyStore());
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
  assert.ok([0, 200000].includes(data.members.length));
  assert.equal(data.meta.storeRevision, data.members.length === 0 ? 0 : 1);
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
