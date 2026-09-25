import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  MAX_ALLOCATION_APPLICANTS,
  MAX_SEMESTER_COURSES,
  allocate,
} from '../../backend/src/allocation/engine.ts';

const policy = { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' };

test('allocates every applicant at the published applicant and course limits', (context) => {
  const courses = Array.from({ length: MAX_SEMESTER_COURSES }, (_, index) => ({
    id: `semester-course-${index}`,
    courseId: `course-${index}`,
    courseName: `강좌 ${index}`,
    capacity: MAX_ALLOCATION_APPLICANTS / MAX_SEMESTER_COURSES,
  }));
  const applications = Array.from({ length: MAX_ALLOCATION_APPLICANTS }, (_, index) => ({
    id: `application-${index}`,
    memberId: `member-${index}`,
    memberName: `회원 ${index}`,
    applicationOrder: index + 1,
    applicationOrderStatus: 'NORMAL',
  }));
  const choices = applications.map((application, index) => ({
    id: `choice-${index}`,
    applicationId: application.id,
    semesterCourseId: courses[index % courses.length].id,
    preference: 1,
  }));
  const input = {
    semester: { id: 'semester', name: '최대 규모', order: 1 },
    semesterCourses: courses,
    applications,
    choices,
    relevantPastEnrollments: [],
    existingEnrollments: [],
  };

  const beforeHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = allocate(input, policy, 'operational-preference-scale');
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.items.length, MAX_ALLOCATION_APPLICANTS);
  assert.equal(result.items.filter(({ autoDecision }) => autoDecision === 'SELECTED').length, MAX_ALLOCATION_APPLICANTS);
  assert.equal(result.courseSummary.length, MAX_SEMESTER_COURSES);
  assert.ok(result.courseSummary.every(({ remaining }) => remaining === 0));
  context.diagnostic(JSON.stringify({
    scenario: 'preference-limit',
    applicants: applications.length,
    semesterCourses: courses.length,
    elapsedMs: Math.round(elapsedMs),
    heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024),
  }));
});

test('completes a dense fallback workload without dropping applicants', (context) => {
  const applicantCount = 1_000;
  const courses = [
    { id: 'blocked', courseId: 'blocked', courseName: '신청 강좌', capacity: 0 },
    ...Array.from({ length: 99 }, (_, index) => ({
      id: `fallback-${index}`,
      courseId: `fallback-${index}`,
      courseName: `대체 강좌 ${index}`,
      capacity: 11,
    })),
  ];
  const applications = Array.from({ length: applicantCount }, (_, index) => ({
    id: `application-${index}`,
    memberId: `member-${index}`,
    memberName: `회원 ${index}`,
    applicationOrder: index + 1,
    applicationOrderStatus: 'NORMAL',
  }));
  const input = {
    semester: { id: 'semester', name: '대체 배정 부하', order: 1 },
    semesterCourses: courses,
    applications,
    choices: applications.map((application, index) => ({
      id: `choice-${index}`,
      applicationId: application.id,
      semesterCourseId: 'blocked',
      preference: 1,
    })),
    relevantPastEnrollments: [],
    existingEnrollments: [],
  };

  const beforeHeap = process.memoryUsage().heapUsed;
  const startedAt = performance.now();
  const result = allocate(input, policy, 'operational-fallback-scale');
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.items.length, applicantCount);
  assert.equal(result.items.filter(({ autoReasonCode }) => autoReasonCode === 'RANDOM_FALLBACK').length, applicantCount);
  context.diagnostic(JSON.stringify({
    scenario: 'dense-fallback',
    applicants: applications.length,
    semesterCourses: courses.length,
    candidateEdges: applicantCount * (courses.length - 1),
    elapsedMs: Math.round(elapsedMs),
    heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - beforeHeap) / 1024 / 1024),
  }));
});
