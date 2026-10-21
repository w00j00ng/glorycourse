import { createHash, randomUUID } from 'node:crypto';

import { MAX_CHOICES_PER_APPLICATION } from '../allocation/engine.ts';
import { applicationWarnings } from '../domain/application-warnings.ts';
import {
  extractRawRows,
  exportRawRows,
  readSafeWorkbook,
  TEMPLATE_VERSIONS,
  WorkbookValidationError,
  type ImportKind,
  type RawRow,
  type WorkbookLimits,
} from '../excel/workbooks.ts';
import { applyBatchCandidate, evaluateEnrollmentImport } from './enrollments.ts';
import { applyContext } from './import-context.ts';
import type { Repository } from '../repository/database.ts';
import type { ImportContext } from '../repository/imports.ts';
import type { ImportBatchRecord } from '../domain/records.ts';

export type ImportMode = 'MERGE_KEEP_EXISTING' | 'REPLACE_APPLICATION';
export type ApplicationStatus = 'NORMAL' | 'CONFLICT' | 'MISSING' | 'INVALID';
export type ImportIssue = {
  code: string;
  message: string;
  severity: 'ERROR' | 'WARNING' | 'INFO';
  blockingStages: ('IMPORT_COMMIT' | 'AUTO_ALLOCATE')[];
  acknowledgementStages: ('IMPORT_COMMIT')[];
  subject: { entityType: string; entityId?: string; memberId?: string; courseId?: string };
  source: { sheet?: string; row?: number; column?: string };
  detail: Record<string, unknown>;
};
export type ApplicationCandidate = {
  semesterName: string;
  memberName: string;
  ministry: string | null;
  applicantNote?: string | null;
  applicationOrder: number | null;
  applicationOrderStatus: ApplicationStatus;
  choices: Array<{
    courseName: string;
    preference: number | null;
    sourceRefs: Array<{ sheet: string; row: number }>;
  }>;
  sourceRowCount: number;
  removedCourseNames: string[];
};
export type EnrollmentCandidate = {
  semesterName: string;
  memberName: string;
  ministry: string | null;
  courseName: string;
  adminNote: string;
  sourceRef: { sheet: string; row: number };
};
export type ImportContextChange = {
  entity: 'SEMESTER' | 'SEMESTER_COURSE';
  semesterName: string;
  courseName?: string;
  field: 'order' | 'capacity';
  fileValue: number | null;
  existingValue: number | null;
  status: 'NEW' | 'IDENTICAL' | 'EXISTING_CONFLICT' | 'MISSING' | 'INVALID' | 'SOURCE_CONFLICT';
  sourceRefs: Array<{ sheet: string; row: number }>;
};
export type ImportPreview = {
  previewId: string;
  kind: ImportKind;
  templateVersion: string;
  mode: ImportMode;
  fileHash: string;
  storeRevision: number;
  storeEpoch: string;
  expiresAt: string;
  warningDigest: string;
  sourceBatchId?: string;
  sourceRowCount: number;
  insertCandidates: number;
  identicalRows: number;
  conflicts: number;
  issues: ImportIssue[];
  contextChanges: ImportContextChange[];
  rawRows: RawRow[];
  applications: ApplicationCandidate[];
  enrollments: EnrollmentCandidate[];
};
type Dependencies = {
  id: () => string;
  now: () => Date;
  limits?: Partial<WorkbookLimits>;
  previewTtlMs?: number;
};
type ImportBatch = ImportBatchRecord;

export class ImportPreviewNotFoundError extends Error {
  constructor() {
    super('Import preview was not found or has expired');
    this.name = 'ImportPreviewNotFoundError';
  }
}

export class ImportBatchNotFoundError extends Error {
  constructor() {
    super('Import batch was not found');
    this.name = 'ImportBatchNotFoundError';
  }
}

export class ImportPreviewService {
  readonly #repository: Repository;
  readonly #dependencies: Dependencies & { previewTtlMs: number };
  readonly #previews = new Map<string, ImportPreview>();

  constructor(repository: Repository, dependencies: Dependencies) {
    this.#repository = repository;
    this.#dependencies = { ...dependencies, previewTtlMs: dependencies.previewTtlMs ?? 15 * 60 * 1000 };
  }

