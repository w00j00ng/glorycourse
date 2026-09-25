import { createHmac } from 'node:crypto';

export const ALLOCATION_ENGINE_VERSION = '1.0.0';
export const MAX_ALLOCATION_APPLICANTS = 10_000;
export const MAX_SEMESTER_COURSES = 1_000;
export const MAX_CHOICES_PER_APPLICATION = 100;

export type PolicySettings = {
  preferenceMode: 'NEW_FIRST' | 'RANK_FIRST';
  fallbackMode: 'MAX_CARDINALITY_PRIORITIZED';
};

export type AllocationSnapshot = {
  semester: { id: string; name: string; order: number | null };
  semesterCourses: Array<{
    id: string;
    courseId: string;
    courseName: string;
    capacity: number | null;
  }>;
  applications: Array<{
    id: string;
    memberId: string;
    memberName: string;
    applicationOrder: number | null;
    applicationOrderStatus: 'NORMAL' | 'CONFLICT' | 'MISSING' | 'INVALID';
  }>;
  choices: Array<{
    id: string;
    applicationId: string;
    semesterCourseId: string;
    preference: number | null;
  }>;
  relevantPastEnrollments: Array<{
    id: string;
    memberId: string;
    courseId: string;
    semesterId: string;
    semesterOrder: number | null;
  }>;
  existingEnrollments: Array<{
    id: string;
    memberId: string;
    memberName: string;
    semesterCourseId: string;
  }>;
};

export type AllocationIssue = {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING';
  memberId?: string;
  semesterCourseId?: string;
};

type ReasonCode =
  | 'PREFERENCE_ALLOCATED'
  | 'ALREADY_TAKEN'
  | 'CAPACITY_FULL'
  | 'ALLOCATED_TO_HIGHER_PREFERENCE'
  | 'RANDOM_FALLBACK'
  | 'NO_FALLBACK_COURSE'
  | 'FALLBACK_COMPETITION_LOST'
  | 'ALREADY_ENROLLED';

export type PreferenceAttempt = {
  choiceIdAtGeneration: string;
  semesterCourseId: string;
  courseNameAtGeneration: string;
  preference: number;
  decision: 'SELECTED' | 'REJECTED' | 'NOT_EVALUATED';
  reasonCode: ReasonCode;
};

export type AllocationItem = {
  memberId: string;
  memberNameAtGeneration: string;
  sourceApplicationId: string | null;
  autoDecision: 'SELECTED' | 'REJECTED';
  autoSemesterCourseId: string | null;
  autoReasonCode: ReasonCode;
  autoReasonDetail: {
    preferenceAttempts: PreferenceAttempt[];
    fallback: null | {
      stageCandidateSemesterCourseIds: string[];
      selectedSemesterCourseId: string | null;
      reasonCode: 'RANDOM_FALLBACK' | 'NO_FALLBACK_COURSE' | 'FALLBACK_COMPETITION_LOST';
      totalAssignedInStage: number;
    };
  };
};

export type AllocationResult = {
  engineVersion: typeof ALLOCATION_ENGINE_VERSION;
  items: AllocationItem[];
  existingEnrollments: Array<{
    enrollmentId: string;
    memberId: string;
    memberNameAtGeneration: string;
    semesterCourseId: string;
    reasonCode: 'ALREADY_ENROLLED';
  }>;
  courseSummary: Array<{
    semesterCourseId: string;
    capacity: number;
    existingEnrollmentCount: number;
    preferenceAssignedCount: number;
    fallbackAssignedCount: number;
    remaining: number;
  }>;
  issues: AllocationIssue[];
};

export class AllocationValidationError extends Error {
  readonly issues: AllocationIssue[];

  constructor(issues: AllocationIssue[]) {
    super('Allocation input is not ready for automatic allocation');
    this.name = 'AllocationValidationError';
    this.issues = issues;
  }
}

type Course = AllocationSnapshot['semesterCourses'][number] & { capacity: number };
type Application = AllocationSnapshot['applications'][number] & {
  applicationOrder: number;
  choices: AllocationSnapshot['choices'];
};
type State = {
  application: Application;
  isNew: boolean;
  pastCourseIds: Set<string>;
  fixed: boolean;
  preferenceAttempts: PreferenceAttempt[];
  selectedPreferenceCourseId?: string;
  fallbackCandidates: string[];
};

