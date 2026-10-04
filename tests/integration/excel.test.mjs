import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import ExcelJS from '@excel.js/exceljs';
import JSZip from '@excel.js/jszip';

import {
  WorkbookValidationError,
  createImportTemplate,
  exportApplicationRows,
  exportRawRows,
} from '../../backend/src/excel/workbooks.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import { ImportPreviewService } from '../../backend/src/services/import-preview.ts';
import { Store, openStore } from '../../backend/src/storage/store.ts';

const emptyStore = () => ({
  meta: { storeEpoch: 'epoch-1', storeRevision: 0 },
  semesters: [],
  members: [],
  courses: [],
  semesterCourses: [],
  applications: [],
  applicationChoices: [],
  enrollments: [],
  allocationDrafts: [],
  allocationDraftItems: [],
  importBatches: [],
  finalizationReceipts: [],
  restoreReceipts: [],
});

const serviceFor = (store, limits) => {
  let id = 0;
  return new ImportPreviewService(store, {
    id: () => `import-id-${++id}`,
    now: () => new Date('2026-09-22T00:00:00.000Z'),
    limits,
  });
};

const workbookWithRows = async (kind, rows) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImportTemplate(kind));
  const sheet = workbook.getWorksheet(kind === 'APPLICATIONS' ? '수강신청' : '수강이력');
  workbook.getWorksheet('메타').getCell('B1').value = '2';
  sheet.getRow(1).values = kind === 'APPLICATIONS'
    ? ['학기명', '회원명', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌']
    : ['학기명', '회원명', '강좌명', '관리자 메모'];
  if (kind === 'APPLICATIONS') {
    if (rows.some((row) => row.length > 6)) sheet.getCell('G1').value = '4순위 강좌';
    if (rows.some((row) => row.length > 7)) sheet.getCell('H1').value = '5순위 강좌';
  }
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

test('creates name-based templates and exports formula-looking names as text', async () => {
  const template = new ExcelJS.Workbook();
  await template.xlsx.load(await createImportTemplate('APPLICATIONS', {
    semesterName: '2027 봄',
    semesterOrder: 3,
    courses: [
      { courseName: '발성', capacity: 12 },
      { courseName: '합창', capacity: null },
    ],
  }));

  assert.deepEqual(template.worksheets.map(({ name }) => name), ['메타', '학기', '개설강좌', '수강신청']);
  assert.deepEqual(template.getWorksheet('수강신청').getRow(1).values.slice(1), [
    '학기명', '회원명', '학생 소속', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌', '4순위 강좌',
  ]);
  assert.equal(template.getWorksheet('메타').getCell('B1').text, '3');
  assert.equal(template.getWorksheet('메타').getCell('B2').text, 'APPLICATIONS');
  assert.deepEqual(template.getWorksheet('학기').getRow(2).values.slice(1), ['2027 봄', 3]);
  assert.deepEqual(template.getWorksheet('개설강좌').getRow(2).values.slice(1), ['2027 봄', '발성', 12]);
  assert.equal(template.getWorksheet('개설강좌').getCell('A3').text, '2027 봄');
  assert.equal(template.getWorksheet('개설강좌').getCell('B3').text, '합창');
  assert.equal(template.getWorksheet('개설강좌').getCell('C3').value, null);

  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(await exportApplicationRows([{
    semesterName: '2026 봄',
    memberName: '=2+2',
    applicationOrder: 15,
    courseName: '=HYPERLINK("https://example.com")',
    preference: 1,
  }]));
  assert.equal(exported.getWorksheet('수강신청').getCell('B2').value, '=2+2');
  assert.equal(exported.getWorksheet('수강신청').getCell('B2').formula, undefined);
  assert.equal(exported.getWorksheet('수강신청').getCell('E2').formula, undefined);
});

test('exports one row per semester and member with course columns in preference order', async () => {
  const request = [
    { semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1, courseName: '심화', preference: 5 },
    { semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1, courseName: '기초', preference: 1 },
    { semesterName: '2026 봄', memberName: '김은혜', applicationOrder: 2, courseName: '합창', preference: 1 },
    { semesterName: '2026 가을', memberName: '홍길동', applicationOrder: 1, courseName: '합창', preference: 3 },
  ];
  const contexts = [
    { semesterName: '2026 봄', semesterOrder: 2, courses: [
      { courseName: '기초', capacity: 10 }, { courseName: '심화', capacity: 12 }, { courseName: '합창', capacity: 0 },
    ] },
    { semesterName: '2026 가을', semesterOrder: 5, courses: [
      { courseName: '합창', capacity: null }, { courseName: '발성', capacity: 7 },
    ] },
  ];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportApplicationRows(request, contexts));
  const sheet = workbook.getWorksheet('수강신청');
  const expected = [
    ['2026 봄', '홍길동', null, 1, '기초', null, null, null, '심화'],
    ['2026 봄', '김은혜', null, 2, '합창', null, null, null, null],
    ['2026 가을', '홍길동', null, 1, null, null, '합창', null, null],
  ];
  assert.equal(sheet.rowCount, 4);
  assert.deepEqual(expected.map((_, index) => Array.from({ length: 9 }, (_, column) => (
    sheet.getRow(index + 2).getCell(column + 1).value
  ))), expected);
  assert.deepEqual(workbook.getWorksheet('학기').getSheetValues().slice(2).map((row) => row.slice(1)), [
    ['2026 봄', 2], ['2026 가을', 5],
  ]);
  const expectedCourses = [
    ['2026 봄', '기초', 10], ['2026 봄', '심화', 12], ['2026 봄', '합창', 0],
    ['2026 가을', '합창', null], ['2026 가을', '발성', 7],
  ];
  const courses = workbook.getWorksheet('개설강좌');
  assert.equal(courses.rowCount, expectedCourses.length + 1);
  assert.deepEqual(expectedCourses.map((_, index) => Array.from({ length: 3 }, (_, column) => (
    courses.getRow(index + 2).getCell(column + 1).value
  ))), expectedCourses);
});

