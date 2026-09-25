import assert from 'node:assert/strict';
import test from 'node:test';

import { ApplicationConflictError, ApplicationService } from '../../backend/src/services/applications.ts';
import {
  EnrollmentAcknowledgementError,
  EnrollmentConflictError,
  EnrollmentService,
  EnrollmentStaleError,
  EnrollmentTokenError,
  EnrollmentValidationError,
} from '../../backend/src/services/enrollments.ts';
import { Store } from '../../backend/src/storage/store.ts';

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

const openServices = async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  let appId = 0;
  let enrollmentId = 0;
  let now = new Date('2026-09-22T00:00:00.000Z');
  return {
    store,
    applications: new ApplicationService(store, {
      id: () => `app-id-${++appId}`,
      now: () => now,
    }),
    enrollments: new EnrollmentService(store, {
      id: () => `enrollment-id-${++enrollmentId}`,
      now: () => now,
      secret: 'local-test-secret-at-least-32-bytes',
    }),
    setNow: (value) => { now = new Date(value); },
  };
};

const createSemester = async (applications, {
  semesterName,
  memberName = '홍길동',
  applicationOrder = 1,
  order,
  courses: courseInputs,
}) => {
  const application = await applications.create({
    semesterName,
    memberName,
    applicationOrder,
    choices: courseInputs.map(({ courseName }, index) => ({ courseName, preference: index + 1 })),
  });
  const context = applications.getSemesterContext(application.semesterId);
  await applications.updateSemesterContext({
    semesterId: application.semesterId,
    expectedRevision: context.allocationInputRevision,
    order,
    semesterCourses: courseInputs,
  });
  return application;
};

const commitCreate = async (enrollments, input, acknowledgementNote) => {
  const preview = enrollments.preview({ action: 'CREATE', ...input });
  return enrollments.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
    ...(acknowledgementNote ? { acknowledgementNote } : {}),
  });
};

test('previews a retake without mutation and records an explicitly acknowledged warning', async () => {
  const { applications, enrollments, store } = await openServices();
  await createSemester(applications, {
    semesterName: '2025 가을',
    order: 1,
    courses: [{ courseName: '기초', capacity: 10 }],
  });
  await commitCreate(enrollments, {
    semesterName: '2025 가을', memberName: '홍길동', courseName: '기초',
  });
  await createSemester(applications, {
    semesterName: '2026 봄',
    order: 2,
    courses: [{ courseName: '기초', capacity: 10 }],
  });
  const beforePreview = store.read();

  const preview = enrollments.preview({
    action: 'CREATE', semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });

  assert.deepEqual(preview.issues.map(({ code }) => code), ['RETAKE']);
  assert.deepEqual(store.read(), beforePreview);
  await assert.rejects(enrollments.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
  }), EnrollmentAcknowledgementError);
  const created = await enrollments.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '재수강을 확인함',
  });
  assert.deepEqual(created.exceptionAcknowledgement, {
    warningDigest: preview.warningDigest,
    note: '재수강을 확인함',
    acknowledgedAt: '2026-09-22T00:00:00.000Z',
  });
});

test('never allows a second enrollment for the same member and semester', async () => {
  const { applications, enrollments, store } = await openServices();
  await createSemester(applications, {
    semesterName: '2026 봄',
    order: 1,
    courses: [
      { courseName: '기초', capacity: 10 },
      { courseName: '심화', capacity: 10 },
    ],
  });
  await commitCreate(enrollments, {
    semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });

  const preview = enrollments.preview({
    action: 'CREATE', semesterName: '2026 봄', memberName: '홍길동', courseName: '심화',
  });

  assert.deepEqual(preview.issues.map(({ code, severity }) => ({ code, severity })), [
    { code: 'SAME_SEMESTER_ENROLLMENT', severity: 'ERROR' },
  ]);
  await assert.rejects(enrollments.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '강제 확인 시도',
  }), EnrollmentConflictError);
  assert.equal(store.read().enrollments.length, 1);
});