  async preview(input: {
    filename: string;
    bytes: Uint8Array;
    kind: ImportKind;
    mode?: ImportMode;
  }): Promise<ImportPreview> {
    const workbook = await readSafeWorkbook({
      filename: input.filename,
      bytes: input.bytes,
      limits: this.#dependencies.limits,
    });
    const templateVersion = validateMetadata(workbook, input.kind);
    const rawRows = extractRawRows(workbook, input.kind);
    return this.#remember(buildPreview(
      this.#repository.read((queries) => queries.imports.getContext()),
      input.kind,
      templateVersion,
      rawRows,
      createHash('sha256').update(input.bytes).digest('hex'),
      this.#dependencies.id(),
      new Date(this.#dependencies.now().getTime() + this.#dependencies.previewTtlMs).toISOString(),
      input.mode ?? 'MERGE_KEEP_EXISTING',
    ));
  }

  async stage(previewId: string): Promise<ImportBatch> {
    const preview = this.#previews.get(previewId);
    if (!preview || Date.parse(preview.expiresAt) <= this.#dependencies.now().getTime()) {
      this.#previews.delete(previewId);
      throw new ImportPreviewNotFoundError();
    }
    return this.#repository.write({}, (queries) => {
      const batch: ImportBatch = {
        id: this.#dependencies.id(),
        kind: preview.kind,
        templateVersion: preview.templateVersion,
        fileHash: preview.fileHash,
        importedAt: this.#dependencies.now().toISOString(),
        status: 'STAGED',
        rawRows: structuredClone(preview.rawRows),
        resolutions: [],
        receipt: null,
      };
      queries.imports.saveBatch({ record: batch });
      return structuredClone(batch);
    });
  }

  getStaged(id: string): ImportBatch {
    const batch = this.#repository.read((queries) => queries.imports.getBatch({ id }));
    if (!batch || batch.status !== 'STAGED') throw new ImportBatchNotFoundError();
    return structuredClone(batch);
  }

  repreviewStaged(id: string): ImportPreview {
    const batch = this.getStaged(id);
    return this.#remember(buildPreview(
      this.#repository.read((queries) => queries.imports.getContext()),
      batch.kind,
      batch.templateVersion,
      batch.rawRows,
      batch.fileHash,
      this.#dependencies.id(),
      new Date(this.#dependencies.now().getTime() + this.#dependencies.previewTtlMs).toISOString(),
      'MERGE_KEEP_EXISTING',
      batch.id,
    ));
  }

  getPreview(id: string): ImportPreview {
    const preview = this.#previews.get(id);
    if (!preview || Date.parse(preview.expiresAt) <= this.#dependencies.now().getTime()) {
      this.#previews.delete(id);
      throw new ImportPreviewNotFoundError();
    }
    return structuredClone(preview);
  }

  async exportStagedOriginal(id: string): Promise<Buffer> {
    const batch = this.getStaged(id);
    return exportRawRows(batch.kind, batch.rawRows, batch.templateVersion);
  }

  #remember(preview: ImportPreview): ImportPreview {
    for (const [id, current] of this.#previews) {
      if (Date.parse(current.expiresAt) <= this.#dependencies.now().getTime()) this.#previews.delete(id);
    }
    this.#previews.set(preview.previewId, structuredClone(preview));
    return structuredClone(preview);
  }
}

const buildPreview = (
  data: ImportContext,
  kind: ImportKind,
  templateVersion: string,
  rawRows: RawRow[],
  fileHash: string,
  previewId: string,
  expiresAt: string,
  mode: ImportMode,
  sourceBatchId?: string,
): ImportPreview => {
  const result = kind === 'APPLICATIONS'
    ? analyzeApplications(data, rawRows, mode)
    : analyzeEnrollments(data, rawRows);
  return {
    previewId,
    kind,
    templateVersion,
    mode,
    fileHash,
    storeRevision: data.meta.storeRevision,
    storeEpoch: data.meta.storeEpoch,
    expiresAt,
    warningDigest: warningDigest(result.issues),
    ...(sourceBatchId ? { sourceBatchId } : {}),
    rawRows: structuredClone(rawRows),
    ...result,
  };
};

