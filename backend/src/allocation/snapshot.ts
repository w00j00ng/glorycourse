import { createHash } from 'node:crypto';

import type { DatabaseState } from '../storage/store.ts';
import type { AllocationSnapshot, PolicySettings } from './engine.ts';

type Named = { id: string; name: string };
type Semester = Named & { order: number | null; allocationInputRevision: number };
type SemesterCourse = { id: string; semesterId: string; courseId: string; capacity: number | null };
type Application = {
  id: string;
  semesterId: string;
  memberId: string;
  applicationOrder: number | null;
  applicationOrderStatus: 'NORMAL' | 'CONFLICT' | 'MISSING' | 'INVALID';
};
type Choice = {
  id: string;
  applicationId: string;
  semesterCourseId: string;
  preference: number | null;
};
type Enrollment = { id: string; semesterCourseId: string; memberId: string };

export type FingerprintPolicy = {
  policyId: string;
  policyVersion: string;
  settings: PolicySettings;
};

export type InputChange = { code: string };

export class AllocationSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AllocationSnapshotError';
  }
}

export const buildAllocationSnapshot = (
  data: Pick<DatabaseState, 'semesters' | 'members' | 'courses' | 'semesterCourses' |
    'applications' | 'applicationChoices' | 'enrollments'>,
  semesterId: string,
): AllocationSnapshot => {
  const semesters = data.semesters as Semester[];
  const members = data.members as Named[];
  const courses = data.courses as Named[];
  const semesterCourses = data.semesterCourses as SemesterCourse[];
  const applications = (data.applications as Application[]).filter((item) => item.semesterId === semesterId);
  const choices = data.applicationChoices as Choice[];
  const enrollments = data.enrollments as Enrollment[];
  const semester = requireById(semesters, semesterId, 'Semester');
  const memberById = new Map(members.map((item) => [item.id, item]));
  const courseById = new Map(courses.map((item) => [item.id, item]));
  const semesterById = new Map(semesters.map((item) => [item.id, item]));
  const semesterCourseById = new Map(semesterCourses.map((item) => [item.id, item]));
  const targetCourses = semesterCourses.filter((item) => item.semesterId === semesterId);
  const applicationIds = new Set(applications.map(({ id }) => id));
  const applicantIds = new Set(applications.map(({ memberId }) => memberId));

  return {
    semester: { id: semester.id, name: semester.name, order: semester.order },
    semesterCourses: targetCourses.map((item) => ({
      id: item.id,
      courseId: item.courseId,
      courseName: requireById(courses, item.courseId, 'Course').name,
      capacity: item.capacity,
    })).sort(byId),
    applications: applications.map((item) => ({
      id: item.id,
      memberId: item.memberId,
      memberName: requireById(members, item.memberId, 'Member').name,
      applicationOrder: item.applicationOrder,
      applicationOrderStatus: item.applicationOrderStatus,
    })).sort(byId),
    choices: choices.filter((item) => applicationIds.has(item.applicationId)).map((item) => ({
      id: item.id,
      applicationId: item.applicationId,
      semesterCourseId: item.semesterCourseId,
      preference: item.preference,
    })).sort(byId),
    relevantPastEnrollments: enrollments.flatMap((item) => {
      if (!applicantIds.has(item.memberId)) return [];
      const semesterCourse = requireMap(semesterCourseById, item.semesterCourseId, 'Semester course');
      if (semesterCourse.semesterId === semesterId) return [];
      const enrollmentSemester = requireMap(semesterById, semesterCourse.semesterId, 'Semester');
      requireMap(memberById, item.memberId, 'Member');
      requireMap(courseById, semesterCourse.courseId, 'Course');
      if (
        semester.order !== null
        && enrollmentSemester.order !== null
        && enrollmentSemester.order >= semester.order
      ) return [];
      return [{
        id: item.id,
        memberId: item.memberId,
        courseId: semesterCourse.courseId,
        semesterId: enrollmentSemester.id,
        semesterOrder: enrollmentSemester.order,
      }];
    }).sort(byId),
    existingEnrollments: enrollments.flatMap((item) => {
      const semesterCourse = requireMap(semesterCourseById, item.semesterCourseId, 'Semester course');
      if (semesterCourse.semesterId !== semesterId) return [];
      return [{
        id: item.id,
        memberId: item.memberId,
        memberName: requireMap(memberById, item.memberId, 'Member').name,
        semesterCourseId: item.semesterCourseId,
      }];
    }).sort(byId),
  };
};

