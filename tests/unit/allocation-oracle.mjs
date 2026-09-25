import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import { allocate } from '../../backend/src/allocation/engine.ts';

test('matches an independent exhaustive fallback objective on 1000 generated small graphs', () => {
  const random = lcg(0x5eed008);
  for (let caseIndex = 0; caseIndex < 1000; caseIndex += 1) {
    const studentCount = 1 + Math.floor(random() * 5);
    const courseCount = 1 + Math.floor(random() * 4);
    const seed = `oracle-${caseIndex}`;
    const capacities = Array.from({ length: courseCount }, () => Math.floor(random() * 3));
    const students = Array.from({ length: studentCount }, (_, index) => {
      const memberId = `member-${index}`;
      const isNew = random() < 0.5;
      const excluded = new Set();
      if (!isNew) {
        for (let courseIndex = 0; courseIndex < courseCount; courseIndex += 1) {
          if (random() < 0.4) excluded.add(courseIndex);
        }
      }
      return { memberId, isNew, excluded, applicationOrder: 1 + Math.floor(random() * 4) };
    });
    const input = generatedSnapshot(students, capacities);

    const actual = allocate(input, {
      preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED',
    }, seed);
    const expectedSelected = exhaustiveSelected(students, capacities, seed);
    const actualSelected = actual.items
      .filter(({ autoReasonCode }) => autoReasonCode === 'RANDOM_FALLBACK')
      .map(({ memberId }) => memberId)
      .sort();

    assert.deepEqual(actualSelected, expectedSelected, `generated case ${caseIndex}`);
  }
});

const generatedSnapshot = (students, capacities) => ({
  semester: { id: 'target', name: 'target', order: 2 },
  semesterCourses: [
    { id: 'preference-zero', courseId: 'preference-zero', courseName: 'P', capacity: 0 },
    ...capacities.map((capacity, index) => ({
      id: `course-${index}`, courseId: `course-${index}`, courseName: `C${index}`, capacity,
    })),
  ],
  applications: students.map(({ memberId, applicationOrder }) => ({
    id: `application-${memberId}`,
    memberId,
    memberName: memberId,
    applicationOrder,
    applicationOrderStatus: 'NORMAL',
  })),
  choices: students.map(({ memberId }) => ({
    id: `choice-${memberId}`,
    applicationId: `application-${memberId}`,
    semesterCourseId: 'preference-zero',
    preference: 1,
  })),
  relevantPastEnrollments: students.flatMap(({ memberId, isNew, excluded }) => isNew ? [] : [
    { memberId, courseId: `unrelated-${memberId}`, semesterId: `old-${memberId}`, semesterOrder: 1 },
    ...[...excluded].map((index) => ({
      memberId, courseId: `course-${index}`, semesterId: `old-${memberId}-${index}`, semesterOrder: 1,
    })),
  ]),
  existingEnrollments: [],
});

const exhaustiveSelected = (students, capacities, seed) => {
  const ordered = [...students].sort((left, right) => (
    Number(right.isNew) - Number(left.isNew)
    || left.applicationOrder - right.applicationOrder
    || compareHash(seed, 'fallback-student', left.memberId, right.memberId)
    || compareId(left.memberId, right.memberId)
  ));
  let best = null;
  const assigned = Array(capacities.length).fill(0);
  const selected = new Set();

  const visit = (index) => {
    if (index === students.length) {
      const score = [
        selected.size,
        students.filter(({ memberId, isNew }) => isNew && selected.has(memberId)).length,
        ...ordered.map(({ memberId }) => Number(selected.has(memberId))),
      ];
      if (!best || compareScore(score, best.score) > 0) best = { score, selected: [...selected].sort() };
      return;
    }
    const student = students[index];
    visit(index + 1);
    for (let courseIndex = 0; courseIndex < capacities.length; courseIndex += 1) {
      if (student.excluded.has(courseIndex) || assigned[courseIndex] >= capacities[courseIndex]) continue;
      assigned[courseIndex] += 1;
      selected.add(student.memberId);
      visit(index + 1);
      selected.delete(student.memberId);
      assigned[courseIndex] -= 1;
    }
  };
  visit(0);
  return best.selected;
};

const compareScore = (left, right) => {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

const compareHash = (seed, domain, left, right) => Buffer.compare(
  createHmac('sha256', Buffer.from(seed, 'utf8')).update(JSON.stringify([domain, left])).digest(),
  createHmac('sha256', Buffer.from(seed, 'utf8')).update(JSON.stringify([domain, right])).digest(),
);

const compareId = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const lcg = (seed) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x1_0000_0000;
};