const analyzeApplications = (data: ImportContext, rawRows: RawRow[], mode: ImportMode) => {
  const sourceRows = rawRows.filter(({ sheet, row }) => sheet === '수강신청' && row > 1);
  const issues: ImportIssue[] = [];
  const seen = new Set<string>();
  for (const row of sourceRows) {
    const key = `${nameKey(row.cells['학기명'])}\0${nameKey(row.cells['회원명'])}`;
    if (seen.has(key)) issues.push(requiredRowIssue(
      'DUPLICATE_APPLICATION', 'A member has more than one application row in the same semester', row, '회원명',
    ));
    seen.add(key);
  }
  const contextChanges = analyzeContext(data, rawRows, issues);
  const candidates = sourceRows.map((row) => applicationCandidate(row, issues));
  for (const candidate of candidates) {
    for (const choice of candidate.choices) {
      if (!candidate.semesterName || !choice.courseName || contextChanges.some((change) => (
        change.entity === 'SEMESTER_COURSE'
        && nameKey(change.semesterName) === nameKey(candidate.semesterName)
        && nameKey(change.courseName ?? '') === nameKey(choice.courseName)
      ))) continue;
      const capacity = contextValue(data, 'SEMESTER_COURSE', candidate.semesterName, choice.courseName);
      if (capacity !== undefined && capacity !== null) continue;
      const source = sourceRows.find(({ row }) => row === choice.sourceRefs[0]?.row);
      if (source) issues.push(requiredRowIssue(
        'APPLICATION_COURSE_CAPACITY_MISSING', 'Course capacity is required', source, `${choice.preference}순위 강좌`,
      ));
    }
  }
  let insertCandidates = 0;
  let identicalRows = 0;
  let conflicts = 0;
  for (const candidate of candidates) {
    const qualityConflict = candidate.applicationOrderStatus !== 'NORMAL'
      || candidate.choices.some(({ preference }) => preference === null)
      || !candidate.semesterName
      || !candidate.memberName
      || (candidate.ministry?.length ?? 0) > 200
      || (candidate.applicantNote?.length ?? 0) > 2000;
    const existing = findApplication(data, candidate.semesterName, candidate.memberName);
    candidate.removedCourseNames = existing && mode === 'REPLACE_APPLICATION'
      ? removedCourseNames(data, existing, candidate)
      : [];
    if (!existing && !qualityConflict) insertCandidates += 1;
    else if (existing && applicationMatches(data, existing, candidate)) identicalRows += candidate.sourceRowCount;
    else conflicts += 1;
    issues.push(...candidateWarnings(data, candidate, contextChanges));
  }
  return {
    sourceRowCount: sourceRows.length,
    insertCandidates,
    identicalRows,
    conflicts,
    issues,
    contextChanges,
    applications: candidates,
    enrollments: [] as EnrollmentCandidate[],
  };
};