export const allocate = (
  input: AllocationSnapshot,
  policy: PolicySettings,
  randomSeed: string,
): AllocationResult => {
  const validationIssues = validate(input, policy, randomSeed);
  if (validationIssues.length > 0) throw new AllocationValidationError(validationIssues);

  const courses = [...input.semesterCourses] as Course[];
  const courseById = new Map(courses.map((item) => [item.id, item]));
  const existingByMember = new Map(input.existingEnrollments.map((item) => [item.memberId, item]));
  const existingCounts = countBy(input.existingEnrollments.map(({ semesterCourseId }) => semesterCourseId));
  const remaining = new Map(courses.map((item) => [
    item.id,
    Math.max(0, item.capacity - (existingCounts.get(item.id) ?? 0)),
  ]));
  const states = buildStates(input, existingByMember);

  allocatePreferences(states, courseById, remaining, policy, randomSeed);
  const fallbackAssignments = allocateFallback(states, courses, remaining, randomSeed);
  const totalFallbackAssigned = fallbackAssignments.size;
  const items = resultItems(
    states,
    fallbackAssignments,
    totalFallbackAssigned,
  );
  const warnings = capacityWarnings(courses, existingCounts);
  const preferenceCounts = countBy(states.flatMap((state) => (
    state.selectedPreferenceCourseId ? [state.selectedPreferenceCourseId] : []
  )));
  const fallbackCounts = countBy([...fallbackAssignments.values()]);

  return {
    engineVersion: ALLOCATION_ENGINE_VERSION,
    items: items.sort((left, right) => compareId(left.memberId, right.memberId)),
    existingEnrollments: input.existingEnrollments
      .map((item) => ({
        enrollmentId: item.id,
        memberId: item.memberId,
        memberNameAtGeneration: item.memberName,
        semesterCourseId: item.semesterCourseId,
        reasonCode: 'ALREADY_ENROLLED' as const,
      }))
      .sort((left, right) => compareId(left.memberId, right.memberId)),
    courseSummary: courses
      .map((item) => ({
        semesterCourseId: item.id,
        capacity: item.capacity,
        existingEnrollmentCount: existingCounts.get(item.id) ?? 0,
        preferenceAssignedCount: preferenceCounts.get(item.id) ?? 0,
        fallbackAssignedCount: fallbackCounts.get(item.id) ?? 0,
        remaining: remaining.get(item.id) ?? 0,
      }))
      .sort((left, right) => compareId(left.semesterCourseId, right.semesterCourseId)),
    issues: warnings,
  };
};

const buildStates = (
  input: AllocationSnapshot,
  existingByMember: Map<string, AllocationSnapshot['existingEnrollments'][number]>,
): State[] => {
  const targetOrder = input.semester.order!;
  const choicesByApplication = new Map<string, AllocationSnapshot['choices']>();
  for (const choice of input.choices) {
    const choices = choicesByApplication.get(choice.applicationId) ?? [];
    choices.push(choice);
    choicesByApplication.set(choice.applicationId, choices);
  }
  return input.applications.map((raw): State => {
    const application = {
      ...raw,
      applicationOrder: raw.applicationOrder!,
      choices: choicesByApplication.get(raw.id) ?? [],
    };
    const past = input.relevantPastEnrollments.filter((item) => (
      item.memberId === application.memberId && item.semesterOrder! < targetOrder
    ));
    const fixed = existingByMember.has(application.memberId);
    return {
      application,
      isNew: past.length === 0,
      pastCourseIds: new Set(past.map(({ courseId }) => courseId)),
      fixed,
      preferenceAttempts: [],
      fallbackCandidates: [],
    };
  });
};