test('refuses to export unresolved or out-of-range preferences instead of dropping choices', async () => {
  const request = { semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 1, courseName: '기초' };
  for (const preference of [null, 0, 6]) {
    await assert.rejects(exportApplicationRows([{ ...request, preference }]), WorkbookValidationError);
  }
  await assert.rejects(exportApplicationRows([
    { ...request, preference: 1 }, { ...request, courseName: '심화', preference: 1 },
  ]), WorkbookValidationError);
  await assert.rejects(exportRawRows('APPLICATIONS', [{ sheet: '수강신청', row: 2, cells: {
    학기명: '2026 봄', 회원명: '홍길동', 신청순서: '1', 강좌명: '기초', 희망순위: '1',
  } }]), WorkbookValidationError);
});

test('previews student rows after adding fourth and fifth columns, preserving optional preference gaps', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const request = [
    ['2026 봄', '한 강좌', 1, '기초'],
    ['2026 봄', '세 강좌', 2, '기초', '합창', '심화'],
    ['2026 봄', '다섯 강좌', 3, '기초', '합창', '심화', '발성', '연기'],
    ['2026 봄', '빈 순위', 4, '기초', null, null, '발성', '연기'],
  ];
  const expected = [
    [['기초', 1]],
    [['기초', 1], ['합창', 2], ['심화', 3]],
    [['기초', 1], ['합창', 2], ['심화', 3], ['발성', 4], ['연기', 5]],
    [['기초', 1], ['발성', 4], ['연기', 5]],
  ];
  const before = store.read();
  const preview = await service.preview({ filename: 'wide.xlsx', kind: 'APPLICATIONS',
    bytes: await workbookWithRows('APPLICATIONS', request) });
  assert.equal(preview.sourceRowCount, 4);
  assert.deepEqual(preview.applications.map(({ sourceRowCount }) => sourceRowCount), [1, 1, 1, 1]);
  assert.deepEqual(preview.applications.map(({ choices }) => choices.map(({ courseName, preference }) => (
    [courseName, preference]
  ))), expected);
  assert.ok(!preview.issues.some(({ code }) => code.startsWith('PREFERENCE_')));
  assert.deepEqual(store.read(), before);
});

