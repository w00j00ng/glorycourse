import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ApplicationService } from '../../backend/src/services/applications.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';
import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';
import { openStore, Store } from '../../backend/src/storage/store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const timestamp = '2026-09-26T00:00:00.000Z';

const setup = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-incremental-'));
  let db;
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, structuredClone(empty));
  let sequence = 0;
  const dependencies = { id: () => `record-${++sequence}`, now: () => new Date(timestamp), seed: () => 'fixed-seed' };
  const applications = new ApplicationService(store, dependencies);
  const [first] = await applications.createMany([
    { semesterName: 'Fall', memberName: 'Alice', applicationOrder: 1,
      choices: [{ courseName: 'Art', preference: 1 }, { courseName: 'Music', preference: 2 }] },
    { semesterName: 'Fall', memberName: 'Bob', applicationOrder: 2,
      choices: [{ courseName: 'Music', preference: 1 }] },
  ]);
  const context = applications.getSemesterContext(first.semesterId);
  await applications.updateSemesterContext({
    semesterId: first.semesterId, expectedRevision: context.allocationInputRevision, order: 1,
    semesterCourses: context.semesterCourses.map(({ id, courseName }) => ({ id, courseName, capacity: 3 })),
  });
  await store.write({}, (data) => {
    for (const name of ['Unused', 'Charlie']) data.members.push({
      id: name.toLowerCase(), name, nameKey: name, createdAt: timestamp, updatedAt: timestamp,
    });
    data.enrollments.push({
      id: 'enrollment', memberId: 'charlie', semesterCourseId: data.semesterCourses[1].id,
      exceptionAcknowledgement: null, revision: 0, createdAt: timestamp, updatedAt: timestamp,
    });
    data.importBatches.push({
      id: 'batch', kind: 'APPLICATIONS', templateVersion: '1', fileHash: 'hash',
      importedAt: timestamp, status: 'STAGED', resolutions: [], receipt: null,
      rawRows: [
        { sheet: 'Applications', row: 2, cells: { member: 'Alice', course: 'Art', note: null } },
        { sheet: 'Applications', row: 3, cells: { member: 'Bob', course: 'Music', note: 'original' } },
      ],
    });
    data.applicationChoices[0].sourceRefs.push({ importBatchId: 'batch', sheet: 'Applications', row: 2 });
  });
  const drafts = new DraftService(store, dependencies);
  await drafts.create({
    semesterId: first.semesterId, mode: 'AUTO', policyId: 'policy', policyVersion: '1',
    policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' },
  });

  db = new DatabaseSync(file);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").all();
  db.exec('CREATE TABLE write_audit (table_name TEXT, operation TEXT)');
  for (const { name } of tables) {
    for (const operation of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`
      CREATE TRIGGER audit_${name}_${operation} AFTER ${operation} ON ${name}
      BEGIN INSERT INTO write_audit VALUES ('${name}', '${operation}'); END;
    `);
  }
  return {
    store, drafts, db, file,
    reopen: async () => (await openStore(file, structuredClone(empty))).read(),
    changes: () => Object.fromEntries(db.prepare(`SELECT table_name, operation, count(*) AS count
      FROM write_audit GROUP BY table_name, operation`).all()
      .map(({ table_name, operation, count }) => [`${table_name}:${operation}`, count])),
  };
};

const applyBatch = (data) => {
  const batch = data.importBatches[0];
  batch.status = 'APPLIED';
  batch.receipt = {
    receiptId: 'import-receipt', importBatchId: batch.id, previewId: 'preview',
    storeEpoch: data.meta.storeEpoch, idempotencyKey: 'import-request', requestHash: 'a'.repeat(64),
    inserted: 0, updated: 0, skipped: 2, committedAt: timestamp,
  };
};

test('saves one member name without rewriting other records or imported and automatic evidence', async (t) => {
  const { store, reopen, changes } = await setup(t);
  await store.write({}, (data) => { data.members[0].name = 'Alice renamed'; });

  assert.deepEqual(await reopen(), store.read());
  assert.deepEqual(changes(), { 'members:UPDATE': 1, 'store_meta:UPDATE': 1 });
});

