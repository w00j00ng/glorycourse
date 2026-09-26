import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { produce } from 'immer';

import {
  StoreEpochConflictError,
  StoreRevisionConflictError,
  type DatabaseState,
  type EnrollmentRecord as Enrollment,
  type NamedRecord as Named,
  type SemesterCourseRecord as SemesterCourse,
  type SemesterRecord as Semester,
  type Store,
} from '../storage/store.ts';
import { nextSemesterOrder } from './semester-order.ts';

type Action = 'CREATE' | 'UPDATE' | 'DELETE';
export type Acknowledgement = NonNullable<Enrollment['exceptionAcknowledgement']>;
type PreviewInput = {
  action: Action;
  enrollmentId?: string;
  expectedRevision?: number;
  semesterName: string;
  memberName: string;
  courseName: string;
};
type CleanInput = PreviewInput & { semesterName: string; memberName: string; courseName: string };
export type EnrollmentIssue = {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING';
  blockingStages: ('ENROLLMENT_WRITE')[];
  acknowledgementStages: ('ENROLLMENT_WRITE')[];
  subject: { entityType: string; entityId?: string; memberId?: string; courseId?: string };
  source: Record<string, never>;
  detail: Record<string, unknown>;
};
type TokenPayload = {
  version: 1;
  input: CleanInput;
  storeRevision: number;
  storeEpoch: string;
  expiresAt: string;
  warningDigest: string;
};
type BatchInput = Pick<PreviewInput, 'semesterName' | 'memberName' | 'courseName'>;
type BatchTokenPayload = Omit<TokenPayload, 'input'> & { kind: 'BATCH_CREATE'; inputs: BatchInput[] };

export type EnrollmentView = Pick<Enrollment,
  'id' | 'semesterCourseId' | 'memberId' | 'exceptionAcknowledgement' | 'revision'
> & {
  semesterName: string;
  courseName: string;
  memberName: string;
};

export type EnrollmentListFilters = {
  memberName?: string;
  semesterId?: string;
  courseId?: string;
};

export class EnrollmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnrollmentValidationError';
  }
}

export class EnrollmentNotFoundError extends Error {
  constructor() {
    super('Enrollment was not found');
    this.name = 'EnrollmentNotFoundError';
  }
}

export class EnrollmentConflictError extends Error {
  readonly issues: EnrollmentIssue[];

  constructor(issues: EnrollmentIssue[]) {
    super('Enrollment change violates a non-overridable rule');
    this.name = 'EnrollmentConflictError';
    this.issues = issues;
  }
}

export class EnrollmentAcknowledgementError extends Error {
  constructor() {
    super('Current warnings require their exact digest and a non-empty acknowledgement note');
    this.name = 'EnrollmentAcknowledgementError';
  }
}

export class EnrollmentTokenError extends Error {
  constructor(message = 'Prepared action token is invalid or expired') {
    super(message);
    this.name = 'EnrollmentTokenError';
  }
}

export class EnrollmentStaleError extends Error {
  constructor() {
    super('Prepared action no longer matches the current store state');
    this.name = 'EnrollmentStaleError';
  }
}

type Dependencies = { id: () => string; now: () => Date; secret: string | Uint8Array; ttlMs?: number };

export class EnrollmentService {
  private readonly store: Store;
  private readonly dependencies: Required<Omit<Dependencies, 'secret'>> & { secret: Buffer };

  constructor(store: Store, dependencies: Dependencies) {
    const secret = Buffer.from(dependencies.secret);
    if (secret.byteLength < 32) throw new EnrollmentValidationError('Prepared action secret is too short');
    this.store = store;
    this.dependencies = {
      id: dependencies.id,
      now: dependencies.now,
      secret,
      ttlMs: dependencies.ttlMs ?? 5 * 60 * 1000,
    };
  }