const allocatePreferences = (
  states: State[],
  courseById: Map<string, Course>,
  remaining: Map<string, number>,
  policy: PolicySettings,
  seed: string,
): void => {
  const active = states.filter(({ fixed }) => !fixed);
  // ponytail: bounded materialization is simplest; stream by rank if GC-014 shows memory pressure.
  const attempts = active.flatMap((state) => state.application.choices.map((choice) => ({ state, choice })));
  const tieKeys = new Map(active.map(({ application }) => [
    application.memberId,
    seededKey(seed, 'preference-student', application.memberId),
  ]));
  attempts.sort((left, right) => {
    const newDifference = Number(right.state.isNew) - Number(left.state.isNew);
    const preferenceDifference = left.choice.preference! - right.choice.preference!;
    return (
      policy.preferenceMode === 'NEW_FIRST'
        ? newDifference || preferenceDifference
        : preferenceDifference || newDifference
    )
      || left.state.application.applicationOrder - right.state.application.applicationOrder
      || Buffer.compare(tieKeys.get(left.state.application.memberId)!, tieKeys.get(right.state.application.memberId)!)
      || compareId(left.state.application.memberId, right.state.application.memberId)
      || compareId(left.choice.id, right.choice.id);
  });

  for (const { state, choice } of attempts) {
    const course = courseById.get(choice.semesterCourseId)!;
    const attempt: PreferenceAttempt = {
      choiceIdAtGeneration: choice.id,
      semesterCourseId: choice.semesterCourseId,
      courseNameAtGeneration: course.courseName,
      preference: choice.preference!,
      decision: 'REJECTED',
      reasonCode: 'CAPACITY_FULL',
    };
    if (state.selectedPreferenceCourseId) {
      attempt.decision = 'NOT_EVALUATED';
      attempt.reasonCode = 'ALLOCATED_TO_HIGHER_PREFERENCE';
    } else if (state.pastCourseIds.has(course.courseId)) {
      attempt.reasonCode = 'ALREADY_TAKEN';
    } else if ((remaining.get(course.id) ?? 0) > 0) {
      attempt.decision = 'SELECTED';
      attempt.reasonCode = 'PREFERENCE_ALLOCATED';
      state.selectedPreferenceCourseId = course.id;
      remaining.set(course.id, remaining.get(course.id)! - 1);
    }
    state.preferenceAttempts.push(attempt);
  }
  for (const state of states) {
    state.preferenceAttempts.sort((left, right) => (
      left.preference - right.preference
      || compareId(left.choiceIdAtGeneration, right.choiceIdAtGeneration)
    ));
  }
};

const allocateFallback = (
  states: State[],
  courses: Course[],
  remaining: Map<string, number>,
  seed: string,
): Map<string, string> => {
  const availableAtStart = courses
    .filter(({ id }) => (remaining.get(id) ?? 0) > 0)
    .sort((left, right) => compareId(left.id, right.id));
  const active = states.filter((state) => !state.fixed && !state.selectedPreferenceCourseId);
  for (const state of active) {
    const desired = new Set(state.application.choices.map(({ semesterCourseId }) => semesterCourseId));
    state.fallbackCandidates = availableAtStart
      .filter((item) => !desired.has(item.id) && !state.pastCourseIds.has(item.courseId))
      .map(({ id }) => id);
  }
  const studentKeys = new Map(active.map(({ application }) => [
    application.memberId,
    seededKey(seed, 'fallback-student', application.memberId),
  ]));
  active.sort((left, right) => (
    Number(right.isNew) - Number(left.isNew)
    || left.application.applicationOrder - right.application.applicationOrder
    || Buffer.compare(studentKeys.get(left.application.memberId)!, studentKeys.get(right.application.memberId)!)
    || compareId(left.application.memberId, right.application.memberId)
  ));
  const stateByMember = new Map(active.map((state) => [state.application.memberId, state]));
  const assignments = new Map<string, string>();
  const courseMembers = new Map(availableAtStart.map(({ id }) => [id, new Set<string>()]));
  const edgeOrders = new Map(active.map((state) => [
    state.application.memberId,
    state.fallbackCandidates
      .map((id) => ({ id, key: seededKey(seed, 'fallback-edge', state.application.memberId, id) }))
      .sort((left, right) => Buffer.compare(left.key, right.key) || compareId(left.id, right.id))
      .map(({ id }) => id),
  ]));

  for (const state of active) {
    augment(
      state.application.memberId,
      stateByMember,
      edgeOrders,
      remaining,
      assignments,
      courseMembers,
    );
  }
  for (const courseId of assignments.values()) remaining.set(courseId, remaining.get(courseId)! - 1);
  return assignments;
};

const augment = (
  startMemberId: string,
  stateByMember: Map<string, State>,
  edgeOrders: Map<string, string[]>,
  capacity: Map<string, number>,
  assignments: Map<string, string>,
  courseMembers: Map<string, Set<string>>,
): boolean => {
  const queue = [startMemberId];
  const visitedMembers = new Set(queue);
  const visitedCourses = new Set<string>();
  const courseParent = new Map<string, string>();
  let freeCourse: string | undefined;

  for (let index = 0; index < queue.length && freeCourse === undefined; index += 1) {
    const memberId = queue[index]!;
    for (const courseId of edgeOrders.get(memberId) ?? []) {
      if (visitedCourses.has(courseId)) continue;
      visitedCourses.add(courseId);
      courseParent.set(courseId, memberId);
      const occupants = courseMembers.get(courseId)!;
      if (occupants.size < (capacity.get(courseId) ?? 0)) {
        freeCourse = courseId;
        break;
      }
      for (const occupant of [...occupants].sort()) {
        if (visitedMembers.has(occupant) || !stateByMember.has(occupant)) continue;
        visitedMembers.add(occupant);
        queue.push(occupant);
      }
    }
  }
  if (freeCourse === undefined) return false;

  let courseId = freeCourse;
  while (true) {
    const memberId = courseParent.get(courseId)!;
    const previousCourse = assignments.get(memberId);
    if (previousCourse) courseMembers.get(previousCourse)!.delete(memberId);
    assignments.set(memberId, courseId);
    courseMembers.get(courseId)!.add(memberId);
    if (!previousCourse) break;
    courseId = previousCourse;
  }
  return true;
};

