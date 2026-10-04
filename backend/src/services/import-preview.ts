import { createHash, randomUUID } from 'node:crypto';

import { MAX_CHOICES_PER_APPLICATION } from '../allocation/engine.ts';
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
import type { Store, DatabaseState } from '../storage/store.ts';

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
  affiliation: string | null;
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
  affiliation: string | null;
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
type ImportBatch = DatabaseState['importBatches'][number];

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
  readonly #store: Store;
  readonly #dependencies: Dependencies & { previewTtlMs: number };
  readonly #previews = new Map<string, ImportPreview>();

  constructor(store: Store, dependencies: Dependencies) {
    this.#store = store;
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
      this.#store.read(),
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
    return this.#store.write({}, (data) => {
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
      importBatches(data).push(batch);
      return structuredClone(batch);
    });
  }

  getStaged(id: string): ImportBatch {
    const batch = this.#store.getImportBatch(id);
    if (!batch || batch.status !== 'STAGED') throw new ImportBatchNotFoundError();
    return structuredClone(batch);
  }

  repreviewStaged(id: string): ImportPreview {
    const batch = this.getStaged(id);
    return this.#remember(buildPreview(
      this.#store.read(),
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
  data: DatabaseState,
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

const analyzeApplications = (data: DatabaseState, rawRows: RawRow[], mode: ImportMode) => {
  const sourceRows = rawRows.filter(({ sheet }) => sheet === '수강신청');
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
      || (candidate.affiliation?.length ?? 0) > 200;
    const existing = findApplication(data, candidate.semesterName, candidate.memberName);
    candidate.removedCourseNames = existing && mode === 'REPLACE_APPLICATION'
      ? removedCourseNames(data, existing, candidate)
      : [];
    if (!existing && !qualityConflict) insertCandidates += 1;
    else if (existing && applicationMatches(data, existing, candidate)) identicalRows += candidate.sourceRowCount;
    else conflicts += 1;
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
  const affiliation = clean(first.cells['학생 소속']) || null;
  if (affiliation && affiliation.length > 200) issues.push(requiredRowIssue(
    'AFFILIATION_TOO_LONG', '학생 소속은 200자 이내로 입력하세요.', first, '학생 소속',
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
  const seenCourses = new Set<string>();
  for (const [column, value] of Object.entries(first.cells)) {
    const match = /^(\d+)순위 강좌$/.exec(column);
    if (!match) continue;
    const courseName = clean(value);
    if (!courseName) continue;
    const key = nameKey(courseName);
    if (seenCourses.has(key)) issues.push(requiredRowIssue(
      'DUPLICATE_CHOICE_COURSE', 'Application course choice is duplicated', first, column,
    ));
    seenCourses.add(key);
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
    affiliation,
    applicationOrder,
    applicationOrderStatus,
    choices,
    sourceRowCount: 1,
    removedCourseNames: [],
  };
};

const analyzeEnrollments = (data: DatabaseState, rawRows: RawRow[]) => {
  const sourceRows = rawRows.filter(({ sheet }) => sheet === '수강이력');
  const issues: ImportIssue[] = [];
  const contextChanges = contextCandidates(data, rawRows.filter(({ sheet }) => sheet === '개설강좌'), 'SEMESTER_COURSE', issues, 'ENROLLMENTS');
  const candidates = sourceRows.map((row): EnrollmentCandidate => {
    const semesterName = clean(row.cells['학기명']);
    const memberName = clean(row.cells['회원명']);
    const affiliation = clean(row.cells['학생 소속']) || null;
    if (affiliation && affiliation.length > 200) issues.push(requiredRowIssue(
      'AFFILIATION_TOO_LONG', '학생 소속은 200자 이내로 입력하세요.', row, '학생 소속',
    ));
    const courseName = clean(row.cells['강좌명']);
    const adminNote = clean(row.cells['관리자 메모']);
    if (!semesterName) issues.push(requiredRowIssue('SEMESTER_NAME_REQUIRED', 'Semester name is required', row, '학기명'));
    if (!memberName) issues.push(requiredRowIssue('MEMBER_NAME_REQUIRED', 'Member name is required', row, '회원명'));
    if (!courseName) issues.push(requiredRowIssue('COURSE_NAME_REQUIRED', 'Course name is required', row, '강좌명'));
    if (adminNote.length > 2000) issues.push(requiredRowIssue('ENROLLMENT_NOTE_TOO_LONG', 'Administrator note must be at most 2000 characters', row, '관리자 메모'));
    return { semesterName, memberName, affiliation, courseName, adminNote, sourceRef: { sheet: row.sheet, row: row.row } };
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
    if (group.length > 1 || !group[0]!.semesterName || !group[0]!.memberName || !group[0]!.courseName || (group[0]!.affiliation?.length ?? 0) > 200) {
      conflicts += group.length;
      continue;
    }
    const existing = findEnrollment(data, group[0]!.semesterName, group[0]!.memberName);
    if (existing === null) {
      insertCandidates += 1;
      pending.push(group[0]!);
    }
    else if (nameKey(existing.courseName) === nameKey(group[0]!.courseName)) {
      if (existing.affiliation !== group[0]!.affiliation) {
        conflicts += 1;
        issues.push(requiredRowIssue('ENROLLMENT_AFFILIATION_CONFLICT',
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

const analyzeContext = (data: DatabaseState, rawRows: RawRow[], issues: ImportIssue[]): ImportContextChange[] => [
  ...contextCandidates(data, rawRows.filter(({ sheet }) => sheet === '학기'), 'SEMESTER', issues),
  ...contextCandidates(data, rawRows.filter(({ sheet }) => sheet === '개설강좌'), 'SEMESTER_COURSE', issues),
];

const contextCandidates = (
  data: DatabaseState,
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
  data: DatabaseState,
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
    || !['2', TEMPLATE_VERSIONS[kind]].includes(metadata.getCell('B1').text)
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
  data: DatabaseState,
  semesterName: string,
  memberName: string,
): DatabaseState['applications'][number] | undefined => {
  const semester = data.semesters.find((item) => item.nameKey === nameKey(semesterName));
  const member = data.members.find((item) => item.nameKey === nameKey(memberName));
  return semester && member
    ? data.applications.find((item) => item.semesterId === semester.id && item.memberId === member.id)
    : undefined;
};

const applicationMatches = (
  data: DatabaseState,
  application: DatabaseState['applications'][number],
  candidate: ApplicationCandidate,
): boolean => {
  if (
    application.applicationOrderStatus !== candidate.applicationOrderStatus
    || application.applicationOrder !== candidate.applicationOrder
    || application.affiliation !== candidate.affiliation
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

const findEnrollment = (data: DatabaseState, semesterName: string, memberName: string): { courseName: string; affiliation: string | null } | null => {
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
  return course ? { courseName: course.name, affiliation: enrollment.affiliation } : null;
};

const removedCourseNames = (
  data: DatabaseState,
  application: DatabaseState['applications'][number],
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

const clean = (value: string | null | undefined): string => typeof value === 'string' ? value.trim() : '';
const nameKey = (value: string | null | undefined): string => clean(value).normalize('NFC');
const importBatches = (data: DatabaseState): ImportBatch[] => data.importBatches as unknown as ImportBatch[];
