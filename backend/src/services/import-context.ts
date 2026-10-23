import type { ImportContext } from '../repository/import-batches.ts';
import type { ImportResolutionRecord as Resolution, NamedRecord as Named, SemesterCourseRecord as SemesterCourse, SemesterRecord as Semester } from '../domain/records.ts';
import type { ImportContextChange, ImportIssue } from './import-preview.ts';
import { nextSemesterOrder } from './semester-order.ts';

export class ImportCommitConflictError extends Error {
  readonly issues: ImportIssue[];

  constructor(message = 'Import contains an unresolved conflict', issues: ImportIssue[] = []) {
    super(message);
    this.name = 'ImportCommitConflictError';
    this.issues = issues;
  }
}

export const applyContext = (
  data: ImportContext,
  changes: ImportContextChange[],
  resolutions: Resolution[],
  now: string,
  id: () => string,
): void => {
  for (const change of changes) {
    if (['MISSING', 'INVALID', 'SOURCE_CONFLICT', 'IDENTICAL'].includes(change.status)) continue;
    if (change.status === 'EXISTING_CONFLICT') {
      const resolution = contextResolution(resolutions, change);
      if (resolution?.action === 'KEEP_EXISTING') continue;
      if (resolution?.action !== 'APPLY_FILE_VALUE') {
        throw new ImportCommitConflictError('Context conflict requires an explicit previewed decision');
      }
    }
    if ((change.entity === 'SEMESTER' && change.fileValue === null) || !change.semesterName || (
      change.entity === 'SEMESTER_COURSE' && !change.courseName
    )) continue;
    const semester = resolveSemester(data, change.semesterName, now, id);
    if (change.entity === 'SEMESTER') {
      if (semester.order !== change.fileValue) {
        if (semesters(data).some((item) => item.id !== semester.id && item.order === change.fileValue)) {
          throw new ImportCommitConflictError('Semester order must be unique');
        }
        semester.order = change.fileValue;
        bumpSemester(semester, now);
      }
      continue;
    }
    const course = resolveNamed(courses(data), change.courseName!, now, id);
    const existing = semesterCourses(data).find((item) => item.semesterId === semester.id && item.courseId === course.id);
    const semesterCourse = existing ?? resolveSemesterCourse(data, semester.id, course.id, now, id);
    if (!existing || semesterCourse.capacity !== change.fileValue) {
      semesterCourse.capacity = change.fileValue;
      semesterCourse.updatedAt = now;
      bumpSemester(semester, now);
    }
  }
};

const contextResolution = (resolutions: Resolution[], change: ImportContextChange) => resolutions.find((item) => (
  item.entity === change.entity
  && item.field === change.field
  && nameKey(String(item.semesterName ?? '')) === nameKey(change.semesterName)
  && (change.entity === 'SEMESTER'
    || nameKey(String(item.courseName ?? '')) === nameKey(change.courseName ?? ''))
));

export const resolveNamed = (items: Named[], name: string, now: string, id: () => string): Named => {
  const key = nameKey(name);
  const existing = items.find(({ nameKey: current }) => current === key);
  if (existing) return existing;
  const created = { id: id(), name, nameKey: key, createdAt: now, updatedAt: now };
  items.push(created);
  return created;
};

export const resolveSemester = (data: ImportContext, name: string, now: string, id: () => string): Semester => {
  const existing = semesters(data).find(({ nameKey: key }) => key === nameKey(name));
  if (existing) return existing;
  const created: Semester = {
    ...resolveNamed([], name, now, id),
    order: nextSemesterOrder(semesters(data)),
    allocationInputRevision: 0,
  };
  semesters(data).push(created);
  return created;
};

export const resolveSemesterCourse = (
  data: ImportContext,
  semesterId: string,
  courseId: string,
  now: string,
  id: () => string,
): SemesterCourse => {
  const existing = semesterCourses(data).find((item) => item.semesterId === semesterId && item.courseId === courseId);
  if (existing) return existing;
  const created = { id: id(), semesterId, courseId, capacity: null, createdAt: now, updatedAt: now };
  semesterCourses(data).push(created);
  return created;
};

export const bumpSemester = (semester: Semester, now: string): void => {
  semester.allocationInputRevision += 1;
  semester.updatedAt = now;
};

const nameKey = (value: string): string => value.trim().normalize('NFC');
const semesters = (data: ImportContext): Semester[] => data.semesters;
const courses = (data: ImportContext): Named[] => data.courses;
const semesterCourses = (data: ImportContext): SemesterCourse[] => data.semesterCourses;
