import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationConflictError,
  ApplicationNotFoundError,
  ApplicationService,
  ApplicationValidationError,
  RevisionConflictError,
} from '../../backend/src/services/applications.ts';
import { Store, StoreEpochConflictError, StoreRevisionConflictError } from '../../backend/src/storage/store.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';
import { EnrollmentService } from '../../backend/src/services/enrollments.ts';

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

const openService = async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  let id = 0;
  return {
    store,
    service: new ApplicationService(store, {
      id: () => `id-${++id}`,
      now: () => new Date('2026-09-22T00:00:00.000Z'),
    }),
  };
};

test('resolves trimmed NFC names, preserves the first display name, and accepts preference gaps', async () => {
  const { service, store } = await openService();
  const request = {
    semesterName: '  2026 봄  ',
    memberName: '  Hong e\u0301  ',
    applicationOrder: 7,
    choices: [
      { courseName: '  기초 A  ', preference: 1 },
      { courseName: '기초 C', preference: 3 },
    ],
  };

  const created = await service.create(request);

  assert.equal(created.semesterName, '2026 봄');
  assert.equal(created.memberName, 'Hong e\u0301');
  assert.deepEqual(created.choices.map(({ courseName, preference }) => ({ courseName, preference })), [
    { courseName: '기초 A', preference: 1 },
    { courseName: '기초 C', preference: 3 },
  ]);
  assert.equal(store.read().members[0].nameKey, 'Hong é');

  await assert.rejects(service.create({
    ...request,
    semesterName: '2026 봄',
    memberName: 'Hong é',
  }), ApplicationConflictError);
  assert.deepEqual(
    ['semesters', 'members', 'courses', 'semesterCourses', 'applications', 'applicationChoices']
      .map((key) => store.read()[key].length),
    [1, 1, 2, 2, 1, 2],
  );
});

test('does not merge names that differ by internal whitespace or case', async () => {
  const { service, store } = await openService();
  const base = {
    semesterName: '2026 봄',
    applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  };

  await service.create({ ...base, memberName: 'Kim Min' });
  await service.create({ ...base, memberName: 'kim  min', applicationOrder: 2 });

  assert.deepEqual(store.read().members.map(({ nameKey }) => nameKey), ['Kim Min', 'kim  min']);
});

test('rejects invalid direct input without leaving resolved master records', async () => {
  const { service, store } = await openService();
  const request = {
    semesterName: '2026 봄',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 0 }],
  };

  await assert.rejects(service.create(request), ApplicationValidationError);

  assert.deepEqual(store.read(), emptyStore());
});

test('accepts up to five preferences and atomically rejects a sixth in all input paths', async () => {
  const { service, store } = await openService();
  const request = (count) => ({
    semesterName: '2026 봄', memberName: `${count}개 신청`, applicationOrder: count,
    choices: Array.from({ length: count }, (_, index) => ({ courseName: `강좌 ${index + 1}`, preference: index + 1 })),
  });
  for (const count of [3, 5]) {
    const created = await service.create(request(count));
    assert.deepEqual(created.choices.map(({ courseName, preference }) => ({ courseName, preference })), request(count).choices);
  }
  const existing = service.list({})[0];
  const before = store.read();
  for (const invalid of [request(6), { ...request(1), choices: [{ courseName: '강좌 6', preference: 6 }] }]) {
    await assert.rejects(service.create(invalid), ApplicationValidationError);
    await assert.rejects(service.update(existing.id, { ...invalid, expectedRevision: existing.revision }), ApplicationValidationError);
    await assert.rejects(service.createMany([request(1), invalid]), ApplicationValidationError);
    assert.deepEqual(store.read(), before);
  }
});

