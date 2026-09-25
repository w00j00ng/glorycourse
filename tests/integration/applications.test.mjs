import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ApplicationConflictError,
  ApplicationService,
  ApplicationValidationError,
  RevisionConflictError,
} from '../../backend/src/services/applications.ts';
import { Store } from '../../backend/src/storage/store.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';

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
      data.enrollments.push({ id: 'enrollment-1', memberId: 'member-1', semesterCourseId: context.semesterCourses[0].id,
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
