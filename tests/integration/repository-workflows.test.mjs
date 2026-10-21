import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';
import { FinalizationService } from '../../backend/src/services/finalization.ts';

const empty = () => ({
  meta: { storeEpoch: 'repository-workflow', storeRevision: 0 },
  semesters: [], members: [], courses: [], semesterCourses: [], applications: [],
  applicationChoices: [], enrollments: [], allocationDrafts: [], allocationDraftItems: [],
  importBatches: [], finalizationReceipts: [], restoreReceipts: [],
});
const policy = { policyId: 'course-allocation', policyVersion: '1.0.0',
  policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' } };
const setup = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-repository-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const repository = await openRepository(file, empty());
  t.after(() => repository.close());
  let next = 0;
  const dependencies = { id: () => `repository-${++next}`, now: () => new Date('2026-10-21T00:00:00.000Z'),
    seed: () => 'repository-seed', secret: Buffer.alloc(32, 7) };
  const applications = new ApplicationService(repository, dependencies);
  const drafts = new DraftService(repository, dependencies);
  const finalization = new FinalizationService(repository, dependencies);
  const application = await applications.create({ semesterName: '2026 가을', memberName: '홍길동',
    ministry: '청년부', applicationOrder: 1, choices: [{ courseName: '기초', preference: 1 }] });
  const semester = applications.getSemesterContext(application.semesterId);
  await applications.updateSemesterContext({ semesterId: application.semesterId,
    expectedRevision: semester.allocationInputRevision, order: semester.order,
    semesterCourses: semester.semesterCourses.map((course) => ({ id: course.id, courseName: course.courseName, capacity: 1 })) });
  const draft = await drafts.create({ semesterId: application.semesterId, mode: 'AUTO', ...policy });
  return { file, repository, applications, drafts, finalization, application, draft, dependencies };
};
const request = (preview, key) => ({ idempotencyKey: key, preparedActionToken: preview.preparedActionToken,
  expectedDraftRevision: preview.draftRevision, acknowledgedWarningDigest: preview.warningDigest });

test('SQL-backed services preserve generation-time ministry and replay the same finalization after restart', async (t) => {
  const context = await setup(t);
  const changed = { semesterName: '2026 가을', memberName: '홍길동', ministry: '장년부', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }], expectedRevision: context.application.revision };
  await context.applications.update(context.application.id, changed);
  const detail = context.drafts.get(context.draft.draft.id);
  assert.equal(detail.applicationSnapshot.applications[0].ministry, '청년부');
  assert.equal(detail.isStale, true);
  const preview = context.finalization.preview(detail.draft.id, { expectedDraftRevision: detail.draft.revision });
  const input = request(preview, 'repository-finalize');
  const receipt = await context.finalization.finalize(detail.draft.id, input);
  const reopened = await openRepository(context.file, empty());
  t.after(() => reopened.close());
  const restarted = new FinalizationService(reopened, { ...context.dependencies,
    now: () => new Date('2027-10-21T00:00:00.000Z') });
  assert.deepEqual(await restarted.finalize(detail.draft.id, input), receipt);
  assert.equal(reopened.snapshot().enrollments[0].ministry, '청년부');
  assert.equal(reopened.snapshot().enrollments.length, 1);
});

test('a SQL receipt failure rolls back enrollments and draft deletion and permits a complete retry', async (t) => {
  const context = await setup(t);
  const preview = context.finalization.preview(context.draft.draft.id, { expectedDraftRevision: 0 });
  const input = request(preview, 'repository-rollback');
  const before = context.repository.snapshot();
  const db = new DatabaseSync(context.file);
  try {
    db.exec("CREATE TRIGGER reject_finalization BEFORE INSERT ON finalization_receipts BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END");
    await assert.rejects(context.finalization.finalize(context.draft.draft.id, input), /receipt rejected/);
    assert.deepEqual(context.repository.snapshot(), before);
    db.exec('DROP TRIGGER reject_finalization');
  } finally { db.close(); }
  const receipt = await context.finalization.finalize(context.draft.draft.id, input);
  assert.equal(receipt.createdCount, 1);
  assert.equal(context.repository.snapshot().allocationDrafts.length, 0);
  assert.equal(context.repository.snapshot().enrollments.length, 1);
});