const applicationCandidate = (first: RawRow, issues: ImportIssue[]): ApplicationCandidate => {
  const semesterName = clean(first.cells['학기명']);
  const memberName = clean(first.cells['회원명']);
  const ministry = clean(first.cells['학생 소속']) || null;
  const applicantNote = '신청자 메모' in first.cells ? clean(first.cells['신청자 메모']) || null : undefined;
  if (applicantNote && applicantNote.length > 2000) issues.push(requiredRowIssue(
    'APPLICANT_NOTE_TOO_LONG', '신청자 메모는 2000자 이내로 입력하세요.', first, '신청자 메모',
  ));
  if (ministry && ministry.length > 200) issues.push(requiredRowIssue(
    'MINISTRY_TOO_LONG', '학생 소속은 200자 이내로 입력하세요.', first, '학생 소속',
  ));
  if (!semesterName) issues.push(requiredRowIssue('SEMESTER_NAME_REQUIRED', 'Semester name is required', first, '학기명'));
  if (!memberName) issues.push(requiredRowIssue('MEMBER_NAME_REQUIRED', 'Member name is required', first, '회원명'));
  const parsedOrder = parsePositiveInteger(first.cells['신청순서']);
  const applicationOrderStatus = parsedOrder.kind === 'VALID' ? 'NORMAL' : parsedOrder.kind;
  const applicationOrder = parsedOrder.kind === 'VALID' ? parsedOrder.value : null;
  if (applicationOrderStatus !== 'NORMAL') {
    issues.push(rowIssue(
      `APPLICATION_ORDER_${applicationOrderStatus}`,
      `Application order is ${applicationOrderStatus.toLowerCase()}`,
      first,
      '신청순서',
    ));
  }

  const choices: ApplicationCandidate['choices'] = [];
  for (const [column, value] of Object.entries(first.cells)) {
    const match = /^(\d+)순위 강좌$/.exec(column);
    if (!match) continue;
    const courseName = clean(value);
    if (!courseName) continue;
    choices.push({ courseName, preference: Number(match[1]), sourceRefs: [{ sheet: first.sheet, row: first.row }] });
  }
  if (choices.length > MAX_CHOICES_PER_APPLICATION || choices.some(({ preference }) => (
    preference === null || !Number.isSafeInteger(preference) || preference < 1 || preference > MAX_CHOICES_PER_APPLICATION
  ))) issues.push(requiredRowIssue(
    'APPLICATION_CHOICE_LIMIT', `Applications allow at most ${MAX_CHOICES_PER_APPLICATION} preferences`, first, '희망 강좌',
  ));
  if (choices.length === 0) issues.push(requiredRowIssue('CHOICE_REQUIRED', 'At least one course is required', first, '1순위 강좌'));
  return {
    semesterName,
    memberName,
    ministry,
    ...(applicantNote !== undefined ? { applicantNote } : {}),
    applicationOrder,
    applicationOrderStatus,
    choices,
    sourceRowCount: 1,
    removedCourseNames: [],
  };
};

