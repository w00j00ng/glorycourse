import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BackupConfirmationError,
  createBackup,
  listBackups,
  planBackupRetention,
  pruneBackups,
  restoreBackup,
} from '../../backend/src/storage/backup.ts';
import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';
import { openStore, Store } from '../../backend/src/storage/store.ts';
import { DatabaseSync } from 'node:sqlite';
import { RecoveryService, RecoveryIdempotencyConflictError } from '../../backend/src/services/recovery.ts';
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
  await new SQLiteAdapter(file).write(data);
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

test('creates a byte-verifiable backup of a valid store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  await writeStore(dataFile, emptyStore());

  const backup = await createBackup(dataFile, join(directory, 'backups'), {
    id: 'backup-1',
    now: new Date('2026-09-22T00:00:00.000Z'),
  });

  assert.equal(backup.id, 'backup-1');
  const bytes = await readFile(backup.file);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual(await new SQLiteAdapter(backup.file).read(), await new SQLiteAdapter(dataFile).read());
  assert.equal(backup.digest, createHash('sha256').update(bytes).digest('hex'));
});

test('lists a damaged backup separately without hiding a valid backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-backup-list-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const backupDirectory = join(directory, 'backups');
  await writeStore(dataFile, emptyStore());
  await createBackup(dataFile, backupDirectory, {
    id: 'valid', now: new Date('2026-09-22T00:00:00.000Z'),
  });
  await writeFile(join(backupDirectory, '2026-09-23T00-00-00.000Z-damaged.sqlite'), 'damaged');
  assert.deepEqual((await listBackups(backupDirectory)).map(({ id, status }) => ({ id, status })), [
    { id: 'damaged', status: 'INVALID' }, { id: 'valid', status: 'READY' },
  ]);
});

test('restores a validated backup after backing up current data and changes epoch', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  await writeStore(dataFile, emptyStore('old-epoch', 2));
  const oldBackup = await createBackup(dataFile, join(directory, 'old-backups'), {
    id: 'old', now: new Date('2026-09-21T00:00:00.000Z'),
  });
  const backupFile = oldBackup.file;
  const current = emptyStore('current-epoch', 4);
  current.restoreReceipts.push({
    idempotencyKey: 'prior-restore', requestHash: 'a'.repeat(64), receiptId: 'prior-receipt',
    previousBackupId: 'prior-backup', storeRevision: 3, storeEpoch: 'prior-epoch',
    restoredAt: '2026-09-21T00:00:00.000Z',
  });
  await new SQLiteAdapter(dataFile).write(current);

  const receipt = await restoreBackup({
    dataFile,
    backupFile,
    backupDirectory: join(directory, 'backups'),
    newEpoch: 'restored-epoch',
    now: new Date('2026-09-22T00:00:00.000Z'),
    backupId: 'before-restore',
  });
  const restored = await new SQLiteAdapter(dataFile).read();

  assert.equal(receipt.previousBackup.id, 'before-restore');
  assert.equal(restored.meta.storeEpoch, 'restored-epoch');
  assert.equal(restored.meta.storeRevision, 2);
  assert.deepEqual(restored.restoreReceipts, current.restoreReceipts);
  assert.equal((await new SQLiteAdapter(receipt.previousBackup.file).read()).meta.storeRevision, 4);
});

test('leaves current data untouched when a restore candidate is invalid', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-restore-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const backupFile = join(directory, 'restore.sqlite');
  const current = JSON.stringify(emptyStore('current-epoch', 4));
  await writeStore(dataFile, JSON.parse(current));
  await writeFile(backupFile, 'invalid SQLite file');

  await assert.rejects(restoreBackup({
    dataFile,
    backupFile,
    backupDirectory: join(directory, 'backups'),
    newEpoch: 'restored-epoch',
    now: new Date('2026-09-22T00:00:00.000Z'),
    backupId: 'before-restore',
  }));
  assert.equal(JSON.stringify(await new SQLiteAdapter(dataFile).read()), current);
});

test('plans backup retention, requires exact confirmation, and keeps the newest ten', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-retention-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const backupDirectory = join(directory, 'backups');
  await writeStore(dataFile, emptyStore());
  for (let index = 0; index < 12; index += 1) {
    await createBackup(dataFile, backupDirectory, {
      id: `backup-${index}`,
      now: new Date(Date.UTC(2026, 8, 1 + index)),
    });
  }

  const plan = await planBackupRetention(backupDirectory);

  assert.equal(plan.keep, 10);
  assert.deepEqual(plan.toDelete.map(({ createdAt }) => createdAt), [
    '2026-09-01T00:00:00.000Z',
    '2026-09-02T00:00:00.000Z',
  ]);
  await assert.rejects(pruneBackups(plan, []), BackupConfirmationError);
  assert.equal((await planBackupRetention(backupDirectory)).total, 12);
  await pruneBackups(plan, plan.toDelete.map(({ file }) => file));
  assert.equal((await planBackupRetention(backupDirectory)).total, 10);
});

