import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { readDrafts, readImportBatches, writeDrafts } from '../../backend/src/repository/relational-store.ts';
import {
  StoreEpochConflictError,
  StoreRecoveryRequiredError,
  StoreRevisionConflictError,
  StoreValidationError,
} from '../../backend/src/domain/errors.ts';

const emptyStore = () => ({
  meta: { storeEpoch: 'epoch-1', storeRevision: 0 },
  semesters: [], members: [], courses: [], semesterCourses: [], applications: [],
  applicationChoices: [], enrollments: [], allocationDrafts: [], allocationDraftItems: [],
  importBatches: [], finalizationReceipts: [], restoreReceipts: [],
});
const member = (id) => ({
  id, name: id, nameKey: id,
  createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
});
const open = async (t, initial = emptyStore()) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-repository-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const repository = await openRepository(file, initial);
  t.after(() => repository.close());
  return { repository, file };
};

test('repository persists a requested member and reads another committed connection without a cache', async (t) => {
  const { repository, file } = await open(t);
  const request = member('requested-member');
  await repository.write({ expectedRevision: 0, expectedEpoch: 'epoch-1' }, (queries) => (
    queries.catalog.insertNamed({ kind: 'members', record: request })
  ));

  assert.deepEqual(repository.read((queries) => queries.catalog.listNamed({ kind: 'members' })), [request]);
  assert.deepEqual(repository.version(), { storeEpoch: 'epoch-1', storeRevision: 1 });

  const external = await openRepository(file, emptyStore());
  t.after(() => external.close());
  await external.write({}, (queries) => {
    queries.catalog.updateNamed({ kind: 'members', record: { ...request, name: 'renamed' } });
  });

  assert.equal(repository.read((queries) => queries.catalog.listNamed({ kind: 'members' }))[0].name, 'renamed');
  assert.equal(repository.version().storeRevision, 2);
});

test('repository serializes saves and rolls back all data when a requested operation fails', async (t) => {
  const { repository } = await open(t);
  const failed = new Error('requested operation failed');
  await assert.rejects(repository.write({}, (queries) => {
    queries.catalog.insertNamed({ kind: 'members', record: member('rolled-back') });
    throw failed;
  }), failed);
  assert.deepEqual(repository.snapshot(), emptyStore());

  await Promise.all(['first', 'second'].map((id) => repository.write({}, async (queries) => {
    await Promise.resolve();
    queries.catalog.insertNamed({ kind: 'members', record: member(id) });
  })));
  assert.deepEqual(repository.snapshot().members.map(({ id }) => id), ['first', 'second']);
  assert.equal(repository.version().storeRevision, 2);
});

test('repository reads the last committed version during an awaited save and returns detached records', async (t) => {
  const { repository } = await open(t);
  let resume;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const paused = new Promise((resolve) => { resume = resolve; });
  const requested = member('suspended-save');
  const saving = repository.write({}, async (queries) => {
    queries.catalog.insertNamed({ kind: 'members', record: requested });
    entered();
    await paused;
    return queries.catalog.getMember({ id: requested.id });
  });
  await ready;
  try {
    assert.deepEqual(repository.read((queries) => ({
      members: queries.catalog.listNamed({ kind: 'members' }), version: queries.metadata(),
    })), { members: [], version: { storeEpoch: 'epoch-1', storeRevision: 0 } });
  } finally { resume(); }
  const saved = await saving;
  assert.deepEqual(saved, requested);
  saved.name = 'caller changed the save result';
  const read = repository.read((queries) => queries.catalog.getMember({ id: requested.id }));
  read.name = 'caller changed the read result';
  assert.deepEqual(repository.read((queries) => queries.catalog.getMember({ id: requested.id })), requested);
  const snapshot = repository.snapshot();
  snapshot.members[0].name = 'caller changed a recovery snapshot';
  assert.deepEqual(repository.read((queries) => queries.catalog.getMember({ id: requested.id })), requested);
});

test('repository rolls back requested rows when the store revision cannot be incremented safely', async (t) => {
  const initial = emptyStore();
  initial.meta.storeRevision = Number.MAX_SAFE_INTEGER;
  const { repository } = await open(t, initial);

  await assert.rejects(repository.write({}, (queries) => (
    queries.catalog.insertNamed({ kind: 'members', record: member('overflowed-save') })
  )), /CHECK constraint failed/);
  assert.deepEqual(repository.snapshot(), initial);
});

