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
    '학기명', '회원명', '신청순서', '강좌명', '희망순위',
  ]);
  assert.equal(template.getWorksheet('메타').getCell('B1').text, '1');
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
  assert.equal(exported.getWorksheet('수강신청').getCell('D2').formula, undefined);
});

test('preserves raw order cells and reports application quality without mutating the store', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const bytes = await workbookWithRows('APPLICATIONS', [
    ['2026 봄', '홍길동', '15', '기초', '1'],
    ['2026 봄', '홍길동', '16', '심화', '2'],
    ['2026 봄', '홍길동', '15', '기초', '1'],
    ['2026 봄', '김빈칸', '', '기초', '1'],
    ['2026 봄', '김문자', 'abc', '기초', '1'],
    ['2026 봄', '김영', '0015', '기초', '1'],
  ]);
  const before = store.read();

  const preview = await service.preview({ filename: 'applications.xlsx', bytes, kind: 'APPLICATIONS' });

  assert.deepEqual(store.read(), before);
  assert.equal(preview.sourceRowCount, 6);
  assert.equal(preview.rawRows.at(-1).cells['신청순서'], '0015');
  assert.deepEqual(
    preview.applications.map(({ memberName, applicationOrder, applicationOrderStatus }) => ({
      memberName, applicationOrder, applicationOrderStatus,
    })),
    [
      { memberName: '홍길동', applicationOrder: null, applicationOrderStatus: 'CONFLICT' },
      { memberName: '김빈칸', applicationOrder: null, applicationOrderStatus: 'MISSING' },
      { memberName: '김문자', applicationOrder: null, applicationOrderStatus: 'INVALID' },
      { memberName: '김영', applicationOrder: 15, applicationOrderStatus: 'NORMAL' },
    ],
  );
  assert.deepEqual(preview.applications[0].choices[0].sourceRefs.map(({ row }) => row), [2, 4]);
});

test('keeps duplicate preference source values but marks the choices unresolved', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const service = serviceFor(store);
  const bytes = await workbookWithRows('APPLICATIONS', [
    ['2026 봄', '홍길동', '15', '기초', '1'],
    ['2026 봄', '홍길동', '15', '심화', '1'],
  ]);

  const preview = await service.preview({ filename: 'duplicate-preference.xlsx', bytes, kind: 'APPLICATIONS' });

  assert.deepEqual(preview.applications[0].choices.map(({ preference }) => preference), [null, null]);
  assert.ok(preview.issues.some(({ code }) => code === 'PREFERENCE_CONFLICT'));
  assert.equal(preview.conflicts, 1);
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
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '0015', '기초', '1']]),
    kind: 'APPLICATIONS',
  });
  const conflicting = await service.preview({
    filename: 'changed.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '16', '기초', '1']]),
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
    ['2026 봄', '홍길동', '0015', '기초', '1'],
  ]);

  const preview = await service.preview({ filename: 'applications.xlsx', bytes, kind: 'APPLICATIONS' });
  assert.equal(store.read().importBatches.length, 0);
  const staged = await service.stage(preview.previewId);
  assert.equal(store.read().applications.length, 0);
  assert.equal(store.read().members.length, 0);

  const reopened = await openStore(dataFile, emptyStore());
  const restarted = serviceFor(reopened);
  assert.equal(restarted.getStaged(staged.id).rawRows[0].cells['신청순서'], '0015');
  const currentPreview = restarted.repreviewStaged(staged.id);
  assert.equal(currentPreview.applications[0].applicationOrder, 15);

  const originalExport = await restarted.exportStagedOriginal(staged.id);
  const roundTrip = await restarted.preview({
    filename: 'original-export.xlsx', bytes: originalExport, kind: 'APPLICATIONS',
  });
  assert.deepEqual(roundTrip.rawRows, preview.rawRows);
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