test('draft pages treat an empty semester filter as omitted and preserve literal nonempty filters', async (t) => {
  const context = await setup(t);
  for (const { semesterId, total } of [
    { semesterId: undefined, total: 1 },
    { semesterId: '', total: 1 },
    { semesterId: context.application.semesterId, total: 1 },
    { semesterId: 'missing-semester', total: 0 },
    { semesterId: ' ', total: 0 },
  ]) {
    const result = context.drafts.listPage({ semesterId, page: 1, limit: 10 });
    assert.equal(result.total, total, `semesterId=${JSON.stringify(semesterId)}`);
    assert.equal(result.items.length, total);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 10);
    if (total) assert.equal(result.items[0].id, context.draft.draft.id);
  }
});

test('saving one draft reads its own snapshot, preserves sibling evidence and appends a manual item after reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-scoped-draft-save-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const initial = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-ministry.json', import.meta.url), 'utf8'));
  const sourceDraft = initial.allocationDrafts[0];
  const sourceItem = initial.allocationDraftItems[0];
  initial.allocationDrafts = ['first-sibling', 'target-draft', 'last-sibling']
    .map((id) => ({ ...structuredClone(sourceDraft), id }));
  initial.allocationDraftItems = initial.allocationDrafts
    .map(({ id }) => ({ ...structuredClone(sourceItem), id: `${id}-item`, draftId: id }));
  initial.members.push({ ...initial.members[0], id: 'new-member', name: '추가 회원', nameKey: '추가 회원' });
  const repository = await openRepository(file, initial);
  t.after(() => repository.close());
  const target = structuredClone(initial.allocationDrafts[1]);
  target.revision = 1;
  const changedItem = { ...initial.allocationDraftItems[1], ministry: '변경된 소속' };
  const newItem = { ...changedItem, id: 'new-target-item', memberId: 'new-member',
    memberNameAtGeneration: '추가 회원', sourceApplicationId: null, ministry: '추가 소속' };
  const siblingIds = new Set(['first-sibling', 'last-sibling']);
  let siblingRowsRead = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function(sql) {
    const statement = prepare.call(this, sql);
    const all = statement.all;
    statement.all = function(...params) {
      const rows = all.apply(this, params);
      siblingRowsRead += rows.filter((row) => [row.id, row.parentId, row.draftId].some((id) => siblingIds.has(id))).length;
      return rows;
    };
    return statement;
  };
  try {
    await repository.write({}, (queries) => queries.allocation.save({ draft: target, items: [changedItem, newItem] }));
  } finally { DatabaseSync.prototype.prepare = prepare; }
  assert.equal(siblingRowsRead, 0, 'an edit must not materialize snapshots or items belonging to sibling drafts');

  const reopened = await openRepository(file, initial);
  t.after(() => reopened.close());
  const saved = reopened.snapshot();
  assert.deepEqual(saved.allocationDrafts, initial.allocationDrafts.map((draft) => draft.id === target.id ? target : draft));
  assert.deepEqual(saved.allocationDraftItems, [
    initial.allocationDraftItems[0], changedItem, initial.allocationDraftItems[2], newItem,
  ]);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.deepEqual(db.prepare('SELECT id, position FROM allocation_drafts ORDER BY position').all()
      .map(({ id, position }) => [id, position]), [['first-sibling', 0], ['target-draft', 1], ['last-sibling', 2]]);
    assert.deepEqual(db.prepare('SELECT id, position FROM allocation_draft_items ORDER BY position').all()
      .map(({ id, position }) => [id, position]), [
      ['first-sibling-item', 0], ['target-draft-item', 1], ['last-sibling-item', 2], ['new-target-item', 3],
    ]);
  } finally { db.close(); }
});