test('repository read operations reject writes and leave committed data unchanged', async (t) => {
  const { repository } = await open(t);
  assert.throws(() => repository.read((queries) => (
    queries.catalog.insertNamed({ kind: 'members', record: member('read-operation') })
  )), /readonly|read-only/i);
  assert.deepEqual(repository.snapshot(), emptyStore());
});

test('repository rejects stale revisions and epochs without changing saved data', async (t) => {
  const { repository } = await open(t);
  await repository.write({}, (queries) => queries.catalog.insertNamed({ kind: 'members', record: member('saved') }));
  const before = repository.snapshot();
  for (const { options, error } of [
    { options: { expectedRevision: 0 }, error: StoreRevisionConflictError },
    { options: { expectedEpoch: 'older-epoch' }, error: StoreEpochConflictError },
  ]) {
    await assert.rejects(repository.write(options, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('stale') })
    )), error);
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('repository reconciles a lost commit response and returns the saved operation result', async (t) => {
  const { repository } = await open(t);
  const exec = DatabaseSync.prototype.exec;
  let fail = true;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && fail) {
      fail = false;
      throw new Error('commit response was lost');
    }
    return result;
  };
  let result;
  try {
    result = await repository.write({}, (queries) => {
      queries.catalog.insertNamed({ kind: 'members', record: member('saved') });
      return { receiptId: 'saved-receipt' };
    });
  } finally { DatabaseSync.prototype.exec = exec; }

  assert.deepEqual(result, { receiptId: 'saved-receipt' });
  assert.deepEqual(repository.snapshot().members, [member('saved')]);
  assert.equal(repository.version().storeRevision, 1);
});

test('repository blocks unreconciled saves until an explicit restore succeeds', async (t) => {
  const { repository } = await open(t);
  const exec = DatabaseSync.prototype.exec;
  let fail = true;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && fail) {
      fail = false;
      exec.call(this, 'UPDATE store_meta SET store_revision = store_revision + 100 WHERE id = 1');
      throw new Error('commit response was lost and data changed');
    }
    return result;
  };
  try {
    await assert.rejects(repository.write({}, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('uncertain') })
    )), StoreRecoveryRequiredError);
  } finally { DatabaseSync.prototype.exec = exec; }

  await assert.rejects(repository.write({}, () => 'later-save'), StoreRecoveryRequiredError);
  const before = repository.snapshot();
  const replacement = emptyStore();
  replacement.meta.storeEpoch = 'recovered-epoch';
  const backupError = new Error('recovery backup failed');
  await assert.rejects(repository.restore(replacement, {
    expectedRevision: before.meta.storeRevision, expectedEpoch: before.meta.storeEpoch,
    backup: async () => { throw backupError; },
  }), backupError);
  assert.deepEqual(repository.snapshot(), before);
  await assert.rejects(repository.write({}, () => 'save-after-failed-restore'), StoreRecoveryRequiredError);
  let backups = 0;
  await repository.restore(replacement, {
    expectedRevision: before.meta.storeRevision, expectedEpoch: before.meta.storeEpoch,
    backup: async () => { backups += 1; assert.deepEqual(repository.snapshot(), before); },
  });
  assert.equal(backups, 1);
  assert.deepEqual(repository.snapshot(), replacement);
  await repository.write({ expectedRevision: 0, expectedEpoch: 'recovered-epoch' }, (queries) => (
    queries.catalog.insertNamed({ kind: 'members', record: member('recovered-save') })
  ));
  assert.deepEqual(repository.snapshot().members, [member('recovered-save')]);
});

test('repository detects another writer after a lost commit response even when metadata is unchanged', async (t) => {
  const { repository, file } = await open(t);
  const exec = DatabaseSync.prototype.exec;
  let fail = true;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && fail) {
      fail = false;
      const external = new DatabaseSync(file);
      try { external.prepare('UPDATE members SET name = ? WHERE id = ?').run('externally changed', 'saved'); }
      finally { external.close(); }
      throw new Error('commit response was lost');
    }
    return result;
  };
  try {
    await assert.rejects(repository.write({}, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('saved') })
    )), StoreRecoveryRequiredError);
  } finally { DatabaseSync.prototype.exec = exec; }

  assert.deepEqual(repository.version(), { storeEpoch: 'epoch-1', storeRevision: 1 });
  await assert.rejects(repository.write({}, () => 'later-save'), StoreRecoveryRequiredError);
});