test('reads and preserves a user-added fourth column without requiring a fifth column', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const request = [['2026 봄', '홍길동', 1, '기초', null, null, '심화']];
  const expected = [['기초', 1], ['심화', 4]];
  const preview = await service.preview({ filename: 'fourth.xlsx', kind: 'APPLICATIONS',
    bytes: await workbookWithRows('APPLICATIONS', request) });
  assert.deepEqual(preview.applications[0].choices.map(({ courseName, preference }) => [courseName, preference]), expected);
  assert.equal(Object.keys(preview.rawRows[0].cells).length, 7);
  const staged = await service.stage(preview.previewId);
  const bytes = await service.exportStagedOriginal(staged.id);
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(bytes);
  assert.deepEqual(exported.getWorksheet('수강신청').getRow(1).values.slice(1), [
    '학기명', '회원명', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌', '4순위 강좌',
  ]);
  const roundTrip = await service.preview({ filename: 'original.xlsx', bytes, kind: 'APPLICATIONS' });
  assert.deepEqual(roundTrip.rawRows, preview.rawRows);
});

test('the staged-row parser reads all rank columns and blocks ranks beyond the configured limit', async () => {
  const initial = emptyStore();
  const request = {
    학기명: '2026 봄', 회원명: '홍길동', 신청순서: '1',
    '1순위 강좌': '기초', '2순위 강좌': '심화', '3순위 강좌': '합창',
    '4순위 강좌': '발성', '5순위 강좌': '연기', '6순위 강좌': '추가',
  };
  initial.importBatches.push({ id: 'staged', kind: 'APPLICATIONS', templateVersion: '2', fileHash: 'hash',
    importedAt: '2026-09-22T00:00:00.000Z', status: 'STAGED',
    rawRows: [{ sheet: '수강신청', row: 2, cells: request }], resolutions: [], receipt: null });
  const store = await Store.open(new MemoryAdapter(initial), emptyStore());
  const service = serviceFor(store);
  const before = store.read();
  const preview = service.repreviewStaged('staged');
  assert.deepEqual(preview.applications[0].choices.map(({ courseName, preference }) => [courseName, preference]), [
    ['기초', 1], ['심화', 2], ['합창', 3], ['발성', 4], ['연기', 5], ['추가', 6],
  ]);
  assert.ok(preview.issues.some(({ code, severity, blockingStages }) => (
    code === 'APPLICATION_CHOICE_LIMIT' && severity === 'ERROR' && blockingStages.includes('IMPORT_COMMIT')
  )));
  await assert.rejects(service.exportStagedOriginal('staged'), WorkbookValidationError);
  assert.deepEqual(store.read(), before);
});

test('rejects the old application layout and any sixth preference column', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  for (const [headers, row] of [
    [['학기명', '회원명', '신청순서', '강좌명', '희망순위'], ['2026 봄', '홍길동', 1, '기초', 1]],
    [['학기명', '회원명', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌', '4순위 강좌', '5순위 강좌', '6순위 강좌'],
      ['2026 봄', '홍길동', 1, '기초', '합창', '심화', '발성', '연기', '추가']],
  ]) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await createImportTemplate('APPLICATIONS'));
    workbook.getWorksheet('수강신청').getRow(1).values = headers;
    workbook.getWorksheet('수강신청').addRow(row);
    await assert.rejects(service.preview({ filename: 'invalid.xlsx', kind: 'APPLICATIONS',
      bytes: Buffer.from(await workbook.xlsx.writeBuffer()) }), WorkbookValidationError);
  }
  assert.deepEqual(store.read(), emptyStore());
});

