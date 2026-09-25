import { createHash } from 'node:crypto';

import {
  EnrollmentAcknowledgementError,
  EnrollmentConflictError,
  applyEnrollmentImport,
  digestEnrollmentWarnings,
  evaluateEnrollmentImport,
} from './enrollments.ts';
import {
  type ApplicationCandidate,
  type EnrollmentCandidate,
  type ImportContextChange,
  type ImportPreview,
  ImportPreviewNotFoundError,
  type ImportPreviewService,
} from './import-preview.ts';
import {
  StoreRevisionConflictError,
  type DatabaseState,
  type ImportResolutionRecord as Resolution,
  type Store,
} from '../storage/store.ts';
import { nextSemesterOrder } from './semester-order.ts';
type Dependencies = { id: () => string; now: () => Date };

export type ImportReceipt = {
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

type CommitInput = {
  previewId: string;
  idempotencyKey: string;
  storeRevision: number;
  storeEpoch: string;
  warningDigest: string;
  resolutions: Resolution[];
};

type ImportBatch = {
  id: string;
  kind: 'APPLICATIONS' | 'ENROLLMENTS';
  templateVersion: string;
  fileHash: string;
  importedAt: string;
  status: 'STAGED' | 'APPLIED';
  rawRows: ImportPreview['rawRows'];
  resolutions: Resolution[];
  receipt: ImportReceipt | null;
};

type Named = { id: string; name: string; nameKey: string; createdAt: string; updatedAt: string };
type Semester = Named & { order: number | null; allocationInputRevision: number };
type SemesterCourse = {
  id: string;
  semesterId: string;
  courseId: string;
  capacity: number | null;
  createdAt: string;
  updatedAt: string;
};
type Application = {
  id: string;
  semesterId: string;
  memberId: string;
  applicationOrder: number | null;
  applicationOrderStatus: ApplicationCandidate['applicationOrderStatus'];
  orderResolution: 'SOURCE_AGREED' | 'ADMIN_CONFIRMED' | 'UNRESOLVED';
  orderResolutionNote: null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type Choice = {
  id: string;
  applicationId: string;
  semesterCourseId: string;
  preference: number | null;
  sourceRefs: Array<{ importBatchId: string; sheet: string; row: number }>;
  createdAt: string;
  updatedAt: string;
};

export class ImportPreviewStaleError extends Error {
  constructor() {
    super('Import preview no longer matches the current store state');
    this.name = 'ImportPreviewStaleError';
  }
}

export class ImportIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different request');
    this.name = 'ImportIdempotencyConflictError';
  }
}

export class ImportCommitConflictError extends Error {
  constructor(message = 'Import contains an unresolved conflict') {
    super(message);
    this.name = 'ImportCommitConflictError';
  }
}

export class ImportAcknowledgementError extends Error {
  constructor() {
    super('Import warnings require the preview digest and a non-empty acknowledgement note');
    this.name = 'ImportAcknowledgementError';
  }
}

export class ImportCommitService {
  readonly #store: Store;
  readonly #previews: ImportPreviewService;
  readonly #dependencies: Dependencies;

  constructor(store: Store, previews: ImportPreviewService, dependencies: Dependencies) {
    this.#store = store;
    this.#previews = previews;
    this.#dependencies = dependencies;
  }

