import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { AllocationSnapshot } from '../allocation/engine.ts';
import {
  AllocationSnapshotError,
  allocationFingerprint,
  allocationInputChanges,
  buildAllocationSnapshot,
} from '../allocation/snapshot.ts';
import {
  StoreRevisionConflictError,
  StoreEpochConflictError,
  type DatabaseState,
  type FinalizationReceiptRecord,
  type FinalizationRecord,
  type Store,
} from '../storage/store.ts';
import {
  EnrollmentValidationError,
  evaluateEnrollmentSelection,
  type EnrollmentIssue,
} from './enrollments.ts';

type DraftRecord = {
  id: string;
  semesterId: string;
  status: 'DRAFT' | 'FINALIZED' | 'ARCHIVED';
  revision: number;
  policyId: string;
  policyVersion: string;
  policySettings: AllocationSnapshotPolicy;
  inputFingerprint: string;
  inputSnapshot: AllocationSnapshot;
  updatedAt: string;
  finalizedAt: string | null;
  finalization: FinalizationRecord | null;
};
type AllocationSnapshotPolicy = {
  preferenceMode: 'NEW_FIRST' | 'RANK_FIRST';
  fallbackMode: 'MAX_CARDINALITY_PRIORITIZED';
};
type DraftItem = {
  id: string;
  draftId: string;
  memberId: string;
  sourceApplicationId: string | null;
  finalDecision: 'SELECTED' | 'REJECTED';
  finalSemesterCourseId: string | null;
};
type EnrollmentRecord = {
  id: string;
  semesterCourseId: string;
  memberId: string;
  exceptionAcknowledgement: { warningDigest: string; note: string; acknowledgedAt: string } | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
type FinalizationReceipt = FinalizationReceiptRecord['receipt'];
type Candidate = {
  id: string;
  draftItemId: string;
  memberId: string;
  semesterCourseId: string;
};
type SelectedItem = {
  draftItemId: string;
  memberId: string;
  semesterCourseId: string;
  sourceApplicationId: string | null;
};
type TokenPayload = {
  version: 1;
  operation: 'FINALIZE_DRAFT';
  draftId: string;
  draftRevision: number;
  storeRevision: number;
  storeEpoch: string;
  expiresAt: string;
  warningDigest: string;
  selectionDigest: string;
  candidates: Candidate[];
};
export type FinalizationIssue = {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING';
  blockingStages: ('FINALIZE')[];
  acknowledgementStages: ('FINALIZE')[];
  subject: { entityType: string; entityId?: string; memberId?: string; courseId?: string };
  source: Record<string, never>;
  detail: { changeCode?: string };
};
type PreviewEnrollment = {
  id: string;
  semesterCourseId: string;
  memberId: string;
  semesterName: string;
  courseName: string;
  memberName: string;
  exceptionAcknowledgement: null;
  revision: 0;
};
type Evaluation = {
  issues: FinalizationIssue[];
  enrollments: PreviewEnrollment[];
  records: EnrollmentRecord[];
  courseSummary: Array<{
    semesterCourseId: string;
    capacity: number | null;
    existingCount: number;
    addedCount: number;
    totalCount: number;
  }>;
  selectionDigest: string;
};
type FinalizeInput = {
  idempotencyKey: string;
  preparedActionToken: string;
  expectedDraftRevision: number;
  acknowledgedWarningDigest: string;
  acknowledgementNote: string;
};
type Dependencies = {
  id: () => string;
  now: () => Date;
  secret: string | Uint8Array;
  ttlMs?: number;
};

export class FinalizationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalizationValidationError';
  }
}

export class FinalizationStaleError extends Error {
  constructor() {
    super('Finalization confirmation no longer matches the current store state');
    this.name = 'FinalizationStaleError';
  }
}

export class FinalizationConflictError extends Error {
  readonly issues: FinalizationIssue[];

  constructor(issues: FinalizationIssue[]) {
    super('Draft finalization violates a non-overridable rule');
    this.name = 'FinalizationConflictError';
    this.issues = issues;
  }
}

export class FinalizationAcknowledgementError extends Error {
  constructor() {
    super('Finalization warnings require their exact digest and an acknowledgement note');
    this.name = 'FinalizationAcknowledgementError';
  }
}