test('does not change current data when the backup destination cannot be created', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-backup-fail-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const invalidBackupDirectory = join(directory, 'not-a-directory');
  const current = JSON.stringify(emptyStore('current-epoch', 4));
  await writeStore(dataFile, JSON.parse(current));
  await writeFile(invalidBackupDirectory, 'occupied');

  await assert.rejects(createBackup(dataFile, invalidBackupDirectory, {
    id: 'backup-1',
    now: new Date('2026-09-22T00:00:00.000Z'),
  }));

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

const restoreRequest = (preview, idempotencyKey) => ({
  idempotencyKey, preparedActionToken: preview.preparedActionToken,
  acknowledgedWarningDigest: preview.warningDigest, acknowledgementNote: '현재 자료 교체 확인',
});

test('replays restore receipts after restart, expiry, and a later restore of the same old backup', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-restore-replay-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  let now = new Date('2026-09-25T00:00:00.000Z');
  const dependencies = { dataFile, backupDirectory: join(directory, 'backups'), id: randomUUID, now: () => now };
  const store = await openStore(dataFile, emptyStore());
  const service = new RecoveryService(store, dependencies);
  const backup = await service.create();
  await store.write({}, (data) => { data.members.push({
    id: 'member', name: '회원', nameKey: '회원', createdAt: now.toISOString(), updatedAt: now.toISOString(),
  }); });
  const request = restoreRequest(await service.preview(backup.file), 'restore-first');
  const receipt = await service.restore(request);
  assert.deepEqual(store.read().members, []);
  now = new Date('2026-09-26T00:00:00.000Z');
  const reopened = await openStore(dataFile, emptyStore());
  const restarted = new RecoveryService(reopened, dependencies);
  const beforeReplay = reopened.read();
  assert.deepEqual(await restarted.restore(request), receipt);
  assert.deepEqual(reopened.read(), beforeReplay);
  await assert.rejects(restarted.restore({ ...request, acknowledgementNote: '다른 요청' }), RecoveryIdempotencyConflictError);
  const secondRequest = restoreRequest(await restarted.preview(backup.file), 'restore-second');
  const concurrent = await Promise.all([restarted.restore(secondRequest), restarted.restore(secondRequest)]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  const finalStore = await openStore(dataFile, emptyStore());
  const finalService = new RecoveryService(finalStore, dependencies);
  assert.deepEqual(await finalService.restore(request), receipt);
  assert.deepEqual(await finalService.restore(secondRequest), concurrent[0]);
  assert.equal(finalStore.read().restoreReceipts.length, 2);
  assert.equal((await finalService.list()).length, 3, 'replays must not create extra backups');
});

test('rolls back restored data when receipt insertion fails and can retry the same request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-restore-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const store = await openStore(dataFile, emptyStore());
  const service = new RecoveryService(store, {
    dataFile, backupDirectory: join(directory, 'backups'), id: randomUUID,
    now: () => new Date('2026-09-25T00:00:00.000Z'),
  });
  const backup = await service.create();
  await store.write({}, () => {});
  const before = store.read();
  const request = restoreRequest(await service.preview(backup.file), 'restore-failed');
  const db = new DatabaseSync(dataFile);
  try {
    db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON restore_receipts BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
    await assert.rejects(service.restore(request), /receipt rejected/);
    assert.deepEqual((await openStore(dataFile, emptyStore())).read(), before);
    assert.deepEqual(store.read(), before);
    db.exec('DROP TRIGGER reject_receipt');
  } finally { db.close(); }
  const receipt = await service.restore(request);
  assert.equal(store.read().meta.storeRevision, 0);
  assert.equal(store.read().restoreReceipts[0].receiptId, receipt.receiptId);
});

test('returns the durable restore receipt when the adapter loses its write response', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-restore-response-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  await openStore(dataFile, emptyStore());
  const adapter = new SQLiteAdapter(dataFile);
  const store = await Store.open({
    read: () => adapter.read(),
    write: async (data) => { await adapter.write(data); throw new Error('response lost'); },
  }, emptyStore());
  const dependencies = {
    dataFile, backupDirectory: join(directory, 'backups'), id: randomUUID,
    now: () => new Date('2026-09-25T00:00:00.000Z'),
  };
  const service = new RecoveryService(store, dependencies);
  const backup = await service.create();
  const request = restoreRequest(await service.preview(backup.file), 'restore-response');
  const receipt = await service.restore(request);
  const restarted = new RecoveryService(await openStore(dataFile, emptyStore()), dependencies);
  assert.deepEqual(await restarted.restore(request), receipt);
});
