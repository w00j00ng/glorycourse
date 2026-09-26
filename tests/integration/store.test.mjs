import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';

import {
  Store,
  StoreRecoveryRequiredError,
  StoreRevisionConflictError,
  StoreValidationError,
  openStore,
} from '../../backend/src/storage/store.ts';

const emptyStore = () => ({
  meta: { storeEpoch: 'epoch-1', storeRevision: 0 },
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

const member = (id) => ({
  id,
  name: id,
  nameKey: id,
  createdAt: '2026-09-22T00:00:00.000Z',
  updatedAt: '2026-09-22T00:00:00.000Z',
});

test('serializes concurrent commands and persists both changes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, emptyStore());

  await Promise.all([
    store.write({}, (candidate) => candidate.members.push(member('member-a'))),
    store.write({}, (candidate) => candidate.members.push(member('member-b'))),
  ]);

  assert.deepEqual(store.read().members.map(({ id }) => id), ['member-a', 'member-b']);
  assert.equal(store.read().meta.storeRevision, 2);
  assert.deepEqual(await new SQLiteAdapter(file).read(), store.read());
});

test('rejects stale revisions without changing committed state', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  await store.write({ expectedRevision: 0 }, (candidate) => candidate.members.push(member('member-a')));

  await assert.rejects(
    store.write({ expectedRevision: 0 }, (candidate) => candidate.members.push(member('member-b'))),
    StoreRevisionConflictError,
  );
  assert.deepEqual(store.read().members.map(({ id }) => id), ['member-a']);
});

test('rejects an invalid candidate before writing it', async () => {
  const adapter = new MemoryAdapter(emptyStore());
  const store = await Store.open(adapter, emptyStore());

  await assert.rejects(store.write({}, (candidate) => {
    candidate.semesterCourses.push({
      id: 'offering-1',
      semesterId: 'semester-1',
      courseId: 'course-1',
      capacity: -1,
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    });
  }), StoreValidationError);

  assert.equal(adapter.writeCount, 0);
  assert.deepEqual(store.read(), emptyStore());
});

test('editing one member preserves unrelated rows and returns a usable result', async () => {
  const initial = emptyStore();
  initial.members.push(member('member-a'), member('member-b'));
  initial.courses.push(member('course-a'));
  let saved;
  const adapter = {
    read: async () => structuredClone(initial),
    write: async (candidate, previous) => { saved = { candidate, previous }; },
  };
  const store = await Store.open(adapter, initial);

  const result = await store.write({}, (candidate) => {
    candidate.members[0].name = '수정 회원';
    candidate.members[0].nameKey = '수정 회원';
    return { member: candidate.members[0], course: candidate.courses[0] };
  });

  assert.equal(result.member.name, '수정 회원');
  assert.equal(result.course.id, 'course-a');
  assert.equal(store.read().members[0].name, '수정 회원');
  assert.equal(saved.candidate.members[1], saved.previous.members[1]);
  assert.equal(saved.candidate.courses, saved.previous.courses);
  assert.equal(saved.candidate.meta.storeRevision, 1);
});

test('rejects an invalid edit of an existing row without changing saved data', async () => {
  const initial = emptyStore();
  initial.members.push(member('member-a'));
  const adapter = new MemoryAdapter(initial);
  const store = await Store.open(adapter, initial);

  await assert.rejects(store.write({}, (candidate) => {
    candidate.members[0].name = '';
  }), StoreValidationError);

  assert.equal(adapter.writeCount, 0);
  assert.deepEqual(store.read(), initial);
});

test('recovers success when an adapter reports an error after persisting the candidate', async () => {
  const adapter = new WriteThenFailAdapter(emptyStore());
  const store = await Store.open(adapter, emptyStore());

  const result = await store.write({}, (candidate) => {
    candidate.members.push(member('member-a'));
    return 'receipt-1';
  });

  assert.equal(result, 'receipt-1');
  assert.equal(store.read().meta.storeRevision, 1);
  assert.deepEqual(store.read(), await adapter.read());
});