test('repository detects another writer between a lost commit response and the reconciliation read', async (t) => {
  const { repository, file } = await open(t);
  const exec = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  let lostResponse = false;
  let changed = false;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && !lostResponse) {
      lostResponse = true;
      throw new Error('commit response was lost');
    }
    return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    if (lostResponse && !changed && sql.includes('SELECT store_epoch')) {
      changed = true;
      const external = new DatabaseSync(file);
      try { external.prepare('UPDATE members SET name = ? WHERE id = ?').run('externally changed', 'saved'); }
      finally { external.close(); }
    }
    return prepare.call(this, sql);
  };
  try {
    await assert.rejects(repository.write({}, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('saved') })
    )), StoreRecoveryRequiredError);
  } finally {
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.prepare = prepare;
  }

  await assert.rejects(repository.write({}, () => 'later-save'), StoreRecoveryRequiredError);
});

test('repository keeps the original error and saved state when commit fails before persisting', async (t) => {
  const { repository } = await open(t);
  const exec = DatabaseSync.prototype.exec;
  const failure = new Error('commit did not persist');
  let fail = true;
  DatabaseSync.prototype.exec = function(sql) {
    if (sql === 'COMMIT' && fail) {
      fail = false;
      throw failure;
    }
    return exec.call(this, sql);
  };
  try {
    await assert.rejects(repository.write({}, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('not-saved') })
    )), failure);
  } finally { DatabaseSync.prototype.exec = exec; }

  assert.deepEqual(repository.snapshot(), emptyStore());
  await repository.write({}, (queries) => queries.catalog.insertNamed({ kind: 'members', record: member('next-save') }));
  assert.deepEqual(repository.snapshot().members, [member('next-save')]);
});

test('repository blocks later saves when the commit outcome cannot be read', async (t) => {
  const { repository } = await open(t);
  const exec = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  let unreadable = false;
  DatabaseSync.prototype.exec = function(sql) {
    const result = exec.call(this, sql);
    if (sql === 'COMMIT' && !unreadable) {
      unreadable = true;
      throw new Error('commit response was lost');
    }
    return result;
  };
  DatabaseSync.prototype.prepare = function(sql) {
    if (unreadable && sql.includes('SELECT store_epoch')) throw new Error('storage is unreadable');
    return prepare.call(this, sql);
  };
  try {
    await assert.rejects(repository.write({}, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('uncertain') })
    )), StoreRecoveryRequiredError);
  } finally {
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.prepare = prepare;
  }

  await assert.rejects(repository.write({}, () => 'later-save'), StoreRecoveryRequiredError);
});

test('repository restore validates and backs up before replacing the current state', async (t) => {
  const { repository } = await open(t);
  await repository.write({}, (queries) => queries.catalog.insertNamed({ kind: 'members', record: member('current') }));
  const before = repository.snapshot();
  const replacement = emptyStore();
  replacement.meta = { storeEpoch: 'restored-epoch', storeRevision: 7 };
  replacement.members.push(member('restored'));
  const backupError = new Error('backup destination is unavailable');
  await assert.rejects(repository.restore(replacement, {
    expectedRevision: 1, expectedEpoch: 'epoch-1', backup: async () => { throw backupError; },
  }), backupError);
  assert.deepEqual(repository.snapshot(), before);

  await repository.restore(replacement, {
    expectedRevision: 1, expectedEpoch: 'epoch-1',
    backup: async () => assert.deepEqual(repository.snapshot(), before),
  });
  assert.deepEqual(repository.snapshot(), replacement);
  await repository.write({ expectedRevision: 7, expectedEpoch: 'restored-epoch' }, () => 'saved');
  assert.deepEqual(repository.version(), { storeEpoch: 'restored-epoch', storeRevision: 8 });
});

for (const { stage, persisted } of [
  { stage: 'before', persisted: false },
  { stage: 'after', persisted: true },
]) {
  test(`repository reconciles a restore failure ${stage} COMMIT when metadata stays unchanged`, async (t) => {
    const initial = emptyStore();
    initial.members.push(member('current'));
    const { repository } = await open(t, initial);
    const replacement = emptyStore();
    replacement.members.push(member('restored'));
    const failure = new Error(`restore failed ${stage} COMMIT`);
    const exec = DatabaseSync.prototype.exec;
    let fail = true;
    DatabaseSync.prototype.exec = function(sql) {
      if (sql === 'COMMIT' && fail) {
        fail = false;
        if (persisted) exec.call(this, sql);
        throw failure;
      }
      return exec.call(this, sql);
    };
    try {
      const restoring = repository.restore(replacement, {
        expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => {},
      });
      if (persisted) await restoring;
      else await assert.rejects(restoring, failure);
    } finally { DatabaseSync.prototype.exec = exec; }

    assert.deepEqual(repository.snapshot(), persisted ? replacement : initial);
    await repository.write({ expectedRevision: 0, expectedEpoch: 'epoch-1' }, (queries) => (
      queries.catalog.insertNamed({ kind: 'members', record: member('next-save') })
    ));
    assert.deepEqual(repository.snapshot().members, [...(persisted ? replacement : initial).members, member('next-save')]);
  });
}