const analyzeEnrollments = (data: ImportContext, rawRows: RawRow[]) => {
  const sourceRows = rawRows.filter(({ sheet, row }) => sheet === '수강이력' && row > 1);
  const issues: ImportIssue[] = [];
  const contextChanges = contextCandidates(data, rawRows.filter(({ sheet }) => sheet === '개설강좌'), 'SEMESTER_COURSE', issues, 'ENROLLMENTS');
  const candidates = sourceRows.map((row): EnrollmentCandidate => {
    const semesterName = clean(row.cells['학기명']);
    const memberName = clean(row.cells['회원명']);
    const ministry = clean(row.cells['학생 소속']) || null;
    if (ministry && ministry.length > 200) issues.push(requiredRowIssue(
      'MINISTRY_TOO_LONG', '학생 소속은 200자 이내로 입력하세요.', row, '학생 소속',
    ));
    const courseName = clean(row.cells['강좌명']);
    const adminNote = clean(row.cells['관리자 메모']);
    if (!semesterName) issues.push(requiredRowIssue('SEMESTER_NAME_REQUIRED', 'Semester name is required', row, '학기명'));
    if (!memberName) issues.push(requiredRowIssue('MEMBER_NAME_REQUIRED', 'Member name is required', row, '회원명'));
    if (!courseName) issues.push(requiredRowIssue('COURSE_NAME_REQUIRED', 'Course name is required', row, '강좌명'));
    if (adminNote.length > 2000) issues.push(requiredRowIssue('ENROLLMENT_NOTE_TOO_LONG', 'Administrator note must be at most 2000 characters', row, '관리자 메모'));
    return { semesterName, memberName, ministry, courseName, adminNote, sourceRef: { sheet: row.sheet, row: row.row } };
  });

  const groups = new Map<string, EnrollmentCandidate[]>();
  for (const candidate of candidates) {
    const key = `${nameKey(candidate.semesterName)}\0${nameKey(candidate.memberName)}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    if (group.length > 1) {
      issues.push({
        code: 'DUPLICATE_SEMESTER_ENROLLMENT',
        message: 'A member has more than one enrollment row in the same semester',
        severity: 'ERROR',
        blockingStages: ['IMPORT_COMMIT'],
        acknowledgementStages: [],
        subject: { entityType: 'Enrollment' },
        source: group[0]!.sourceRef,
        detail: { rows: group.map(({ sourceRef }) => sourceRef.row) },
      });
    }
  }
  let insertCandidates = 0;
  let identicalRows = 0;
  let conflicts = 0;
  const pending: EnrollmentCandidate[] = [];
  for (const group of groups.values()) {
    if (group.length > 1 || !group[0]!.semesterName || !group[0]!.memberName || !group[0]!.courseName || (group[0]!.ministry?.length ?? 0) > 200) {
      conflicts += group.length;
      continue;
    }
    const existing = findEnrollment(data, group[0]!.semesterName, group[0]!.memberName);
    if (existing === null) {
      insertCandidates += 1;
      pending.push(group[0]!);
    }
    else if (nameKey(existing.courseName) === nameKey(group[0]!.courseName)) {
      if (existing.ministry !== group[0]!.ministry) {
        conflicts += 1;
        issues.push(requiredRowIssue('ENROLLMENT_MINISTRY_CONFLICT',
          '기존 수강이력과 학생 소속이 다릅니다. 수강이력 화면에서 확인 후 수정하세요.', sourceRows.find(({ row }) => row === group[0]!.sourceRef.row)!, '학생 소속'));
        continue;
      }
      identicalRows += 1;
      continue;
    } else conflicts += 1;
    const semester = data.semesters.find(({ nameKey: key }) => key === nameKey(group[0]!.semesterName));
    const course = data.courses.find(({ nameKey: key }) => key === nameKey(group[0]!.courseName));
    const semesterCourse = semester && course && data.semesterCourses.find((item) => (
      item.semesterId === semester.id && item.courseId === course.id
    ));
    for (const issue of evaluateEnrollmentImport(data, group[0]!)) {
      if (issue.code === 'CAPACITY_UNRESOLVED' && !semesterCourse && contextChanges.some((change) => (
        change.status === 'NEW' && nameKey(change.semesterName) === nameKey(group[0]!.semesterName)
        && nameKey(change.courseName ?? '') === nameKey(group[0]!.courseName)
      ))) continue;
      const informational = (issue.code === 'SEMESTER_ORDER_UNRESOLVED' && !semester)
        || (issue.code === 'CAPACITY_UNRESOLVED' && !semesterCourse);
      issues.push({
        ...issue,
        severity: informational ? 'INFO' : issue.severity,
        blockingStages: issue.severity === 'ERROR' ? ['IMPORT_COMMIT'] : [],
        acknowledgementStages: issue.severity === 'WARNING' && !informational ? ['IMPORT_COMMIT'] : [],
        source: group[0]!.sourceRef,
      });
    }
  }
  const now = new Date().toISOString();
  const actions = contextChanges.some(({ status }) => status === 'EXISTING_CONFLICT')
    ? ['KEEP_EXISTING', 'APPLY_FILE_VALUE'] as const : ['APPLY_FILE_VALUE'] as const;
  for (const action of actions) {
    const prospective = structuredClone(data);
    applyContext(prospective, contextChanges, contextChanges.filter(({ status }) => status === 'EXISTING_CONFLICT').map((change) => ({
      entity: change.entity, field: change.field, semesterName: change.semesterName, courseName: change.courseName, action,
    })), now, randomUUID);
    const cohort = applyBatchCandidate(prospective, pending, now, randomUUID);
    for (const issue of cohort.issues) {
      const source = pending[Number(issue.detail.rowNumber) - 1]!.sourceRef;
      if (issues.some((existing) => existing.code === issue.code && existing.source.sheet === source.sheet && existing.source.row === source.row)) continue;
      issues.push({
        ...issue,
        blockingStages: issue.severity === 'ERROR' ? ['IMPORT_COMMIT'] : [],
        acknowledgementStages: issue.severity === 'WARNING' ? ['IMPORT_COMMIT'] : [],
        source,
      });
    }
  }
  return {
    sourceRowCount: sourceRows.length,
    insertCandidates,
    identicalRows,
    conflicts,
    issues,
    contextChanges,
    applications: [] as ApplicationCandidate[],
    enrollments: candidates,
  };
};

const analyzeContext = (data: ImportContext, rawRows: RawRow[], issues: ImportIssue[]): ImportContextChange[] => [
  ...contextCandidates(data, rawRows.filter(({ sheet }) => sheet === '학기'), 'SEMESTER', issues),
  ...contextCandidates(data, rawRows.filter(({ sheet }) => sheet === '개설강좌'), 'SEMESTER_COURSE', issues),
];

const contextCandidates = (
  data: ImportContext,
  rows: RawRow[],
  entity: ImportContextChange['entity'],
  issues: ImportIssue[],
  kind: ImportKind = 'APPLICATIONS',
): ImportContextChange[] => {
  const groups = new Map<string, RawRow[]>();
  for (const row of rows) {
    const semesterName = clean(row.cells['학기명']);
    const courseName = entity === 'SEMESTER_COURSE' ? clean(row.cells['강좌명']) : '';
    const key = `${nameKey(semesterName)}\0${nameKey(courseName)}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const semesterName = clean(first.cells['학기명']);
    const courseName = entity === 'SEMESTER_COURSE' ? clean(first.cells['강좌명']) : undefined;
    const field = entity === 'SEMESTER' ? 'order' : 'capacity';
    const column = entity === 'SEMESTER' ? '순서' : '정원';
    const parsed = group.map((row) => parseContextInteger(row.cells[column], field === 'capacity', kind === 'ENROLLMENTS'));
    const values = new Set(parsed.filter((item) => item.kind === 'VALID').map((item) => item.value));
    let sourceStatus: ImportContextChange['status'] | null = null;
    if (!semesterName || (entity === 'SEMESTER_COURSE' && !courseName)) {
      sourceStatus = 'INVALID';
      if (!semesterName) issues.push(requiredRowIssue('SEMESTER_NAME_REQUIRED', 'Semester name is required', first, '학기명'));
      if (entity === 'SEMESTER_COURSE' && !courseName) {
        issues.push(requiredRowIssue('COURSE_NAME_REQUIRED', 'Course name is required', first, '강좌명'));
      }
    }
    else if (parsed.some(({ kind }) => kind === 'INVALID')) sourceStatus = 'INVALID';
    else if (parsed.every(({ kind }) => kind === 'MISSING')) sourceStatus = 'MISSING';
    else if (values.size !== 1 || parsed.some(({ kind }) => kind === 'MISSING')) sourceStatus = 'SOURCE_CONFLICT';
    const fileValue = sourceStatus === null ? [...values][0]! : null;
    const existingValue = contextValue(data, entity, semesterName, courseName);
    const status = sourceStatus
      ?? (existingValue === undefined ? 'NEW' : existingValue === fileValue ? 'IDENTICAL' : 'EXISTING_CONFLICT');
    const missingRow = entity === 'SEMESTER_COURSE'
      ? group.find((_, index) => parsed[index]?.kind === 'MISSING')
      : undefined;
    if (missingRow) issues.push(requiredRowIssue(
      'SEMESTER_COURSE_CAPACITY_MISSING', 'Course capacity is required', missingRow, column,
    ));
    if (status !== 'NEW' && status !== 'IDENTICAL' && !missingRow) {
      const blocksImport = kind === 'ENROLLMENTS' && (status === 'INVALID' || status === 'SOURCE_CONFLICT');
      issues.push({
        ...rowIssue(
          `${entity}_${field.toUpperCase()}_${status}`,
          `${entity} ${field} requires review`,
          first,
          column,
        ),
        severity: blocksImport ? 'ERROR' : 'WARNING',
        blockingStages: blocksImport ? ['IMPORT_COMMIT'] : ['AUTO_ALLOCATE'],
      });
    }
    return {
      entity,
      semesterName,
      ...(courseName !== undefined ? { courseName } : {}),
      field,
      fileValue,
      existingValue: existingValue ?? null,
      status,
      sourceRefs: group.map(({ sheet, row }) => ({ sheet, row })),
    };
  });
};

