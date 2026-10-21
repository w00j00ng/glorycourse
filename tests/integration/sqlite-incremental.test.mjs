import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ApplicationService } from '../../backend/src/services/applications.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';
import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { seedRepository } from '../helpers/repository.mjs';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const timestamp = '2026-09-26T00:00:00.000Z';

const setup = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-incremental-'));
  let db;
  t.after(async () => { db?.close(); await rm(directory, { recursive: true, force: true }); });
  const file = join(directory, 'db.sqlite');
  const store = await openRepository(file, structuredClone(empty));
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
  await seedRepository(store, (data) => {
    for (const name of ['Unused', 'Charlie']) data.members.push({
      id: name.toLowerCase(), name, nameKey: name, createdAt: timestamp, updatedAt: timestamp,
    });
    data.enrollments.push({
      id: 'enrollment', memberId: 'charlie', semesterCourseId: data.semesterCourses[1].id,
      ministry: null,
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
    reopen: async () => (await openRepository(file, structuredClone(empty))).snapshot(),
    changes: () => Object.fromEntries(db.prepare(`SELECT table_name, operation, count(*) AS count
      FROM write_audit GROUP BY table_name, operation`).all()
      .map(({ table_name, operation, count }) => [`${table_name}:${operation}`, count])),
  };
};

const applyBatch = (queries) => {
  const batch = queries.imports.getBatch({ id: 'batch' });
  batch.status = 'APPLIED';
  batch.receipt = {
    receiptId: 'import-receipt', importBatchId: batch.id, previewId: 'preview',
    storeEpoch: queries.metadata().storeEpoch, idempotencyKey: 'import-request', requestHash: 'a'.repeat(64),
    inserted: 0, updated: 0, skipped: 2, committedAt: timestamp,
  };
  queries.imports.saveBatch({ record: batch });
};

test('saves one member name without rewriting other records or imported and automatic evidence', async (t) => {
  const { store, reopen, changes } = await setup(t);
  await store.write({}, (queries) => queries.catalog.updateNamed({
    kind: 'members', record: { ...queries.catalog.listNamed({ kind: 'members' })[0], name: 'Alice renamed' },
  }));

  assert.deepEqual(await reopen(), store.snapshot());
  assert.deepEqual(changes(), { 'members:UPDATE': 1, 'store_meta:UPDATE': 1 });
});

test('changes a final draft decision without rewriting its snapshot or automatic reasons', async (t) => {
  const { store, drafts, reopen, changes } = await setup(t);
  const before = store.snapshot();
  const draft = before.allocationDrafts[0];
  const item = before.allocationDraftItems[0];
  assert.equal(item.autoDecision, 'SELECTED');
  await drafts.updateItem(draft.id, item.memberId, {
    expectedDraftRevision: draft.revision, finalDecision: 'REJECTED', finalSemesterCourseId: null,
    finalReasonCode: 'ADMIN_EXCLUDED', finalReasonDetail: { note: 'Member requested exclusion' },
  });

  const after = await reopen();
  assert.deepEqual(after, store.snapshot());
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
  const before = store.snapshot();
  await store.write({}, applyBatch);

  const after = await reopen();
  assert.deepEqual(after, store.snapshot());
  assert.equal(after.importBatches[0].status, 'APPLIED');
  assert.deepEqual(after.importBatches[0].rawRows, before.importBatches[0].rawRows);
  assert.deepEqual(after.applicationChoices, before.applicationChoices);
  assert.deepEqual(changes(), { 'import_batches:UPDATE': 1, 'import_receipts:INSERT': 1, 'store_meta:UPDATE': 1 });
});

test('restores deleted, reordered, renamed, and reassigned records with their exact relationships', async (t) => {
  const { store, reopen, db } = await setup(t);
  const before = store.snapshot();
  const requested = structuredClone(before);
  requested.members = requested.members.filter(({ id }) => id !== 'unused');
  const [alice, bob] = requested.members;
  [alice.name, bob.name] = [bob.name, alice.name];
  [alice.nameKey, bob.nameKey] = [bob.nameKey, alice.nameKey];
  requested.members.reverse();
  requested.applicationChoices.reverse();
  [requested.applications[0].memberId, requested.applications[1].memberId]
    = [requested.applications[1].memberId, requested.applications[0].memberId];
  [requested.semesterCourses[0].courseId, requested.semesterCourses[1].courseId]
    = [requested.semesterCourses[1].courseId, requested.semesterCourses[0].courseId];
  const sameApplication = requested.applicationChoices.filter(({ applicationId }) => applicationId === requested.applications[0].id);
  [sameApplication[0].semesterCourseId, sameApplication[1].semesterCourseId]
    = [sameApplication[1].semesterCourseId, sameApplication[0].semesterCourseId];
  requested.enrollments[0].semesterCourseId = requested.semesterCourses[0].id;
  requested.courses.reverse();
  await store.restore(requested, {
    expectedRevision: before.meta.storeRevision, expectedEpoch: before.meta.storeEpoch, backup: async () => {},
  });

  const after = await reopen();
  assert.deepEqual(after, store.snapshot());
  assert.deepEqual(after.members.map(({ id }) => id), ['charlie', before.members[1].id, before.members[0].id]);
  assert.equal(after.applications[0].memberId, before.applications[1].memberId);
  assert.equal(after.enrollments[0].semesterCourseId, after.semesterCourses[0].id);
  assert.deepEqual(after.allocationDrafts, before.allocationDrafts);
  assert.deepEqual(after.importBatches, before.importBatches);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  const retainedChoice = after.applicationChoices.find(({ sourceRefs }) => sourceRefs.length);
  const retainedApplication = after.applications[1];
  const reparent = store.snapshot();
  const choice = reparent.applicationChoices.find(({ id }) => id === retainedChoice.id);
  const removedApplicationId = choice.applicationId;
  reparent.applicationChoices = reparent.applicationChoices.filter((item) => (
    item.applicationId !== removedApplicationId || item.id === choice.id
  ));
  choice.applicationId = retainedApplication.id;
  choice.semesterCourseId = reparent.semesterCourses[0].id;
  reparent.applications = reparent.applications.filter(({ id }) => id !== removedApplicationId);
  await store.restore(reparent, {
    expectedRevision: after.meta.storeRevision, expectedEpoch: after.meta.storeEpoch, backup: async () => {},
  });
  const reparented = await reopen();
  assert.deepEqual(reparented, store.snapshot());
  const savedChoice = reparented.applicationChoices.find(({ id }) => id === retainedChoice.id);
  assert.equal(savedChoice.applicationId, retainedApplication.id);
  assert.deepEqual(savedChoice.sourceRefs, retainedChoice.sourceRefs);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('rolls back all incremental changes when a receipt is rejected and saves a subsequent retry', async (t) => {
  const { store, reopen, db, changes } = await setup(t);
  const before = store.snapshot();
  const save = (queries) => {
    queries.catalog.updateNamed({
      kind: 'members', record: { ...queries.catalog.listNamed({ kind: 'members' })[0], name: 'Alice renamed' },
    });
    applyBatch(queries);
  };
  db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON import_receipts BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
  await assert.rejects(store.write({}, save), /receipt rejected/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await reopen(), before);
  assert.deepEqual(changes(), {});

  db.exec('DROP TRIGGER reject_receipt');
  await store.write({}, save);
  assert.deepEqual(await reopen(), store.snapshot());
  assert.equal(store.snapshot().members[0].name, 'Alice renamed');
  assert.equal(store.snapshot().importBatches[0].receipt.receiptId, 'import-receipt');
});

test('rejects restores based on an older revision or a different epoch without changing saved records', async (t) => {
  const { store, db, reopen, changes } = await setup(t);
  const before = store.snapshot();
  await store.write({}, (queries) => queries.catalog.updateNamed({
    kind: 'members', record: { ...before.members[0], name: 'Newest name' },
  }));
  const current = store.snapshot();
  db.exec('DELETE FROM write_audit');
  for (const previous of [before, { ...current, meta: { ...current.meta, storeEpoch: 'previous-epoch' } }]) {
    const candidate = structuredClone(previous);
    candidate.members[0].name = 'Stale name';
    candidate.meta.storeRevision += 1;
    await assert.rejects(store.restore(candidate, {
      expectedRevision: previous.meta.storeRevision, expectedEpoch: previous.meta.storeEpoch, backup: async () => {},
    }), /Expected store revision|Expected store epoch/);
  }
  assert.deepEqual(await reopen(), current);
  assert.deepEqual(store.snapshot(), current);
  assert.deepEqual(changes(), {});
});

test('rejects a duplicated existing record instead of losing it when reopening the store', async (t) => {
  const { store, reopen, changes } = await setup(t);
  const before = store.snapshot();
  await assert.rejects(store.write({}, (queries) => queries.catalog.insertNamed({ kind: 'members', record: before.members[0] })));
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await reopen(), before);
  assert.deepEqual(changes(), {});
});

test('restores inserted and reordered records after reopening data with gaps in stored positions', async (t) => {
  const { store, db, reopen } = await setup(t);
  // Migrations can leave gaps when they remove records without rebuilding their arrays.
  db.exec('UPDATE members SET position = position + 20; UPDATE members SET position = (position - 20) * 2');
  assert.deepEqual(await reopen(), store.snapshot());
  const inserted = store.snapshot();
  inserted.members.splice(2, 0, {
    id: 'inserted', name: 'Inserted member', nameKey: 'Inserted member', createdAt: timestamp, updatedAt: timestamp,
  });
  await store.restore(inserted, {
    expectedRevision: inserted.meta.storeRevision, expectedEpoch: inserted.meta.storeEpoch, backup: async () => {},
  });
  assert.deepEqual(await reopen(), store.snapshot());
  assert.equal(store.snapshot().members[2].id, 'inserted');

  db.exec('UPDATE members SET position = position + 20; UPDATE members SET position = (position - 20) * 2');
  const reordered = store.snapshot();
  reordered.members.reverse();
  await store.restore(reordered, {
    expectedRevision: reordered.meta.storeRevision, expectedEpoch: reordered.meta.storeEpoch, backup: async () => {},
  });
  assert.deepEqual(await reopen(), store.snapshot());
  assert.deepEqual(db.prepare('SELECT position FROM members ORDER BY position').all().map(({ position }) => position), [0, 1, 2, 3, 4]);
});
