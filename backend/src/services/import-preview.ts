import { createHash } from 'node:crypto';

import {
  extractRawRows,
  exportRawRows,
  readSafeWorkbook,
  WorkbookValidationError,
  type ImportKind,
  type RawRow,
  type WorkbookLimits,
} from '../excel/workbooks.ts';
import { evaluateEnrollmentImport } from './enrollments.ts';
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
  courseName: string;
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
    validateMetadata(workbook, input.kind);
    const rawRows = extractRawRows(workbook, input.kind);
    return this.#remember(buildPreview(
      this.#store.read(),
      input.kind,
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
        templateVersion: '1',
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
    const batch = importBatches(this.#store.read()).find((item) => item.id === id);
    if (!batch || batch.status !== 'STAGED') throw new ImportBatchNotFoundError();
    return structuredClone(batch);
  }

  repreviewStaged(id: string): ImportPreview {
    const batch = this.getStaged(id);
    return this.#remember(buildPreview(
      this.#store.read(),
      batch.kind,
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
    return exportRawRows(batch.kind, batch.rawRows);
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
  const grouped = new Map<string, RawRow[]>();
  for (const row of sourceRows) {
    const key = `${nameKey(row.cells['학기명'])}\0${nameKey(row.cells['회원명'])}`;
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }
  const issues: ImportIssue[] = [];
  const contextChanges = analyzeContext(data, rawRows, issues);
  const candidates = [...grouped.values()].map((rows) => applicationCandidate(rows, issues));
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
        'APPLICATION_COURSE_CAPACITY_MISSING', 'Course capacity is required', source, '강좌명',
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
      || !candidate.memberName;
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

const applicationCandidate = (rows: RawRow[], issues: ImportIssue[]): ApplicationCandidate => {
  const first = rows[0]!;
  const semesterName = clean(first.cells['학기명']);
  const memberName = clean(first.cells['회원명']);
  if (!semesterName) issues.push(requiredRowIssue('SEMESTER_NAME_REQUIRED', 'Semester name is required', first, '학기명'));
  if (!memberName) issues.push(requiredRowIssue('MEMBER_NAME_REQUIRED', 'Member name is required', first, '회원명'));
  const parsedOrders = rows.map((row) => parsePositiveInteger(row.cells['신청순서']));
  const validOrders = new Set(parsedOrders.filter((item) => item.kind === 'VALID').map((item) => item.value));
  let applicationOrderStatus: ApplicationStatus;
  let applicationOrder: number | null = null;
  if (parsedOrders.some(({ kind }) => kind === 'INVALID')) applicationOrderStatus = 'INVALID';
  else if (validOrders.size === 0) applicationOrderStatus = 'MISSING';
  else if (validOrders.size > 1 || parsedOrders.some(({ kind }) => kind === 'MISSING')) applicationOrderStatus = 'CONFLICT';
  else {
    applicationOrderStatus = 'NORMAL';
    applicationOrder = [...validOrders][0]!;
  }
  if (applicationOrderStatus !== 'NORMAL') {
    issues.push(rowIssue(
      `APPLICATION_ORDER_${applicationOrderStatus}`,
      `Application order is ${applicationOrderStatus.toLowerCase()}`,
      first,
      '신청순서',
    ));
  }

  const choiceRows = new Map<string, RawRow[]>();
  for (const row of rows) {
    const key = nameKey(row.cells['강좌명']);
    const grouped = choiceRows.get(key) ?? [];
    grouped.push(row);
    choiceRows.set(key, grouped);
  }
  const choices = [...choiceRows.values()].map((group) => {
    const courseName = clean(group[0]!.cells['강좌명']);
    if (!courseName) issues.push(requiredRowIssue('COURSE_NAME_REQUIRED', 'Course name is required', group[0]!, '강좌명'));
    const parsed = group.map((row) => parsePositiveInteger(row.cells['희망순위']));
    const values = new Set(parsed.filter((item) => item.kind === 'VALID').map((item) => item.value));
    const preference = values.size === 1 && parsed.every(({ kind }) => kind === 'VALID')
      ? [...values][0]!
      : null;
    if (preference === null) {
      issues.push(rowIssue('PREFERENCE_UNRESOLVED', 'Choice preference is missing, invalid, or conflicting', group[0]!, '희망순위'));
    }
    return {
      courseName,
      preference,
      sourceRefs: group.map(({ sheet, row }) => ({ sheet, row })),
    };
  });
  const preferenceCounts = new Map<number, number>();
  for (const { preference } of choices) {
    if (preference !== null) preferenceCounts.set(preference, (preferenceCounts.get(preference) ?? 0) + 1);
  }
  for (const [preference, count] of preferenceCounts) {
    if (count < 2) continue;
    for (const choice of choices) {
      if (choice.preference === preference) choice.preference = null;
    }
    issues.push(rowIssue(
      'PREFERENCE_CONFLICT',
      `Preference ${preference} is assigned to more than one course`,
      first,
      '희망순위',
    ));
  }
  return {
    semesterName,
    memberName,
    applicationOrder,
    applicationOrderStatus,
    choices,
    sourceRowCount: rows.length,
    removedCourseNames: [],
  };
};

const analyzeEnrollments = (data: DatabaseState, rawRows: RawRow[]) => {
  const sourceRows = rawRows.filter(({ sheet }) => sheet === '수강이력');
  const issues: ImportIssue[] = [];
  const candidates = sourceRows.map((row): EnrollmentCandidate => {
    const semesterName = clean(row.cells['학기명']);
    const memberName = clean(row.cells['회원명']);
    const courseName = clean(row.cells['강좌명']);
    if (!semesterName) issues.push(requiredRowIssue('SEMESTER_NAME_REQUIRED', 'Semester name is required', row, '학기명'));
    if (!memberName) issues.push(requiredRowIssue('MEMBER_NAME_REQUIRED', 'Member name is required', row, '회원명'));
    if (!courseName) issues.push(requiredRowIssue('COURSE_NAME_REQUIRED', 'Course name is required', row, '강좌명'));
    return { semesterName, memberName, courseName, sourceRef: { sheet: row.sheet, row: row.row } };
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
  for (const group of groups.values()) {
    if (group.length > 1 || !group[0]!.semesterName || !group[0]!.memberName || !group[0]!.courseName) {
      conflicts += group.length;
      continue;
    }
    const existingCourse = findEnrollmentCourse(data, group[0]!.semesterName, group[0]!.memberName);
    if (existingCourse === null) insertCandidates += 1;
    else if (nameKey(existingCourse) === nameKey(group[0]!.courseName)) {
      identicalRows += 1;
      continue;
    } else conflicts += 1;
    const semester = data.semesters.find(({ nameKey: key }) => key === nameKey(group[0]!.semesterName));
    const course = data.courses.find(({ nameKey: key }) => key === nameKey(group[0]!.courseName));
    const semesterCourse = semester && course && data.semesterCourses.find((item) => (
      item.semesterId === semester.id && item.courseId === course.id
    ));
    for (const issue of evaluateEnrollmentImport(data, group[0]!)) {
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
  return {
    sourceRowCount: sourceRows.length,
    insertCandidates,
    identicalRows,
    conflicts,
    issues,
    contextChanges: [] as ImportContextChange[],
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
    const parsed = group.map((row) => parseContextInteger(row.cells[column], field === 'capacity'));
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
      issues.push({
        ...rowIssue(
          `${entity}_${field.toUpperCase()}_${status}`,
          `${entity} ${field} requires review`,
          first,
          column,
        ),
        blockingStages: ['AUTO_ALLOCATE'],
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

const validateMetadata = (workbook: import('@excel.js/exceljs').Workbook, kind: ImportKind): void => {
  const metadata = workbook.getWorksheet('메타');
  if (
    !metadata
    || metadata.getCell('A1').text !== 'templateVersion'
    || metadata.getCell('B1').text !== '1'
    || metadata.getCell('A2').text !== 'kind'
    || metadata.getCell('B2').text !== kind
  ) throw new WorkbookValidationError([{
    code: 'INVALID_METADATA',
    message: 'Workbook metadata does not match the selected import kind',
    location: '메타!A1:B2',
  }]);
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

const parseContextInteger = (raw: string | null | undefined, zeroAllowed: boolean): (
  { kind: 'VALID'; value: number } | { kind: 'MISSING' | 'INVALID' }
) => {
  const value = clean(raw);
  if (!value) return { kind: 'MISSING' };
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

const findEnrollmentCourse = (data: DatabaseState, semesterName: string, memberName: string): string | null => {
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
  return typeof course?.name === 'string' ? course.name : null;
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
