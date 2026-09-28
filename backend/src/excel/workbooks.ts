import { createRequire } from 'node:module';

import ExcelJS from '@excel.js/exceljs';

import { MAX_CHOICES_PER_APPLICATION } from '../allocation/engine.ts';

export type ImportKind = 'APPLICATIONS' | 'ENROLLMENTS';
export const TEMPLATE_VERSIONS = { APPLICATIONS: '2', ENROLLMENTS: '1' } as const;
export type RawRow = { sheet: string; row: number; cells: Record<string, string | null> };
export type WorkbookIssue = { code: string; message: string; location?: string };
export type WorkbookLimits = {
  uploadBytes: number;
  expandedWorkbookBytes: number;
  workbookSheets: number;
  workbookRows: number;
  workbookCells: number;
};

export const DEFAULT_WORKBOOK_LIMITS: WorkbookLimits = {
  uploadBytes: 20_971_520,
  expandedWorkbookBytes: 104_857_600,
  workbookSheets: 20,
  workbookRows: 100_000,
  workbookCells: 1_000_000,
};

const DEFAULT_APPLICATION_CHOICES = 3;
const applicationHeaders = (choiceCount = DEFAULT_APPLICATION_CHOICES): string[] => [
  '학기명', '회원명', '신청순서',
  ...Array.from({ length: choiceCount }, (_, index) => `${index + 1}순위 강좌`),
];

export const SHEET_HEADERS = {
  '학기': ['학기명', '순서'],
  '개설강좌': ['학기명', '강좌명', '정원'],
  '수강신청': applicationHeaders(),
  '수강이력': ['학기명', '회원명', '강좌명'],
} as const;

export class WorkbookValidationError extends Error {
  readonly issues: WorkbookIssue[];

  constructor(issues: WorkbookIssue[]) {
    super('Workbook cannot be safely imported');
    this.name = 'WorkbookValidationError';
    this.issues = issues;
  }
}

export class WorkbookExportValidationError extends WorkbookValidationError {
  constructor(issue: WorkbookIssue) {
    super([issue]);
    this.name = 'WorkbookExportValidationError';
    this.message = issue.message;
  }
}

type ZipEntry = { dir?: boolean; _data?: { uncompressedSize?: number } };
type ZipArchive = { files: Record<string, ZipEntry> };
type ZipReader = { loadAsync(bytes: Buffer): Promise<ZipArchive> };
const JSZip = createRequire(import.meta.url)('@excel.js/jszip') as ZipReader;

type ApplicationTemplateContext = {
  semesterName: string;
  semesterOrder: number | null;
  courses: { courseName: string; capacity: number | null }[];
};

