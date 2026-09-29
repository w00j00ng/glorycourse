import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DraftReadOnlyError,
  DraftRevisionConflictError,
  DraftService,
  DraftUnsupportedEngineError,
  DraftValidationError,
} from '../../backend/src/services/drafts.ts';
import { openStore } from '../../backend/src/storage/store.ts';
import { FinalizationService } from '../../backend/src/services/finalization.ts';
import { draftFinalSelection } from '../../frontend/draft-view.js';

const timestamp = '2026-09-23T00:00:00.000Z';
const policy = {
  policyId: 'policy-1',
  policyVersion: 'version-1',
  policySettings: {
    preferenceMode: 'NEW_FIRST',
    fallbackMode: 'MAX_CARDINALITY_PRIORITIZED',
  },
};

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

const fixture = () => ({
  ...emptyStore(),
  semesters: [
    named({ id: 'semester-1', name: '2026 봄', order: 2, allocationInputRevision: 4 }),
    named({ id: 'semester-0', name: '2025 겨울', order: 1, allocationInputRevision: 1 }),
    named({ id: 'semester-2', name: '2026 여름', order: 3, allocationInputRevision: 1 }),
  ],
  members: [named({ id: 'member-1', name: '홍길동' }), named({ id: 'member-2', name: '김영희' })],
  courses: [named({ id: 'course-a', name: '기초' }), named({ id: 'course-b', name: '심화' })],
  semesterCourses: [
    stamped({ id: 'sc-a', semesterId: 'semester-1', courseId: 'course-a', capacity: 1 }),
    stamped({ id: 'sc-b', semesterId: 'semester-1', courseId: 'course-b', capacity: 1 }),
    stamped({ id: 'sc-other', semesterId: 'semester-2', courseId: 'course-a', capacity: 1 }),
  ],
  applications: [stamped({
    id: 'application-1',
    semesterId: 'semester-1',
    memberId: 'member-1',
    applicationOrder: 1,
    applicationOrderStatus: 'NORMAL',
    orderResolution: 'SOURCE_AGREED',
    orderResolutionNote: null,
    revision: 0,
  })],
  applicationChoices: [stamped({
    id: 'choice-1',
    applicationId: 'application-1',
    semesterCourseId: 'sc-a',
    preference: 1,
    sourceRefs: [],
  })],
});

test('persists automatic evidence and an administrator final edit across a real file reopen', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'glorycourse-drafts-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const file = join(workspace, 'db.sqlite');
  const first = await serviceAt(file, fixture());
  const beforeEnrollments = first.store.read().enrollments;
  const created = await first.service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const automatic = structuredClone(created.studentResults[0]);
  assert.deepEqual(first.service.list().map(({ id }) => id), [created.draft.id]);

  await first.service.updateItem(created.draft.id, 'member-1', {
    expectedDraftRevision: 0,
    ...draftFinalSelection(automatic, ''),
  });
  const reopened = await serviceAt(file, emptyStore());
  const stored = reopened.service.get(created.draft.id);

  assert.deepEqual(stored.studentResults[0].autoReasonDetail, automatic.autoReasonDetail);
  assert.equal(stored.studentResults[0].autoDecision, automatic.autoDecision);
  assert.equal(stored.studentResults[0].finalDecision, 'REJECTED');
  assert.equal(stored.studentResults[0].finalReasonCode, 'ADMIN_EXCLUDED');
  assert.deepEqual(
    stored.courseSummary.find(({ semesterCourseId }) => semesterCourseId === 'sc-a'),
    {
      semesterCourseId: 'sc-a',
      capacity: 1,
      existingEnrollmentCount: 0,
      finalSelectedCount: 0,
      remaining: 1,
    },
  );
  assert.deepEqual(reopened.store.read().enrollments, beforeEnrollments);
  assert.equal(stored.isStale, false);

  const restored = await reopened.service.restoreAuto(created.draft.id, 'member-1', {
    expectedDraftRevision: 1,
  });
  assert.equal(restored.studentResults[0].finalDecision, automatic.autoDecision);
  assert.equal(restored.studentResults[0].finalSemesterCourseId, automatic.autoSemesterCourseId);
  assert.deepEqual(reopened.store.read().enrollments, beforeEnrollments);
});

