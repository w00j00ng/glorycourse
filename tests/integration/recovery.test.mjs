import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSqliteSnapshot } from '../../backend/src/storage/sqlite-snapshot.ts';
import { openRepository } from '../../backend/src/bootstrap/database.ts';
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
  const repository = await openRepository(file, data);
  repository.close();
};

const lockProcess = (t, directory, mode = 'instance') => {
  const child = fork(new URL('../fixtures/instance-lock-process.mjs', import.meta.url), [directory, mode], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const result = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Lock process exited ${code}: ${stderr}`)));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  return { child, result, exited };
};

test('a separate SQLite guard rejects contenders and recovers after its process is killed', { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-sqlite-guard-'));
  try {
    const dataFile = join(directory, 'db.sqlite');
    const data = emptyStore('retained-epoch', 8);
    data.members.push({
      id: 'member-1', name: '보존 회원', nameKey: '보존 회원',
      createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    });
    await writeStore(dataFile, data);
    const before = await readFile(dataFile);

    const owner = lockProcess(t, directory, 'sqlite');
    assert.equal((await owner.result).status, 'acquired');
    const contender = lockProcess(t, directory, 'sqlite');
    const rejected = await contender.result;
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.errcode & 0xff, 5);
    await contender.exited;

    owner.child.kill('SIGKILL');
    await owner.exited;
    const replacement = lockProcess(t, directory, 'sqlite');
    const acquired = await replacement.result;
    assert.equal(acquired.status, 'acquired');
    t.diagnostic(`Separate-process SQLite guard verified on ${acquired.nodeVersion}`);
    replacement.child.send('release');
    await replacement.exited;
    assert.deepEqual(await readFile(dataFile), before);
    const repository = await openRepository(dataFile, emptyStore());
    try { assert.deepEqual(repository.snapshot(), data); }
    finally { repository.close(); }
  } finally {
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
});

test('concurrent stale-lock recovery leaves exactly one owner even when both callers read the old owner', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-stale-race-'));
  const file = join(directory, '.glorycourse.lock');
  try {
    const dead = lockProcess(t, directory, 'sqlite');
    const { pid } = await dead.result;
    dead.child.kill('SIGKILL');
    await dead.exited;
    await writeFile(file, JSON.stringify({ pid, token: 'stale-owner' }));

    const peerReadOrFinished = Promise.withResolvers();
    const firstFinished = Promise.withResolvers();
    const originalReadFile = fs.readFile;
    const owners = [];
    let reads = 0;
    fs.readFile = async (...args) => {
      const contents = await originalReadFile(...args);
      if (args[0] === file && String(contents).includes('stale-owner')) {
        reads++;
        if (reads === 1) await peerReadOrFinished.promise;
        else { peerReadOrFinished.resolve(); await firstFinished.promise; }
      }
      return contents;
    };
    syncBuiltinESMExports();
    const acquire = () => acquireInstanceLock(directory).then((lock) => {
      owners.push(lock);
      return lock;
    }).finally(() => {
      firstFinished.resolve();
      peerReadOrFinished.resolve();
    });
    try {
      const results = await Promise.allSettled([acquire(), acquire()]);
      t.diagnostic(`Successful stale-lock owners: ${owners.length}; expected: 1`);
      assert.equal(owners.length, 1);
      assert.equal(results.filter(({ status, reason }) => status === 'rejected' && reason instanceof InstanceAlreadyRunningError).length, 1);
      const metadata = JSON.parse(await originalReadFile(file, 'utf8'));
      assert.equal(metadata.pid, process.pid);
      assert.notEqual(metadata.token, 'stale-owner');
      await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
    } finally {
      peerReadOrFinished.resolve();
      firstFinished.resolve();
      fs.readFile = originalReadFile;
      syncBuiltinESMExports();
      for (const lock of owners) await lock.release();
    }
  } finally {
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
});

test('allows only one live instance lock for a data directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await acquireInstanceLock(directory);
  t.after(() => first.release());

  await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
  await first.release();
  const second = await acquireInstanceLock(directory);
  const metadata = await readFile(join(directory, '.glorycourse.lock'), 'utf8');
  await first.release();
  assert.equal(await readFile(join(directory, '.glorycourse.lock'), 'utf8'), metadata);
  await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
  await second.release();
  await readFile(join(directory, '.glorycourse.instance.sqlite'));
});

const legacyOwners = [
  { name: 'live legacy owner', metadata: JSON.stringify({ pid: process.pid, token: 'legacy' }) },
  { name: 'unknown owner', metadata: JSON.stringify({ pid: process.pid, token: 'legacy' }), killCode: 'EPERM' },
  { name: 'blank initialization', metadata: '' },
  { name: 'invalid JSON', metadata: '{' },
  { name: 'null owner', metadata: 'null' },
  { name: 'invalid PID', metadata: JSON.stringify({ pid: 0, token: 'legacy' }) },
  { name: 'missing token', metadata: JSON.stringify({ pid: 2147483647 }) },
  { name: 'blank token', metadata: JSON.stringify({ pid: 2147483647, token: '' }) },
];
for (const input of legacyOwners) {
  test(`refuses ${input.name} without changing its metadata`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-legacy-owner-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, '.glorycourse.lock');
    await writeFile(file, input.metadata);
    if (input.killCode) t.mock.method(process, 'kill', () => { throw Object.assign(new Error('Unknown owner'), { code: input.killCode }); });
    await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
    assert.equal(await readFile(file, 'utf8'), input.metadata);
  });
}

for (const stage of ['before write', 'partial write', 'after write']) {
  test(`failed JSON ${stage} closes its handle and permits a fresh acquisition`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-metadata-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const originalWriteFile = fs.writeFile;
    const failure = Object.assign(new Error('Metadata write failed'), { code: 'EIO' });
    let failedHandle;
    const mocked = t.mock.method(fs, 'writeFile', async (...args) => {
      if (typeof args[0] !== 'string') {
        failedHandle = args[0];
        if (stage === 'partial write') await originalWriteFile(args[0], String(args[1]).slice(0, 12), 'utf8');
        if (stage === 'after write') await originalWriteFile(...args);
        throw failure;
      }
      return originalWriteFile(...args);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(acquireInstanceLock(directory), (error) => error === failure); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(failedHandle.fd, -1);
    await assert.rejects(readFile(join(directory, '.glorycourse.lock')), { code: 'ENOENT' });
    const replacement = await acquireInstanceLock(directory);
    await replacement.release();
  });
}

test('failed metadata writing preserves a different owner and still frees its guard', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-replaced-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.glorycourse.lock');
  const metadata = JSON.stringify({ pid: process.pid, token: 'different-owner' });
  const failure = Object.assign(new Error('Metadata writing interrupted'), { code: 'EIO' });
  const originalWriteFile = fs.writeFile;
  const mocked = t.mock.method(fs, 'writeFile', async (handle) => {
    await originalWriteFile(handle, metadata, 'utf8');
    throw failure;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(acquireInstanceLock(directory), (error) => error === failure); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(await readFile(file, 'utf8'), metadata);
  await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
  await rm(file);
  const replacement = await acquireInstanceLock(directory);
  await replacement.release();
});

for (const input of [
  { name: 'different token', metadata: JSON.stringify({ pid: process.pid, token: 'different-owner' }) },
  { name: 'malformed metadata', metadata: '{', error: SyntaxError },
  { name: 'missing metadata' },
]) {
  test(`release frees its guard and preserves a ${input.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-release-cleanup-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, '.glorycourse.lock');
    const lock = await acquireInstanceLock(directory);
    if (input.metadata !== undefined) await writeFile(file, input.metadata);
    else await rm(file);
    if (input.error) await assert.rejects(lock.release(), input.error);
    else await lock.release();
    if (input.metadata !== undefined) assert.equal(await readFile(file, 'utf8'), input.metadata);
    await rm(file, { force: true });
    const replacement = await acquireInstanceLock(directory);
    await lock.release();
    await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
    await replacement.release();
  });
}

