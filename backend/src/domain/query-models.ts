import type { ApplicationWarning } from './application-warnings.ts';
import type { ApplicationChoiceRecord, ApplicationRecord, EnrollmentRecord } from './records.ts';

export type ApplicationView = Pick<ApplicationRecord,
  'id' | 'semesterId' | 'memberId' | 'ministry' | 'applicantNote' | 'applicationOrder' | 'applicationOrderStatus' | 'orderResolution' | 'revision'
> & {
  warnings: ApplicationWarning[];
  reviewStatus: ApplicationReviewStatus;
  semesterName: string;
  memberName: string;
  choices: (Pick<ApplicationChoiceRecord, 'id' | 'semesterCourseId' | 'preference'> & { courseName: string })[];
};

export type ApplicationListFilters = {
  memberName?: string;
  semesterId?: string;
  courseId?: string;
  sort?: ApplicationSort;
  reviewStatus?: ApplicationReviewStatus;
};

export const APPLICATION_REVIEW_STATUSES = ['NORMAL', 'RETAKE', 'NEEDS_REVIEW'] as const;
export type ApplicationReviewStatus = typeof APPLICATION_REVIEW_STATUSES[number];

export const APPLICATION_SORTS = ['ORDER_ASC', 'ORDER_DESC', 'NAME_ASC', 'NAME_DESC'] as const;
export type ApplicationSort = typeof APPLICATION_SORTS[number];

export type EnrollmentView = Pick<EnrollmentRecord,
  'id' | 'semesterCourseId' | 'memberId' | 'ministry' | 'exceptionAcknowledgement' | 'revision'
> & {
  semesterName: string;
  courseName: string;
  memberName: string;
};

export const ENROLLMENT_SORTS = ['NAME_ASC', 'NAME_DESC', 'COURSE_ASC', 'COURSE_DESC', 'SEMESTER_ASC', 'SEMESTER_DESC'] as const;
export type EnrollmentSort = (typeof ENROLLMENT_SORTS)[number];

export type EnrollmentListFilters = {
  memberName?: string;
  semesterId?: string;
  courseId?: string;
  sort?: EnrollmentSort;
};