test('assigns the next semester order before creating an automatic draft', async (t) => {
  const data = fixture();
  data.semesters.find(({ id }) => id === 'semester-1').order = null;
  const { service, store } = await temporaryService(t, data);

  const created = await service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });

  const saved = store.read();
  const semester = saved.semesters.find(({ id }) => id === 'semester-1');
  const draft = saved.allocationDrafts.find(({ id }) => id === created.draft.id);
  assert.equal(semester.order, 4);
  assert.equal(semester.allocationInputRevision, 5);
  assert.equal(draft.inputSnapshot.semester.order, 4);
  assert.equal(created.studentResults.length, 1);
});

test('allows only one edit at a draft revision and keeps a previously archived draft read-only', async (t) => {
  const { service, store } = await temporaryService(t, fixture());
  const created = await service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const requests = [
    service.updateItem(created.draft.id, 'member-1', rejection(0, 'FIRST')),
    service.updateItem(created.draft.id, 'member-1', rejection(0, 'SECOND')),
  ];

  const results = await Promise.allSettled(requests);

  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.ok(rejected.reason instanceof DraftRevisionConflictError);
  const afterRace = service.get(created.draft.id);
  assert.equal(afterRace.draft.revision, 1);
  const snapshot = structuredClone(store.read());
  await assert.rejects(service.updateItem(created.draft.id, 'member-1', {
    expectedDraftRevision: 1,
    finalDecision: 'SELECTED',
    finalSemesterCourseId: 'sc-other',
    finalReasonCode: null,
    finalReasonDetail: null,
  }), DraftValidationError);
  assert.deepEqual(store.read(), snapshot);

  await store.write({}, (data) => {
    const draft = data.allocationDrafts.find(({ id }) => id === created.draft.id);
    draft.status = 'ARCHIVED';
    draft.revision = 2;
  });
  await assert.rejects(
    service.updateItem(created.draft.id, 'member-1', rejection(2, 'LATE_EDIT')),
    DraftReadOnlyError,
  );
  assert.equal(service.get(created.draft.id).draft.status, 'ARCHIVED');
  assert.deepEqual(service.list(), []);
  assert.equal(store.read().enrollments.length, 0);
});

test('deletes an archived draft without deleting enrollments', async (t) => {
  const { service, store } = await temporaryService(t, fixture());
  const created = await service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  await assert.rejects(
    service.delete(created.draft.id, { expectedDraftRevision: 1 }),
    DraftRevisionConflictError,
  );
  await store.write({}, (data) => {
    const draft = data.allocationDrafts.find(({ id }) => id === created.draft.id);
    draft.status = 'ARCHIVED';
    draft.revision = 1;
    data.enrollments.push(stamped({
      id: 'enrollment-1', semesterCourseId: 'sc-a', memberId: 'member-2',
      exceptionAcknowledgement: null, revision: 0,
    }));
  });

  await service.delete(created.draft.id, { expectedDraftRevision: 1 });

  assert.equal(store.read().allocationDrafts.length, 0);
  assert.equal(store.read().allocationDraftItems.length, 0);
  assert.equal(store.read().enrollments.length, 1);
});

test('creates a manual draft with unresolved automatic input and assigns only registered applicants', async (t) => {
  const data = fixture();
  data.semesters[0].order = null;
  data.applications[0].applicationOrder = null;
  data.applications[0].applicationOrderStatus = 'MISSING';
  data.applications[0].orderResolution = 'UNRESOLVED';
  const { service, store } = await temporaryService(t, data);
  const beforeApplications = store.read().applications.length;
  const created = await service.create({ semesterId: 'semester-1', mode: 'MANUAL', ...policy });

  assert.equal(created.studentResults[0].autoDecision, 'NOT_EVALUATED');
  assert.equal(created.studentResults[0].autoReasonCode, 'MANUAL_ONLY');
  assert.deepEqual(created.studentResults.map(({ memberId }) => memberId), ['member-1']);
  const assigned = await service.updateItem(created.draft.id, 'member-1', {
    expectedDraftRevision: 0,
    finalDecision: 'SELECTED',
    finalSemesterCourseId: 'sc-b',
    finalReasonCode: 'ADMIN_OVERRIDE',
    finalReasonDetail: { note: '관리자 수동 배정' },
  });

  assert.equal(assigned.draft.revision, 1);
  assert.deepEqual(assigned.studentResults.map(({ memberId, sourceApplicationId, finalSemesterCourseId }) => (
    [memberId, sourceApplicationId, finalSemesterCourseId]
  )), [['member-1', 'application-1', 'sc-b']]);
  assert.equal(store.read().applications.length, beforeApplications);
  assert.equal(store.read().enrollments.length, 0);
});

