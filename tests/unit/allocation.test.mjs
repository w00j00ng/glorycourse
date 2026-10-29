import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  AllocationValidationError,
  MAX_ALLOCATION_APPLICANTS,
  allocate,
} from '../../backend/src/allocation/engine.ts';
import { allocationFingerprint, allocationInputChanges } from '../../backend/src/allocation/snapshot.ts';
import { fallbackBoundaryInput } from '../fixtures/fallback-workload.mjs';

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

test('admits effective fallback candidates through 100000 and rejects candidate 100001', () => {
  const cases = [
    { input: fallbackBoundaryInput(99_999), expected: { candidates: 99_999, assigned: 1_000 } },
    { input: fallbackBoundaryInput(100_000), expected: { candidates: 100_000, assigned: 1_000 } },
    { input: fallbackBoundaryInput(100_001), expected: { code: 'ALLOCATION_FALLBACK_WORK_LIMIT' } },
  ];
  for (const { input, expected } of cases) {
    if (expected.code) {
      assert.throws(() => allocate(input, policy(), 'fallback-boundary'), (error) => (
        error instanceof AllocationValidationError
        && error.issues.some(({ code, severity }) => code === expected.code && severity === 'ERROR')
      ));
      continue;
    }
    const result = allocate(input, policy(), 'fallback-boundary');
    assert.equal(result.items.reduce((sum, item) => sum + item.autoReasonDetail.fallback.stageCandidateSemesterCourseIds.length, 0), expected.candidates);
    assert.equal(result.items.filter(({ autoReasonCode }) => autoReasonCode === 'RANDOM_FALLBACK').length, expected.assigned);
    for (const item of result.items) {
      assert.ok(item.autoReasonDetail.fallback.stageCandidateSemesterCourseIds.includes(item.autoSemesterCourseId));
    }
    assert.equal(result.engineVersion, '2.0.0');
  }
});

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

test('allocates all untaken desires, then retakes, then untaken fallback in both policies', () => {
  const requests = [
    {
      name: 'an untaken fourth choice wins against a first-choice retake',
      courses: [course('A', 1)],
      applications: [application('retake', 1, [['A', 1]]), application('untaken', 2, [['A', 4]])],
      past: [past('retake', 'course-A')],
      expected: [['retake', null, 'NO_FALLBACK_COURSE'], ['untaken', 'A', 'PREFERENCE_ALLOCATED']],
    },
    {
      name: 'an applicant gets their untaken second choice before their first-choice retake',
      courses: [course('A', 1), course('B', 1)],
      applications: [application('member', 1, [['A', 1], ['B', 2]])],
      past: [past('member', 'course-A')],
      expected: [['member', 'B', 'PREFERENCE_ALLOCATED']],
      expectedAttempts: [['A', 1, 'NOT_EVALUATED', 'ALLOCATED_TO_HIGHER_PRIORITY'], ['B', 2, 'SELECTED', 'PREFERENCE_ALLOCATED']],
    },
    {
      name: 'a desired retake wins before another applicant gets the course by fallback',
      courses: [course('A', 1), course('P', 0)],
      applications: [application('retake', 2, [['A', 1]]), application('fallback', 1, [['P', 1]])],
      past: [past('retake', 'course-A')],
      expected: [['fallback', null, 'NO_FALLBACK_COURSE'], ['retake', 'A', 'RETAKE_PREFERENCE_ALLOCATED']],
    },
    {
      name: 'a future enrollment does not turn the desired course into a retake',
      courses: [course('A', 1)],
      applications: [application('future', 1, [['A', 1]])],
      past: [past('future', 'course-A', 3)],
      expected: [['future', 'A', 'PREFERENCE_ALLOCATED']],
    },
  ];
  for (const mode of ['NEW_FIRST', 'RANK_FIRST']) {
    for (const request of requests) {
      const result = allocate(snapshot(request), policy(mode), 'stage-seed');
      assert.deepEqual(result.items.map(({ memberId, autoSemesterCourseId, autoReasonCode }) => (
        [memberId, autoSemesterCourseId, autoReasonCode]
      )), request.expected, `${mode}: ${request.name}`);
      if (request.expectedAttempts) {
        assert.deepEqual(result.items[0].autoReasonDetail.preferenceAttempts.map((attempt) => (
          [attempt.semesterCourseId, attempt.preference, attempt.decision, attempt.reasonCode]
        )), request.expectedAttempts, `${mode}: ${request.name}`);
      }
    }
  }
  assert.equal(allocate(snapshot(requests[0]), policy(), 'version-seed').engineVersion, '2.0.0');
});