export class FinalizationTokenError extends Error {
  constructor() {
    super('Finalization token is invalid or expired');
    this.name = 'FinalizationTokenError';
  }
}

export class FinalizationIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used with a different finalization request');
    this.name = 'FinalizationIdempotencyConflictError';
  }
}

export class FinalizationService {
  readonly #store: Store;
  readonly #dependencies: Required<Omit<Dependencies, 'secret'>> & { secret: Buffer };

  constructor(store: Store, dependencies: Dependencies) {
    const secret = Buffer.from(dependencies.secret);
    if (secret.byteLength < 32) throw new FinalizationValidationError('Prepared action secret is too short');
    this.#store = store;
    this.#dependencies = {
      id: dependencies.id,
      now: dependencies.now,
      secret,
      ttlMs: dependencies.ttlMs ?? 10 * 60 * 1000,
    };
  }

  preview(draftId: string, input: { expectedDraftRevision: number }) {
    requireId(draftId, 'draftId');
    requireRevision(input.expectedDraftRevision);
    const data = this.#store.read();
    const draft = requireDraft(data, draftId);
    requireEditableRevision(draft, input.expectedDraftRevision);
    const selected = selectedItems(data, draftId);
    const candidates = selected.map((item) => ({
      id: this.#dependencies.id(),
      draftItemId: item.draftItemId,
      memberId: item.memberId,
      semesterCourseId: item.semesterCourseId,
    }));
    const evaluation = evaluate(data, draft, selected, candidates);
    const warningDigest = digestWarnings(evaluation.issues);
    const expiresAt = new Date(this.#dependencies.now().getTime() + this.#dependencies.ttlMs).toISOString();
    const payload: TokenPayload = {
      version: 1,
      operation: 'FINALIZE_DRAFT',
      draftId,
      draftRevision: draft.revision,
      storeRevision: data.meta.storeRevision,
      storeEpoch: data.meta.storeEpoch,
      expiresAt,
      warningDigest,
      selectionDigest: evaluation.selectionDigest,
      candidates,
    };
    return {
      preparedActionToken: sign(payload, this.#dependencies.secret),
      warningDigest,
      draftRevision: draft.revision,
      storeRevision: data.meta.storeRevision,
      storeEpoch: data.meta.storeEpoch,
      expiresAt,
      issues: evaluation.issues,
      enrollments: evaluation.enrollments,
      courseSummary: evaluation.courseSummary,
    };
  }

  async finalize(draftId: string, input: FinalizeInput): Promise<FinalizationReceipt> {
    validateFinalizeInput(draftId, input);
    const requestHash = hashRequest(draftId, input);
    const previous = findFinalization(this.#store.read(), input.idempotencyKey);
    if (previous) return matchingReceipt(previous, requestHash);

    const payload = verify(input.preparedActionToken, this.#dependencies.secret);
    if (
      payload.draftId !== draftId
      || payload.draftRevision !== input.expectedDraftRevision
      || this.#dependencies.now().getTime() >= Date.parse(payload.expiresAt)
    ) throw new FinalizationTokenError();
    const currentEvaluation = assertCurrent(this.#store.read(), payload);
    validateApproval(currentEvaluation.issues, payload.warningDigest, input);

    const receiptId = this.#dependencies.id();
    try {
      return await this.#store.write({ expectedRevision: payload.storeRevision }, (data) => {
        const raced = findFinalization(data, input.idempotencyKey);
        if (raced) return matchingReceipt(raced, requestHash);
        const evaluation = assertCurrent(data, payload);
        validateApproval(evaluation.issues, payload.warningDigest, input);
        const finalizedAt = this.#dependencies.now().toISOString();
        const warnings = evaluation.issues.filter((issue): issue is FinalizationIssue & { severity: 'WARNING' } => (
          issue.severity === 'WARNING'
        ));
        const acknowledgement = warnings.length === 0 ? null : {
          warningDigest: payload.warningDigest,
          note: input.acknowledgementNote.trim(),
          acknowledgedAt: finalizedAt,
        };
        const inserted = evaluation.records.map((record) => ({
          ...record,
          exceptionAcknowledgement: acknowledgement,
          createdAt: finalizedAt,
          updatedAt: finalizedAt,
        }));
        (data.enrollments as EnrollmentRecord[]).push(...inserted);
        const semesterId = requireDraft(data, draftId).semesterId;
        const receipt: FinalizationReceipt = {
          receiptId,
          draftId,
          createdEnrollmentIds: inserted.map(({ id }) => id),
          createdCount: inserted.length,
          finalizedAt,
        };
        data.finalizationReceipts.push({
          idempotencyKey: input.idempotencyKey,
          requestHash,
          semesterId,
          receipt,
          enrollmentReportDownloadedAt: null,
          enrollmentReportStoreRevision: null,
        });
        data.allocationDrafts = data.allocationDrafts.filter(({ id }) => id !== draftId);
        data.allocationDraftItems = data.allocationDraftItems.filter((item) => item.draftId !== draftId);
        return structuredClone(receipt);
      });
    } catch (error) {
      if (error instanceof StoreRevisionConflictError) {
        const raced = findFinalization(this.#store.read(), input.idempotencyKey);
        if (raced) return matchingReceipt(raced, requestHash);
        throw new FinalizationStaleError();
      }
      throw error;
    }
  }

  reportStatus(semesterId: string) {
    requireId(semesterId, 'semesterId');
    const data = this.#store.read();
    const receipt = latestReceipt(data, semesterId);
    return {
      semesterId,
      finalized: Boolean(receipt),
      enrollmentReportIsCurrent: receipt?.enrollmentReportStoreRevision === data.meta.storeRevision,
      enrollmentReportDownloadedAt: receipt?.enrollmentReportDownloadedAt ?? null,
    };
  }

  async recordEnrollmentReportDownload(
    semesterId: string,
    expected: { storeRevision: number; storeEpoch: string },
  ): Promise<void> {
    requireId(semesterId, 'semesterId');
    const current = this.#store.read();
    if (current.meta.storeEpoch !== expected.storeEpoch) throw new StoreEpochConflictError();
    if (current.meta.storeRevision !== expected.storeRevision) {
      throw new StoreRevisionConflictError(current.meta.storeRevision);
    }
    const receipt = latestReceipt(current, semesterId);
    if (!receipt) throw new FinalizationValidationError('No finalized allocation exists for this semester');
    if (receipt.enrollmentReportStoreRevision === current.meta.storeRevision) return;
    await this.#store.write({ expectedRevision: expected.storeRevision, expectedEpoch: expected.storeEpoch }, (data) => {
      const latest = latestReceipt(data, semesterId);
      if (!latest || latest.idempotencyKey !== receipt.idempotencyKey) throw new FinalizationStaleError();
      latest.enrollmentReportDownloadedAt = this.#dependencies.now().toISOString();
      latest.enrollmentReportStoreRevision = data.meta.storeRevision + 1;
    });
  }
}

const latestReceipt = (data: DatabaseState, semesterId: string): FinalizationReceiptRecord | undefined => (
  data.finalizationReceipts.filter((item) => item.semesterId === semesterId).at(-1)
);

const assertCurrent = (data: DatabaseState, payload: TokenPayload): Evaluation => {
  if (
    data.meta.storeRevision !== payload.storeRevision
    || data.meta.storeEpoch !== payload.storeEpoch
  ) throw new FinalizationStaleError();
  const draft = requireDraft(data, payload.draftId);
  if (draft.status !== 'DRAFT' || draft.revision !== payload.draftRevision) {
    throw new FinalizationStaleError();
  }
  const selected = selectedItems(data, draft.id);
  if (!sameCandidates(selected, payload.candidates)) throw new FinalizationStaleError();
  const evaluation = evaluate(data, draft, selected, payload.candidates);
  if (
    evaluation.selectionDigest !== payload.selectionDigest
    || digestWarnings(evaluation.issues) !== payload.warningDigest
  ) throw new FinalizationStaleError();
  return evaluation;
};

const evaluate = (
  data: DatabaseState,
  draft: DraftRecord,
  selected: SelectedItem[],
  candidates: Candidate[],
): Evaluation => {
  const issues = inputChangeIssues(data, draft);
  const provisional = structuredClone(data);
  const enrollments: PreviewEnrollment[] = [];
  const records: EnrollmentRecord[] = [];
  const semesterCourses = data.semesterCourses as Array<{
    id: string; semesterId: string; courseId: string; capacity: number | null;
  }>;
  const semesters = data.semesters as Array<{ id: string; name: string }>;
  const courses = data.courses as Array<{ id: string; name: string }>;
  const members = data.members as Array<{ id: string; name: string }>;

  for (const item of selected) {
    const candidate = candidates.find(({ draftItemId }) => draftItemId === item.draftItemId)!;
    const semesterCourse = semesterCourses.find(({ id }) => id === item.semesterCourseId);
    const member = members.find(({ id }) => id === item.memberId);
    const semester = semesterCourse && semesters.find(({ id }) => id === semesterCourse.semesterId);
    const course = semesterCourse && courses.find(({ id }) => id === semesterCourse.courseId);
    if (!semesterCourse || semesterCourse.semesterId !== draft.semesterId || !semester || !course || !member) {
      issues.push(issue(
        'LIVE_REFERENCE_INVALID',
        'Selected member or course is no longer valid for the draft semester',
        'ERROR',
        item.memberId,
        semesterCourse?.courseId,
      ));
      continue;
    }
    let enrollmentIssues: EnrollmentIssue[];
    try {
      enrollmentIssues = evaluateEnrollmentSelection(provisional, {
        semesterCourseId: item.semesterCourseId,
        memberId: item.memberId,
      });
    } catch (error) {
      if (!(error instanceof EnrollmentValidationError)) throw error;
      issues.push(issue('LIVE_REFERENCE_INVALID', error.message, 'ERROR', item.memberId, course.id));
      continue;
    }
    const finalIssues = enrollmentIssues.map(finalizationIssue);
    issues.push(...finalIssues);
    const record: EnrollmentRecord = {
      id: candidate.id,
      semesterCourseId: item.semesterCourseId,
      memberId: item.memberId,
      exceptionAcknowledgement: null,
      revision: 0,
      createdAt: '',
      updatedAt: '',
    };
    records.push(record);
    enrollments.push({
      id: record.id,
      semesterCourseId: record.semesterCourseId,
      memberId: record.memberId,
      semesterName: semester.name,
      courseName: course.name,
      memberName: member.name,
      exceptionAcknowledgement: null,
      revision: 0,
    });
    if (!finalIssues.some(({ severity }) => severity === 'ERROR')) {
      (provisional.enrollments as EnrollmentRecord[]).push(record);
    }
    if (hasStagedSource(data, item.sourceApplicationId)) {
      issues.push(issue(
        'RELATED_IMPORT_STAGED',
        'A selected application still has staged import source data',
        'WARNING',
        item.memberId,
        course.id,
      ));
    }
  }
  return {
    issues: sortIssues(issues),
    enrollments,
    records,
    courseSummary: summarizeCourses(data, draft.semesterId, records),
    selectionDigest: digest(selected.map(({ sourceApplicationId: _ignored, ...item }) => item)),
  };
};

const inputChangeIssues = (data: DatabaseState, draft: DraftRecord): FinalizationIssue[] => {
  try {
    const current = buildAllocationSnapshot(data, draft.semesterId);
    const currentFingerprint = allocationFingerprint(current, {
      policyId: draft.policyId,
      policyVersion: draft.policyVersion,
      settings: draft.policySettings,
    });
    if (currentFingerprint === draft.inputFingerprint) return [];
    return allocationInputChanges(draft.inputSnapshot, current).map(({ code }) => issue(
      code,
      'Allocation input changed after this draft was created',
      'WARNING',
      undefined,
      undefined,
      { changeCode: code },
    ));
  } catch (error) {
    if (!(error instanceof AllocationSnapshotError)) throw error;
    return [issue('INPUT_UNAVAILABLE', error.message, 'WARNING')];
  }
};

const hasStagedSource = (data: DatabaseState, applicationId: string | null): boolean => {
  if (!applicationId) return false;
  const staged = new Set((data.importBatches as Array<{ id: string; status: string }>)
    .filter(({ status }) => status === 'STAGED').map(({ id }) => id));
  return (data.applicationChoices as Array<{
    applicationId: string;
    sourceRefs: Array<{ importBatchId: string }>;
  }>).some((choice) => (
    choice.applicationId === applicationId
    && choice.sourceRefs.some(({ importBatchId }) => staged.has(importBatchId))
  ));
};

const summarizeCourses = (data: DatabaseState, semesterId: string, records: EnrollmentRecord[]) => {
  const semesterCourses = (data.semesterCourses as Array<{
    id: string; semesterId: string; capacity: number | null;
  }>).filter((item) => item.semesterId === semesterId);
  const targetIds = new Set(semesterCourses.map(({ id }) => id));
  const existing = count((data.enrollments as EnrollmentRecord[])
    .filter(({ semesterCourseId }) => targetIds.has(semesterCourseId))
    .map(({ semesterCourseId }) => semesterCourseId));
  const added = count(records.map(({ semesterCourseId }) => semesterCourseId));
  return semesterCourses.map((course) => ({
    semesterCourseId: course.id,
    capacity: course.capacity,
    existingCount: existing.get(course.id) ?? 0,
    addedCount: added.get(course.id) ?? 0,
    totalCount: (existing.get(course.id) ?? 0) + (added.get(course.id) ?? 0),
  })).sort((left, right) => compareId(left.semesterCourseId, right.semesterCourseId));
};

const selectedItems = (data: DatabaseState, draftId: string): SelectedItem[] => (
  (data.allocationDraftItems as DraftItem[])
    .filter((item) => item.draftId === draftId && item.finalDecision === 'SELECTED')
    .map((item) => ({
      draftItemId: item.id,
      memberId: item.memberId,
      semesterCourseId: item.finalSemesterCourseId!,
      sourceApplicationId: item.sourceApplicationId,
    }))
    .sort((left, right) => compareId(left.draftItemId, right.draftItemId))
);

const validateApproval = (
  issues: FinalizationIssue[],
  warningDigest: string,
  input: FinalizeInput,
): void => {
  const errors = issues.filter(({ severity }) => severity === 'ERROR');
  if (errors.length > 0) throw new FinalizationConflictError(errors);
  const note = input.acknowledgementNote.trim();
  if (
    input.acknowledgedWarningDigest !== warningDigest
    || note.length < 1
    || note.length > 2000
  ) throw new FinalizationAcknowledgementError();
};

const validateFinalizeInput = (draftId: string, input: FinalizeInput): void => {
  requireId(draftId, 'draftId');
  requireId(input.idempotencyKey, 'idempotencyKey');
  requireRevision(input.expectedDraftRevision);
  for (const [name, value] of [
    ['preparedActionToken', input.preparedActionToken],
    ['acknowledgedWarningDigest', input.acknowledgedWarningDigest],
    ['acknowledgementNote', input.acknowledgementNote],
  ] as const) {
    if (typeof value !== 'string' || value.length < 1) {
      throw new FinalizationValidationError(`${name} is required`);
    }
  }
};

const requireEditableRevision = (draft: DraftRecord, expectedRevision: number): void => {
  if (draft.status !== 'DRAFT') {
    throw new FinalizationConflictError([issue(
      'DRAFT_READ_ONLY',
      `Draft is read-only in ${draft.status} status`,
      'ERROR',
    )]);
  }
  if (draft.revision !== expectedRevision) throw new FinalizationStaleError();
};

const requireDraft = (data: DatabaseState, id: string): DraftRecord => {
  const draft = (data.allocationDrafts as DraftRecord[]).find((item) => item.id === id);
  if (!draft) throw new FinalizationValidationError('Allocation draft was not found');
  return draft;
};

const findFinalization = (data: DatabaseState, key: string): FinalizationReceiptRecord | undefined => (
  data.finalizationReceipts.find((item) => item.idempotencyKey === key)
);

const matchingReceipt = (stored: FinalizationReceiptRecord, requestHash: string): FinalizationReceipt => {
  if (stored.requestHash !== requestHash) throw new FinalizationIdempotencyConflictError();
  return structuredClone(stored.receipt);
};

const hashRequest = (draftId: string, input: FinalizeInput): string => digest({
  draftId,
  preparedActionToken: input.preparedActionToken,
  expectedDraftRevision: input.expectedDraftRevision,
  acknowledgedWarningDigest: input.acknowledgedWarningDigest,
  acknowledgementNote: input.acknowledgementNote,
});

const digestWarnings = (issues: FinalizationIssue[]): string => digest(
  issues.filter(({ severity }) => severity === 'WARNING'),
);
const digest = (value: unknown): string => createHash('sha256')
  .update(JSON.stringify(value)).digest('hex');

const sign = (payload: TokenPayload, secret: Buffer): string => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

const verify = (token: string, secret: Buffer): TokenPayload => {
  if (typeof token !== 'string') throw new FinalizationTokenError();
  const [encoded, providedSignature, extra] = token.split('.');
  if (!encoded || !providedSignature || extra !== undefined) throw new FinalizationTokenError();
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignature, 'base64url');
  } catch {
    throw new FinalizationTokenError();
  }
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
    throw new FinalizationTokenError();
  }
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as TokenPayload;
    if (
      payload.version !== 1
      || payload.operation !== 'FINALIZE_DRAFT'
      || typeof payload.draftId !== 'string'
      || !Number.isSafeInteger(payload.draftRevision)
      || !Number.isSafeInteger(payload.storeRevision)
      || typeof payload.storeEpoch !== 'string'
      || !Number.isFinite(Date.parse(payload.expiresAt))
      || typeof payload.warningDigest !== 'string'
      || typeof payload.selectionDigest !== 'string'
      || !Array.isArray(payload.candidates)
      || payload.candidates.some((item) => !candidateValid(item))
    ) throw new FinalizationTokenError();
    return payload;
  } catch (error) {
    if (error instanceof FinalizationTokenError) throw error;
    throw new FinalizationTokenError();
  }
};