test('builds an empty manual draft by existing and new member names, then finalizes the selected courses', async (t) => {
  const data = fixture();
  data.applications = [];
  data.applicationChoices = [];
  const { service, store } = await temporaryService(t, data);
  const created = await service.create({ semesterId: 'semester-1', mode: 'MANUAL', ...policy });
  assert.equal(created.studentResults.length, 0);
  for (const [revision, memberName, semesterCourseId] of [[0, ' 김영희 ', 'sc-a'], [1, '새 회원', 'sc-b']]) {
    const added = await service.addManualItem(created.draft.id, { expectedDraftRevision: revision, memberName, semesterCourseId });
    const item = added.studentResults.find(({ memberNameAtGeneration }) => memberNameAtGeneration === memberName.trim());
    assert.equal(item.finalSemesterCourseId, semesterCourseId);
    assert.equal(item.sourceApplicationId, null);
    assert.equal(item.autoDecision, 'NOT_EVALUATED');
    assert.equal(added.draft.revision, revision + 1);
    assert.equal(added.isStale, false);
  }
  assert.equal(store.read().members.length, 3);
  assert.equal(store.read().applications.length, 0);
  assert.equal(store.read().enrollments.length, 0);
  let finalizationId = 0;
  const finalization = new FinalizationService(store, {
    id: () => `manual-finalization-${++finalizationId}`, now: () => new Date(timestamp), secret: '0123456789abcdef0123456789abcdef',
  });
  const preview = finalization.preview(created.draft.id, { expectedDraftRevision: 2 });
  assert.deepEqual(preview.enrollments.map(({ memberName, courseName }) => [memberName, courseName]).sort(), [['김영희', '기초'], ['새 회원', '심화']]);
  const receipt = await finalization.finalize(created.draft.id, {
    expectedDraftRevision: 2, preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest, acknowledgementNote: '', idempotencyKey: 'manual-finalization',
  });
  assert.equal(receipt.createdCount, 2);
  assert.equal(store.read().enrollments.length, 2);
});

test('rejects invalid manual member additions without partial changes and explains the problem', async (t) => {
  const data = fixture();
  data.enrollments.push(stamped({ id: 'enrolled', semesterCourseId: 'sc-b', memberId: 'member-2', revision: 0, exceptionAcknowledgement: null }));
  const { service, store } = await temporaryService(t, data);
  const manual = await service.create({ semesterId: 'semester-1', mode: 'MANUAL', ...policy });
  const auto = await service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const base = { expectedDraftRevision: 0, memberName: '신규 회원', semesterCourseId: 'sc-a' };
  const cases = [
    { id: auto.draft.id, request: base, expected: /수동 초안/ },
    { request: { ...base, memberName: ' 홍길동 ' }, expected: /이미.*초안/ },
    { request: { ...base, memberName: '김영희' }, expected: /수강이력/ },
    { request: { ...base, semesterCourseId: 'sc-other' }, expected: /개설 강좌/ },
    { request: { ...base, memberName: ' ' }, expected: /회원명/ },
    { request: { ...base, memberName: '가'.repeat(201) }, expected: /회원명/ },
    { request: { ...base, semesterCourseId: null }, expected: /강좌/ },
    { request: null, expected: /입력/ },
  ];
  for (const { id = manual.draft.id, request, expected } of cases) {
    const before = store.read();
    await assert.rejects(service.addManualItem(id, request), (error) => {
      assert.ok(error instanceof DraftValidationError);
      assert.match(error.issues[0].message, expected);
      return true;
    });
    assert.deepEqual(store.read(), before);
  }
  await service.addManualItem(manual.draft.id, base);
  const before = store.read();
  await assert.rejects(service.addManualItem(manual.draft.id, { ...base, memberName: '동시 입력' }), DraftRevisionConflictError);
  assert.deepEqual(store.read(), before);
  await store.write({}, (candidate) => { candidate.allocationDrafts.find(({ id }) => id === manual.draft.id).status = 'ARCHIVED'; });
  await assert.rejects(service.addManualItem(manual.draft.id, { ...base, expectedDraftRevision: 1 }), DraftReadOnlyError);
});

