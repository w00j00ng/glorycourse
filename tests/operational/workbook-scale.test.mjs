import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  exportApplicationRows,
  extractRawRows,
  readSafeWorkbook,
} from '../../backend/src/excel/workbooks.ts';

test('round-trips every application row at the published workbook row limit', async (context) => {
  const rowCount = 99_993; // Metadata and worksheet headers occupy seven rows.
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    semesterName: '최대 학기',
    memberName: `회원 ${index}`,
    applicationOrder: index + 1,
    applicantNote: `신청 메모 ${index}\n둘째 줄`,
    courseName: `강좌 ${index % 1_000}`,
    preference: 1,
  }));
  const heapBefore = process.memoryUsage().heapUsed;
  const exportStartedAt = performance.now();
  const bytes = await exportApplicationRows(rows);
  const exportMs = performance.now() - exportStartedAt;
  const readStartedAt = performance.now();
  const workbook = await readSafeWorkbook({ filename: 'max-applications.xlsx', bytes });
  const raw = extractRawRows(workbook, 'APPLICATIONS');
  const readMs = performance.now() - readStartedAt;

  assert.equal(workbook.worksheets.reduce((total, sheet) => total + sheet.rowCount, 0), 100_000);
  assert.equal(raw.length, rowCount);
  assert.deepEqual(raw[0].cells, {
    '학기명': '최대 학기', '회원명': '회원 0', '학생 소속': null, '신청순서': '1',
    '신청자 메모': '신청 메모 0\n둘째 줄', '1순위 강좌': '강좌 0',
    '2순위 강좌': null, '3순위 강좌': null, '4순위 강좌': null,
  });
  assert.deepEqual(raw.at(-1).cells, {
    '학기명': '최대 학기', '회원명': `회원 ${rowCount - 1}`, '학생 소속': null, '신청순서': String(rowCount),
    '신청자 메모': `신청 메모 ${rowCount - 1}\n둘째 줄`,
    '1순위 강좌': `강좌 ${(rowCount - 1) % 1_000}`,
    '2순위 강좌': null, '3순위 강좌': null, '4순위 강좌': null,
  });
  workbook.getWorksheet('수강신청').addRow(['최대 학기', '초과 회원', null, rowCount + 1, '초과 메모', '강좌 0']);
  await assert.rejects(readSafeWorkbook({ filename: 'over-limit.xlsx', bytes: await workbook.xlsx.writeBuffer() }),
    (error) => error.issues.some(({ code }) => code === 'ROW_LIMIT'));
  context.diagnostic(JSON.stringify({
    scenario: 'application-workbook-row-limit',
    rows: raw.length,
    xlsxMiB: Math.round(bytes.byteLength / 1024 / 1024 * 10) / 10,
    exportMs: Math.round(exportMs),
    readMs: Math.round(readMs),
    heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024),
  }));
});