test('rejects stale, expired, and previous-epoch preview tokens without changing enrollments', async () => {
  const { applications, enrollments, store, setNow } = await openServices();
  const application = await createSemester(applications, {
    semesterName: '2026 봄',
    order: 1,
    courses: [{ courseName: '기초', capacity: 10 }],
  });
  const request = { action: 'CREATE', semesterName: '2026 봄', memberName: '홍길동', courseName: '기초' };
  const stale = enrollments.preview(request);
  const context = applications.getSemesterContext(application.semesterId);
  await applications.updateSemesterContext({
    semesterId: application.semesterId,
    expectedRevision: context.allocationInputRevision,
    order: 1,
    semesterCourses: [{ courseName: '기초', capacity: 9 }],
  });
  await assert.rejects(enrollments.execute({
    preparedActionToken: stale.preparedActionToken,
    acknowledgedWarningDigest: stale.warningDigest,
  }), EnrollmentStaleError);

  const expired = enrollments.preview(request);
  setNow('2026-09-22T00:06:00.000Z');
  await assert.rejects(enrollments.execute({
    preparedActionToken: expired.preparedActionToken,
    acknowledgedWarningDigest: expired.warningDigest,
  }), EnrollmentTokenError);

  setNow('2026-09-22T00:00:00.000Z');
  const previousEpoch = enrollments.preview(request);
  await store.write({}, (data) => { data.meta.storeEpoch = 'epoch-2'; });
  await assert.rejects(enrollments.execute({
    preparedActionToken: previousEpoch.preparedActionToken,
    acknowledgedWarningDigest: previousEpoch.warningDigest,
  }), EnrollmentStaleError);
  assert.equal(store.read().enrollments.length, 0);
});

test('keeps unresolved semester order and capacity behind explicit warnings', async () => {
  const { applications, enrollments, store } = await openServices();
  const application = await applications.create({
    semesterName: '이관 학기',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: [{ courseName: '과거 강좌', preference: 1 }],
  });
  await store.write({}, (data) => {
    data.semesters.find(({ id }) => id === application.semesterId).order = null;
  });

  const preview = enrollments.preview({
    action: 'CREATE', semesterName: '이관 학기', memberName: '홍길동', courseName: '과거 강좌',
  });

  assert.deepEqual(preview.issues.map(({ code }) => code), [
    'SEMESTER_ORDER_UNRESOLVED',
    'CAPACITY_UNRESOLVED',
  ]);
  const created = await enrollments.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '과거 자료의 미정 값을 유지함',
  });
  assert.equal(created.courseName, '과거 강좌');
  assert.equal(created.exceptionAcknowledgement.note, '과거 자료의 미정 값을 유지함');
});

test('shows a renamed course in existing enrollment history', async () => {
  const { applications, enrollments } = await openServices();
  const application = await createSemester(applications, {
    semesterName: '2026 봄',
    order: 1,
    courses: [{ courseName: '기초', capacity: 10 }],
  });
  const enrollment = await commitCreate(enrollments, {
    semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });
  const context = applications.getSemesterContext(application.semesterId);

  await applications.updateSemesterContext({
    semesterId: application.semesterId,
    expectedRevision: context.allocationInputRevision,
    name: '2026 봄',
    order: 1,
    semesterCourses: [{
      id: context.semesterCourses[0].id,
      courseName: '입문',
      capacity: 10,
    }],
  });

  assert.equal(enrollments.get(enrollment.id).courseName, '입문');
});

test('blocks semester course deletion when enrollment history uses it', async () => {
  const { applications, enrollments } = await openServices();
  const application = await createSemester(applications, {
    semesterName: '2026 봄',
    order: 1,
    courses: [{ courseName: '기초', capacity: 10 }],
  });
  const enrollment = await commitCreate(enrollments, {
    semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });
  const context = applications.getSemesterContext(application.semesterId);
  const course = context.semesterCourses[0];

  assert.deepEqual(
    { applicationCount: course.applicationCount, enrollmentCount: course.enrollmentCount },
    { applicationCount: 1, enrollmentCount: 1 },
  );
  await assert.rejects(applications.deleteSemesterCourse({
    semesterId: application.semesterId,
    semesterCourseId: course.id,
    expectedRevision: context.allocationInputRevision,
    confirmApplications: true,
  }), ApplicationConflictError);
  assert.equal(enrollments.get(enrollment.id).courseName, '기초');
  assert.equal(applications.getSemesterContext(application.semesterId).semesterCourses.length, 1);
});