test('keeps a previously saved member without an application available for draft review and editing', async (t) => {
  const { service, store } = await temporaryService(t, fixture());
  const created = await service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  await store.write({}, (data) => {
    data.allocationDraftItems.push({
      ...data.allocationDraftItems[0], id: 'legacy-item', memberId: 'member-2',
      memberNameAtGeneration: '김영희', sourceApplicationId: null,
      autoDecision: 'NOT_EVALUATED', autoSemesterCourseId: null, autoReasonCode: 'MANUAL_ONLY',
      autoReasonDetail: { preferenceAttempts: [], fallback: null },
      finalDecision: 'SELECTED', finalSemesterCourseId: 'sc-b', finalReasonCode: 'ADMIN_ADDED',
      finalReasonDetail: { note: '기존 현장 추가' },
    });
  });
  const detail = service.get(created.draft.id);
  assert.equal(detail.studentResults.find(({ memberId }) => memberId === 'member-2').sourceApplicationId, null);
  assert.equal(detail.courseSummary.find(({ semesterCourseId }) => semesterCourseId === 'sc-b').finalSelectedCount, 1);
  const edited = await service.updateItem(created.draft.id, 'member-2', {
    expectedDraftRevision: 0, finalDecision: 'REJECTED', finalSemesterCourseId: null,
    finalReasonCode: 'ADMIN_EXCLUDED', finalReasonDetail: { note: '기존 행 제외' },
  });
  assert.equal(edited.studentResults.find(({ memberId }) => memberId === 'member-2').finalDecision, 'REJECTED');
  assert.equal(edited.studentResults.length, 2);
  assert.equal(store.read().applications.length, 1);
});

test('reports current semester enrollment members even when their history was registered after draft creation', async (t) => {
  const data = fixture();
  data.enrollments.push(stamped({ id: 'existing-history', semesterCourseId: 'sc-b', memberId: 'member-2', revision: 0, exceptionAcknowledgement: null }));
  const { service, store } = await temporaryService(t, data);
  const created = await service.create({ semesterId: 'semester-1', mode: 'MANUAL', ...policy });
  assert.deepEqual(created.currentEnrolledMembers, [{ id: 'member-2', name: '김영희' }]);
  await store.write({}, (candidate) => {
    candidate.enrollments.push(stamped({ id: 'later-history', semesterCourseId: 'sc-a', memberId: 'member-1', revision: 0, exceptionAcknowledgement: null }));
  });
  const detail = service.get(created.draft.id);
  assert.deepEqual(detail.currentEnrolledMembers, [{ id: 'member-1', name: '홍길동' }, { id: 'member-2', name: '김영희' }]);
  assert.equal(detail.existingEnrollments.length, 1, 'capacity evidence keeps the original snapshot');
  const before = store.read();
  for (const memberName of [' 김영희 ', '홍길동'.normalize('NFD')]) {
    await assert.rejects(service.addManualItem(created.draft.id, { expectedDraftRevision: 0, memberName, semesterCourseId: 'sc-a' }), (error) => {
      assert.match(error.issues[0].message, /같은 학기에 수강이력/);
      return true;
    });
  }
  assert.deepEqual(store.read(), before);
});