const candidateValid = (value: Candidate): boolean => (
  value !== null
  && typeof value === 'object'
  && ['id', 'draftItemId', 'memberId', 'semesterCourseId']
    .every((key) => typeof value[key as keyof Candidate] === 'string')
);

const sameCandidates = (selected: SelectedItem[], candidates: Candidate[]): boolean => (
  selected.length === candidates.length
  && selected.every((item, index) => {
    const candidate = candidates[index];
    return candidate?.draftItemId === item.draftItemId
      && candidate.memberId === item.memberId
      && candidate.semesterCourseId === item.semesterCourseId;
  })
);

const finalizationIssue = (value: EnrollmentIssue): FinalizationIssue => ({
  code: value.code,
  message: value.message,
  severity: value.severity,
  subject: value.subject,
  source: {},
  detail: {},
  blockingStages: ['FINALIZE'],
  acknowledgementStages: value.severity === 'WARNING' ? ['FINALIZE'] : [],
});

const issue = (
  code: string,
  message: string,
  severity: 'ERROR' | 'WARNING',
  memberId?: string,
  courseId?: string,
  detail: { changeCode?: string } = {},
): FinalizationIssue => ({
  code,
  message,
  severity,
  blockingStages: ['FINALIZE'],
  acknowledgementStages: severity === 'WARNING' ? ['FINALIZE'] : [],
  subject: { entityType: 'AllocationDraft', ...(memberId ? { memberId } : {}), ...(courseId ? { courseId } : {}) },
  source: {},
  detail,
});

const sortIssues = (issues: FinalizationIssue[]): FinalizationIssue[] => issues.sort((left, right) => (
  left.severity.localeCompare(right.severity)
  || compareId(left.code, right.code)
  || compareId(left.subject.memberId ?? '', right.subject.memberId ?? '')
  || compareId(left.subject.courseId ?? '', right.subject.courseId ?? '')
));

const count = (ids: string[]): Map<string, number> => {
  const result = new Map<string, number>();
  for (const id of ids) result.set(id, (result.get(id) ?? 0) + 1);
  return result;
};
const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const requireRevision = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new FinalizationValidationError('expectedDraftRevision is invalid');
  }
};
const requireId = (value: string, name: string): void => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new FinalizationValidationError(`${name} is invalid`);
  }
};