test('preserves raw order cells and reports application quality without mutating the store', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const bytes = await workbookWithRows('APPLICATIONS', [
    ['2026 봄', '홍길동', '15', '기초', '심화'],
    ['2026 봄', '김빈칸', '', '기초'],
    ['2026 봄', '김문자', 'abc', '기초'],
    ['2026 봄', '김영', '0015', '기초'],
  ]);
  const before = store.read();

  const preview = await service.preview({ filename: 'applications.xlsx', bytes, kind: 'APPLICATIONS' });

  assert.deepEqual(store.read(), before);
  assert.equal(preview.sourceRowCount, 4);
  assert.equal(preview.rawRows.at(-1).cells['신청순서'], '0015');
  assert.deepEqual(
    preview.applications.map(({ memberName, applicationOrder, applicationOrderStatus }) => ({
      memberName, applicationOrder, applicationOrderStatus,
    })),
    [
      { memberName: '홍길동', applicationOrder: 15, applicationOrderStatus: 'NORMAL' },
      { memberName: '김빈칸', applicationOrder: null, applicationOrderStatus: 'MISSING' },
      { memberName: '김문자', applicationOrder: null, applicationOrderStatus: 'INVALID' },
      { memberName: '김영', applicationOrder: 15, applicationOrderStatus: 'NORMAL' },
    ],
  );
  assert.deepEqual(preview.applications[0].choices.map(({ sourceRefs }) => sourceRefs), [
    [{ sheet: '수강신청', row: 2 }], [{ sheet: '수강신청', row: 2 }],
  ]);
});

test('reports repeated course columns and repeated student rows as blocking errors', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const bytes = await workbookWithRows('APPLICATIONS', [
    ['2026 봄', '홍길동', '15', '기초', ' 기초 '],
    ['2026 봄', ' 홍길동 ', '15', '심화'],
  ]);

  const preview = await service.preview({ filename: 'duplicate-preference.xlsx', bytes, kind: 'APPLICATIONS' });

  assert.deepEqual(preview.applications[0].choices.map(({ preference }) => preference), [1, 2]);
  for (const expected of ['DUPLICATE_CHOICE_COURSE', 'DUPLICATE_APPLICATION']) {
    assert.ok(preview.issues.some(({ code, severity, blockingStages }) => (
      code === expected && severity === 'ERROR' && blockingStages.includes('IMPORT_COMMIT')
    )));
  }
});

test('distinguishes an identical application row from a conflicting current record', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  let id = 0;
  const applications = new ApplicationService(store, {
    id: () => `existing-id-${++id}`,
    now: () => new Date('2026-09-22T00:00:00.000Z'),
  });
  await applications.create({
    semesterName: '2026 봄',
    memberName: '홍길동',
    applicationOrder: 15,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  const service = serviceFor(store);

  const identical = await service.preview({
    filename: 'same.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '0015', '기초']]),
    kind: 'APPLICATIONS',
  });
  const conflicting = await service.preview({
    filename: 'changed.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '16', '기초']]),
    kind: 'APPLICATIONS',
  });

  assert.deepEqual(
    { insertCandidates: identical.insertCandidates, identicalRows: identical.identicalRows, conflicts: identical.conflicts },
    { insertCandidates: 0, identicalRows: 1, conflicts: 0 },
  );
  assert.deepEqual(
    { insertCandidates: conflicting.insertCandidates, identicalRows: conflicting.identicalRows, conflicts: conflicting.conflicts },
    { insertCandidates: 0, identicalRows: 0, conflicts: 1 },
  );
});

test('rejects formulas, external hyperlinks, and expanded-size excess with cell details', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const formulaWorkbook = new ExcelJS.Workbook();
  await formulaWorkbook.xlsx.load(await createImportTemplate('APPLICATIONS'));
  formulaWorkbook.getWorksheet('수강신청').addRow([
    '2026 봄', '홍길동', { formula: '7+8', result: 15 }, '기초', 1,
  ]);
  const formulaBytes = Buffer.from(await formulaWorkbook.xlsx.writeBuffer());

  await assert.rejects(
    service.preview({ filename: 'formula.xlsx', bytes: formulaBytes, kind: 'APPLICATIONS' }),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some(({ code, location }) => code === 'FORMULA_NOT_ALLOWED' && location === '수강신청!C2'),
  );

  const linkWorkbook = new ExcelJS.Workbook();
  await linkWorkbook.xlsx.load(await createImportTemplate('APPLICATIONS'));
  linkWorkbook.getWorksheet('수강신청').addRow([
    '2026 봄', { text: '홍길동', hyperlink: 'https://example.com' }, 15, '기초', 1,
  ]);
  const linkBytes = Buffer.from(await linkWorkbook.xlsx.writeBuffer());
  await assert.rejects(
    service.preview({ filename: 'link.xlsx', bytes: linkBytes, kind: 'APPLICATIONS' }),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some(({ code, location }) => code === 'EXTERNAL_LINK_NOT_ALLOWED' && location === '수강신청!B2'),
  );

  const zip = new JSZip();
  zip.file('xl/workbook.xml', 'x'.repeat(100));
  const oversized = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const limited = serviceFor(store, { expandedWorkbookBytes: 50 });
  await assert.rejects(
    limited.preview({ filename: 'large.xlsx', bytes: oversized, kind: 'APPLICATIONS' }),
    (error) => error instanceof WorkbookValidationError
      && error.issues.some(({ code }) => code === 'EXPANDED_SIZE_LIMIT'),
  );
  assert.deepEqual(store.read(), emptyStore());
});