const resultItems = (
  states: State[],
  fallbackAssignments: Map<string, string>,
  totalFallbackAssigned: number,
): AllocationItem[] => {
  const items = states.filter(({ fixed }) => !fixed).map((state): AllocationItem => {
    if (state.selectedPreferenceCourseId) return {
      memberId: state.application.memberId,
      memberNameAtGeneration: state.application.memberName,
      sourceApplicationId: state.application.id,
      autoDecision: 'SELECTED',
      autoSemesterCourseId: state.selectedPreferenceCourseId,
      autoReasonCode: 'PREFERENCE_ALLOCATED',
      autoReasonDetail: { preferenceAttempts: state.preferenceAttempts, fallback: null },
    };
    const fallbackCourse = fallbackAssignments.get(state.application.memberId);
    const reasonCode = fallbackCourse
      ? 'RANDOM_FALLBACK'
      : state.fallbackCandidates.length === 0 ? 'NO_FALLBACK_COURSE' : 'FALLBACK_COMPETITION_LOST';
    return {
      memberId: state.application.memberId,
      memberNameAtGeneration: state.application.memberName,
      sourceApplicationId: state.application.id,
      autoDecision: fallbackCourse ? 'SELECTED' : 'REJECTED',
      autoSemesterCourseId: fallbackCourse ?? null,
      autoReasonCode: reasonCode,
      autoReasonDetail: {
        preferenceAttempts: state.preferenceAttempts,
        fallback: {
          stageCandidateSemesterCourseIds: [...state.fallbackCandidates].sort(),
          selectedSemesterCourseId: fallbackCourse ?? null,
          reasonCode,
          totalAssignedInStage: totalFallbackAssigned,
        },
      },
    };
  });
  return items;
};