export const createImportTemplate = async (
  kind: ImportKind,
  context?: ApplicationTemplateContext,
): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  const metadata = workbook.addWorksheet('메타');
  metadata.addRows([
    ['templateVersion', TEMPLATE_VERSIONS[kind]],
    ['kind', kind],
    ['사용법', `${kind === 'APPLICATIONS' ? `학기·회원당 한 행에 희망 강좌를 입력합니다. 필요하면 오른쪽에 순위 열을 추가해 최대 ${MAX_CHOICES_PER_APPLICATION}순위까지 입력합니다. 빈 순위는 건너뜁니다. ` : ''}이름과 숫자만 입력합니다. 수식과 외부 링크는 업로드할 수 없습니다.`],
  ]);
  if (kind === 'APPLICATIONS') {
    const semesterSheet = addHeaderSheet(workbook, '학기');
    const courseSheet = addHeaderSheet(workbook, '개설강좌');
    const applicationSheet = addHeaderSheet(workbook, '수강신청');
    applicationSheet.columns.forEach((column, index) => { column.width = index === 2 ? 12 : 24; });
    if (context) {
      semesterSheet.addRow([context.semesterName, context.semesterOrder]);
      for (const course of context.courses) {
        courseSheet.addRow([context.semesterName, course.courseName, course.capacity]);
      }
    }
  } else {
    addHeaderSheet(workbook, '수강이력');
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const exportApplicationRows = async (rows: Array<{
  semesterName: string;
  memberName: string;
  applicationOrder: number | null;
  courseName: string;
  preference: number | null;
}>): Promise<Buffer> => {
  const workbook = new ExcelJS.Workbook();
  await loadWorkbook(workbook, await createImportTemplate('APPLICATIONS'));
  const sheet = workbook.getWorksheet('수강신청');
  if (!sheet) throw new Error('Application worksheet is missing from the template');
  const applications = new Map<string, (string | number | null)[]>();
  let choiceColumns = DEFAULT_APPLICATION_CHOICES;
  for (const row of rows) {
    const key = JSON.stringify([row.semesterName, row.memberName]);
    const values = applications.get(key) ?? [row.semesterName, row.memberName, row.applicationOrder, ...Array<string | null>(MAX_CHOICES_PER_APPLICATION).fill(null)];
    if (row.preference === null || !Number.isInteger(row.preference)
      || row.preference < 1 || row.preference > MAX_CHOICES_PER_APPLICATION || values[row.preference + 2] !== null) {
      throw new WorkbookExportValidationError({
        code: 'PREFERENCE_UNRESOLVED',
        message: `${row.semesterName} / ${row.memberName}: 희망순위 1~${MAX_CHOICES_PER_APPLICATION}를 확인한 뒤 다시 내보내세요.`,
        location: '수강신청',
      });
    }
    choiceColumns = Math.max(choiceColumns, row.preference);
    values[row.preference + 2] = row.courseName;
    applications.set(key, values);
  }
  sheet.getRow(1).values = applicationHeaders(choiceColumns);
  sheet.columns.forEach((column, index) => { column.width = index === 2 ? 12 : 24; });
  for (const values of applications.values()) sheet.addRow(values.slice(0, choiceColumns + 3));
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const exportRawRows = async (kind: ImportKind, rows: RawRow[]): Promise<Buffer> => {
  let choiceColumns = DEFAULT_APPLICATION_CHOICES;
  for (const raw of rows) {
    if (kind !== 'APPLICATIONS' || raw.sheet !== '수강신청') continue;
    const headers = Object.keys(raw.cells);
    const count = headers.length - 3;
    if (count < DEFAULT_APPLICATION_CHOICES || count > MAX_CHOICES_PER_APPLICATION
      || applicationHeaders(count).some((header) => !(header in raw.cells))) {
      throw new WorkbookValidationError([{ code: 'INVALID_HEADERS', message: 'Use the current application template', location: '수강신청!1' }]);
    }
    choiceColumns = Math.max(choiceColumns, count);
  }
  const workbook = new ExcelJS.Workbook();
  await loadWorkbook(workbook, await createImportTemplate(kind));
  if (kind === 'APPLICATIONS') {
    const sheet = workbook.getWorksheet('수강신청')!;
    sheet.getRow(1).values = applicationHeaders(choiceColumns);
    sheet.columns.forEach((column, index) => { column.width = index === 2 ? 12 : 24; });
  }
  for (const raw of rows) {
    const headers = raw.sheet === '수강신청' ? applicationHeaders(choiceColumns) : headersFor(raw.sheet);
    const sheet = workbook.getWorksheet(raw.sheet);
    if (!sheet || !headers) continue;
    const row = sheet.getRow(raw.row);
    row.values = headers.map((header) => raw.cells[header]);
    row.commit();
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

export const readSafeWorkbook = async (options: {
  filename: string;
  bytes: Uint8Array;
  limits?: Partial<WorkbookLimits>;
}): Promise<ExcelJS.Workbook> => {
  const limits = { ...DEFAULT_WORKBOOK_LIMITS, ...options.limits };
  if (!options.filename.toLocaleLowerCase('en-US').endsWith('.xlsx')) {
    throw new WorkbookValidationError([{ code: 'UNSUPPORTED_FILE_TYPE', message: 'Only .xlsx files are supported' }]);
  }
  const bytes = Buffer.from(options.bytes);
  if (bytes.byteLength > limits.uploadBytes) {
    throw new WorkbookValidationError([{ code: 'UPLOAD_SIZE_LIMIT', message: 'Workbook exceeds the upload size limit' }]);
  }

  let zip: ZipArchive;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new WorkbookValidationError([{ code: 'INVALID_XLSX', message: 'File is not a readable XLSX archive' }]);
  }
  let expandedBytes = 0;
  for (const [name, entry] of Object.entries(zip.files)) {
    if (/^xl\/externalLinks\//i.test(name)) {
      throw new WorkbookValidationError([{
        code: 'EXTERNAL_LINK_NOT_ALLOWED',
        message: 'External workbook links are not allowed',
        location: name,
      }]);
    }
    const size = entry._data?.uncompressedSize ?? 0;
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new WorkbookValidationError([{ code: 'INVALID_XLSX', message: 'Workbook entry size is invalid' }]);
    }
    expandedBytes += size;
    if (expandedBytes > limits.expandedWorkbookBytes) {
      throw new WorkbookValidationError([{
        code: 'EXPANDED_SIZE_LIMIT',
        message: 'Expanded workbook exceeds the configured limit',
      }]);
    }
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await loadWorkbook(workbook, bytes);
  } catch {
    throw new WorkbookValidationError([{ code: 'INVALID_XLSX', message: 'Workbook structure is invalid or encrypted' }]);
  }
  if (workbook.worksheets.length > limits.workbookSheets) {
    throw new WorkbookValidationError([{ code: 'SHEET_LIMIT', message: 'Workbook has too many worksheets' }]);
  }

  const issues: WorkbookIssue[] = [];
  let rows = 0;
  let cells = 0;
  for (const sheet of workbook.worksheets) {
    rows += sheet.rowCount;
    sheet.eachRow((row) => {
      row.eachCell((cell) => {
        cells += 1;
        const value = cell.value;
        if (isFormula(value)) {
          issues.push({
            code: 'FORMULA_NOT_ALLOWED',
            message: 'Formula cells are not evaluated or imported',
            location: `${sheet.name}!${cell.address}`,
          });
        } else if (isExternalHyperlink(value)) {
          issues.push({
            code: 'EXTERNAL_LINK_NOT_ALLOWED',
            message: 'External hyperlinks are not imported',
            location: `${sheet.name}!${cell.address}`,
          });
        }
      });
    });
  }
  if (rows > limits.workbookRows) issues.push({ code: 'ROW_LIMIT', message: 'Workbook has too many rows' });
  if (cells > limits.workbookCells) issues.push({ code: 'CELL_LIMIT', message: 'Workbook has too many cells' });
  if (issues.length > 0) throw new WorkbookValidationError(issues);
  return workbook;
};

export const extractRawRows = (workbook: ExcelJS.Workbook, kind: ImportKind): RawRow[] => {
  const sheetNames = kind === 'APPLICATIONS'
    ? ['학기', '개설강좌', '수강신청']
    : ['수강이력'];
  const rows: RawRow[] = [];
  for (const sheetName of sheetNames) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      if (sheetName === '수강신청' || sheetName === '수강이력') {
        throw new WorkbookValidationError([{
          code: 'REQUIRED_SHEET_MISSING',
          message: `Required worksheet ${sheetName} is missing`,
          location: sheetName,
        }]);
      }
      continue;
    }
    const choiceCount = sheet.actualColumnCount - 3;
    if (sheetName === '수강신청' && choiceCount > MAX_CHOICES_PER_APPLICATION) {
      throw new WorkbookValidationError([{
        code: 'APPLICATION_CHOICE_LIMIT',
        message: `Applications allow at most ${MAX_CHOICES_PER_APPLICATION} preference columns`,
        location: `${sheetName}!1`,
      }]);
    }
    const headers = sheetName === '수강신청'
      ? applicationHeaders(Math.max(DEFAULT_APPLICATION_CHOICES, choiceCount))
      : headersFor(sheetName)!;
    const actualHeaders = headers.map((_, index) => sheet.getRow(1).getCell(index + 1).text.trim());
    if (headers.some((header, index) => actualHeaders[index] !== header)) {
      throw new WorkbookValidationError([{
        code: 'INVALID_HEADERS',
        message: `Worksheet ${sheetName} does not use the required columns`,
        location: `${sheetName}!1`,
      }]);
    }
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const cells = Object.fromEntries(headers.map((header, index) => {
        const cell = row.getCell(index + 1);
        return [header, cell.value === null ? null : cell.text];
      }));
      if (Object.values(cells).every((value) => value === null || value === '')) continue;
      rows.push({ sheet: sheetName, row: rowNumber, cells });
    }
  }
  return rows;
};

const addHeaderSheet = (workbook: ExcelJS.Workbook, name: keyof typeof SHEET_HEADERS): ExcelJS.Worksheet => {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([...SHEET_HEADERS[name]]);
  sheet.getRow(1).font = { bold: true };
  return sheet;
};

const headersFor = (sheet: string): readonly string[] | undefined => (
  SHEET_HEADERS[sheet as keyof typeof SHEET_HEADERS]
);

const isFormula = (value: unknown): boolean => (
  typeof value === 'object'
  && value !== null
  && ('formula' in value || 'sharedFormula' in value)
);

const isExternalHyperlink = (value: unknown): boolean => (
  typeof value === 'object'
  && value !== null
  && 'hyperlink' in value
  && typeof value.hyperlink === 'string'
  && !value.hyperlink.startsWith('#')
);

// Package exports omit its bundled declarations, whose older Buffer type differs from Node 22 types.
const loadWorkbook = async (workbook: ExcelJS.Workbook, bytes: Buffer): Promise<void> => {
  await workbook.xlsx.load(bytes as never);
};
