import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DraftService, DraftNotFoundError } from '../../backend/src/services/drafts.ts';
import {
  FinalizationAcknowledgementError,
  FinalizationConflictError,
  FinalizationIdempotencyConflictError,
  FinalizationService,
  FinalizationStaleError,
} from '../../backend/src/services/finalization.ts';
import {
  Store,
  StoreEpochConflictError,
  StoreRevisionConflictError,
  openStore,
} from '../../backend/src/storage/store.ts';

const timestamp = '2026-09-23T00:00:00.000Z';
const secret = '0123456789abcdef0123456789abcdef';
const policy = {
  policyId: 'policy-1',
  policyVersion: 'version-1',
  policySettings: {
    preferenceMode: 'NEW_FIRST',
    fallbackMode: 'MAX_CARDINALITY_PRIORITIZED',
  },
};

test('finalizes all selected rows atomically and returns the same receipt after restart and expiry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-finalize-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, fixture());
  const drafts = draftService(store);
  const created = await drafts.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  let clock = new Date(timestamp);
  const service = finalizationService(store, {
    now: () => clock,
  });
  const preview = service.preview(created.draft.id, { expectedDraftRevision: 0 });
  const request = finalizeRequest(preview, 'finalize-1');

  const receipt = await service.finalize(created.draft.id, request);

  const committed = store.read();
  assert.equal(receipt.createdCount, 1);
  assert.deepEqual(receipt.createdEnrollmentIds, [preview.enrollments[0].id]);
  assert.equal('sourceDraftId' in committed.enrollments[0], false);
  assert.equal('sourceDraftItemId' in committed.enrollments[0], false);
  assert.deepEqual(committed.allocationDrafts, []);
  assert.deepEqual(committed.allocationDraftItems, []);
  assert.equal(committed.finalizationReceipts[0].semesterId, 'semester-1');
  assert.deepEqual(committed.finalizationReceipts[0].receipt, receipt);
  assert.throws(() => drafts.get(created.draft.id), DraftNotFoundError);

  const reopened = await openStore(file, emptyStore());
  await reopened.write({}, (data) => { data.meta.storeEpoch = 'epoch-after-restore'; });
  const revisionBeforeRetry = reopened.read().meta.storeRevision;
  clock = new Date('2026-09-23T01:00:00.000Z');
  const retried = await finalizationService(reopened, {
    now: () => clock,
  }).finalize(created.draft.id, request);

  assert.deepEqual(retried, receipt);
  assert.equal(reopened.read().meta.storeRevision, revisionBeforeRetry);
  assert.equal(reopened.read().enrollments.length, 1);
  await assert.rejects(
    finalizationService(reopened, { now: () => clock })
      .finalize(created.draft.id, { ...request, acknowledgementNote: '다른 본문' }),
    FinalizationIdempotencyConflictError,
  );
});

test('requires the exact warning digest and rejects a changed preview without partial writes', async () => {
  const data = fixture();
  data.semesterCourses.push(stamped({
    id: 'sc-past', semesterId: 'semester-0', courseId: 'course-a', capacity: 1,
  }));
  data.enrollments.push(stamped({
    id: 'past-enrollment', semesterCourseId: 'sc-past', memberId: 'member-1',
    exceptionAcknowledgement: null, revision: 0,
  }));
  const store = await Store.open(new MemoryAdapter(data), data);
  const drafts = draftService(store);
  const created = await drafts.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  await drafts.updateItem(created.draft.id, 'member-1', {
    expectedDraftRevision: 0,
    finalDecision: 'SELECTED',
    finalSemesterCourseId: 'sc-a',
    finalReasonCode: 'ADMIN_RETAKE',
    finalReasonDetail: null,
  });
  const service = finalizationService(store);
  const preview = service.preview(created.draft.id, { expectedDraftRevision: 1 });
  assert.ok(preview.issues.some(({ code }) => code === 'RETAKE'));
  const before = store.read();

  await assert.rejects(service.finalize(created.draft.id, {
    ...finalizeRequest(preview, 'warning-1'),
    acknowledgedWarningDigest: 'confirmed=true',
  }), FinalizationAcknowledgementError);
  assert.deepEqual(store.read(), before);

  await store.write({}, (candidate) => {
    candidate.semesterCourses.find(({ id }) => id === 'sc-a').capacity = 0;
  });
  const changed = store.read();
  await assert.rejects(
    service.finalize(created.draft.id, finalizeRequest(preview, 'warning-1')),
    FinalizationStaleError,
  );
  assert.deepEqual(store.read(), changed);

  const refreshed = service.preview(created.draft.id, { expectedDraftRevision: 1 });
  const receipt = await service.finalize(
    created.draft.id,
    finalizeRequest(refreshed, 'warning-2'),
  );
  const committed = store.read();
  assert.equal(receipt.createdCount, 1);
  assert.equal(committed.enrollments.at(-1).exceptionAcknowledgement.warningDigest, refreshed.warningDigest);
  assert.equal(committed.enrollments.at(-1).exceptionAcknowledgement.note, '표시된 경고와 최종 선택을 확인함');
  assert.equal(committed.allocationDrafts.length, 0);
  assert.deepEqual(committed.finalizationReceipts[0].receipt, receipt);
});