  async commit(input: CommitInput): Promise<ImportReceipt> {
    validateInput(input);
    const requestHash = hashRequest(input);
    const previous = findReceipt(this.#store.read(), input);
    if (previous) return matchingReceipt(previous, requestHash);

    let preview: ImportPreview;
    try {
      preview = this.#previews.getPreview(input.previewId);
    } catch (error) {
      if (error instanceof ImportPreviewNotFoundError) throw new ImportPreviewStaleError();
      throw error;
    }
    assertCurrent(this.#store.read(), preview, input);
    if (preview.issues.some((issue) => (
      issue.severity === 'ERROR' && issue.blockingStages.includes('IMPORT_COMMIT')
    ))) throw new ImportCommitConflictError();

    const batchId = preview.sourceBatchId ?? this.#dependencies.id();
    const receiptId = this.#dependencies.id();

    try {
      return await this.#store.write({ expectedRevision: preview.storeRevision }, (data) => {
        assertCurrent(data, preview, input);
        const committedAt = this.#dependencies.now().toISOString();
        applyContext(data, preview.contextChanges, input.resolutions, committedAt, this.#dependencies.id);
        const counts = preview.kind === 'APPLICATIONS'
          ? applyApplications(data, preview, input.resolutions, batchId, committedAt, this.#dependencies.id)
          : applyEnrollments(data, preview, input.resolutions, committedAt, this.#dependencies.id);
        const receipt: ImportReceipt = {
          receiptId,
          importBatchId: batchId,
          previewId: preview.previewId,
          storeEpoch: preview.storeEpoch,
          idempotencyKey: input.idempotencyKey,
          requestHash,
          ...counts,
          committedAt,
        };
        const batch = preview.sourceBatchId
          ? batches(data).find(({ id }) => id === preview.sourceBatchId)
          : undefined;
        if (preview.sourceBatchId && (!batch || batch.status !== 'STAGED')) {
          throw new ImportCommitConflictError('Staged import is no longer available');
        }
        if (batch) {
          batch.status = 'APPLIED';
          batch.importedAt = committedAt;
          batch.resolutions = structuredClone(input.resolutions);
          batch.receipt = receipt;
        } else {
          batches(data).push({
            id: batchId,
            kind: preview.kind,
            templateVersion: '1',
            fileHash: preview.fileHash,
            importedAt: committedAt,
            status: 'APPLIED',
            rawRows: structuredClone(preview.rawRows),
            resolutions: structuredClone(input.resolutions),
            receipt,
          });
        }
        return structuredClone(receipt);
      });
    } catch (error) {
      if (error instanceof StoreRevisionConflictError) {
        const receipt = findReceipt(this.#store.read(), input);
        if (receipt) return matchingReceipt(receipt, requestHash);
        throw new ImportPreviewStaleError();
      }
      if (error instanceof EnrollmentConflictError) throw new ImportCommitConflictError();
      if (error instanceof EnrollmentAcknowledgementError) throw new ImportAcknowledgementError();
      throw error;
    }
  }
}

const applyContext = (
  data: DatabaseState,
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
    if (change.fileValue === null || !change.semesterName || (
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
    const semesterCourse = resolveSemesterCourse(data, semester.id, course.id, now, id);
    if (semesterCourse.capacity !== change.fileValue) {
      semesterCourse.capacity = change.fileValue;
      semesterCourse.updatedAt = now;
      bumpSemester(semester, now);
    }
  }
};

const applyApplications = (
  data: DatabaseState,
  preview: ImportPreview,
  resolutions: Resolution[],
  batchId: string,
  now: string,
  id: () => string,
) => {
  const counts = { inserted: 0, updated: 0, skipped: 0 };
  for (const sourceCandidate of preview.applications) {
    const orderDecision = applicationOrderResolution(resolutions, sourceCandidate);
    const confirmedOrder = orderDecision === undefined
      ? undefined
      : confirmedApplicationOrder(orderDecision, sourceCandidate);
    const candidate = confirmedOrder === undefined ? sourceCandidate : {
      ...sourceCandidate,
      applicationOrder: confirmedOrder,
      applicationOrderStatus: 'NORMAL' as const,
    };
    if (!candidate.semesterName || !candidate.memberName || candidate.choices.some(({ courseName }) => !courseName)) {
      throw new ImportCommitConflictError('Application names must be resolved before commit');
    }
    const existing = findApplication(data, candidate.semesterName, candidate.memberName);
    const bundleDecision = applicationBundleResolution(resolutions, candidate);
    if (orderDecision && bundleDecision?.action === 'KEEP_EXISTING') {
      throw new ImportCommitConflictError('Application decisions contradict each other');
    }
    if (existing && applicationMatches(data, existing, candidate)) {
      counts.skipped += 1;
      continue;
    }
    if (existing) {
      if (orderDecision && choicesMatch(data, existing, candidate)) {
        existing.applicationOrder = confirmedOrder!;
        existing.applicationOrderStatus = 'NORMAL';
        existing.orderResolution = 'ADMIN_CONFIRMED';
        existing.orderResolutionNote = null;
        existing.revision += 1;
        existing.updatedAt = now;
        bumpSemester(semesters(data).find(({ id }) => id === existing.semesterId)!, now);
        counts.updated += 1;
        continue;
      }
      if (bundleDecision?.action === 'KEEP_EXISTING') {
        counts.skipped += 1;
        continue;
      }
      if (bundleDecision?.action !== 'REPLACE_APPLICATION' || preview.mode !== 'REPLACE_APPLICATION') {
        throw new ImportCommitConflictError('Existing application requires an explicit previewed decision');
      }
      replaceApplication(data, existing, candidate, confirmedOrder !== undefined, batchId, now, id);
      counts.updated += 1;
      continue;
    }
    createApplication(data, candidate, confirmedOrder !== undefined, batchId, now, id);
    counts.inserted += 1;
  }
  return counts;
};

const applyEnrollments = (
  data: DatabaseState,
  preview: ImportPreview,
  resolutions: Resolution[],
  now: string,
  id: () => string,
) => {
  const counts = { inserted: 0, updated: 0, skipped: 0 };
  for (const candidate of preview.enrollments) {
    if (!candidate.semesterName || !candidate.memberName || !candidate.courseName) {
      throw new ImportCommitConflictError('Enrollment names must be resolved before commit');
    }
    const existingCourse = findEnrollmentCourse(data, candidate);
    if (existingCourse !== null) {
      if (nameKey(existingCourse) === nameKey(candidate.courseName)) {
        counts.skipped += 1;
        continue;
      }
      throw new ImportCommitConflictError('A member can have only one enrollment per semester');
    }
    const informationalCodes = preview.issues.filter((issue) => (
      issue.severity === 'INFO' && issue.source.sheet === candidate.sourceRef.sheet
      && issue.source.row === candidate.sourceRef.row
    )).map(({ code }) => code);
    const issues = evaluateEnrollmentImport(data, candidate)
      .filter(({ code }) => !informationalCodes.includes(code));
    const warnings = issues.filter(({ severity }) => severity === 'WARNING');
    const resolution = enrollmentResolution(resolutions, candidate);
    if (warnings.length > 0 && (
      resolution?.warningDigest !== preview.warningDigest
      || typeof resolution.acknowledgementNote !== 'string'
      || !resolution.acknowledgementNote.trim()
    )) throw new ImportAcknowledgementError();
    applyEnrollmentImport(
      data,
      candidate,
      digestEnrollmentWarnings(issues),
      typeof resolution?.acknowledgementNote === 'string' ? resolution.acknowledgementNote : undefined,
      now,
      id,
      informationalCodes,
    );
    counts.inserted += 1;
  }
  return counts;
};

const createApplication = (
  data: DatabaseState,
  candidate: ApplicationCandidate,
  orderConfirmed: boolean,
  batchId: string,
  now: string,
  id: () => string,
): void => {
  const semester = resolveSemester(data, candidate.semesterName, now, id);
  const member = resolveNamed(members(data), candidate.memberName, now, id);
  const application: Application = {
    id: id(),
    semesterId: semester.id,
    memberId: member.id,
    applicationOrder: candidate.applicationOrder,
    applicationOrderStatus: candidate.applicationOrderStatus,
    orderResolution: candidate.applicationOrderStatus === 'NORMAL'
      ? orderConfirmed ? 'ADMIN_CONFIRMED' : 'SOURCE_AGREED'
      : 'UNRESOLVED',
    orderResolutionNote: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  applications(data).push(application);
  writeChoices(data, application.id, semester.id, candidate, batchId, now, id);
  bumpSemester(semester, now);
};

const replaceApplication = (
  data: DatabaseState,
  application: Application,
  candidate: ApplicationCandidate,
  orderConfirmed: boolean,
  batchId: string,
  now: string,
  id: () => string,
): void => {
  application.applicationOrder = candidate.applicationOrder;
  application.applicationOrderStatus = candidate.applicationOrderStatus;
  application.orderResolution = candidate.applicationOrderStatus === 'NORMAL'
    ? orderConfirmed ? 'ADMIN_CONFIRMED' : 'SOURCE_AGREED'
    : 'UNRESOLVED';
  application.orderResolutionNote = null;
  application.revision += 1;
  application.updatedAt = now;
  data.applicationChoices = choices(data).filter(({ applicationId }) => applicationId !== application.id);
  writeChoices(data, application.id, application.semesterId, candidate, batchId, now, id);
  const semester = semesters(data).find(({ id: semesterId }) => semesterId === application.semesterId)!;
  bumpSemester(semester, now);
};

const writeChoices = (
  data: DatabaseState,
  applicationId: string,
  semesterId: string,
  candidate: ApplicationCandidate,
  batchId: string,
  now: string,
  id: () => string,
): void => {
  for (const input of candidate.choices) {
    const course = resolveNamed(courses(data), input.courseName, now, id);
    const semesterCourse = resolveSemesterCourse(data, semesterId, course.id, now, id);
    choices(data).push({
      id: id(),
      applicationId,
      semesterCourseId: semesterCourse.id,
      preference: input.preference,
      sourceRefs: input.sourceRefs.map((source) => ({ importBatchId: batchId, ...source })),
      createdAt: now,
      updatedAt: now,
    });
  }
};

const validateInput = (input: CommitInput): void => {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 200) {
    throw new ImportCommitConflictError('Idempotency key must contain between 1 and 200 characters');
  }
  if (!Number.isSafeInteger(input.storeRevision) || input.storeRevision < 0) {
    throw new ImportCommitConflictError('Store revision must be a non-negative safe integer');
  }
  if (
    typeof input.previewId !== 'string'
    || typeof input.storeEpoch !== 'string'
    || typeof input.warningDigest !== 'string'
    || !Array.isArray(input.resolutions)
  ) throw new ImportCommitConflictError('Import commit request is invalid');
};

const assertCurrent = (data: DatabaseState, preview: ImportPreview, input: CommitInput): void => {
  if (
    input.storeRevision !== preview.storeRevision
    || input.storeEpoch !== preview.storeEpoch
    || input.warningDigest !== preview.warningDigest
    || data.meta.storeRevision !== preview.storeRevision
    || data.meta.storeEpoch !== preview.storeEpoch
  ) throw new ImportPreviewStaleError();
};

const hashRequest = (input: CommitInput): string => createHash('sha256')
  .update(JSON.stringify(sortObject(input)))
  .digest('hex');

const sortObject = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortObject(item)]));
  }
  return value;
};