  preview(input: PreviewInput) {
    const clean = validateInput(input);
    const data = this.store.read();
    validateTarget(data, clean);
    const issues = enrollmentIssues(data, clean);
    const warningDigest = digestEnrollmentWarnings(issues);
    const expiresAt = new Date(
      this.dependencies.now().getTime() + this.dependencies.ttlMs,
    ).toISOString();
    const payload: TokenPayload = {
      version: 1,
      input: clean,
      storeRevision: data.meta.storeRevision,
      storeEpoch: data.meta.storeEpoch,
      expiresAt,
      warningDigest,
    };
    return {
      preparedActionToken: sign(payload, this.dependencies.secret),
      warningDigest,
      storeRevision: payload.storeRevision,
      storeEpoch: payload.storeEpoch,
      expiresAt,
      issues,
    };
  }

  previewMany(inputs: BatchInput[]) {
    const clean = validateBatchInput(inputs);
    const data = this.store.read();
    let issues: EnrollmentIssue[] = [];
    produce(data, (candidate) => {
      issues = applyBatchCandidate(candidate, clean, this.dependencies.now().toISOString(), randomUUID).issues;
    });
    const payload: BatchTokenPayload = {
      version: 1, kind: 'BATCH_CREATE', inputs: clean,
      storeRevision: data.meta.storeRevision, storeEpoch: data.meta.storeEpoch,
      expiresAt: new Date(this.dependencies.now().getTime() + this.dependencies.ttlMs).toISOString(),
      warningDigest: digestEnrollmentWarnings(issues),
    };
    return {
      preparedActionToken: sign(payload, this.dependencies.secret),
      warningDigest: payload.warningDigest, storeRevision: payload.storeRevision,
      storeEpoch: payload.storeEpoch, expiresAt: payload.expiresAt, issues,
    };
  }

  async executeMany(input: {
    preparedActionToken: string;
    acknowledgedWarningDigest: string;
    acknowledgementNote?: string;
  }): Promise<EnrollmentView[]> {
    const payload = verifyBatch(input.preparedActionToken, this.dependencies.secret);
    if (this.dependencies.now().getTime() >= Date.parse(payload.expiresAt)) throw new EnrollmentTokenError();
    try {
      return await this.store.write({ expectedRevision: payload.storeRevision }, (data) => {
        if (data.meta.storeEpoch !== payload.storeEpoch) throw new EnrollmentStaleError();
        const now = this.dependencies.now().toISOString();
        const { items, issues } = applyBatchCandidate(data, payload.inputs, now, this.dependencies.id);
        const errors = issues.filter(({ severity }) => severity === 'ERROR');
        if (errors.length) throw new EnrollmentConflictError(errors);
        const warningDigest = digestEnrollmentWarnings(issues);
        if (warningDigest !== payload.warningDigest) throw new EnrollmentStaleError();
        const warnings = issues.filter(({ severity }) => severity === 'WARNING');
        const note = typeof input.acknowledgementNote === 'string' ? input.acknowledgementNote.trim() : undefined;
        if (input.acknowledgedWarningDigest !== warningDigest
          || (warnings.length && (!note || note.length > 2000))) throw new EnrollmentAcknowledgementError();
        items.forEach((item, index) => {
          if (!warnings.some(({ detail }) => detail.rowNumber === index + 1)) return;
          const acknowledgement = { warningDigest, note: note!, acknowledgedAt: now };
          enrollments(data).find(({ id }) => id === item.id)!.exceptionAcknowledgement = acknowledgement;
          item.exceptionAcknowledgement = acknowledgement;
        });
        return items;
      });
    } catch (error) {
      if (error instanceof StoreRevisionConflictError) throw new EnrollmentStaleError();
      throw error;
    }
  }