test('warns when a matching past enrollment has no semester order', async () => {
  const { applications, enrollments, store } = await openServices();
  const application = await applications.create({
    semesterName: '순서 미정 과거',
    memberName: '홍길동',
    applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  await store.write({}, (data) => {
    data.semesters.find(({ id }) => id === application.semesterId).order = null;
  });
  await commitCreate(enrollments, {
    semesterName: '순서 미정 과거', memberName: '홍길동', courseName: '기초',
  }, '과거 학기 순서와 정원은 미정임');
  await createSemester(applications, {
    semesterName: '2026 봄',
    order: 2,
    courses: [{ courseName: '기초', capacity: 10 }],
  });

  const preview = enrollments.preview({
    action: 'CREATE', semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });

  assert.deepEqual(preview.issues.map(({ code }) => code), ['SEMESTER_ORDER_UNRESOLVED']);
});

test('changes an enrollment semester and course, including a newly named course', async () => {
  const { applications, enrollments, store } = await openServices();
  await createSemester(applications, {
    semesterName: '2026 봄',
    order: 1,
    courses: [
      { courseName: '기초', capacity: 10 },
      { courseName: '심화', capacity: 10 },
    ],
  });
  const created = await commitCreate(enrollments, {
    semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });
  await createSemester(applications, {
    semesterName: '2026 가을', memberName: '김영희', order: 2,
    courses: [{ courseName: '기초', capacity: 10 }],
  });
  await store.write({}, (data) => {
    const semesterCourse = data.semesterCourses.find(({ id }) => id === created.semesterCourseId);
    data.allocationDrafts.push({
      id: 'finalized-draft-1',
      semesterId: semesterCourse.semesterId,
      status: 'FINALIZED',
      revision: 0,
      mode: 'AUTO',
      policyId: 'default',
      policyVersion: '1',
      engineVersion: '1.0.0',
      policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' },
      randomSeed: 'seed',
      sourceRevision: 1,
      inputFingerprint: 'fingerprint',
      inputSnapshot: {
        semester: { id: semesterCourse.semesterId, name: '2026 봄', order: 1 },
        semesterCourses: [],
        applications: [],
        choices: [],
        relevantPastEnrollments: [],
        existingEnrollments: [],
      },
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
      finalizedAt: '2026-09-22T00:00:00.000Z',
      enrollmentReportDownloadedAt: null,
      enrollmentReportStoreRevision: null,
      finalization: {
        idempotencyKey: 'key',
        requestHash: 'hash',
        receipt: {
          receiptId: 'receipt',
          draftId: 'finalized-draft-1',
          createdEnrollmentIds: [created.id],
          createdCount: 1,
          finalizedAt: '2026-09-22T00:00:00.000Z',
        },
        acknowledgedWarnings: [],
      },
    });
  });
  const beforeSnapshot = structuredClone(store.read().allocationDrafts);

  const updatePreview = enrollments.preview({
    action: 'UPDATE',
    enrollmentId: created.id,
    expectedRevision: created.revision,
    semesterName: '2026 가을',
    memberName: '홍길동',
    courseName: '신설 강좌',
  });
  const updated = await enrollments.execute({
    preparedActionToken: updatePreview.preparedActionToken,
    acknowledgedWarningDigest: updatePreview.warningDigest,
    acknowledgementNote: '새 강좌의 정원은 나중에 설정함',
  });
  assert.equal(updated.semesterName, '2026 가을');
  assert.equal(updated.courseName, '신설 강좌');
  assert.equal('sourceDraftId' in updated, false);
  assert.ok(store.read().courses.some(({ name }) => name === '신설 강좌'));

  const deletePreview = enrollments.preview({
    action: 'DELETE',
    enrollmentId: updated.id,
    expectedRevision: updated.revision,
    semesterName: '2026 가을',
    memberName: '홍길동',
    courseName: '신설 강좌',
  });
  await enrollments.execute({
    preparedActionToken: deletePreview.preparedActionToken,
    acknowledgedWarningDigest: deletePreview.warningDigest,
  });
  assert.equal(store.read().enrollments.length, 0);
  assert.deepEqual(store.read().allocationDrafts, beforeSnapshot);
});

test('filters enrollments by member name, semester, and course', async () => {
  const { applications, enrollments, store } = await openServices();
  await createSemester(applications, {
    semesterName: '2026 봄', memberName: '설정용', order: 1,
    courses: [{ courseName: '기초', capacity: 10 }, { courseName: '심화', capacity: 10 }],
  });
  await createSemester(applications, {
    semesterName: '2026 가을', memberName: '설정용2', order: 2,
    courses: [{ courseName: '심화', capacity: 10 }],
  });
  await commitCreate(enrollments, { semesterName: '2026 봄', memberName: '홍길동', courseName: '기초' });
  await commitCreate(enrollments, { semesterName: '2026 봄', memberName: '김영희', courseName: '심화' });
  await commitCreate(enrollments, { semesterName: '2026 가을', memberName: '홍서준', courseName: '심화' });
  const data = store.read();
  const springId = data.semesters.find(({ name }) => name === '2026 봄').id;
  const advancedId = data.courses.find(({ name }) => name === '심화').id;

  assert.deepEqual(enrollments.list({ memberName: '홍' }).map(({ memberName }) => memberName), ['홍길동', '홍서준']);
  assert.deepEqual(enrollments.list({ semesterId: springId }).map(({ memberName }) => memberName), ['홍길동', '김영희']);
  assert.deepEqual(enrollments.list({ courseId: advancedId }).map(({ memberName }) => memberName), ['김영희', '홍서준']);
  assert.deepEqual(
    enrollments.list({ memberName: '김', semesterId: springId, courseId: advancedId }).map(({ memberName }) => memberName),
    ['김영희'],
  );
});

test('deletes all histories in a selected semester without changing other semesters or applications', async () => {
  const { applications, enrollments, store } = await openServices();
  await createSemester(applications, {
    semesterName: '2026 봄', memberName: '신청자1', order: 1,
    courses: [{ courseName: '창세기', capacity: 10 }],
  });
  await createSemester(applications, {
    semesterName: '2026 가을', memberName: '신청자2', order: 2,
    courses: [{ courseName: '마태복음', capacity: 10 }],
  });
  await commitCreate(enrollments, { semesterName: '2026 봄', memberName: '회원1', courseName: '창세기' });
  await commitCreate(enrollments, { semesterName: '2026 봄', memberName: '회원2', courseName: '창세기' });
  await commitCreate(enrollments, { semesterName: '2026 가을', memberName: '회원3', courseName: '마태복음' });
  const semesterId = store.read().semesters.find(({ name }) => name === '2026 봄').id;
  const applicationIds = store.read().applications.map(({ id }) => id);

  const stalePreview = enrollments.previewSemesterDeletion(semesterId);
  assert.equal(stalePreview.count, 2);
  await commitCreate(enrollments, { semesterName: '2026 봄', memberName: '회원4', courseName: '창세기' });
  await assert.rejects(enrollments.deleteSemester(semesterId, {
    confirmationName: '2026 봄', expectedRevision: stalePreview.storeRevision,
    expectedEpoch: stalePreview.storeEpoch,
  }), EnrollmentStaleError);
  assert.equal(enrollments.list({ semesterId }).length, 3);

  const preview = enrollments.previewSemesterDeletion(semesterId);
  await assert.rejects(enrollments.deleteSemester(semesterId, {
    confirmationName: '2026 봄', expectedRevision: preview.storeRevision,
    expectedEpoch: 'restored-elsewhere',
  }), EnrollmentStaleError);
  await assert.rejects(enrollments.deleteSemester(semesterId, {
    confirmationName: '2026 가을', expectedRevision: preview.storeRevision,
    expectedEpoch: preview.storeEpoch,
  }), EnrollmentValidationError);
  assert.equal(enrollments.list({ semesterId }).length, 3);

  const result = await enrollments.deleteSemester(semesterId, {
    confirmationName: '2026 봄', expectedRevision: preview.storeRevision,
    expectedEpoch: preview.storeEpoch,
  });
  assert.deepEqual(result, { deletedCount: 3 });
  assert.deepEqual(enrollments.list({ semesterId }), []);
  assert.deepEqual(enrollments.list().map(({ memberName }) => memberName), ['회원3']);
  assert.deepEqual(store.read().applications.map(({ id }) => id), applicationIds);
});

test('rejects a tampered prepared action token', async () => {
  const { applications, enrollments } = await openServices();
  await createSemester(applications, {
    semesterName: '2026 봄', order: 1, courses: [{ courseName: '기초', capacity: 10 }],
  });
  const preview = enrollments.preview({
    action: 'CREATE', semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
  });

  await assert.rejects(enrollments.execute({
    preparedActionToken: `${preview.preparedActionToken}x`,
    acknowledgedWarningDigest: preview.warningDigest,
  }), EnrollmentTokenError);
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