export const allocationFingerprint = (
  snapshot: AllocationSnapshot,
  policy: FingerprintPolicy,
): string => createHash('sha256').update(JSON.stringify(semanticInput(snapshot, policy))).digest('hex');

export const allocationInputChanges = (
  before: AllocationSnapshot,
  after: AllocationSnapshot,
): InputChange[] => {
  const changes: InputChange[] = [];
  if (!same(semesterInput(before), semesterInput(after))) changes.push({ code: 'SEMESTER_CHANGED' });
  if (!same(courseInput(before), courseInput(after))) changes.push({ code: 'SEMESTER_COURSES_CHANGED' });

  const beforeApplicationIds = new Set(before.applications.map(({ id }) => id));
  const afterApplicationIds = new Set(after.applications.map(({ id }) => id));
  if (after.applications.some(({ id }) => !beforeApplicationIds.has(id))) changes.push({ code: 'APPLICATION_ADDED' });
  if (before.applications.some(({ id }) => !afterApplicationIds.has(id))) changes.push({ code: 'APPLICATION_REMOVED' });
  if (!same(applicationInput(before), applicationInput(after))) changes.push({ code: 'APPLICATIONS_CHANGED' });
  if (!same(pastInput(before), pastInput(after))) changes.push({ code: 'PAST_ENROLLMENTS_CHANGED' });
  if (!same(existingInput(before), existingInput(after))) changes.push({ code: 'EXISTING_ENROLLMENTS_CHANGED' });
  return changes;
};

const semanticInput = (snapshot: AllocationSnapshot, policy: FingerprintPolicy) => ({
  semester: semesterInput(snapshot),
  semesterCourses: courseInput(snapshot),
  applications: applicationInput(snapshot),
  relevantPastEnrollments: pastInput(snapshot),
  existingEnrollments: existingInput(snapshot),
  policy: {
    id: policy.policyId,
    version: policy.policyVersion,
    settings: {
      preferenceMode: policy.settings.preferenceMode,
      fallbackMode: policy.settings.fallbackMode,
    },
  },
});

const semesterInput = ({ semester }: AllocationSnapshot) => ({ id: semester.id, order: semester.order });
const courseInput = ({ semesterCourses }: AllocationSnapshot) => semesterCourses.map((item) => ({
  id: item.id,
  courseId: item.courseId,
  capacity: item.capacity,
})).sort(byId);
const applicationInput = (snapshot: AllocationSnapshot) => ({
  applications: snapshot.applications.map((item) => ({
    id: item.id,
    memberId: item.memberId,
    applicationOrder: item.applicationOrder,
    applicationOrderStatus: item.applicationOrderStatus,
  })).sort(byId),
  choices: snapshot.choices.map((item) => ({
    id: item.id,
    applicationId: item.applicationId,
    semesterCourseId: item.semesterCourseId,
    preference: item.preference,
  })).sort(byId),
});
const pastInput = ({ relevantPastEnrollments }: AllocationSnapshot) => relevantPastEnrollments.map((item) => ({
  id: item.id,
  memberId: item.memberId,
  courseId: item.courseId,
  semesterId: item.semesterId,
  semesterOrder: item.semesterOrder,
})).sort(byId);
const existingInput = ({ existingEnrollments }: AllocationSnapshot) => existingEnrollments.map((item) => ({
  id: item.id,
  memberId: item.memberId,
  semesterCourseId: item.semesterCourseId,
})).sort(byId);

const requireById = <T extends { id: string }>(items: T[], id: string, label: string): T => {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) throw new AllocationSnapshotError(`${label} ${id} was not found`);
  return item;
};

const requireMap = <T>(items: Map<string, T>, id: string, label: string): T => {
  const item = items.get(id);
  if (!item) throw new AllocationSnapshotError(`${label} ${id} was not found`);
  return item;
};

const byId = <T extends { id: string }>(left: T, right: T): number => (
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0
);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