test('repository rejects invalid restore metadata before backing up or changing current records', async (t) => {
  const { repository } = await open(t);
  const before = repository.snapshot();
  for (const meta of [
    { storeEpoch: '', storeRevision: 0 },
    { storeEpoch: 'epoch-1', storeRevision: -1 },
    { storeEpoch: 'epoch-1', storeRevision: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const candidate = { ...emptyStore(), meta };
    let backedUp = false;
    await assert.rejects(async () => repository.restore(candidate, {
      expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => { backedUp = true; },
    }), StoreValidationError);
    assert.equal(backedUp, false);
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('draft and import queries return only the requested parent and its complete children', async (t) => {
  const initial = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
  const firstDraft = structuredClone(initial.allocationDrafts[0]);
  const firstItems = structuredClone(initial.allocationDraftItems);
  initial.allocationDrafts.push({ ...structuredClone(firstDraft), id: 'other-draft' });
  initial.allocationDraftItems.push(...firstItems.map((item) => ({
    ...structuredClone(item), id: `other-${item.id}`, draftId: 'other-draft',
  })));
  initial.importBatches = ['batch-1', 'batch-2'].map((id) => ({
    id, kind: 'APPLICATIONS', templateVersion: '1', fileHash: id,
    importedAt: '2026-10-21T00:00:00.000Z', status: 'STAGED',
    rawRows: [{ sheet: 'Applications', row: 2, cells: { name: id } }],
    resolutions: [], receipt: null,
  }));
  const { file } = await open(t, initial);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    for (const { id, expected } of [
      { id: firstDraft.id, expected: { drafts: [firstDraft], items: firstItems } },
      { id: 'missing-draft', expected: { drafts: [], items: [] } },
    ]) assert.deepEqual(readDrafts(db, id), expected);
    assert.equal(readDrafts(db).drafts.length, 2);
    for (const { id, expected } of [
      { id: 'batch-1', expected: [initial.importBatches[0]] },
      { id: 'missing-batch', expected: [] },
    ]) assert.deepEqual(readImportBatches(db, id), expected);
    assert.deepEqual(readImportBatches(db), initial.importBatches);
  } finally { db.close(); }
});

test('saving one scoped draft preserves its global positions and unrelated draft evidence', async (t) => {
  const initial = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
  initial.allocationDrafts.push({ ...structuredClone(initial.allocationDrafts[0]), id: 'other-draft' });
  initial.allocationDraftItems.push(...initial.allocationDraftItems.map((item) => ({
    ...structuredClone(item), id: `other-${item.id}`, draftId: 'other-draft',
  })));
  const { repository, file } = await open(t, initial);
  const db = new DatabaseSync(file);
  try {
    const before = readDrafts(db, 'other-draft');
    const requested = { ...before.drafts[0], revision: before.drafts[0].revision + 1 };
    const items = before.items.map((item) => ({ ...item, ministry: 'updated ministry' }));
    const positions = {
      draftPositions: new Map(db.prepare('SELECT id, position FROM allocation_drafts WHERE id = ?').all('other-draft')
        .map(({ id, position }) => [id, position])),
      itemPositions: new Map(db.prepare('SELECT id, position FROM allocation_draft_items WHERE allocation_draft_id = ?').all('other-draft')
        .map(({ id, position }) => [id, position])),
    };
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys = ON');
    writeDrafts(db, [requested], items, {
      allocationDrafts: before.drafts, allocationDraftItems: before.items,
    }, positions);
    db.exec('COMMIT');

    const expected = structuredClone(initial);
    expected.allocationDrafts[1] = requested;
    expected.allocationDraftItems = expected.allocationDraftItems.map((item) => (
      item.draftId === 'other-draft' ? items.find(({ id }) => id === item.id) : item
    ));
    assert.deepEqual(repository.snapshot(), expected);
  } finally { db.close(); }
});