test('marks a downloaded enrollment report current until the stored data changes', async () => {
  const data = fixture();
  const store = await Store.open(new MemoryAdapter(data), data);
  const drafts = draftService(store);
  const created = await drafts.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });

  const finalization = finalizationService(store);
  await assert.rejects(finalization.recordEnrollmentReportDownload('semester-1', store.read().meta),
    /No finalized allocation/);

  const preview = finalization.preview(created.draft.id, { expectedDraftRevision: 0 });
  await finalization.finalize(created.draft.id, finalizeRequest(preview, 'report-finalize'));
  const generatedFromRevision = store.read().meta.storeRevision;
  const generatedFromEpoch = store.read().meta.storeEpoch;
  await store.write({}, (candidate) => {
    candidate.enrollments[0].updatedAt = '2026-09-23T00:30:00.000Z';
  });
  await assert.rejects(
    finalization.recordEnrollmentReportDownload('semester-1', {
      storeRevision: generatedFromRevision, storeEpoch: generatedFromEpoch,
    }),
    StoreRevisionConflictError,
  );
  assert.equal(store.read().finalizationReceipts[0].enrollmentReportDownloadedAt, null);

  const currentStoreRevision = store.read().meta.storeRevision;
  const currentStoreEpoch = store.read().meta.storeEpoch;
  await finalization.recordEnrollmentReportDownload('semester-1', {
    storeRevision: currentStoreRevision, storeEpoch: currentStoreEpoch,
  });

  assert.equal(finalization.reportStatus('semester-1').enrollmentReportDownloadedAt, timestamp);
  assert.equal(finalization.reportStatus('semester-1').enrollmentReportIsCurrent, true);
  const recordedStoreRevision = store.read().meta.storeRevision;

  await finalization.recordEnrollmentReportDownload('semester-1', store.read().meta);
  assert.equal(store.read().meta.storeRevision, recordedStoreRevision);

  await store.write({}, (candidate) => {
    candidate.enrollments[0].updatedAt = '2026-09-23T01:00:00.000Z';
  });
  assert.equal(finalization.reportStatus('semester-1').enrollmentReportIsCurrent, false);
});

test('rejects enrollment report completion after a same-revision restore changes the store epoch', async () => {
  const data = fixture();
  const store = await Store.open(new MemoryAdapter(data), data);
  const drafts = draftService(store);
  const created = await drafts.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const finalization = finalizationService(store);
  const preview = finalization.preview(created.draft.id, { expectedDraftRevision: 0 });
  await finalization.finalize(created.draft.id, finalizeRequest(preview, 'epoch-finalize'));
  const beforeRestore = store.read();
  const restored = structuredClone(beforeRestore);
  restored.meta.storeEpoch = 'epoch-after-report-generation';
  await store.restore(restored, {
    expectedRevision: beforeRestore.meta.storeRevision,
    expectedEpoch: beforeRestore.meta.storeEpoch,
    backup: async () => {},
  });

  await assert.rejects(
    finalization.recordEnrollmentReportDownload('semester-1', beforeRestore.meta),
    StoreEpochConflictError,
  );
  assert.equal(store.read().finalizationReceipts[0].enrollmentReportDownloadedAt, null);
});