for (const operation of ['open', 'readFile']) {
  test(`preserves the JSON ${operation} permission error and frees the guard`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-metadata-permission-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, '.glorycourse.lock');
    if (operation === 'readFile') await writeFile(file, JSON.stringify({ pid: process.pid, token: 'legacy' }));
    const original = fs[operation];
    const failure = Object.assign(new Error('Metadata access denied'), { code: 'EACCES' });
    const mocked = t.mock.method(fs, operation, async (...args) => {
      if (args[0] === file) throw failure;
      return original(...args);
    });
    syncBuiltinESMExports();
    try { await assert.rejects(acquireInstanceLock(directory), (error) => error === failure); }
    finally { mocked.mock.restore(); syncBuiltinESMExports(); }
    await rm(file, { force: true });
    const replacement = await acquireInstanceLock(directory);
    await replacement.release();
  });
}

const invalidGuards = [
  { name: 'corrupt sidecar', prepare: (file) => writeFile(file, 'not a SQLite database'), errcode: 26 },
  { name: 'sidecar path occupied by a directory', prepare: (file) => mkdir(file), errcode: 14 },
];
for (const input of invalidGuards) {
  test(`preserves the SQLite cause for a ${input.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-guard-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = join(directory, '.glorycourse.instance.sqlite');
    await input.prepare(file);
    await assert.rejects(acquireInstanceLock(directory), (error) => (
      !(error instanceof InstanceAlreadyRunningError) && (error.errcode & 0xff) === input.errcode
    ));
    await assert.rejects(readFile(join(directory, '.glorycourse.lock')), { code: 'ENOENT' });
  });
}

test('recovers when the legacy owner removes metadata between exclusive create and inspection', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-owner-stopped-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, '.glorycourse.lock');
  await writeFile(file, JSON.stringify({ pid: process.pid, token: 'legacy' }));
  const originalReadFile = fs.readFile;
  const mocked = t.mock.method(fs, 'readFile', async (...args) => {
    if (args[0] === file) await rm(file, { force: true });
    return originalReadFile(...args);
  });
  syncBuiltinESMExports();
  let lock;
  try { lock = await acquireInstanceLock(directory); }
  finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  await lock.release();
});

test('a killed instance permits only one replacement process and preserves business records', { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-process-recovery-'));
  try {
    const dataFile = join(directory, 'db.sqlite');
    const data = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
    await writeStore(dataFile, data);
    const before = await readFile(dataFile);
    const owner = lockProcess(t, directory);
    assert.equal((await owner.result).status, 'acquired');
    const blocked = lockProcess(t, directory);
    assert.deepEqual(await blocked.result, { status: 'rejected', name: 'InstanceAlreadyRunningError' });
    await blocked.exited;
    owner.child.kill('SIGKILL');
    await owner.exited;

    const candidates = [lockProcess(t, directory), lockProcess(t, directory)];
    const outcomes = await Promise.all(candidates.map(({ result }) => result));
    assert.equal(outcomes.filter(({ status }) => status === 'acquired').length, 1);
    assert.equal(outcomes.filter(({ status, name }) => status === 'rejected' && name === 'InstanceAlreadyRunningError').length, 1);
    const winner = outcomes.findIndex(({ status }) => status === 'acquired');
    const metadata = JSON.parse(await readFile(join(directory, '.glorycourse.lock'), 'utf8'));
    assert.equal(metadata.pid, outcomes[winner].pid);
    await assert.rejects(acquireInstanceLock(directory), InstanceAlreadyRunningError);
    candidates[winner].child.send('release');
    await Promise.all(candidates.map(({ exited }) => exited));
    assert.deepEqual(await readFile(dataFile), before);
    const repository = await openRepository(dataFile, emptyStore());
    try { assert.deepEqual(repository.snapshot(), data); }
    finally { repository.close(); }
  } finally {
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
});

test('creates a byte-verifiable update snapshot of a valid store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  await writeStore(dataFile, emptyStore());

  const backup = await createSqliteSnapshot(dataFile, join(directory, 'update-backups'), 'before-update');

  const bytes = await readFile(backup.file);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.deepEqual((await openRepository(backup.file, emptyStore())).snapshot(), (await openRepository(dataFile, emptyStore())).snapshot());
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

  assert.equal(JSON.stringify((await openRepository(dataFile, emptyStore())).snapshot()), current);
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

  const reopened = await openRepository(dataFile, emptyStore());

  assert.deepEqual(reopened.snapshot().importBatches[0].receipt, data.importBatches[0].receipt);
  assert.equal(reopened.snapshot().meta.storeRevision, 7);
});