  async execute(input: {
    preparedActionToken: string;
    acknowledgedWarningDigest: string;
    acknowledgementNote?: string;
    expectedAction?: Action;
    expectedEnrollmentId?: string;
  }): Promise<EnrollmentView | { deletedId: string }> {
    const payload = verify(input.preparedActionToken, this.dependencies.secret);
    if (
      (input.expectedAction !== undefined && payload.input.action !== input.expectedAction)
      || (input.expectedEnrollmentId !== undefined
        && payload.input.enrollmentId !== input.expectedEnrollmentId)
    ) throw new EnrollmentTokenError();
    if (this.dependencies.now().getTime() >= Date.parse(payload.expiresAt)) {
      throw new EnrollmentTokenError();
    }
    const current = this.store.version();
    if (
      current.storeEpoch !== payload.storeEpoch
      || current.storeRevision !== payload.storeRevision
    ) throw new EnrollmentStaleError();

    try {
      return await this.store.write({ expectedRevision: payload.storeRevision }, (data) => {
        if (data.meta.storeEpoch !== payload.storeEpoch) throw new EnrollmentStaleError();
        validateTarget(data, payload.input);
        const issues = enrollmentIssues(data, payload.input);
        const warningDigest = digestEnrollmentWarnings(issues);
        if (warningDigest !== payload.warningDigest) throw new EnrollmentStaleError();
        const errors = issues.filter(({ severity }) => severity === 'ERROR');
        if (errors.length > 0) throw new EnrollmentConflictError(errors);

        const warnings = issues.filter(({ severity }) => severity === 'WARNING');
        const note = input.acknowledgementNote?.trim();
        if (
          input.acknowledgedWarningDigest !== warningDigest
          || (warnings.length > 0 && (!note || note.length > 2000))
        ) throw new EnrollmentAcknowledgementError();

        return applyEnrollmentChange(
          data,
          payload.input,
          warnings.length === 0 ? null : {
            warningDigest,
            note: note!,
            acknowledgedAt: this.dependencies.now().toISOString(),
          },
          this.dependencies.now().toISOString(),
          this.dependencies.id,
        );
      });
    } catch (error) {
      if (error instanceof StoreRevisionConflictError) throw new EnrollmentStaleError();
      throw error;
    }
  }

  get(id: string): EnrollmentView {
    const data = this.store.read();
    const enrollment = enrollments(data).find((item) => item.id === id);
    if (!enrollment) throw new EnrollmentNotFoundError();
    return enrollmentView(data, enrollment);
  }

  list(filters: EnrollmentListFilters = {}): EnrollmentView[] {
    const data = this.store.read();
    const memberName = filters.memberName?.trim().normalize('NFC');
    return enrollments(data).filter((enrollment) => {
      const semesterCourse = semesterCourses(data).find(({ id }) => id === enrollment.semesterCourseId);
      return semesterCourse
        && (!filters.semesterId || semesterCourse.semesterId === filters.semesterId)
        && (!filters.courseId || semesterCourse.courseId === filters.courseId)
        && (!memberName || members(data).find(({ id }) => id === enrollment.memberId)?.nameKey.includes(memberName));
    }).map((enrollment) => enrollmentView(data, enrollment));
  }

  previewSemesterDeletion(semesterId: string) {
    const data = this.store.read();
    const semester = semesters(data).find(({ id }) => id === semesterId);
    if (!semester) throw new EnrollmentNotFoundError();
    const courseIds = new Set(semesterCourses(data)
      .filter((course) => course.semesterId === semesterId).map(({ id }) => id));
    return {
      semesterName: semester.name,
      count: enrollments(data).filter(({ semesterCourseId }) => courseIds.has(semesterCourseId)).length,
      storeRevision: data.meta.storeRevision,
      storeEpoch: data.meta.storeEpoch,
    };
  }

  async deleteSemester(semesterId: string, input: {
    confirmationName: string; expectedRevision: number; expectedEpoch: string;
  }): Promise<{ deletedCount: number }> {
    if (!input || typeof input.confirmationName !== 'string'
      || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || typeof input.expectedEpoch !== 'string' || !input.expectedEpoch) {
      throw new EnrollmentValidationError('학기 전체 삭제 요청이 올바르지 않습니다.');
    }
    try {
      return await this.store.write({
        expectedRevision: input.expectedRevision, expectedEpoch: input.expectedEpoch,
      }, (data) => {
        const semester = semesters(data).find(({ id }) => id === semesterId);
        if (!semester) throw new EnrollmentNotFoundError();
        if (semester.name !== input.confirmationName) {
          throw new EnrollmentValidationError('삭제할 학기명을 정확히 입력하세요.');
        }
        const courseIds = new Set(semesterCourses(data)
          .filter((course) => course.semesterId === semesterId).map(({ id }) => id));
        const remaining = enrollments(data).filter(({ semesterCourseId }) => !courseIds.has(semesterCourseId));
        const deletedCount = data.enrollments.length - remaining.length;
        if (deletedCount === 0) throw new EnrollmentValidationError('선택한 학기에 삭제할 수강이력이 없습니다.');
        data.enrollments = remaining;
        return { deletedCount };
      });
    } catch (error) {
      if (error instanceof StoreRevisionConflictError || error instanceof StoreEpochConflictError) {
        throw new EnrollmentStaleError();
      }
      throw error;
    }
  }
}