test('changes a final draft decision without rewriting its snapshot or automatic reasons', async (t) => {
  const { store, drafts, reopen, changes } = await setup(t);
  const before = store.read();
  const draft = before.allocationDrafts[0];
  const item = before.allocationDraftItems[0];
  assert.equal(item.autoDecision, 'SELECTED');
  await drafts.updateItem(draft.id, item.memberId, {
    expectedDraftRevision: draft.revision, finalDecision: 'REJECTED', finalSemesterCourseId: null,
    finalReasonCode: 'ADMIN_EXCLUDED', finalReasonDetail: { note: 'Member requested exclusion' },
  });

  const after = await reopen();
  assert.deepEqual(after, store.read());
  assert.deepEqual(after.allocationDrafts[0].inputSnapshot, draft.inputSnapshot);
  assert.deepEqual(after.allocationDraftItems[0].autoReasonDetail, item.autoReasonDetail);
  assert.equal(after.allocationDraftItems[0].finalDecision, 'REJECTED');
  assert.deepEqual(changes(), {
    'allocation_draft_items:UPDATE': 1, 'allocation_drafts:UPDATE': 1,
    'allocation_item_final_reasons:INSERT': 1, 'store_meta:UPDATE': 1,
  });
});

test('records an import receipt while preserving its original rows, cells, and source references', async (t) => {
  const { store, reopen, changes } = await setup(t);
  const before = store.read();
  await store.write({}, applyBatch);

  const after = await reopen();
  assert.deepEqual(after, store.read());
  assert.equal(after.importBatches[0].status, 'APPLIED');
  assert.deepEqual(after.importBatches[0].rawRows, before.importBatches[0].rawRows);
  assert.deepEqual(after.applicationChoices, before.applicationChoices);
  assert.deepEqual(changes(), { 'import_batches:UPDATE': 1, 'import_receipts:INSERT': 1, 'store_meta:UPDATE': 1 });
});

