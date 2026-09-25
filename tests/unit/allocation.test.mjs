import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  AllocationValidationError,
  MAX_ALLOCATION_APPLICANTS,
  allocate,
} from '../../backend/src/allocation/engine.ts';

const policy = (preferenceMode = 'NEW_FIRST') => ({
  preferenceMode,
  fallbackMode: 'MAX_CARDINALITY_PRIORITIZED',
});

const course = (id, capacity) => ({
  id,
  courseId: `course-${id}`,
  courseName: id,
  capacity,
});

const application = (memberId, order, choices) => ({
  id: `application-${memberId}`,
  memberId,
  memberName: memberId,
  applicationOrder: order,
  applicationOrderStatus: 'NORMAL',
  choices: choices.map(([semesterCourseId, preference], index) => ({
    id: `choice-${memberId}-${index}`,
    semesterCourseId,
    preference,
  })),
});

const snapshot = ({ courses, applications, past = [], existing = [] }) => {
  const choices = applications.flatMap(({ id: applicationId, choices: items }) => (
    items.map((choice) => ({ ...choice, applicationId }))
  ));
  return {
    semester: { id: 'semester-target', name: '대상 학기', order: 2 },
    semesterCourses: courses,
    applications: applications.map(({ choices: _choices, ...item }) => item),
    choices,
    relevantPastEnrollments: past,
    existingEnrollments: existing,
  };
};

const past = (memberId, courseId, semesterOrder = 1) => ({
  memberId,
  courseId,
  semesterId: `past-${memberId}-${courseId}`,
  semesterOrder,
});

const itemFor = (result, memberId) => result.items.find((item) => item.memberId === memberId);

test('distinguishes new-first from rank-first preference allocation', () => {
  const input = snapshot({
    courses: [course('X', 0), course('Y', 1)],
    applications: [
      application('A-new', 2, [['X', 1], ['Y', 2]]),
      application('B-existing', 1, [['Y', 1]]),
    ],
    past: [past('B-existing', 'unrelated')],
  });

  const newFirst = allocate(input, policy('NEW_FIRST'), 'policy-seed');
  const rankFirst = allocate(input, policy('RANK_FIRST'), 'policy-seed');

  assert.equal(itemFor(newFirst, 'A-new').autoSemesterCourseId, 'Y');
  assert.equal(itemFor(newFirst, 'B-existing').autoDecision, 'REJECTED');
  assert.equal(itemFor(rankFirst, 'B-existing').autoSemesterCourseId, 'Y');
  assert.equal(itemFor(rankFirst, 'A-new').autoDecision, 'REJECTED');
  assert.equal(
    itemFor(newFirst, 'A-new').autoReasonDetail.preferenceAttempts[0].reasonCode,
    'CAPACITY_FULL',
  );

  const tieSeed = 'preference-tie-seed';
  const tied = allocate(snapshot({
    courses: [course('X', 1)],
    applications: [application('A', 1, [['X', 1]]), application('B', 1, [['X', 1]])],
  }), policy(), tieSeed);
  const expectedWinner = Buffer.compare(
    studentKey(tieSeed, 'preference-student', 'A'),
    studentKey(tieSeed, 'preference-student', 'B'),
  ) < 0 ? 'A' : 'B';
  assert.equal(tied.items.find(({ autoDecision }) => autoDecision === 'SELECTED').memberId, expectedWinner);
});

test('uses numeric application order for both preferred and fallback course competition', () => {
  const orders = [10, 1, 20, 2, 11];
  const cases = [
    { courses: [course('X', 2)], requested: 'X', expectedCourse: 'X' },
    { courses: [course('X', 0), course('Y', 2)], requested: 'X', expectedCourse: 'Y' },
  ];
  for (const { courses, requested, expectedCourse } of cases) {
    const input = snapshot({
      courses,
      applications: orders.map((order) => application(`M${order}`, order, [[requested, 1]])),
    });
    const result = allocate(input, policy(), 'numeric-order-seed');
    assert.deepEqual(
      result.items.filter(({ autoSemesterCourseId }) => autoSemesterCourseId === expectedCourse)
        .map(({ memberId }) => memberId).sort(),
      ['M1', 'M2'],
      expectedCourse,
    );
  }
});