test('reports another finalized draft as a hard conflict instead of silently skipping the member', async () => {
  const store = await Store.open(new MemoryAdapter(fixture()), fixture());
  const drafts = draftService(store);
  const first = await drafts.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const second = await drafts.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const service = finalizationService(store);
  const firstPreview = service.preview(first.draft.id, { expectedDraftRevision: 0 });
  await service.finalize(first.draft.id, finalizeRequest(firstPreview, 'first'));

  const secondPreview = service.preview(second.draft.id, { expectedDraftRevision: 0 });

  assert.ok(secondPreview.issues.some(({ code, severity }) => (
    code === 'SAME_SEMESTER_ENROLLMENT' && severity === 'ERROR'
  )));
  await assert.rejects(
    service.finalize(second.draft.id, finalizeRequest(secondPreview, 'second')),
    FinalizationConflictError,
  );
  assert.equal(store.read().enrollments.length, 1);
  assert.equal(store.read().allocationDrafts.find(({ id }) => id === second.draft.id).status, 'DRAFT');
});

test('keeps enrollments and draft state unchanged when file persistence fails', async () => {
  const initial = fixture();
  const adapter = new FailingMemoryAdapter(initial);
  const failingStore = await Store.open(adapter, initial);
  const failingDraft = await draftService(failingStore)
    .create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const writeFailure = finalizationService(failingStore);
  const failingPreview = writeFailure.preview(failingDraft.draft.id, { expectedDraftRevision: 0 });
  const beforeWrite = failingStore.read();
  adapter.failNext = true;

  await assert.rejects(
    writeFailure.finalize(failingDraft.draft.id, finalizeRequest(failingPreview, 'write-failure')),
    /write failed/,
  );
  assert.deepEqual(failingStore.read(), beforeWrite);
});

const finalizationService = (store, overrides = {}) => {
  let id = 0;
  return new FinalizationService(store, {
    id: () => `final-generated-${++id}`,
    now: () => new Date(timestamp),
    secret,
    ...overrides,
  });
};

const draftService = (store) => {
  let id = 0;
  return new DraftService(store, {
    id: () => `draft-generated-${++id}`,
    now: () => new Date(timestamp),
    seed: () => 'seed-1',
  });
};

const finalizeRequest = (preview, idempotencyKey) => ({
  idempotencyKey,
  preparedActionToken: preview.preparedActionToken,
  expectedDraftRevision: preview.draftRevision,
  acknowledgedWarningDigest: preview.warningDigest,
  acknowledgementNote: '표시된 경고와 최종 선택을 확인함',
});

const emptyStore = () => ({
  meta: { storeEpoch: 'epoch-1', storeRevision: 0 },
  semesters: [], members: [], courses: [], semesterCourses: [], applications: [],
  applicationChoices: [], enrollments: [], allocationDrafts: [], allocationDraftItems: [], finalizationReceipts: [], importBatches: [], restoreReceipts: [],
});

const fixture = () => ({
  ...emptyStore(),
  semesters: [
    named({ id: 'semester-0', name: '2025 겨울', order: 1, allocationInputRevision: 1 }),
    named({ id: 'semester-1', name: '2026 봄', order: 2, allocationInputRevision: 1 }),
  ],
  members: [named({ id: 'member-1', name: '홍길동' })],
  courses: [named({ id: 'course-a', name: '기초' }), named({ id: 'course-b', name: '심화' })],
  semesterCourses: [
    stamped({ id: 'sc-a', semesterId: 'semester-1', courseId: 'course-a', capacity: 1 }),
    stamped({ id: 'sc-b', semesterId: 'semester-1', courseId: 'course-b', capacity: 1 }),
  ],
  applications: [stamped({
    id: 'application-1', semesterId: 'semester-1', memberId: 'member-1', applicationOrder: 1,
    applicationOrderStatus: 'NORMAL', orderResolution: 'SOURCE_AGREED', orderResolutionNote: null, revision: 0,
  })],
  applicationChoices: [stamped({
    id: 'choice-1', applicationId: 'application-1', semesterCourseId: 'sc-a', preference: 1, sourceRefs: [],
  })],
});

const named = (value) => stamped({ ...value, nameKey: value.name });
const stamped = (value) => ({ ...value, createdAt: timestamp, updatedAt: timestamp });

class MemoryAdapter {
  constructor(data) { this.data = structuredClone(data); }
  async read() { return structuredClone(this.data); }
  async write(data) { this.data = structuredClone(data); }
}

class FailingMemoryAdapter extends MemoryAdapter {
  failNext = false;
  async write(data) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('write failed');
    }
    await super.write(data);
  }
}
