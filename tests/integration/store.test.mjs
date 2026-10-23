import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openRepository } from '../../backend/src/bootstrap/database.ts';
import {
  StoreEpochConflictError,
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
  createdAt: '2026-09-22T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z',
});
const open = async (t, initial = emptyStore()) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const repository = await openRepository(file, initial);
  t.after(() => repository.close());
  return { repository, file };
};

test('snapshot edits remain local until an explicit restore commits them', async (t) => {
  const initial = emptyStore();
  initial.members.push(member('current'));
  const { repository } = await open(t, initial);
  const replacement = repository.snapshot();
  replacement.members[0].name = 'restored member';
  replacement.meta = { storeEpoch: 'restored', storeRevision: 7 };
  assert.deepEqual(repository.snapshot(), initial);

  await repository.restore(replacement, {
    expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => {},
  });
  assert.deepEqual(repository.snapshot(), replacement);
  assert.deepEqual(repository.version(), replacement.meta);
  replacement.members[0].name = 'caller edited the restored snapshot';
  assert.equal(repository.snapshot().members[0].name, 'restored member');
});

test('restoring one changed member keeps unrelated SQLite rows untouched', async (t) => {
  const initial = emptyStore();
  initial.members.push(member('changed'), member('untouched'));
  const { repository, file } = await open(t, initial);
  const replacement = repository.snapshot();
  replacement.meta.storeEpoch = 'restored';
  replacement.members[0].name = '수정된 회원';
  replacement.members[0].nameKey = '수정된 회원';

  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TRIGGER protect_untouched BEFORE DELETE ON members
      WHEN OLD.id = 'untouched' BEGIN SELECT RAISE(ABORT, 'unrelated member deleted'); END`);
  } finally { db.close(); }

  await repository.restore(replacement, {
    expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => {},
  });
  const reopened = await openRepository(file, emptyStore());
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot(), replacement);
  assert.equal(repository.snapshot().members[1].name, 'untouched');
});

test('invalid restore requests leave saved records intact and do not run the backup', async (t) => {
  const initial = emptyStore();
  initial.members.push(member('current'));
  const { repository, file } = await open(t, initial);
  for (const input of [
    { ...member('current'), name: '' },
    { ...member('current'), createdAt: 'not-a-timestamp' },
  ]) {
    const replacement = repository.snapshot();
    replacement.members = [input];
    let backedUp = false;
    await assert.rejects(async () => repository.restore(replacement, {
      expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => { backedUp = true; },
    }), StoreValidationError);
    assert.equal(backedUp, false);
    assert.deepEqual(repository.snapshot(), initial);
  }
  const reopened = await openRepository(file, emptyStore());
  t.after(() => reopened.close());
  assert.deepEqual(reopened.snapshot(), initial);
});

test('stale restore requests leave saved records intact and do not run the backup', async (t) => {
  const initial = emptyStore();
  initial.members.push(member('current'));
  const { repository } = await open(t, initial);
  const replacement = emptyStore();
  replacement.meta.storeEpoch = 'replacement';
  for (const { options, error } of [
    { options: { expectedRevision: 1, expectedEpoch: 'epoch-1' }, error: StoreRevisionConflictError },
    { options: { expectedRevision: 0, expectedEpoch: 'previous-epoch' }, error: StoreEpochConflictError },
  ]) {
    let backedUp = false;
    await assert.rejects(repository.restore(replacement, {
      ...options, backup: async () => { backedUp = true; },
    }), error);
    assert.equal(backedUp, false);
    assert.deepEqual(repository.snapshot(), initial);
  }
});

test('a rejected restore rolls back earlier changes and permits a subsequent restore', async (t) => {
  const initial = emptyStore();
  initial.members.push(member('current'));
  const { repository, file } = await open(t, initial);
  const replacement = repository.snapshot();
  replacement.meta.storeEpoch = 'restored';
  replacement.members[0].name = 'renamed';
  replacement.members.push(member('rejected'));
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TRIGGER reject_member BEFORE INSERT ON members WHEN NEW.id = 'rejected' BEGIN SELECT RAISE(ABORT, 'restore rejected'); END");
    let backedUp = false;
    await assert.rejects(repository.restore(replacement, {
      expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => { backedUp = true; },
    }), /restore rejected/);
    assert.equal(backedUp, true);
    assert.deepEqual(repository.snapshot(), initial);
    db.exec('DROP TRIGGER reject_member');
    await repository.restore(replacement, {
      expectedRevision: 0, expectedEpoch: 'epoch-1', backup: async () => {},
    });
    assert.deepEqual(repository.snapshot(), replacement);
  } finally { db.close(); }
});

test('does not replace a malformed existing file with an empty store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const malformed = '{ existing but broken';
  await writeFile(file, malformed);

  await assert.rejects(openRepository(file, emptyStore()));
  assert.equal(await readFile(file, 'utf8'), malformed);
});