test('updates an application atomically and rejects a stale application revision', async () => {
  const { service, store } = await openService();
  const created = await service.create({
    semesterName: '2026 봄',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  const request = {
    expectedRevision: 0,
    semesterName: '2026 봄',
    memberName: '홍길동',
    applicationOrder: 2,
    choices: [{ courseName: '심화', preference: 1 }],
  };

  const updated = await service.update(created.id, request);

  assert.equal(updated.revision, 1);
  assert.equal(updated.applicationOrder, 2);
  assert.deepEqual(updated.choices.map(({ courseName }) => courseName), ['심화']);
  await assert.rejects(service.update(created.id, request), RevisionConflictError);
  assert.equal(store.read().applications.length, 1);
  assert.equal(store.read().applicationChoices.length, 1);
});

test('assigns an order when updating a legacy semester whose order is unknown', async () => {
  const { service, store } = await openService();
  const created = await service.create({
    semesterName: '2026 봄',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  await store.write({}, (data) => {
    data.semesters.find(({ id }) => id === created.semesterId).order = null;
  });
  const initial = await service.getSemesterContext(created.semesterId);
  const request = {
    semesterId: created.semesterId,
    expectedRevision: initial.allocationInputRevision,
    order: null,
    semesterCourses: [{ courseName: '기초', capacity: 0 }],
  };

  const updated = await service.updateSemesterContext(request);

  assert.equal(updated.order, 1);
  assert.equal(updated.semesterCourses[0].capacity, 0);
  assert.equal(updated.readyForAutoAllocation, true);
  await assert.rejects(service.updateSemesterContext(request), RevisionConflictError);
});

test('moves a newly added semester between existing semesters without duplicate order', async () => {
  const { service, store } = await openService();
  const spring = await service.createSemester({ name: '2026 봄', order: null });
  const summer = await service.createSemester({ name: '2026 여름', order: null });
  const fall = await service.createSemester({ name: '2026 가을', order: null });

  const moved = await service.moveSemester({
    semesterId: fall.semester.id, direction: 'DOWN', expectedOrder: 3,
    adjacentSemesterId: summer.semester.id,
  });

  assert.equal(moved.order, 2);
  assert.deepEqual(
    store.read().semesters.map(({ name, order, allocationInputRevision }) => ({ name, order, allocationInputRevision })),
    [
      { name: '2026 봄', order: 1, allocationInputRevision: 0 },
      { name: '2026 여름', order: 3, allocationInputRevision: 1 },
      { name: '2026 가을', order: 2, allocationInputRevision: 1 },
    ],
  );
  const before = store.read();
  await assert.rejects(service.moveSemester({
    semesterId: fall.semester.id, direction: 'DOWN', expectedOrder: 3,
    adjacentSemesterId: summer.semester.id,
  }), ApplicationConflictError);
  assert.deepEqual(store.read(), before);
  const restored = await service.moveSemester({
    semesterId: fall.semester.id, direction: 'UP', expectedOrder: 2,
    adjacentSemesterId: summer.semester.id,
  });
  assert.equal(restored.order, 3);
  assert.equal(spring.order, 1);
});

test('creates and renames semesters and courses while preserving linked applications', async () => {
  const { service } = await openService();
  const spring = await service.createSemester({ name: '2026 봄', order: 1 });
  let springContext = await service.updateSemesterContext({
    semesterId: spring.semester.id,
    expectedRevision: spring.allocationInputRevision,
    name: '2026 봄',
    order: 1,
    semesterCourses: [{ courseName: '기초', capacity: 10 }],
  });
  const springApplication = await service.create({
    semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  const fall = await service.createSemester({ name: '2026 가을', order: 2 });
  await service.updateSemesterContext({
    semesterId: fall.semester.id,
    expectedRevision: fall.allocationInputRevision,
    name: '2026 가을',
    order: 2,
    semesterCourses: [{ courseName: '기초', capacity: 8 }],
  });
  const fallApplication = await service.create({
    semesterName: '2026 가을', memberName: '김영희', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });

  springContext = service.getSemesterContext(spring.semester.id);
  const renamed = await service.updateSemesterContext({
    semesterId: spring.semester.id,
    expectedRevision: springContext.allocationInputRevision,
    name: '2026 봄학기',
    order: 1,
    semesterCourses: [{
      id: springContext.semesterCourses[0].id,
      courseName: '입문',
      capacity: 12,
    }],
  });

  assert.equal(renamed.semester.name, '2026 봄학기');
  assert.deepEqual(renamed.semesterCourses.map(({ courseName, capacity }) => ({ courseName, capacity })), [
    { courseName: '입문', capacity: 12 },
  ]);
  assert.equal(service.get(springApplication.id).semesterName, '2026 봄학기');
  assert.equal(service.get(springApplication.id).choices[0].courseName, '입문');
  assert.equal(service.get(fallApplication.id).choices[0].courseName, '입문');
  assert.equal(service.getSemesterContext(fall.semester.id).semesterCourses[0].courseName, '입문');
});

test('requires capacity for a newly opened course without changing the semester', async () => {
  const { service, store } = await openService();
  const semester = await service.createSemester({ name: '2026 가을', order: 1 });
  const request = {
    semesterId: semester.semester.id,
    expectedRevision: semester.allocationInputRevision,
    name: '2026 가을',
    order: 1,
    semesterCourses: [{ courseName: '창세기', capacity: null }],
  };
  const before = store.read();

  await assert.rejects(service.updateSemesterContext(request), ApplicationValidationError);
  assert.deepEqual(store.read(), before);
  const updated = await service.updateSemesterContext({
    ...request,
    semesterCourses: [{ courseName: '창세기', capacity: 0 }],
  });
  assert.equal(updated.semesterCourses[0].capacity, 0);
});

test('deletes an unused semester course while retaining a course used by another semester', async () => {
  const { service, store } = await openService();
  const spring = await service.createSemester({ name: '2026 봄', order: 1 });
  let springContext = await service.updateSemesterContext({
    semesterId: spring.semester.id,
    expectedRevision: spring.allocationInputRevision,
    name: '2026 봄',
    order: 1,
    semesterCourses: [{ courseName: '기초', capacity: 10 }],
  });
  const fall = await service.createSemester({ name: '2026 가을', order: 2 });
  await service.updateSemesterContext({
    semesterId: fall.semester.id,
    expectedRevision: fall.allocationInputRevision,
    name: '2026 가을',
    order: 2,
    semesterCourses: [{ courseName: '기초', capacity: 8 }],
  });
  springContext = service.getSemesterContext(spring.semester.id);
  const course = springContext.semesterCourses[0];

  assert.deepEqual(
    { applicationCount: course.applicationCount, enrollmentCount: course.enrollmentCount },
    { applicationCount: 0, enrollmentCount: 0 },
  );
  await service.deleteSemesterCourse({
    semesterId: spring.semester.id,
    semesterCourseId: course.id,
    expectedRevision: springContext.allocationInputRevision,
    confirmApplications: false,
  });

  assert.equal(service.getSemesterContext(spring.semester.id).semesterCourses.length, 0);
  assert.equal(service.getSemesterContext(fall.semester.id).semesterCourses[0].courseName, '기초');
  assert.deepEqual(store.read().courses.map(({ name }) => name), ['기초']);
});

test('deletes an unused semester and its offerings while retaining courses shared with another semester', async () => {
  const { service, store } = await openService();
  const spring = await service.createSemester({ name: '2026 봄', order: 1 });
  const springContext = await service.updateSemesterContext({
    semesterId: spring.semester.id, expectedRevision: 0, name: '2026 봄', order: 1,
    semesterCourses: [{ courseName: '창세기', capacity: 10 }, { courseName: '마태복음', capacity: 10 }],
  });
  const fall = await service.createSemester({ name: '2026 가을', order: 2 });
  await service.updateSemesterContext({
    semesterId: fall.semester.id, expectedRevision: 0, name: '2026 가을', order: 2,
    semesterCourses: [{ courseName: '창세기', capacity: 10 }],
  });

  await service.deleteSemester({ semesterId: spring.semester.id, expectedRevision: springContext.allocationInputRevision });

  assert.deepEqual(store.read().semesters.map(({ name }) => name), ['2026 가을']);
  assert.deepEqual(store.read().courses.map(({ name }) => name), ['창세기']);
  assert.deepEqual(service.getSemesterContext(fall.semester.id).semesterCourses.map(({ courseName }) => courseName), ['창세기']);
});

test('keeps a semester with applications, enrollments, drafts, or finalization records', async () => {
  for (const use of ['application', 'enrollment', 'draft', 'finalization']) {
    const { service, store } = await openService();
    const semester = await service.createSemester({ name: '2026 봄', order: 1 });
    const context = await service.updateSemesterContext({
      semesterId: semester.semester.id, expectedRevision: 0, name: '2026 봄', order: 1,
      semesterCourses: [{ courseName: '창세기', capacity: 10 }],
    });
    if (use === 'application') await service.create({
      semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1,
      choices: [{ courseName: '창세기', preference: 1 }],
    });
    if (use === 'enrollment') await store.write({}, (data) => {
      data.members.push({ id: 'member-1', name: '홍길동', nameKey: '홍길동', createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' });
      data.enrollments.push({ id: 'enrollment-1', memberId: 'member-1', affiliation: null, semesterCourseId: context.semesterCourses[0].id,
        exceptionAcknowledgement: null, revision: 0, createdAt: '2026-09-25T00:00:00.000Z', updatedAt: '2026-09-25T00:00:00.000Z' });
    });
    if (use === 'draft') await new DraftService(store, {
      id: () => 'draft-1', seed: () => 'seed', now: () => new Date('2026-09-25T00:00:00.000Z'),
    }).create({ semesterId: semester.semester.id, mode: 'MANUAL', policyId: 'course-allocation',
      policyVersion: '1.0.0', policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' } });
    if (use === 'finalization') await store.write({}, (data) => {
      data.finalizationReceipts.push({ idempotencyKey: 'key-1', requestHash: 'a'.repeat(64), semesterId: semester.semester.id,
        receipt: { receiptId: 'receipt-1', draftId: 'draft-1', createdEnrollmentIds: [], createdCount: 0, finalizedAt: '2026-09-25T00:00:00.000Z' },
        enrollmentReportDownloadedAt: null, enrollmentReportStoreRevision: null });
    });
    const before = store.read();
    await assert.rejects(service.deleteSemester({ semesterId: semester.semester.id,
      expectedRevision: service.getSemesterContext(semester.semester.id).allocationInputRevision }),
      ApplicationConflictError, use);
    assert.deepEqual(store.read(), before, use);
  }
});

test('does not delete a semester using a stale revision', async () => {
  const { service, store } = await openService();
  const semester = await service.createSemester({ name: '2026 봄', order: 1 });
  await service.updateSemesterContext({ semesterId: semester.semester.id, expectedRevision: 0,
    name: '2026 봄', order: 1, semesterCourses: [{ courseName: '창세기', capacity: 10 }] });
  const before = store.read();
  await assert.rejects(service.deleteSemester({ semesterId: semester.semester.id, expectedRevision: 0 }), RevisionConflictError);
  assert.deepEqual(store.read(), before);
});

test('requires confirmation before removing choices and deletes applications left empty', async () => {
  const { service, store } = await openService();
  const emptyAfterDeletion = await service.create({
    semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  const retained = await service.create({
    semesterName: '2026 봄', memberName: '김영희', applicationOrder: 2,
    choices: [
      { courseName: '기초', preference: 1 },
      { courseName: '심화', preference: 2 },
    ],
  });
  const context = service.getSemesterContext(emptyAfterDeletion.semesterId);
  const course = context.semesterCourses.find(({ courseName }) => courseName === '기초');

  assert.deepEqual(
    { applicationCount: course.applicationCount, enrollmentCount: course.enrollmentCount },
    { applicationCount: 2, enrollmentCount: 0 },
  );
  const request = {
    semesterId: emptyAfterDeletion.semesterId,
    semesterCourseId: course.id,
    expectedRevision: context.allocationInputRevision,
    confirmApplications: false,
  };
  await assert.rejects(service.deleteSemesterCourse(request), ApplicationConflictError);
  assert.equal(service.list().length, 2);

  await service.deleteSemesterCourse({ ...request, confirmApplications: true });

  assert.deepEqual(service.list().map(({ id }) => id), [retained.id]);
  assert.deepEqual(service.get(retained.id).choices.map(({ courseName, preference }) => ({ courseName, preference })), [
    { courseName: '심화', preference: 2 },
  ]);
  assert.equal(service.get(retained.id).revision, 1);
  assert.deepEqual(store.read().courses.map(({ name }) => name), ['심화']);
});

test('deletes only the selected application and keeps shared masters', async () => {
  const { service, store } = await openService();
  const created = await service.create({
    semesterName: '2026 봄',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });

  await service.delete(created.id, { expectedRevision: 0 });

  const data = store.read();
  assert.equal(data.applications.length, 0);
  assert.equal(data.applicationChoices.length, 0);
  assert.deepEqual(
    [data.semesters.length, data.members.length, data.courses.length, data.semesterCourses.length],
    [1, 1, 1, 1],
  );
});

test('deletes every application and choice in one semester while preserving histories and saved drafts', async () => {
  const { service, store } = await openService();
  const [spring, , fall] = await service.createMany([
    { semesterName: '2026 봄', memberName: '회원1', applicationOrder: 1,
      choices: [{ courseName: '기초', preference: 1 }, { courseName: '심화', preference: 2 }] },
    { semesterName: '2026 봄', memberName: '회원2', applicationOrder: 2,
      choices: [{ courseName: '심화', preference: 1 }] },
    { semesterName: '2026 가을', memberName: '회원1', applicationOrder: 1,
      choices: [{ courseName: '기초', preference: 1 }] },
  ]);
  const context = service.getSemesterContext(spring.semesterId);
  await service.updateSemesterContext({
    semesterId: spring.semesterId, expectedRevision: context.allocationInputRevision,
    name: '2026 봄', order: context.order,
    semesterCourses: context.semesterCourses.map((course) => ({ ...course, capacity: 10 })),
  });
  const enrollments = new EnrollmentService(store, {
    id: () => 'enrollment-1', now: () => new Date('2026-09-25T00:00:00.000Z'), secret: Buffer.alloc(32, 1),
  });
  const history = enrollments.preview({ action: 'CREATE', semesterName: '2026 봄', memberName: '회원1', courseName: '기초' });
  await enrollments.execute({ preparedActionToken: history.preparedActionToken, acknowledgedWarningDigest: history.warningDigest });
  let draftId = 0;
  const drafts = new DraftService(store, {
    id: () => `draft-${++draftId}`, seed: () => 'seed', now: () => new Date('2026-09-25T00:00:00.000Z'),
  });
  const draft = await drafts.create({ semesterId: spring.semesterId, mode: 'MANUAL', policyId: 'course-allocation',
    policyVersion: '1.0.0', policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' } });
  assert.equal(drafts.get(draft.draft.id).isStale, false);
  const before = store.read();
  const preview = service.previewSemesterApplicationDeletion(spring.semesterId);
  assert.deepEqual(preview, { semesterName: '2026 봄', count: 2, ...store.version() });

  const result = await service.deleteSemesterApplications(spring.semesterId, {
    confirmationName: preview.semesterName, expectedRevision: preview.storeRevision, expectedEpoch: preview.storeEpoch,
  });

  assert.deepEqual(result, { deletedCount: 2 });
  assert.deepEqual(service.list({ semesterId: spring.semesterId }), []);
  assert.deepEqual(service.get(fall.id), fall);
  const after = store.read();
  assert.deepEqual(after.applicationChoices, before.applicationChoices.filter(({ applicationId }) => applicationId === fall.id));
  for (const key of ['members', 'courses', 'semesterCourses', 'enrollments', 'allocationDrafts', 'allocationDraftItems']) {
    assert.deepEqual(after[key], before[key], key);
  }
  assert.deepEqual(after.semesters.find(({ id }) => id === fall.semesterId), before.semesters.find(({ id }) => id === fall.semesterId));
  assert.equal(service.getSemesterContext(spring.semesterId).allocationInputRevision, context.allocationInputRevision + 2);
  assert.equal(drafts.get(draft.draft.id).isStale, true);
});

test('rejects unconfirmed, stale, missing, and empty semester application deletion without changing data', async () => {
  const { service, store } = await openService();
  const application = await service.create({ semesterName: '2026 봄', memberName: '회원1', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }] });
  const preview = service.previewSemesterApplicationDeletion(application.semesterId);
  const request = { confirmationName: '2026 봄', expectedRevision: preview.storeRevision, expectedEpoch: preview.storeEpoch };
  const before = store.read();
  for (const invalid of [null, {}, { ...request, confirmationName: '2026 가을' },
    { ...request, confirmationName: ' 2026 봄 ' }, { ...request, confirmationName: 1 },
    { ...request, expectedRevision: -1 }, { ...request, expectedRevision: 1.5 },
    { ...request, expectedRevision: String(request.expectedRevision) },
    { ...request, expectedEpoch: '' }, { ...request, expectedEpoch: null }]) {
    await assert.rejects(service.deleteSemesterApplications(application.semesterId, invalid), ApplicationValidationError);
    assert.deepEqual(store.read(), before);
  }
  await assert.rejects(service.deleteSemesterApplications(application.semesterId, { ...request, expectedEpoch: 'older-epoch' }), StoreEpochConflictError);
  assert.throws(() => service.previewSemesterApplicationDeletion('missing'), ApplicationNotFoundError);
  await assert.rejects(service.deleteSemesterApplications('missing', request), ApplicationNotFoundError);
  assert.deepEqual(store.read(), before);

  await service.create({ semesterName: '2026 봄', memberName: '회원2', applicationOrder: 2,
    choices: [{ courseName: '기초', preference: 1 }] });
  const afterCreate = store.read();
  await assert.rejects(service.deleteSemesterApplications(application.semesterId, request), StoreRevisionConflictError);
  assert.deepEqual(store.read(), afterCreate);
  const empty = await service.createSemester({ name: '빈 학기', order: 2 });
  const emptyPreview = service.previewSemesterApplicationDeletion(empty.semester.id);
  assert.equal(emptyPreview.count, 0);
  const beforeEmptyDeletion = store.read();
  await assert.rejects(service.deleteSemesterApplications(empty.semester.id, {
    confirmationName: emptyPreview.semesterName, expectedRevision: emptyPreview.storeRevision, expectedEpoch: emptyPreview.storeEpoch,
  }), ApplicationValidationError);
  assert.deepEqual(store.read(), beforeEmptyDeletion);
});

test('filters applications by member name, semester, and course', async () => {
  const { service, store } = await openService();
  await service.create({
    semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  await service.create({
    semesterName: '2026 봄', memberName: '김영희', applicationOrder: 2,
    choices: [{ courseName: '심화', preference: 1 }],
  });
  await service.create({
    semesterName: '2026 가을', memberName: '홍서준', applicationOrder: 1,
    choices: [{ courseName: '심화', preference: 1 }],
  });
  const data = store.read();
  const springId = data.semesters.find(({ name }) => name === '2026 봄').id;
  const advancedId = data.courses.find(({ name }) => name === '심화').id;

  assert.deepEqual(service.list({ memberName: '홍' }).map(({ memberName }) => memberName), ['홍길동', '홍서준']);
  assert.deepEqual(service.list({ semesterId: springId }).map(({ memberName }) => memberName), ['홍길동', '김영희']);
  assert.deepEqual(service.list({ courseId: advancedId }).map(({ memberName }) => memberName), ['김영희', '홍서준']);
  assert.deepEqual(
    service.list({ memberName: '김', semesterId: springId, courseId: advancedId }).map(({ memberName }) => memberName),
    ['김영희'],
  );
});

class MemoryAdapter {
  constructor(data) {
    this.data = structuredClone(data);
  }

  async read() {
    return structuredClone(this.data);
  }

  async write(data) {
    this.data = structuredClone(data);
  }
}
