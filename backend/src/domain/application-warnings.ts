import type { AllocationSnapshot } from '../allocation/engine.ts';

export type ApplicationWarning = {
  code: 'RETAKE' | 'SEMESTER_ORDER_UNRESOLVED';
  message: string;
  severity: 'WARNING';
  memberId: string;
  semesterCourseId: string;
  courseName: string;
  preferences: number[];
};

export const applicationWarnings = (input: {
  memberId: string;
  semesterOrder: number | null;
  choices: { semesterCourseId: string; courseId: string; courseName: string; preference: number | null }[];
  history: { courseId: string; semesterOrder: number | null }[];
}): ApplicationWarning[] => {
  const grouped = new Map<string, typeof input.choices>();
  for (const choice of input.choices) {
    const choices = grouped.get(choice.courseId) ?? [];
    choices.push(choice);
    grouped.set(choice.courseId, choices);
  }
  return [...grouped.values()].flatMap((choices): ApplicationWarning[] => {
    const choice = choices[0]!;
    const history = input.history.filter(({ courseId }) => courseId === choice.courseId);
    const earlier = input.semesterOrder !== null && history.some(({ semesterOrder }) => (
      semesterOrder !== null && semesterOrder < input.semesterOrder!
    ));
    const unresolved = history.length > 0 && (input.semesterOrder === null
      || history.some(({ semesterOrder }) => semesterOrder === null));
    if (!earlier && !unresolved) return [];
    const preferences = [...new Set(choices.flatMap(({ preference }) => preference === null ? [] : [preference]))]
      .sort((left, right) => left - right);
    const ranks = preferences.map((preference) => `${preference}지망`).join(', ');
    return [{
      code: earlier ? 'RETAKE' : 'SEMESTER_ORDER_UNRESOLVED',
      message: earlier
        ? `${choice.courseName}(${ranks})은 이전 학기에 수강한 강좌입니다. 미수강 희망 강좌 배정 후 재수강을 배정합니다.`
        : `${choice.courseName}(${ranks})의 수강 이력 학기 순서를 확인할 수 없어 재수강 여부를 판단할 수 없습니다.`,
      severity: 'WARNING', memberId: input.memberId, semesterCourseId: choice.semesterCourseId,
      courseName: choice.courseName, preferences,
    }];
  }).sort((left, right) => compareId(left.semesterCourseId, right.semesterCourseId));
};

export const snapshotApplicationWarnings = (snapshot: AllocationSnapshot): ApplicationWarning[] => {
  const courseById = new Map(snapshot.semesterCourses.map((course) => [course.id, course]));
  const choicesByApplication = new Map<string, AllocationSnapshot['choices']>();
  for (const choice of snapshot.choices) {
    const choices = choicesByApplication.get(choice.applicationId) ?? [];
    choices.push(choice);
    choicesByApplication.set(choice.applicationId, choices);
  }
  const historyByMember = new Map<string, AllocationSnapshot['relevantPastEnrollments']>();
  for (const history of snapshot.relevantPastEnrollments) {
    const records = historyByMember.get(history.memberId) ?? [];
    records.push(history);
    historyByMember.set(history.memberId, records);
  }
  return snapshot.applications.flatMap((application) => applicationWarnings({
    memberId: application.memberId,
    semesterOrder: snapshot.semester.order,
    choices: (choicesByApplication.get(application.id) ?? []).flatMap((choice) => {
      const course = courseById.get(choice.semesterCourseId);
      return course ? [{ ...choice, courseId: course.courseId, courseName: course.courseName }] : [];
    }),
    history: historyByMember.get(application.memberId) ?? [],
  })).sort((left, right) => compareId(left.memberId, right.memberId)
    || compareId(left.semesterCourseId, right.semesterCourseId));
};

const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