export const evaluateEnrollmentImport = (
  data: DatabaseState,
  input: { semesterName: string; memberName: string; courseName: string },
): EnrollmentIssue[] => enrollmentIssues(data, validateInput({ action: 'CREATE', ...input }));

export const evaluateEnrollmentSelection = (
  data: DatabaseState,
  input: { semesterCourseId: string; memberId: string },
): EnrollmentIssue[] => {
  const semesterCourse = semesterCourses(data).find(({ id }) => id === input.semesterCourseId);
  const semester = semesterCourse && semesters(data).find(({ id }) => id === semesterCourse.semesterId);
  const course = semesterCourse && courses(data).find(({ id }) => id === semesterCourse.courseId);
  const member = members(data).find(({ id }) => id === input.memberId);
  if (!semesterCourse || !semester || !course || !member) {
    throw new EnrollmentValidationError('Enrollment selection has an invalid live reference');
  }
  return enrollmentIssues(data, validateInput({
    action: 'CREATE',
    semesterName: semester.name,
    memberName: member.name,
    courseName: course.name,
  }));
};

export const applyEnrollmentImport = (
  data: DatabaseState,
  input: { semesterName: string; memberName: string; courseName: string },
  acknowledgedWarningDigest: string,
  acknowledgementNote: string | undefined,
  now: string,
  id: () => string,
  informationalCodes: readonly string[] = [],
): EnrollmentView => {
  const clean = validateInput({ action: 'CREATE', ...input });
  const issues = enrollmentIssues(data, clean).filter(({ code }) => !informationalCodes.includes(code));
  const errors = issues.filter(({ severity }) => severity === 'ERROR');
  if (errors.length > 0) throw new EnrollmentConflictError(errors);
  const warnings = issues.filter(({ severity }) => severity === 'WARNING');
  const warningDigest = digestEnrollmentWarnings(issues);
  const note = acknowledgementNote?.trim();
  if (
    acknowledgedWarningDigest !== warningDigest
    || (warnings.length > 0 && (!note || note.length > 2000))
  ) throw new EnrollmentAcknowledgementError();
  return applyEnrollmentChange(
    data,
    clean,
    warnings.length === 0 ? null : { warningDigest, note: note!, acknowledgedAt: now },
    now,
    id,
  ) as EnrollmentView;
};

const validateInput = (input: PreviewInput): CleanInput => {
  if (!input || typeof input !== 'object') throw new EnrollmentValidationError('이력 행이 올바르지 않습니다.');
  if (!['CREATE', 'UPDATE', 'DELETE'].includes(input.action)) {
    throw new EnrollmentValidationError('action is invalid');
  }
  const semesterName = cleanName(input.semesterName, 'semesterName');
  const memberName = cleanName(input.memberName, 'memberName');
  const courseName = cleanName(input.courseName, 'courseName');
  if (input.action !== 'CREATE') {
    if (!input.enrollmentId) throw new EnrollmentValidationError('enrollmentId is required');
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 0) {
      throw new EnrollmentValidationError('expectedRevision must be a non-negative safe integer');
    }
  }
  return { ...input, semesterName, memberName, courseName };
};

const validateTarget = (data: DatabaseState, input: CleanInput): void => {
  if (input.action === 'CREATE') return;
  const target = enrollments(data).find((item) => item.id === input.enrollmentId);
  if (!target) throw new EnrollmentNotFoundError();
  if (target.revision !== input.expectedRevision) throw new EnrollmentStaleError();
};

