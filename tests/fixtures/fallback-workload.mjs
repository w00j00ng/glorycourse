import { readFileSync } from 'node:fs';

export const fallbackBoundaryInput = (candidateEdges) => {
  const extraApplicant = candidateEdges === 100_001;
  const applications = Array.from({ length: extraApplicant ? 1_001 : 1_000 }, (_, index) => ({
    id: `application-${index}`, memberId: `member-${index}`, memberName: `회원 ${index}`,
    ministry: null, applicantNote: null, applicationOrder: index + 1, applicationOrderStatus: 'NORMAL',
  }));
  const exclusions = candidateEdges === 99_999 ? 1 : extraApplicant ? 99 : 0;
  return {
    semester: { id: 'current', name: '후보 한도 검증', order: 2 },
    semesterCourses: [
      { id: 'sc-blocked', courseId: 'blocked', courseName: '희망 강좌', capacity: 0 },
      ...Array.from({ length: 100 }, (_, index) => ({
        id: `sc-${index}`, courseId: `course-${index}`, courseName: `대체 강좌 ${index}`, capacity: 11,
      })),
    ],
    applications,
    choices: applications.map((application, index) => ({
      id: `choice-${index}`, applicationId: application.id, semesterCourseId: 'sc-blocked', preference: 1,
    })),
    relevantPastEnrollments: Array.from({ length: exclusions }, (_, index) => ({
      id: `past-${index}`, memberId: extraApplicant ? 'member-1000' : 'member-0',
      courseId: `course-${index}`, semesterId: 'past', semesterOrder: 1,
    })),
    existingEnrollments: [],
  };
};

export const fallbackStore = (input, order = input.semester.order) => {
  const data = JSON.parse(readFileSync(new URL('./store/store-valid-empty.json', import.meta.url), 'utf8'));
  const timestamp = '2026-10-27T00:00:00.000Z';
  const stamped = (record) => ({ ...record, createdAt: timestamp, updatedAt: timestamp });
  const named = (id, name) => stamped({ id, name, nameKey: name });
  data.semesters = [
    { ...named(input.semester.id, input.semester.name), order, allocationInputRevision: 4 },
    { ...named('past', '지난 학기'), order: 1, allocationInputRevision: 0 },
  ];
  data.members = input.applications.map(({ memberId, memberName }) => named(memberId, memberName));
  data.courses = input.semesterCourses.map(({ courseId, courseName }) => named(courseId, courseName));
  data.semesterCourses = input.semesterCourses.map(({ id, courseId, capacity }) => stamped({
    id, courseId, capacity, semesterId: input.semester.id,
  }));
  data.applications = input.applications.map(({ memberName: _name, ...record }) => stamped({
    ...record, semesterId: input.semester.id, orderResolution: 'SOURCE_AGREED', orderResolutionNote: null, revision: 0,
  }));
  data.applicationChoices = input.choices.map((record) => stamped({ ...record, sourceRefs: [] }));
  data.semesterCourses.push(...[...new Set(input.relevantPastEnrollments.map(({ courseId }) => courseId))]
    .map((courseId) => stamped({ id: `past-${courseId}`, courseId, semesterId: 'past', capacity: 1_001 })));
  data.enrollments = input.relevantPastEnrollments.map(({ id, courseId, memberId }) => stamped({
    id, memberId, semesterCourseId: `past-${courseId}`, ministry: null, exceptionAcknowledgement: null, revision: 0,
  }));
  return data;
};