const findReceipt = (data: DatabaseState, input: CommitInput): ImportReceipt | undefined => batches(data)
  .map(({ receipt }) => receipt)
  .find((receipt): receipt is ImportReceipt => Boolean(
    receipt
    && receipt.previewId === input.previewId
    && receipt.storeEpoch === input.storeEpoch
    && receipt.idempotencyKey === input.idempotencyKey,
  ));

const matchingReceipt = (receipt: ImportReceipt, requestHash: string): ImportReceipt => {
  if (receipt.requestHash !== requestHash) throw new ImportIdempotencyConflictError();
  return structuredClone(receipt);
};

const applicationBundleResolution = (resolutions: Resolution[], candidate: ApplicationCandidate) => resolutions.find((item) => (
  item.entity === 'APPLICATION'
  && ['KEEP_EXISTING', 'REPLACE_APPLICATION'].includes(String(item.action))
  && nameKey(String(item.semesterName ?? '')) === nameKey(candidate.semesterName)
  && nameKey(String(item.memberName ?? '')) === nameKey(candidate.memberName)
));

const applicationOrderResolution = (resolutions: Resolution[], candidate: ApplicationCandidate) => resolutions.find((item) => (
  item.entity === 'APPLICATION'
  && item.action === 'CONFIRM_APPLICATION_ORDER'
  && nameKey(String(item.semesterName ?? '')) === nameKey(candidate.semesterName)
  && nameKey(String(item.memberName ?? '')) === nameKey(candidate.memberName)
));