test('reopens deleted, reordered, renamed, and reassigned records with their exact relationships', async (t) => {
  const { store, reopen, db } = await setup(t);
  const before = store.read();
  await store.write({}, (data) => {
    data.members = data.members.filter(({ id }) => id !== 'unused');
    const [alice, bob] = data.members;
    [alice.name, bob.name] = [bob.name, alice.name];
    [alice.nameKey, bob.nameKey] = [bob.nameKey, alice.nameKey];
    data.members.reverse();
    data.applicationChoices.reverse();
    [data.applications[0].memberId, data.applications[1].memberId]
      = [data.applications[1].memberId, data.applications[0].memberId];
    [data.semesterCourses[0].courseId, data.semesterCourses[1].courseId]
      = [data.semesterCourses[1].courseId, data.semesterCourses[0].courseId];
    const sameApplication = data.applicationChoices.filter(({ applicationId }) => applicationId === data.applications[0].id);
    [sameApplication[0].semesterCourseId, sameApplication[1].semesterCourseId]
      = [sameApplication[1].semesterCourseId, sameApplication[0].semesterCourseId];
    data.enrollments[0].semesterCourseId = data.semesterCourses[0].id;
    data.courses.reverse();
  });

  const after = await reopen();
  assert.deepEqual(after, store.read());
  assert.deepEqual(after.members.map(({ id }) => id), ['charlie', before.members[1].id, before.members[0].id]);
  assert.equal(after.applications[0].memberId, before.applications[1].memberId);
  assert.equal(after.enrollments[0].semesterCourseId, after.semesterCourses[0].id);
  assert.deepEqual(after.allocationDrafts, before.allocationDrafts);
  assert.deepEqual(after.importBatches, before.importBatches);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const retainedChoice = after.applicationChoices.find(({ sourceRefs }) => sourceRefs.length);
  const retainedApplication = after.applications[1];
  await store.write({}, (data) => {
    const choice = data.applicationChoices.find(({ id }) => id === retainedChoice.id);
    const removedApplicationId = choice.applicationId;
    data.applicationChoices = data.applicationChoices.filter((item) => (
      item.applicationId !== removedApplicationId || item.id === choice.id
    ));
    choice.applicationId = retainedApplication.id;
    choice.semesterCourseId = data.semesterCourses[0].id;
    data.applications = data.applications.filter(({ id }) => id !== removedApplicationId);
  });
  const reparented = await reopen();
  assert.deepEqual(reparented, store.read());
  const savedChoice = reparented.applicationChoices.find(({ id }) => id === retainedChoice.id);
  assert.equal(savedChoice.applicationId, retainedApplication.id);
  assert.deepEqual(savedChoice.sourceRefs, retainedChoice.sourceRefs);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('rolls back all incremental changes when a receipt is rejected and saves a subsequent retry', async (t) => {
  const { store, reopen, db, changes } = await setup(t);
  const before = store.read();
  const save = (data) => { data.members[0].name = 'Alice renamed'; applyBatch(data); };
  db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON import_receipts BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
  await assert.rejects(store.write({}, save), /receipt rejected/);
  assert.deepEqual(store.read(), before);
  assert.deepEqual(await reopen(), before);
  assert.deepEqual(changes(), {});

  db.exec('DROP TRIGGER reject_receipt');
  await store.write({}, save);
  assert.deepEqual(await reopen(), store.read());
  assert.equal(store.read().members[0].name, 'Alice renamed');
  assert.equal(store.read().importBatches[0].receipt.receiptId, 'import-receipt');
});

test('rejects writes based on an older revision or a different store epoch without changing saved records', async (t) => {
  const { store, file, db, reopen, changes } = await setup(t);
  const before = store.read();
  await store.write({}, (data) => { data.members[0].name = 'Newest name'; });
  const current = store.read();
  db.exec('DELETE FROM write_audit');
  const adapter = new SQLiteAdapter(file);
  for (const previous of [before, { ...current, meta: { ...current.meta, storeEpoch: 'previous-epoch' } }]) {
    const candidate = structuredClone(previous);
    candidate.members[0].name = 'Stale name';
    candidate.meta.storeRevision += 1;
    await assert.rejects(adapter.write(candidate, previous), /state changed/);
  }
  assert.deepEqual(await reopen(), current);
  assert.deepEqual(store.read(), current);
  assert.deepEqual(changes(), {});
});

test('recovers the saved result after an incremental write response is lost', async (t) => {
  const { file, reopen, changes } = await setup(t);
  const adapter = new SQLiteAdapter(file);
  const store = await Store.open({
    read: () => adapter.read(),
    write: async (data, previous) => {
      assert.ok(previous, 'the write must receive its previous snapshot');
      await adapter.write(data, previous);
      throw new Error('response lost after commit');
    },
  }, structuredClone(empty));
  const result = await store.write({}, (data) => { data.members[0].name = 'Recovered name'; return 'saved'; });
  assert.equal(result, 'saved');
  assert.deepEqual(await reopen(), store.read());
  assert.equal(store.read().members[0].name, 'Recovered name');
  assert.deepEqual(changes(), { 'members:UPDATE': 1, 'store_meta:UPDATE': 1 });
});

test('rejects a duplicated existing record instead of losing it when reopening the store', async (t) => {
  const { store, reopen, changes } = await setup(t);
  const before = store.read();
  await assert.rejects(store.write({}, (data) => { data.members.push(structuredClone(data.members[0])); }));
  assert.deepEqual(store.read(), before);
  assert.deepEqual(await reopen(), before);
  assert.deepEqual(changes(), {});
});

test('inserts and reorders records after reopening data with gaps in stored positions', async (t) => {
  const { store, db, reopen } = await setup(t);
  // Migrations can leave gaps when they remove records without rebuilding their arrays.
  db.exec('UPDATE members SET position = position + 20; UPDATE members SET position = (position - 20) * 2');
  assert.deepEqual(await reopen(), store.read());
  await store.write({}, (data) => {
    data.members.splice(2, 0, {
      id: 'inserted', name: 'Inserted member', nameKey: 'Inserted member', createdAt: timestamp, updatedAt: timestamp,
    });
  });
  assert.deepEqual(await reopen(), store.read());
  assert.equal(store.read().members[2].id, 'inserted');

  db.exec('UPDATE members SET position = position + 20; UPDATE members SET position = (position - 20) * 2');
  await store.write({}, (data) => { data.members.reverse(); });
  assert.deepEqual(await reopen(), store.read());
  assert.deepEqual(db.prepare('SELECT position FROM members ORDER BY position').all().map(({ position }) => position), [0, 1, 2, 3, 4]);
});