test('uses an augmenting path for fallback and distinguishes no candidate from competition loss', () => {
  const seed = seedWhereAExploresXFirst();
  const augmenting = snapshot({
    courses: [course('P', 0), course('X', 1), course('Y', 1)],
    applications: [
      application('A', 1, [['P', 1]]),
      application('B', 2, [['P', 1]]),
    ],
    past: [past('A', 'unrelated'), past('B', 'course-Y')],
  });

  const matched = allocate(augmenting, policy(), seed);

  assert.equal(itemFor(matched, 'A').autoSemesterCourseId, 'Y');
  assert.equal(itemFor(matched, 'B').autoSemesterCourseId, 'X');
  assert.equal(itemFor(matched, 'A').autoReasonCode, 'RANDOM_FALLBACK');
  assert.equal(itemFor(matched, 'A').autoReasonDetail.fallback.totalAssignedInStage, 2);

  const constrained = snapshot({
    courses: [course('P', 0), course('X', 1)],
    applications: [
      application('A', 1, [['P', 1]]),
      application('B', 2, [['P', 1]]),
      application('C', 3, [['P', 1], ['X', 2]]),
    ],
    past: [past('A', 'unrelated'), past('B', 'unrelated'), past('C', 'course-X')],
  });
  const result = allocate(constrained, policy(), 'reason-seed');

  assert.equal(itemFor(result, 'B').autoReasonCode, 'FALLBACK_COMPETITION_LOST');
  assert.deepEqual(itemFor(result, 'B').autoReasonDetail.fallback.stageCandidateSemesterCourseIds, ['X']);
  assert.equal(itemFor(result, 'C').autoReasonCode, 'NO_FALLBACK_COURSE');
  assert.deepEqual(itemFor(result, 'C').autoReasonDetail.fallback.stageCandidateSemesterCourseIds, []);
});

test('reserves current enrollments and records capacity and retake reasons', () => {
  const input = snapshot({
    courses: [course('X', 1), course('Y', 1)],
    applications: [
      application('A', 1, [['X', 1]]),
      application('B', 2, [['X', 1]]),
    ],
    past: [
      past('B', 'course-X', 1),
      past('B', 'course-Y', 3),
      past('unrelated', 'course-X', null),
    ],
    existing: [{
      id: 'enrollment-current', memberId: 'C', memberName: 'C', semesterCourseId: 'X',
    }],
  });

  const result = allocate(input, policy(), 'history-seed');

  assert.equal(itemFor(result, 'C'), undefined);
  assert.deepEqual(result.existingEnrollments, [{
    enrollmentId: 'enrollment-current',
    memberId: 'C',
    memberNameAtGeneration: 'C',
    semesterCourseId: 'X',
    reasonCode: 'ALREADY_ENROLLED',
  }]);
  assert.equal(itemFor(result, 'A').autoReasonDetail.preferenceAttempts[0].reasonCode, 'CAPACITY_FULL');
  assert.equal(itemFor(result, 'B').autoReasonDetail.preferenceAttempts[0].reasonCode, 'ALREADY_TAKEN');
  assert.ok(itemFor(result, 'B').autoReasonDetail.fallback.stageCandidateSemesterCourseIds.includes('Y'));
  assert.deepEqual(
    result.courseSummary.find(({ semesterCourseId }) => semesterCourseId === 'X'),
    {
      semesterCourseId: 'X', capacity: 1, existingEnrollmentCount: 1,
      preferenceAssignedCount: 0, fallbackAssignedCount: 0, remaining: 0,
    },
  );

  const unresolved = structuredClone(input);
  unresolved.relevantPastEnrollments.push(past('A', 'course-Y', null));
  assert.throws(
    () => allocate(unresolved, policy(), 'history-seed'),
    (error) => error instanceof AllocationValidationError
      && error.issues.some(({ code, memberId }) => code === 'SEMESTER_ORDER_UNRESOLVED' && memberId === 'A'),
  );
});

