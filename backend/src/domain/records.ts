import type { AllocationSnapshot, PolicySettings } from '../allocation/engine.ts';

type Timestamped = { createdAt: string; updatedAt: string };
export type NamedRecord = Timestamped & { id: string; name: string; nameKey: string };
export type SemesterRecord = NamedRecord & { order: number | null; allocationInputRevision: number };
export type SemesterCourseRecord = Timestamped & {
  id: string;
  semesterId: string;
  courseId: string;
  capacity: number | null;
};
export type ApplicationRecord = Timestamped & {
  applicantNote: string | null;
  id: string;
  semesterId: string;
  memberId: string;
  ministry: string | null;
  applicationOrder: number | null;
  applicationOrderStatus: 'NORMAL' | 'CONFLICT' | 'MISSING' | 'INVALID';
  orderResolution: 'SOURCE_AGREED' | 'ADMIN_CONFIRMED' | 'UNRESOLVED';
  orderResolutionNote: string | null;
  revision: number;
};
export type ApplicationChoiceRecord = Timestamped & {
  id: string;
  applicationId: string;
  semesterCourseId: string;
  preference: number | null;
  sourceRefs: Array<{ importBatchId: string; sheet: string; row: number }>;
};
export type EnrollmentRecord = Timestamped & {
  id: string;
  semesterCourseId: string;
  memberId: string;
  ministry: string | null;
  exceptionAcknowledgement: null | { warningDigest: string; note: string; acknowledgedAt: string };
  revision: number;
};
export type FinalizationWarningRecord = {
  code: string;
  message: string;
  severity: 'WARNING';
  blockingStages: ['FINALIZE'];
  acknowledgementStages: ['FINALIZE'];
  subject: { entityType: string; entityId?: string; memberId?: string; courseId?: string };
  source: { [key: string]: never };
  detail: { changeCode?: string };
  note: string;
  acknowledgedAt: string;
};
export type FinalizationRecord = {
  idempotencyKey: string;
  requestHash: string;
  receipt: {
    receiptId: string;
    draftId: string;
    createdEnrollmentIds: string[];
    createdCount: number;
    finalizedAt: string;
  };
  acknowledgedWarnings: FinalizationWarningRecord[];
};
export type AllocationDraftRecord = {
  id: string;
  semesterId: string;
  status: 'DRAFT' | 'FINALIZED' | 'ARCHIVED';
  revision: number;
  mode: 'AUTO' | 'MANUAL';
  policyId: string;
  policyVersion: string;
  engineVersion: string;
  policySettings: PolicySettings;
  randomSeed: string;
  sourceRevision: number;
  inputFingerprint: string;
  inputSnapshot: AllocationSnapshot;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  enrollmentReportDownloadedAt: string | null;
  enrollmentReportStoreRevision: number | null;
  finalization: FinalizationRecord | null;
};
export type FinalizationReceiptRecord = Pick<FinalizationRecord, 'idempotencyKey' | 'requestHash' | 'receipt'> & {
  semesterId: string;
  enrollmentReportDownloadedAt: string | null;
  enrollmentReportStoreRevision: number | null;
};
type PreferenceAttempt = {
  choiceIdAtGeneration: string;
  semesterCourseId: string;
  courseNameAtGeneration: string;
  preference: number;
  decision: 'SELECTED' | 'REJECTED' | 'NOT_EVALUATED';
  reasonCode: string;
};
export type AllocationDraftItemRecord = {
  id: string;
  draftId: string;
  memberId: string;
  ministry: string | null;
  sourceApplicationId: string | null;
  memberNameAtGeneration: string;
  autoSemesterCourseId: string | null;
  autoDecision: 'SELECTED' | 'REJECTED' | 'NOT_EVALUATED';
  autoReasonCode: string;
  autoReasonDetail: {
    preferenceAttempts: PreferenceAttempt[];
    fallback: null | {
      stageCandidateSemesterCourseIds: string[];
      selectedSemesterCourseId: string | null;
      reasonCode: string;
      totalAssignedInStage: number;
    };
  };
  finalSemesterCourseId: string | null;
  finalDecision: 'SELECTED' | 'REJECTED';
  finalReasonCode: string | null;
  finalReasonDetail: { note: string } | null;
  updatedAt: string;
};
export type ImportResolutionRecord = {
  entity: 'APPLICATION' | 'ENROLLMENT' | 'SEMESTER' | 'SEMESTER_COURSE';
  action: 'KEEP_EXISTING' | 'REPLACE_APPLICATION' | 'CONFIRM_APPLICATION_ORDER' | 'APPLY_FILE_VALUE' | 'ACKNOWLEDGE_WARNING';
  field?: 'order' | 'capacity';
  semesterName?: string;
  memberName?: string;
  courseName?: string;
  applicationOrder?: number;
  warningDigest?: string;
  acknowledgementNote?: string;
};
export type ImportBatchRecord = {
  id: string;
  kind: 'APPLICATIONS' | 'ENROLLMENTS';
  templateVersion: string;
  fileHash: string;
  importedAt: string;
  status: 'STAGED' | 'APPLIED';
  rawRows: Array<{ sheet: string; row: number; cells: { [column: string]: string | null } }>;
  resolutions: ImportResolutionRecord[];
  receipt: null | {
    receiptId: string;
    importBatchId: string;
    previewId: string;
    storeEpoch: string;
    idempotencyKey: string;
    requestHash: string;
    inserted: number;
    updated: number;
    skipped: number;
    committedAt: string;
  };
};

export type RestoreReceiptRecord = {
  idempotencyKey: string;
  requestHash: string;
  receiptId: string;
  previousBackupId: string;
  storeRevision: number;
  storeEpoch: string;
  restoredAt: string;
};

export type DatabaseState = {
  meta: {
    storeEpoch: string;
    storeRevision: number;
  };
  semesters: SemesterRecord[];
  members: NamedRecord[];
  courses: NamedRecord[];
  semesterCourses: SemesterCourseRecord[];
  applications: ApplicationRecord[];
  applicationChoices: ApplicationChoiceRecord[];
  enrollments: EnrollmentRecord[];
  allocationDrafts: AllocationDraftRecord[];
  allocationDraftItems: AllocationDraftItemRecord[];
  finalizationReceipts: FinalizationReceiptRecord[];
  importBatches: ImportBatchRecord[];
  restoreReceipts: RestoreReceiptRecord[];
};