const enrollmentIssues = (data: DatabaseState, input: CleanInput): EnrollmentIssue[] => {
  if (input.action === 'DELETE') return [];
  const semester = semesters(data).find((item) => item.nameKey === nameKey(input.semesterName));
  const member = members(data).find((item) => item.nameKey === nameKey(input.memberName));
  const course = courses(data).find((item) => item.nameKey === nameKey(input.courseName));
  const semesterCourse = semester && course
    ? semesterCourses(data).find((item) => item.semesterId === semester.id && item.courseId === course.id)
    : undefined;
  const excludedId = input.action === 'UPDATE' ? input.enrollmentId : undefined;

  if (semester && member && enrollments(data).some((item) => {
    if (item.id === excludedId || item.memberId !== member.id) return false;
    return semesterCourses(data).some((candidate) => (
      candidate.id === item.semesterCourseId && candidate.semesterId === semester.id
    ));
  })) return [issue('SAME_SEMESTER_ENROLLMENT', 'A member can have only one enrollment per semester', 'ERROR', member.id, course?.id)];

  const issues: EnrollmentIssue[] = [];
  if (!semester || semester.order === null) {
    issues.push(issue('SEMESTER_ORDER_UNRESOLVED', 'Semester order is unresolved', 'WARNING', member?.id, course?.id));
  }
  if (!semesterCourse || semesterCourse.capacity === null) {
    issues.push(issue('CAPACITY_UNRESOLVED', 'Course capacity is unresolved', 'WARNING', member?.id, course?.id));
  } else {
    const occupied = enrollments(data).filter((item) => (
      item.id !== excludedId && item.semesterCourseId === semesterCourse.id
    )).length;
    if (occupied >= semesterCourse.capacity) {
      issues.push(issue('CAPACITY_EXCEEDED', 'Course capacity would be exceeded', 'WARNING', member?.id, course?.id));
    }
  }

  if (semester && member && course) {
    let hasPriorCourse = false;
    let hasUnorderedMatchingCourse = false;
    for (const item of enrollments(data)) {
      if (item.id === excludedId || item.memberId !== member.id) continue;
      const oldSemesterCourse = semesterCourses(data).find((candidate) => candidate.id === item.semesterCourseId);
      if (!oldSemesterCourse || oldSemesterCourse.courseId !== course.id) continue;
      const oldSemester = semesters(data).find((candidate) => candidate.id === oldSemesterCourse.semesterId);
      if (!oldSemester || semester.order === null || oldSemester.order === null) {
        hasUnorderedMatchingCourse = true;
      } else if (oldSemester.order < semester.order) {
        hasPriorCourse = true;
      }
    }
    if (
      hasUnorderedMatchingCourse
      && !issues.some(({ code }) => code === 'SEMESTER_ORDER_UNRESOLVED')
    ) issues.push(issue('SEMESTER_ORDER_UNRESOLVED', 'Semester order is unresolved', 'WARNING', member.id, course.id));
    if (hasPriorCourse) issues.push(issue('RETAKE', 'Member has completed this course in an earlier semester', 'WARNING', member.id, course.id));
  }
  return issues;
};

const issue = (
  code: string,
  message: string,
  severity: 'ERROR' | 'WARNING',
  memberId?: string,
  courseId?: string,
): EnrollmentIssue => ({
  code,
  message,
  severity,
  blockingStages: ['ENROLLMENT_WRITE'],
  acknowledgementStages: severity === 'WARNING' ? ['ENROLLMENT_WRITE'] : [],
  subject: { entityType: 'Enrollment', ...(memberId ? { memberId } : {}), ...(courseId ? { courseId } : {}) },
  source: {},
  detail: {},
});

