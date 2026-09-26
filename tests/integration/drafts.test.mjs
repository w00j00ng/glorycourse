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

test('creates a manual draft with invalid automatic input and adds a member without an application', async (t) => {
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
  const added = await service.addItem(created.draft.id, {
    expectedDraftRevision: 0,
    memberId: 'member-2',
    finalDecision: 'SELECTED',
    finalSemesterCourseId: 'sc-b',
    finalReasonCode: 'ADMIN_ADDED',
    finalReasonDetail: { note: '현장 추가' },
  });

  assert.equal(added.draft.revision, 1);
  assert.equal(added.studentResults.find(({ memberId }) => memberId === 'member-2').sourceApplicationId, null);
  assert.equal(store.read().applications.length, beforeApplications);
  assert.equal(store.read().enrollments.length, 0);
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