test('stages only raw rows, survives restart, and re-previews an original export', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-import-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const store = await openStore(dataFile, emptyStore());
  const service = serviceFor(store);
  const bytes = await workbookWithRows('APPLICATIONS', [
    ['2026 봄', '홍길동', '0015', '기초', null, null, null, '심화'],
  ]);

  const preview = await service.preview({ filename: 'applications.xlsx', bytes, kind: 'APPLICATIONS' });
  assert.equal(store.read().importBatches.length, 0);
  const staged = await service.stage(preview.previewId);
  assert.equal(staged.templateVersion, '2');
  assert.equal(store.read().applications.length, 0);
  assert.equal(store.read().members.length, 0);

  const reopened = await openStore(dataFile, emptyStore());
  const restarted = serviceFor(reopened);
  assert.equal(restarted.getStaged(staged.id).rawRows[0].cells['신청순서'], '0015');
  const currentPreview = restarted.repreviewStaged(staged.id);
  assert.equal(currentPreview.applications[0].applicationOrder, 15);
  assert.equal(currentPreview.templateVersion, '2');

  const originalExport = await restarted.exportStagedOriginal(staged.id);
  const roundTrip = await restarted.preview({
    filename: 'original-export.xlsx', bytes: originalExport, kind: 'APPLICATIONS',
  });
  assert.deepEqual(roundTrip.rawRows, preview.rawRows);
  assert.equal(roundTrip.templateVersion, '2');
});

test('staging an empty legacy workbook preserves its version and legacy headers on original export', async () => {
  const cases = [
    { kind: 'APPLICATIONS', sheet: '수강신청', headers: ['학기명', '회원명', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌'] },
    { kind: 'ENROLLMENTS', sheet: '수강이력', headers: ['학기명', '회원명', '강좌명', '관리자 메모'] },
  ];
  for (const { kind, sheet, headers } of cases) {
    const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
    const service = serviceFor(store);
    const bytes = await workbookWithRows(kind, []);
    const preview = await service.preview({ filename: '기존 빈 양식.xlsx', bytes, kind });
    const staged = await service.stage(preview.previewId);
    assert.equal(staged.templateVersion, '2');
    const exported = new ExcelJS.Workbook();
    await exported.xlsx.load(await service.exportStagedOriginal(staged.id));
    assert.equal(exported.getWorksheet('메타').getCell('B1').text, '2');
    assert.deepEqual(exported.getWorksheet(sheet).getRow(1).values.slice(1), headers);
  }
});

test('reports two enrollment rows for one member and semester as a blocking conflict', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const bytes = await workbookWithRows('ENROLLMENTS', [
    ['2026 봄', '홍길동', '기초'],
    ['2026 봄', '홍길동', '심화'],
  ]);

  const preview = await service.preview({ filename: 'enrollments.xlsx', bytes, kind: 'ENROLLMENTS' });

  assert.equal(preview.sourceRowCount, 2);
  assert.ok(preview.issues.some(({ code, severity }) => (
    code === 'DUPLICATE_SEMESTER_ENROLLMENT' && severity === 'ERROR'
  )));
  assert.deepEqual(store.read(), emptyStore());
});

class MemoryAdapter {
  constructor(data) {
    this.data = structuredClone(data);
  }

  async read() {
    return structuredClone(this.data);
  }

  async write(data) {
    this.data = structuredClone(data);
  }
}