const applyEnrollmentChange = (
  data: DatabaseState,
  input: CleanInput,
  acknowledgement: Acknowledgement | null,
  now: string,
  id: () => string,
): EnrollmentView | { deletedId: string } => {
  if (input.action === 'DELETE') {
    data.enrollments = enrollments(data).filter((item) => item.id !== input.enrollmentId);
    return { deletedId: input.enrollmentId! };
  }

  const semester = resolveSemester(data, input.semesterName, now, id);
  const member = resolveNamed(members(data), input.memberName, now, id);
  const course = resolveNamed(courses(data), input.courseName, now, id);
  const semesterCourse = resolveSemesterCourse(data, semester.id, course.id, now, id);
  if (input.action === 'CREATE') {
    const created: Enrollment = {
      id: id(),
      semesterCourseId: semesterCourse.id,
      memberId: member.id,
      exceptionAcknowledgement: acknowledgement,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    enrollments(data).push(created);
    return enrollmentView(data, created);
  }

  const current = enrollments(data).find((item) => item.id === input.enrollmentId);
  if (!current) throw new EnrollmentNotFoundError();
  current.semesterCourseId = semesterCourse.id;
  current.memberId = member.id;
  current.exceptionAcknowledgement = acknowledgement;
  current.revision += 1;
  current.updatedAt = now;
  return enrollmentView(data, current);
};

const enrollmentView = (data: DatabaseState, enrollment: Enrollment): EnrollmentView => {
  const semesterCourse = semesterCourses(data).find((item) => item.id === enrollment.semesterCourseId);
  const semester = semesterCourse && semesters(data).find((item) => item.id === semesterCourse.semesterId);
  const course = semesterCourse && courses(data).find((item) => item.id === semesterCourse.courseId);
  const member = members(data).find((item) => item.id === enrollment.memberId);
  if (!semesterCourse || !semester || !course || !member) throw new EnrollmentNotFoundError();
  return {
    id: enrollment.id,
    semesterCourseId: enrollment.semesterCourseId,
    memberId: enrollment.memberId,
    semesterName: semester.name,
    courseName: course.name,
    memberName: member.name,
    exceptionAcknowledgement: enrollment.exceptionAcknowledgement,
    revision: enrollment.revision,
  };
};

const sign = (payload: TokenPayload | BatchTokenPayload, secret: Buffer): string => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
};

const readToken = (token: string, secret: Buffer): unknown => {
  if (typeof token !== 'string') throw new EnrollmentTokenError();
  const [encoded, providedSignature, extra] = token.split('.');
  if (!encoded || !providedSignature || extra !== undefined) throw new EnrollmentTokenError();
  const expected = createHmac('sha256', secret).update(encoded).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignature, 'base64url');
  } catch {
    throw new EnrollmentTokenError();
  }
  if (provided.byteLength !== expected.byteLength || !timingSafeEqual(provided, expected)) {
    throw new EnrollmentTokenError();
  }
  try { return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new EnrollmentTokenError(); }
};

const verify = (token: string, secret: Buffer): TokenPayload => {
  try {
    const parsed = readToken(token, secret) as TokenPayload;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.storeRevision)
      || typeof parsed.storeEpoch !== 'string'
      || !Number.isFinite(Date.parse(parsed.expiresAt))
      || typeof parsed.warningDigest !== 'string'
    ) throw new EnrollmentTokenError();
    parsed.input = validateInput(parsed.input);
    return parsed;
  } catch (error) {
    if (error instanceof EnrollmentTokenError) throw error;
    throw new EnrollmentTokenError();
  }
};

const verifyBatch = (token: string, secret: Buffer): BatchTokenPayload => {
  try {
    const parsed = readToken(token, secret) as BatchTokenPayload;
    if (parsed.version !== 1 || parsed.kind !== 'BATCH_CREATE'
      || !Number.isSafeInteger(parsed.storeRevision) || typeof parsed.storeEpoch !== 'string'
      || !Number.isFinite(Date.parse(parsed.expiresAt)) || typeof parsed.warningDigest !== 'string') {
      throw new EnrollmentTokenError();
    }
    parsed.inputs = validateBatchInput(parsed.inputs);
    return parsed;
  } catch { throw new EnrollmentTokenError(); }
};

const validateBatchInput = (inputs: BatchInput[]): BatchInput[] => {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
    throw new EnrollmentValidationError('한 번에 1~100건을 등록하세요.');
  }
  return inputs.map((input, index) => {
    try {
      if (!input || typeof input !== 'object') throw new EnrollmentValidationError('이력 행이 올바르지 않습니다.');
      const clean = validateInput({ ...input, action: 'CREATE' });
      return { semesterName: clean.semesterName, memberName: clean.memberName, courseName: clean.courseName };
    } catch (error) {
      const message = `${index + 1}행: ${error instanceof Error ? error.message : '입력을 확인하세요.'}`;
      throw Object.assign(new EnrollmentValidationError(message), {
        issues: [{ ...issue('ENROLLMENT_INPUT_INVALID', message, 'ERROR'), detail: { rowNumber: index + 1 } }],
      });
    }
  });
};

