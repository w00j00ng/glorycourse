import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSqliteSnapshot } from '../../backend/src/storage/sqlite-snapshot.ts';
import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';
import { openStore } from '../../backend/src/storage/store.ts';
import { InstanceAlreadyRunningError, acquireInstanceLock } from '../../backend/src/storage/instance-lock.ts';

const emptyStore = (epoch = 'epoch-1', revision = 0) => ({
  meta: { storeEpoch: epoch, storeRevision: revision },
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
const writeStore = async (file, data) => {
  await openStore(file, emptyStore());
  await new SQLiteAdapter(file).write(data, emptyStore());
};

test('allows only one live instance lock for a data directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await acquireInstanceLock(directory);
  t.after(() => first.release());

  await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
  await first.release();
  const second = await acquireInstanceLock(directory);
  await second.release();
});

test('creates a byte-verifiable update snapshot of a valid store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  await writeStore(dataFile, emptyStore());

  const backup = await createSqliteSnapshot(dataFile, join(directory, 'update-backups'), 'before-update');

  const bytes = await readFile(backup.file);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual(await new SQLiteAdapter(backup.file).read(), await new SQLiteAdapter(dataFile).read());
  assert.equal(backup.digest, createHash('sha256').update(bytes).digest('hex'));
});

test('does not change current data when the backup destination cannot be created', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-backup-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const invalidBackupDirectory = join(directory, 'not-a-directory');
  const current = JSON.stringify(emptyStore('current-epoch', 4));
  await writeStore(dataFile, JSON.parse(current));
  await writeFile(invalidBackupDirectory, 'occupied');

  await assert.rejects(createSqliteSnapshot(dataFile, invalidBackupDirectory, 'before-update'));

  assert.equal(JSON.stringify(await new SQLiteAdapter(dataFile).read()), current);
});

test('reopens a valid store with its persisted receipt unchanged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-restart-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const data = emptyStore('epoch-1', 7);
  data.importBatches.push({
    id: 'batch-1',
    kind: 'APPLICATIONS',
    templateVersion: '1',
    fileHash: 'hash',
    importedAt: '2026-09-22T00:00:00.000Z',
    status: 'APPLIED',
    rawRows: [],
    resolutions: [],
    receipt: {
      receiptId: 'receipt-1',
      importBatchId: 'batch-1',
      previewId: 'preview-1',
      storeEpoch: 'epoch-1',
      idempotencyKey: 'request-1',
      requestHash: 'a'.repeat(64),
      inserted: 1,
      updated: 0,
      skipped: 0,
      committedAt: '2026-09-22T00:00:00.000Z',
    },
  });
  await writeStore(dataFile, data);

  const reopened = await openStore(dataFile, emptyStore());

  assert.deepEqual(reopened.read().importBatches[0].receipt, data.importBatches[0].receipt);
  assert.equal(reopened.read().meta.storeRevision, 7);
});