const contextValue = (
  data: ImportContext,
  entity: ImportContextChange['entity'],
  semesterName: string,
  courseName?: string,
): number | null | undefined => {
  const semester = data.semesters.find((item) => item.nameKey === nameKey(semesterName));
  if (!semester) return undefined;
  if (entity === 'SEMESTER') return semester.order as number | null;
  const course = data.courses.find((item) => item.nameKey === nameKey(courseName ?? ''));
  const semesterCourse = course && data.semesterCourses.find((item) => (
    item.semesterId === semester.id && item.courseId === course.id
  ));
  return semesterCourse ? semesterCourse.capacity as number | null : undefined;
};

const validateMetadata = (workbook: import('@excel.js/exceljs').Workbook, kind: ImportKind): string => {
  const metadata = workbook.getWorksheet('메타');
  if (
    !metadata
    || metadata.getCell('A1').text !== 'templateVersion'
    || !['2', '3', TEMPLATE_VERSIONS[kind]].includes(metadata.getCell('B1').text)
    || metadata.getCell('A2').text !== 'kind'
    || metadata.getCell('B2').text !== kind
  ) throw new WorkbookValidationError([{
    code: 'INVALID_METADATA',
    message: 'Workbook metadata does not match the selected import kind',
    location: '메타!A1:B2',
  }]);
  return metadata.getCell('B1').text;
};