const applyBatchCandidate = (data: DatabaseState, inputs: BatchInput[], now: string, id: () => string) => {
  const issues: EnrollmentIssue[] = [];
  const items: EnrollmentView[] = [];
  for (const [index, input] of inputs.entries()) {
    const clean: CleanInput = { ...input, action: 'CREATE' };
    const rowIssues = enrollmentIssues(data, clean).map((issue) => ({
      ...issue,
      detail: { rowNumber: index + 1 },
    }));
    issues.push(...rowIssues);
    if (!rowIssues.some(({ severity }) => severity === 'ERROR')) {
      items.push(applyEnrollmentChange(data, clean, null, now, id) as EnrollmentView);
    }
  }
  if (!issues.some(({ severity }) => severity === 'ERROR')) {
    // Earlier semesters may appear later in the request; check retakes against the complete candidate.
    items.forEach((item, index) => {
      const retake = enrollmentIssues(data, { ...inputs[index]!, action: 'UPDATE', enrollmentId: item.id })
        .find(({ code }) => code === 'RETAKE');
      if (retake && !issues.some(({ code, detail }) => code === 'RETAKE' && detail.rowNumber === index + 1)) {
        issues.push({ ...retake, detail: { rowNumber: index + 1 } });
      }
    });
  }
  return { items, issues: issues.map((issue) => ({
    ...issue,
    message: `${issue.detail.rowNumber}행 (${inputs[Number(issue.detail.rowNumber) - 1]!.memberName}): ${issue.message}`,
    subject: { entityType: 'Enrollment' },
  })) };
};

export const digestEnrollmentWarnings = (issues: EnrollmentIssue[]): string => createHash('sha256')
  .update(JSON.stringify(issues.filter(({ severity }) => severity === 'WARNING')))
  .digest('hex');

const cleanName = (value: string, field: string): string => {
  if (typeof value !== 'string') throw new EnrollmentValidationError(`${field} must be a string`);
  const clean = value.trim();
  if (clean.length < 1 || clean.length > 200) {
    throw new EnrollmentValidationError(`${field} must contain between 1 and 200 characters`);
  }
  return clean;
};

const nameKey = (value: string): string => value.trim().normalize('NFC');

const resolveNamed = (items: Named[], name: string, now: string, id: () => string): Named => {
  const key = nameKey(name);
  const existing = items.find((item) => item.nameKey === key);
  if (existing) return existing;
  const created = { id: id(), name, nameKey: key, createdAt: now, updatedAt: now };
  items.push(created);
  return created;
};

const resolveSemester = (
  data: DatabaseState,
  name: string,
  now: string,
  id: () => string,
): Semester => {
  const key = nameKey(name);
  const existing = semesters(data).find((item) => item.nameKey === key);
  if (existing) return existing;
  const created: Semester = {
    id: id(),
    name,
    nameKey: key,
    order: nextSemesterOrder(semesters(data)),
    allocationInputRevision: 0,
    createdAt: now,
    updatedAt: now,
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
  const existing = semesterCourses(data).find((item) => (
    item.semesterId === semesterId && item.courseId === courseId
  ));
  if (existing) return existing;
  const created: SemesterCourse = {
    id: id(),
    semesterId,
    courseId,
    capacity: null,
    createdAt: now,
    updatedAt: now,
  };
  semesterCourses(data).push(created);
  return created;
};

const semesters = (data: DatabaseState): Semester[] => data.semesters;
const members = (data: DatabaseState): Named[] => data.members;
const courses = (data: DatabaseState): Named[] => data.courses;
const semesterCourses = (data: DatabaseState): SemesterCourse[] => data.semesterCourses;
const enrollments = (data: DatabaseState): Enrollment[] => data.enrollments;