test('uses a semantic fingerprint, preserves deleted-source evidence, and replays the stored input', async (t) => {
  const { service, store } = await temporaryService(t, fixture());
  const original = await service.create({ semesterId: 'semester-1', mode: 'AUTO', ...policy });
  const originalAuto = original.studentResults.map(autoProjection);

  await store.write({}, (data) => {
    data.semesters.reverse();
    data.members.reverse();
    data.courses.reverse();
    data.semesterCourses.reverse();
    data.applications.reverse();
    data.applicationChoices.reverse();
    data.members[0].updatedAt = '2026-09-24T00:00:00.000Z';
    data.enrollments.push(stamped({
      id: 'unrelated-enrollment',
      semesterCourseId: 'sc-other',
      memberId: 'member-2',
      exceptionAcknowledgement: null,
      revision: 0,
    }));
    data.enrollments.push(stamped({
      id: 'applicant-future-enrollment',
      semesterCourseId: 'sc-other',
      memberId: 'member-1',
      exceptionAcknowledgement: null,
      revision: 0,
    }));
  });
  assert.equal(service.get(original.draft.id).isStale, false);

  await store.write({}, (data) => {
    data.semesterCourses.push(stamped({
      id: 'sc-past',
      semesterId: 'semester-0',
      courseId: 'course-b',
      capacity: 1,
    }));
    data.enrollments.push(stamped({
      id: 'related-past-enrollment',
      semesterCourseId: 'sc-past',
      memberId: 'member-1',
      exceptionAcknowledgement: null,
      revision: 0,
    }));
  });
  assert.ok(service.get(original.draft.id).inputChanges.some(({ code }) => code === 'PAST_ENROLLMENTS_CHANGED'));
  await store.write({}, (data) => {
    data.enrollments = data.enrollments.filter(({ id }) => id !== 'related-past-enrollment');
    data.semesterCourses = data.semesterCourses.filter(({ id }) => id !== 'sc-past');
  });
  assert.equal(service.get(original.draft.id).isStale, false);

  await store.write({}, (data) => {
    data.semesters.find(({ id }) => id === 'semester-1').order = 4;
  });
  assert.ok(service.get(original.draft.id).inputChanges.some(({ code }) => code === 'SEMESTER_CHANGED'));
  await store.write({}, (data) => {
    data.semesters.find(({ id }) => id === 'semester-1').order = 2;
    data.semesterCourses.find(({ id }) => id === 'sc-a').capacity = 2;
  });
  assert.ok(service.get(original.draft.id).inputChanges.some(({ code }) => code === 'SEMESTER_COURSES_CHANGED'));
  await store.write({}, (data) => {
    data.semesterCourses.find(({ id }) => id === 'sc-a').capacity = 1;
  });
  assert.equal(service.get(original.draft.id).isStale, false);

  await store.write({}, (data) => {
    data.applications = [];
    data.applicationChoices = [];
  });
  const stale = service.get(original.draft.id);
  assert.equal(stale.isStale, true);
  assert.ok(stale.inputChanges.some(({ code }) => code === 'APPLICATION_REMOVED'));
  assert.equal(stale.studentResults[0].sourceApplicationId, 'application-1');
  assert.deepEqual(stale.studentResults.map(autoProjection), originalAuto);

  const replayed = await service.create({
    semesterId: 'semester-1',
    mode: 'AUTO',
    ...policy,
    replayFromDraftId: original.draft.id,
  });
  assert.notEqual(replayed.draft.id, original.draft.id);
  const persisted = store.read().allocationDrafts;
  const originalRecord = persisted.find(({ id }) => id === original.draft.id);
  const replayedRecord = persisted.find(({ id }) => id === replayed.draft.id);
  assert.equal(replayedRecord.randomSeed, originalRecord.randomSeed);
  assert.equal(replayedRecord.inputFingerprint, originalRecord.inputFingerprint);
  assert.deepEqual(replayed.studentResults.map(autoProjection), originalAuto);

  await store.write({}, (data) => {
    data.allocationDrafts.find(({ id }) => id === original.draft.id).engineVersion = '0.0.0';
  });
  await assert.rejects(service.create({
    semesterId: 'semester-1',
    mode: 'AUTO',
    ...policy,
    replayFromDraftId: original.draft.id,
  }), DraftUnsupportedEngineError);
});

const temporaryService = async (t, data) => {
  const workspace = await mkdtemp(join(tmpdir(), 'glorycourse-drafts-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return serviceAt(join(workspace, 'db.sqlite'), data);
};

const serviceAt = async (file, data) => {
  const store = await openStore(file, data);
  let nextId = 0;
  const service = new DraftService(store, {
    id: () => `draft-generated-${++nextId}`,
    now: () => new Date(timestamp),
    seed: () => 'seed-1',
  });
  return { service, store };
};

const named = (value) => stamped({ ...value, nameKey: value.name });
const stamped = (value) => ({ ...value, createdAt: timestamp, updatedAt: timestamp });
const rejection = (expectedDraftRevision, finalReasonCode) => ({
  expectedDraftRevision,
  finalDecision: 'REJECTED',
  finalSemesterCourseId: null,
  finalReasonCode,
  finalReasonDetail: null,
});
const autoProjection = ({ memberId, autoDecision, autoSemesterCourseId, autoReasonCode, autoReasonDetail }) => ({
  memberId,
  autoDecision,
  autoSemesterCourseId,
  autoReasonCode,
  autoReasonDetail,
});