const parsePositiveInteger = (raw: string | null | undefined): (
  { kind: 'VALID'; value: number } | { kind: 'MISSING' | 'INVALID' }
) => {
  const value = clean(raw);
  if (!value) return { kind: 'MISSING' };
  if (!/^\d+$/.test(value)) return { kind: 'INVALID' };
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0
    ? { kind: 'VALID', value: number }
    : { kind: 'INVALID' };
};

const parseContextInteger = (raw: string | null | undefined, zeroAllowed: boolean, unresolvedAllowed = false): (
  { kind: 'VALID'; value: number | null } | { kind: 'MISSING' | 'INVALID' }
) => {
  const value = clean(raw);
  if (!value) return { kind: 'MISSING' };
  if (unresolvedAllowed && value === '미정') return { kind: 'VALID', value: null };
  if (!/^\d+$/.test(value)) return { kind: 'INVALID' };
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= (zeroAllowed ? 0 : 1)
    ? { kind: 'VALID', value: number }
    : { kind: 'INVALID' };
};

const rowIssue = (code: string, message: string, row: RawRow, column: string): ImportIssue => ({
  code,
  message,
  severity: 'WARNING',
  blockingStages: ['AUTO_ALLOCATE'],
  acknowledgementStages: [],
  subject: { entityType: row.sheet === '수강신청' ? 'Application' : 'Enrollment' },
  source: { sheet: row.sheet, row: row.row, column },
  detail: {},
});

const requiredRowIssue = (code: string, message: string, row: RawRow, column: string): ImportIssue => ({
  ...rowIssue(code, message, row, column),
  severity: 'ERROR',
  blockingStages: ['IMPORT_COMMIT'],
});

const findApplication = (
  data: ImportContext,
  semesterName: string,
  memberName: string,
): ImportContext['applications'][number] | undefined => {
  const semester = data.semesters.find((item) => item.nameKey === nameKey(semesterName));
  const member = data.members.find((item) => item.nameKey === nameKey(memberName));
  return semester && member
    ? data.applications.find((item) => item.semesterId === semester.id && item.memberId === member.id)
    : undefined;
};

const applicationMatches = (
  data: ImportContext,
  application: ImportContext['applications'][number],
  candidate: ApplicationCandidate,
): boolean => {
  if (
    application.applicationOrderStatus !== candidate.applicationOrderStatus
    || application.applicationOrder !== candidate.applicationOrder
    || application.ministry !== candidate.ministry
    || (candidate.applicantNote !== undefined && application.applicantNote !== candidate.applicantNote)
  ) return false;
  const actual = data.applicationChoices
    .filter((choice) => choice.applicationId === application.id)
    .map((choice) => {
      const semesterCourse = data.semesterCourses.find((item) => item.id === choice.semesterCourseId);
      const course = semesterCourse && data.courses.find((item) => item.id === semesterCourse.courseId);
      return course ? `${course.nameKey}\0${choice.preference}` : '';
    })
    .sort();
  const expected = candidate.choices.map(({ courseName, preference }) => `${nameKey(courseName)}\0${preference}`).sort();
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
};

const findEnrollment = (data: ImportContext, semesterName: string, memberName: string): { courseName: string; ministry: string | null } | null => {
  const semester = data.semesters.find((item) => item.nameKey === nameKey(semesterName));
  const member = data.members.find((item) => item.nameKey === nameKey(memberName));
  if (!semester || !member) return null;
  const enrollment = data.enrollments.find((item) => {
    if (item.memberId !== member.id) return false;
    const semesterCourse = data.semesterCourses.find((candidate) => candidate.id === item.semesterCourseId);
    return semesterCourse?.semesterId === semester.id;
  });
  if (!enrollment) return null;
  const semesterCourse = data.semesterCourses.find((item) => item.id === enrollment.semesterCourseId);
  const course = semesterCourse && data.courses.find((item) => item.id === semesterCourse.courseId);
  return course ? { courseName: course.name, ministry: enrollment.ministry } : null;
};