test('never moves preference or current-enrollment assignments during fallback', () => {
  const preferenceFixed = allocate(snapshot({
    courses: [course('P', 0), course('X', 1), course('Y', 1)],
    applications: [
      application('A', 1, [['X', 1], ['Y', 2]]),
      application('B', 2, [['P', 1]]),
    ],
    past: [past('B', 'course-Y')],
  }), policy(), 'fixed-seed');

  assert.equal(itemFor(preferenceFixed, 'A').autoSemesterCourseId, 'X');
  assert.equal(itemFor(preferenceFixed, 'B').autoDecision, 'REJECTED');
  assert.equal(itemFor(preferenceFixed, 'B').autoReasonCode, 'NO_FALLBACK_COURSE');

  const existingFixed = allocate(snapshot({
    courses: [course('X', 1)],
    applications: [],
    existing: [
      { id: 'existing-1', memberId: 'C', memberName: 'C', semesterCourseId: 'X' },
      { id: 'existing-2', memberId: 'D', memberName: 'D', semesterCourseId: 'X' },
    ],
  }), policy(), 'fixed-seed');
  assert.equal(existingFixed.items.length, 0);
  assert.equal(existingFixed.existingEnrollments.length, 2);
  assert.equal(existingFixed.courseSummary[0].remaining, 0);
  assert.ok(existingFixed.issues.some(({ code }) => code === 'EXISTING_CAPACITY_EXCEEDED'));
});

test('is invariant to input array order and does not mutate its snapshot', () => {
  const input = snapshot({
    courses: [course('P', 0), course('X', 1), course('Y', 1)],
    applications: [
      application('A', 1, [['P', 1]]),
      application('B', 1, [['P', 1]]),
      application('C', 2, [['P', 1]]),
    ],
  });
  const before = structuredClone(input);
  const permuted = structuredClone(input);
  permuted.semesterCourses.reverse();
  permuted.applications.reverse();
  permuted.choices.reverse();

  const expected = allocate(input, policy(), 'stable-seed');
  const actual = allocate(permuted, policy(), 'stable-seed');

  assert.deepEqual(actual, expected);
  assert.deepEqual(input, before);
});

test('rejects unresolved inputs and applicant counts over the published limit', () => {
  const invalid = snapshot({
    courses: [course('X', null)],
    applications: [{
      ...application('A', 1, [['X', 1]]),
      applicationOrderStatus: 'CONFLICT',
      applicationOrder: null,
    }],
  });
  invalid.semester.order = null;

  assert.throws(
    () => allocate(invalid, policy(), 'invalid-seed'),
    (error) => error instanceof AllocationValidationError
      && error.issues.some(({ code }) => code === 'SEMESTER_ORDER_UNRESOLVED')
      && error.issues.some(({ code }) => code === 'CAPACITY_UNRESOLVED')
      && error.issues.some(({ code }) => code === 'APPLICATION_ORDER_UNRESOLVED'),
  );

  const tooLarge = snapshot({
    courses: [course('X', 1)],
    applications: Array.from({ length: MAX_ALLOCATION_APPLICANTS + 1 }, (_, index) => (
      application(`member-${index}`, index + 1, [['X', 1]])
    )),
  });
  assert.throws(
    () => allocate(tooLarge, policy(), 'limit-seed'),
    (error) => error instanceof AllocationValidationError
      && error.issues.some(({ code }) => code === 'ALLOCATION_APPLICANT_LIMIT'),
  );
});

const seedWhereAExploresXFirst = () => {
  for (let index = 0; index < 1000; index += 1) {
    const seed = `augment-${index}`;
    if (Buffer.compare(edgeKey(seed, 'A', 'X'), edgeKey(seed, 'A', 'Y')) < 0) return seed;
  }
  throw new Error('Could not find deterministic edge-order seed');
};

const edgeKey = (seed, memberId, semesterCourseId) => createHmac('sha256', Buffer.from(seed, 'utf8'))
  .update(JSON.stringify(['fallback-edge', memberId, semesterCourseId]))
  .digest();

const studentKey = (seed, domain, memberId) => createHmac('sha256', Buffer.from(seed, 'utf8'))
  .update(JSON.stringify([domain, memberId]))
  .digest();