const validate = (
  input: AllocationSnapshot,
  policy: PolicySettings,
  randomSeed: string,
): AllocationIssue[] => {
  const issues: AllocationIssue[] = [];
  if (!['NEW_FIRST', 'RANK_FIRST'].includes(policy.preferenceMode)) {
    issues.push(errorIssue('INVALID_PREFERENCE_MODE', 'Preference mode is invalid'));
  }
  if (policy.fallbackMode !== 'MAX_CARDINALITY_PRIORITIZED') {
    issues.push(errorIssue('INVALID_FALLBACK_MODE', 'Fallback mode is invalid'));
  }
  if (typeof randomSeed !== 'string' || randomSeed.length < 1) {
    issues.push(errorIssue('RANDOM_SEED_REQUIRED', 'Random seed is required'));
  }
  if (input.applications.length > MAX_ALLOCATION_APPLICANTS) {
    return [errorIssue('ALLOCATION_APPLICANT_LIMIT', 'Allocation has too many applicants')];
  }
  if (input.semesterCourses.length > MAX_SEMESTER_COURSES) {
    return [errorIssue('SEMESTER_COURSE_LIMIT', 'Semester has too many courses')];
  }
  if (!positiveInteger(input.semester.order)) {
    issues.push(errorIssue('SEMESTER_ORDER_UNRESOLVED', 'Target semester order is unresolved'));
  }
  const courseIds = new Set<string>();
  const baseCourseIds = new Set<string>();
  for (const course of input.semesterCourses) {
    if (courseIds.has(course.id) || baseCourseIds.has(course.courseId)) {
      issues.push(errorIssue('DUPLICATE_SEMESTER_COURSE', 'Semester course is duplicated', undefined, course.id));
    }
    courseIds.add(course.id);
    baseCourseIds.add(course.courseId);
    if (!nonNegativeInteger(course.capacity)) {
      issues.push(errorIssue('CAPACITY_UNRESOLVED', 'Course capacity is unresolved', undefined, course.id));
    }
  }
  const applicationMembers = new Set<string>();
  const applicationIds = new Set<string>();
  for (const application of input.applications) {
    if (applicationIds.has(application.id)) {
      issues.push(errorIssue('DUPLICATE_APPLICATION_ID', 'Application ID is duplicated', application.memberId));
    }
    applicationIds.add(application.id);
  }
  const choicesByApplication = new Map<string, AllocationSnapshot['choices']>();
  const choiceIds = new Set<string>();
  for (const choice of input.choices) {
    if (choiceIds.has(choice.id)) {
      issues.push(errorIssue('DUPLICATE_CHOICE_ID', 'Choice ID is duplicated'));
    }
    choiceIds.add(choice.id);
    if (!applicationIds.has(choice.applicationId)) {
      issues.push(errorIssue('CHOICE_APPLICATION_INVALID', 'Choice does not belong to an application'));
      continue;
    }
    const choices = choicesByApplication.get(choice.applicationId) ?? [];
    choices.push(choice);
    choicesByApplication.set(choice.applicationId, choices);
  }
  for (const application of input.applications) {
    if (applicationMembers.has(application.memberId)) {
      issues.push(errorIssue('DUPLICATE_APPLICATION', 'Member has more than one application', application.memberId));
    }
    applicationMembers.add(application.memberId);
    if (application.applicationOrderStatus !== 'NORMAL' || !positiveInteger(application.applicationOrder)) {
      issues.push(errorIssue('APPLICATION_ORDER_UNRESOLVED', 'Application order is unresolved', application.memberId));
    }
    const choices = choicesByApplication.get(application.id) ?? [];
    if (choices.length < 1) {
      issues.push(errorIssue('CHOICE_REQUIRED', 'Application has no choices', application.memberId));
    }
    if (choices.length > MAX_CHOICES_PER_APPLICATION) {
      issues.push(errorIssue('APPLICATION_CHOICE_LIMIT', 'Application has too many choices', application.memberId));
    }
    const choiceCourses = new Set<string>();
    const preferences = new Set<number>();
    for (const choice of choices) {
      if (!courseIds.has(choice.semesterCourseId)) {
        issues.push(errorIssue('CHOICE_COURSE_INVALID', 'Choice does not belong to the target semester', application.memberId, choice.semesterCourseId));
      }
      if (choiceCourses.has(choice.semesterCourseId)) {
        issues.push(errorIssue('DUPLICATE_CHOICE_COURSE', 'Application course choice is duplicated', application.memberId, choice.semesterCourseId));
      }
      choiceCourses.add(choice.semesterCourseId);
      if (!positiveInteger(choice.preference) || preferences.has(choice.preference!)) {
        issues.push(errorIssue('PREFERENCE_UNRESOLVED', 'Choice preference is missing, invalid, or duplicated', application.memberId, choice.semesterCourseId));
      } else preferences.add(choice.preference!);
    }
  }
  const existingMembers = new Set<string>();
  for (const enrollment of input.existingEnrollments) {
    if (existingMembers.has(enrollment.memberId)) {
      issues.push(errorIssue('DUPLICATE_EXISTING_ENROLLMENT', 'Member has more than one current enrollment', enrollment.memberId));
    }
    existingMembers.add(enrollment.memberId);
    if (!courseIds.has(enrollment.semesterCourseId)) {
      issues.push(errorIssue('EXISTING_ENROLLMENT_COURSE_INVALID', 'Current enrollment course is invalid', enrollment.memberId, enrollment.semesterCourseId));
    }
  }
  if (positiveInteger(input.semester.order)) {
    for (const enrollment of input.relevantPastEnrollments) {
      if (
        applicationMembers.has(enrollment.memberId)
        && !existingMembers.has(enrollment.memberId)
        && !positiveInteger(enrollment.semesterOrder)
      ) issues.push(errorIssue('SEMESTER_ORDER_UNRESOLVED', 'Relevant enrollment semester order is unresolved', enrollment.memberId));
    }
  }
  return issues;
};

const capacityWarnings = (courses: Course[], existingCounts: Map<string, number>): AllocationIssue[] => courses
  .filter((course) => (existingCounts.get(course.id) ?? 0) > course.capacity)
  .map((course) => ({
    code: 'EXISTING_CAPACITY_EXCEEDED',
    message: 'Current enrollments exceed course capacity',
    severity: 'WARNING' as const,
    semesterCourseId: course.id,
  }))
  .sort((left, right) => compareId(left.semesterCourseId!, right.semesterCourseId!));

const errorIssue = (
  code: string,
  message: string,
  memberId?: string,
  semesterCourseId?: string,
): AllocationIssue => ({
  code,
  message,
  severity: 'ERROR',
  ...(memberId ? { memberId } : {}),
  ...(semesterCourseId ? { semesterCourseId } : {}),
});

const seededKey = (seed: string, domain: string, ...ids: string[]): Buffer => createHmac(
  'sha256',
  Buffer.from(seed, 'utf8'),
).update(JSON.stringify([domain, ...ids])).digest();

const countBy = (values: string[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};

const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