test('preserves duplicate choices and ranks while granting one competition entry per course', () => {
  for (const mode of ['NEW_FIRST', 'RANK_FIRST']) {
    for (const capacity of [0, 1]) {
      for (const seed of ['duplicate-1', 'duplicate-2', 'duplicate-3']) {
        const request = {
          courses: [course('A', capacity), course('B', 2)],
          applications: [
            application('member', 1, [['A', 1], ['A', 2], ['B', 3]]),
            application('competitor', 1, [['A', 1], ['B', 2]]),
          ],
        };
        const input = snapshot(request);
        const before = structuredClone(input);
        const deduplicated = structuredClone(input);
        deduplicated.choices = deduplicated.choices.filter(({ id }) => id !== 'choice-member-1');
        const result = allocate(input, policy(mode), seed);
        const expected = allocate(deduplicated, policy(mode), seed);
        assert.deepEqual(result.items.map(({ memberId, autoSemesterCourseId }) => [memberId, autoSemesterCourseId]),
          expected.items.map(({ memberId, autoSemesterCourseId }) => [memberId, autoSemesterCourseId]));
        const attempts = itemFor(result, 'member').autoReasonDetail.preferenceAttempts;
        assert.deepEqual(attempts.map(({ preference }) => preference), [1, 2, 3]);
        assert.equal(attempts[1].reasonCode, 'DUPLICATE_CHOICE_SKIPPED');
        assert.equal(attempts[1].decision, 'NOT_EVALUATED');
        if (capacity === 0) assert.equal(attempts[2].decision, 'SELECTED');
        const permuted = structuredClone(input);
        permuted.applications.reverse();
        permuted.choices.reverse();
        permuted.semesterCourses.reverse();
        assert.deepEqual(allocate(permuted, policy(mode), seed), result);
        assert.deepEqual(input, before);
      }
    }
  }
});

test('retake competition keeps numeric order and the existing seeded student tie without duplicate lottery weight', () => {
  for (const mode of ['NEW_FIRST', 'RANK_FIRST']) {
    for (const orders of [[10, 2], [1, 1]]) {
      for (const seed of ['retake-tie-1', 'retake-tie-2']) {
        const input = snapshot({
          courses: [course('A', 1)],
          applications: [application('A', orders[0], [['A', 1], ['A', 2]]), application('B', orders[1], [['A', 1]])],
          past: [past('A', 'course-A'), past('B', 'course-A')],
        });
        const expectedWinner = orders[0] === orders[1]
          ? Buffer.compare(studentKey(seed, 'preference-student', 'A'), studentKey(seed, 'preference-student', 'B')) < 0 ? 'A' : 'B'
          : 'B';
        const result = allocate(input, policy(mode), seed);
        assert.equal(result.items.find(({ autoDecision }) => autoDecision === 'SELECTED').memberId, expectedWinner);
        assert.equal(itemFor(result, expectedWinner).autoReasonCode, 'RETAKE_PREFERENCE_ALLOCATED');
        assert.equal(itemFor(result, 'A').autoReasonDetail.preferenceAttempts[1].reasonCode, 'DUPLICATE_CHOICE_SKIPPED');
        const permuted = structuredClone(input);
        permuted.applications.reverse();
        permuted.choices.reverse();
        permuted.relevantPastEnrollments.reverse();
        assert.deepEqual(allocate(permuted, policy(mode), seed), result);
      }
    }
  }
});