const confirmedApplicationOrder = (resolution: Resolution, candidate: ApplicationCandidate): number => {
  if (
    candidate.applicationOrderStatus === 'NORMAL'
    || !Number.isSafeInteger(resolution.applicationOrder)
    || Number(resolution.applicationOrder) < 1
  ) throw new ImportCommitConflictError('Confirmed application order must resolve a quality issue to a positive integer');
  return Number(resolution.applicationOrder);
};

const enrollmentResolution = (resolutions: Resolution[], candidate: EnrollmentCandidate) => resolutions.find((item) => (
  item.entity === 'ENROLLMENT'
  && item.action === 'ACKNOWLEDGE_WARNING'
  && nameKey(String(item.semesterName ?? '')) === nameKey(candidate.semesterName)
  && nameKey(String(item.memberName ?? '')) === nameKey(candidate.memberName)
  && nameKey(String(item.courseName ?? '')) === nameKey(candidate.courseName)
));

const contextResolution = (resolutions: Resolution[], change: ImportContextChange) => resolutions.find((item) => (
  item.entity === change.entity
  && item.field === change.field
  && nameKey(String(item.semesterName ?? '')) === nameKey(change.semesterName)
  && (change.entity === 'SEMESTER'
    || nameKey(String(item.courseName ?? '')) === nameKey(change.courseName ?? ''))
));