test('recovers the committed result from the real file adapter after a lost write response', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  await openStore(file, emptyStore());
  const adapter = new WriteThenFailFileAdapter(file);
  const store = await Store.open(adapter, emptyStore());

  const receipt = await store.write({}, (candidate) => {
    candidate.members.push(member('member-a'));
    return 'receipt-from-command';
  });

  assert.equal(receipt, 'receipt-from-command');
  assert.deepEqual(await new SQLiteAdapter(file).read(), store.read());
});

test('blocks later writes when disk state cannot be determined', async () => {
  const adapter = new IndeterminateAdapter(emptyStore());
  const store = await Store.open(adapter, emptyStore());

  await assert.rejects(
    store.write({}, (candidate) => candidate.members.push(member('member-a'))),
    StoreRecoveryRequiredError,
  );
  await assert.rejects(
    store.write({}, (candidate) => candidate.members.push(member('member-b'))),
    StoreRecoveryRequiredError,
  );
});

test('keeps saves and restores consistent after failed, committed, or uncertain writes', async () => {
  for (const action of ['save', 'restore']) {
    for (const outcome of ['unchanged', 'committed', 'different', 'unreadable']) {
      const original = emptyStore();
      original.members.push(member('original'));
      const adapter = new MemoryAdapter(original);
      const store = await Store.open(adapter, emptyStore());
      const candidate = emptyStore();
      candidate.meta.storeEpoch = 'restored';
      candidate.members.push(member('replacement'));
      const writeError = new Error('storage write failed');
      const persist = adapter.write.bind(adapter);
      adapter.write = async (data) => {
        if (outcome === 'committed') await persist(data);
        if (outcome === 'different') await persist(emptyStore());
        if (outcome === 'unreadable') adapter.read = async () => { throw new Error('storage read failed'); };
        throw writeError;
      };
      const operation = action === 'save'
        ? store.write({}, (data) => { data.members = candidate.members; return 'saved'; })
        : store.restore(candidate, {
          expectedRevision: 0, expectedEpoch: 'epoch-1',
          backup: async () => assert.deepEqual(store.read(), original),
        });
      if (outcome === 'committed') {
        assert.equal(await operation, action === 'save' ? 'saved' : undefined);
        assert.equal(store.read().members[0].id, 'replacement');
        assert.deepEqual(store.read(), await adapter.read());
      } else {
        await assert.rejects(operation, outcome === 'unchanged' ? writeError : StoreRecoveryRequiredError);
        assert.deepEqual(store.read(), original);
      }
      adapter.write = persist;
      if (outcome === 'different' || outcome === 'unreadable') {
        await assert.rejects(store.write({}, () => {}), StoreRecoveryRequiredError);
      } else {
        await store.write({}, (data) => { data.members.push(member('next')); });
        assert.equal(store.read().members.at(-1).id, 'next');
      }
    }
  }
});

test('does not replace a malformed existing file with an empty store', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const malformed = '{ existing but broken';
  await import('node:fs/promises').then(({ writeFile }) => writeFile(file, malformed));

  await assert.rejects(openStore(file, emptyStore()));
  assert.equal(await readFile(file, 'utf8'), malformed);
});

class MemoryAdapter {
  writeCount = 0;

  constructor(data) {
    this.data = structuredClone(data);
  }

  async read() {
    return structuredClone(this.data);
  }

  async write(data) {
    this.writeCount += 1;
    this.data = structuredClone(data);
  }
}

class WriteThenFailAdapter extends MemoryAdapter {
  async write(data) {
    await super.write(data);
    throw new Error('response lost after persistence');
  }
}

class WriteThenFailFileAdapter {
  constructor(file) {
    this.adapter = new SQLiteAdapter(file);
  }

  read() {
    return this.adapter.read();
  }

  async write(data) {
    await this.adapter.write(data);
    throw new Error('response lost after file replacement');
  }
}

class IndeterminateAdapter extends MemoryAdapter {
  failed = false;

  async read() {
    if (this.failed) throw new Error('cannot read disk');
    return super.read();
  }

  async write() {
    this.failed = true;
    throw new Error('unknown write result');
  }
}