test('includes applicant notes in semantic changes while retaining legacy null-note fingerprints', () => {
  const input = snapshot({ courses: [course('A', 1)], applications: [application('member', 1, [['A', 1]])] });
  const fingerprintPolicy = { policyId: 'policy', policyVersion: '1', settings: policy() };
  const legacyFingerprint = allocationFingerprint(input, fingerprintPolicy);
  const nullNote = structuredClone(input);
  nullNote.applications[0].applicantNote = null;
  assert.equal(allocationFingerprint(nullNote, fingerprintPolicy), legacyFingerprint);
  const annotated = structuredClone(input);
  annotated.applications[0].applicantNote = '오전 수업을 희망합니다';
  assert.notEqual(allocationFingerprint(annotated, fingerprintPolicy), legacyFingerprint);
  assert.deepEqual(allocationInputChanges(input, annotated), [{ code: 'APPLICATIONS_CHANGED' }]);
});

test('warns once per repeated course using only earlier history and reports unresolved matching order', async () => {
  const { applicationWarnings } = await import('../../backend/src/domain/application-warnings.ts');
  const choices = [
    { semesterCourseId: 'A', courseId: 'course-A', courseName: '기초', preference: 1 },
    { semesterCourseId: 'A', courseId: 'course-A', courseName: '기초', preference: 3 },
    { semesterCourseId: 'B', courseId: 'course-B', courseName: '심화', preference: 2 },
  ];
  const requests = [
    { semesterOrder: 2, history: [{ courseId: 'course-A', semesterOrder: 1 }], expected: [['RETAKE', 'A', [1, 3]]] },
    { semesterOrder: 2, history: [{ courseId: 'course-A', semesterOrder: 3 }], expected: [] },
    { semesterOrder: 2, history: [{ courseId: 'course-A', semesterOrder: 2 }], expected: [] },
    { semesterOrder: 2, history: [{ courseId: 'course-A', semesterOrder: null }], expected: [['SEMESTER_ORDER_UNRESOLVED', 'A', [1, 3]]] },
    { semesterOrder: null, history: [{ courseId: 'course-A', semesterOrder: 1 }], expected: [['SEMESTER_ORDER_UNRESOLVED', 'A', [1, 3]]] },
    { semesterOrder: 2, history: [{ courseId: 'unrelated', semesterOrder: null }], expected: [] },
  ];
  for (const request of requests) {
    const warnings = applicationWarnings({ memberId: 'member', choices, ...request });
    assert.deepEqual(warnings.map(({ code, semesterCourseId, preferences }) => [code, semesterCourseId, preferences]), request.expected);
    for (const warning of warnings) {
      assert.equal(warning.memberId, 'member');
      assert.equal(warning.severity, 'WARNING');
      assert.equal(warning.courseName, '기초');
      assert.match(warning.message, /1.*3/);
    }
  }
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
      application('C', 3, [['P', 1]]),
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
  assert.equal(itemFor(result, 'B').autoReasonDetail.preferenceAttempts[0].reasonCode, 'CAPACITY_FULL');
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
    courses: [course('X', 1), course('Y', 1)],
    applications: [application('C', 1, [['Y', 1]])],
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
  const courses = Array.from({ length: 6 }, (_, index) => course(`C${index + 1}`, 1));
  const fiveChoices = Array.from({ length: 5 }, (_, index) => [`C${index + 1}`, index + 1]);
  const allowed = snapshot({ courses, applications: [application('A', 1, fiveChoices)] });
  assert.equal(itemFor(allocate(allowed, policy(), 'five-seed'), 'A').autoSemesterCourseId, 'C1');
  for (const [choices, expected] of [
    [[...fiveChoices, ['C6', 6]], 'APPLICATION_CHOICE_LIMIT'],
    [[['C6', 6]], 'PREFERENCE_UNRESOLVED'],
    [[['C1', 1], ['C1', 1]], 'PREFERENCE_UNRESOLVED'],
    [[['C1', 1], ['C2', 1]], 'PREFERENCE_UNRESOLVED'],
    [[['C1', 0]], 'PREFERENCE_UNRESOLVED'],
    [[['C1', null]], 'PREFERENCE_UNRESOLVED'],
  ]) {
    const request = snapshot({ courses, applications: [application('A', 1, choices)] });
    assert.throws(() => allocate(request, policy(), 'sixth-seed'), (error) => (
      error instanceof AllocationValidationError && error.issues.some(({ code }) => code === expected)
    ));
  }
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