const findApplication = (data: DatabaseState, semesterName: string, memberName: string): Application | undefined => {
  const semester = semesters(data).find(({ nameKey: key }) => key === nameKey(semesterName));
  const member = members(data).find(({ nameKey: key }) => key === nameKey(memberName));
  return semester && member
    ? applications(data).find((item) => item.semesterId === semester.id && item.memberId === member.id)
    : undefined;
};

const applicationMatches = (data: DatabaseState, application: Application, candidate: ApplicationCandidate): boolean => {
  if (
    application.applicationOrder !== candidate.applicationOrder
    || application.applicationOrderStatus !== candidate.applicationOrderStatus
  ) return false;
  return choicesMatch(data, application, candidate);
};

const choicesMatch = (data: DatabaseState, application: Application, candidate: ApplicationCandidate): boolean => {
  const actual = choices(data)
    .filter((choice) => choice.applicationId === application.id)
    .map((choice) => {
      const semesterCourse = semesterCourses(data).find(({ id }) => id === choice.semesterCourseId);
      const course = semesterCourse && courses(data).find(({ id }) => id === semesterCourse.courseId);
      return `${course?.nameKey ?? ''}\0${choice.preference}`;
    })
    .sort();
  const expected = candidate.choices.map(({ courseName, preference }) => `${nameKey(courseName)}\0${preference}`).sort();
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
};

const findEnrollmentCourse = (data: DatabaseState, candidate: EnrollmentCandidate): string | null => {
  const semester = semesters(data).find(({ nameKey: key }) => key === nameKey(candidate.semesterName));
  const member = members(data).find(({ nameKey: key }) => key === nameKey(candidate.memberName));
  if (!semester || !member) return null;
  const enrollment = data.enrollments.find((item) => {
    if (item.memberId !== member.id) return false;
    return semesterCourses(data).some(({ id, semesterId }) => id === item.semesterCourseId && semesterId === semester.id);
  });
  if (!enrollment) return null;
  const semesterCourse = semesterCourses(data).find(({ id }) => id === enrollment.semesterCourseId);
  const course = semesterCourse && courses(data).find(({ id }) => id === semesterCourse.courseId);
  return course?.name ?? null;
};

const resolveNamed = (items: Named[], name: string, now: string, id: () => string): Named => {
  const key = nameKey(name);
  const existing = items.find(({ nameKey: current }) => current === key);
  if (existing) return existing;
  const created = { id: id(), name, nameKey: key, createdAt: now, updatedAt: now };
  items.push(created);
  return created;
};

const resolveSemester = (data: DatabaseState, name: string, now: string, id: () => string): Semester => {
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

const resolveSemesterCourse = (
  data: DatabaseState,
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

const bumpSemester = (semester: Semester, now: string): void => {
  semester.allocationInputRevision += 1;
  semester.updatedAt = now;
};

const nameKey = (value: string): string => value.trim().normalize('NFC');
const batches = (data: DatabaseState): ImportBatch[] => data.importBatches as unknown as ImportBatch[];
const semesters = (data: DatabaseState): Semester[] => data.semesters as unknown as Semester[];
const members = (data: DatabaseState): Named[] => data.members as unknown as Named[];
const courses = (data: DatabaseState): Named[] => data.courses as unknown as Named[];
const semesterCourses = (data: DatabaseState): SemesterCourse[] => data.semesterCourses as unknown as SemesterCourse[];
const applications = (data: DatabaseState): Application[] => data.applications as unknown as Application[];
const choices = (data: DatabaseState): Choice[] => data.applicationChoices as unknown as Choice[];