const removedCourseNames = (
  data: ImportContext,
  application: ImportContext['applications'][number],
  candidate: ApplicationCandidate,
): string[] => {
  const expected = new Set(candidate.choices.map(({ courseName }) => nameKey(courseName)));
  return data.applicationChoices
    .filter((choice) => choice.applicationId === application.id)
    .map((choice) => {
      const semesterCourse = data.semesterCourses.find((item) => item.id === choice.semesterCourseId);
      return semesterCourse && data.courses.find((item) => item.id === semesterCourse.courseId);
    })
    .filter((course) => course !== undefined)
    .filter((course) => !expected.has(String(course.nameKey)))
    .map((course) => String(course.name))
    .sort();
};

const warningDigest = (issues: ImportIssue[]): string => createHash('sha256')
  .update(JSON.stringify(issues.filter(({ severity }) => severity === 'WARNING')))
  .digest('hex');

const candidateWarnings = (
  data: ImportContext,
  candidate: ApplicationCandidate,
  changes: ImportContextChange[],
): ImportIssue[] => {
  const member = data.members.find(({ nameKey: key }) => key === nameKey(candidate.memberName));
  if (!member) return [];
  const semester = data.semesters.find(({ nameKey: key }) => key === nameKey(candidate.semesterName));
  const change = changes.find((change) => change.entity === 'SEMESTER'
    && nameKey(change.semesterName) === nameKey(candidate.semesterName));
  const semesterOrders = change?.status === 'NEW' ? [change.fileValue]
    : change?.status === 'EXISTING_CONFLICT' ? [semester?.order ?? null, change.fileValue]
      : [semester?.order ?? null];
  const choices = candidate.choices.flatMap((choice) => {
    const course = data.courses.find(({ nameKey: key }) => key === nameKey(choice.courseName));
    if (!course) return [];
    const semesterCourse = data.semesterCourses.find((item) => item.semesterId === semester?.id && item.courseId === course.id);
    return [{ semesterCourseId: semesterCourse?.id ?? course.id, courseId: course.id,
      courseName: course.name, preference: choice.preference }];
  });
  const history = data.enrollments.filter(({ memberId }) => memberId === member.id).flatMap((enrollment) => {
    const course = data.semesterCourses.find(({ id }) => id === enrollment.semesterCourseId);
    if (!course || course.semesterId === semester?.id) return [];
    const historySemester = data.semesters.find(({ id }) => id === course.semesterId);
    const change = changes.find((change) => change.entity === 'SEMESTER'
      && nameKey(change.semesterName) === historySemester?.nameKey);
    const orders = change?.status === 'EXISTING_CONFLICT'
      ? [historySemester?.order ?? null, change.fileValue] : [historySemester?.order ?? null];
    return orders.map((semesterOrder) => ({ courseId: course.courseId, semesterOrder }));
  });
  const warnings = new Map(semesterOrders.flatMap((semesterOrder) => (
    applicationWarnings({ memberId: member.id, semesterOrder, choices, history })
  )).map((warning) => [`${warning.code}\0${warning.semesterCourseId}`, warning]));
  return [...warnings.values()].flatMap((warning) => (
    candidate.choices.filter(({ courseName }) => nameKey(courseName) === nameKey(warning.courseName)).flatMap((choice) => (
      choice.sourceRefs.map((source): ImportIssue => ({
        code: warning.code, message: warning.message, severity: 'WARNING', blockingStages: [], acknowledgementStages: [],
        subject: { entityType: 'Application', memberId: member.id },
        source: { ...source, column: `${choice.preference}순위 강좌` }, detail: { preferences: warning.preferences },
      }))
    ))
  ));
};

const clean = (value: string | null | undefined): string => typeof value === 'string' ? value.trim() : '';
const nameKey = (value: string | null | undefined): string => clean(value).normalize('NFC');
