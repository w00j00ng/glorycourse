import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import {
  exportApplicationRows,
  extractRawRows,
  readSafeWorkbook,
} from '../../backend/src/excel/workbooks.ts';

test('round-trips every application row at the published workbook row limit', async (context) => {
  const rowCount = 99_994;
  const rows = Array.from({ length: rowCount }, (_, index) => ({
    semesterName: '최대 학기',
    memberName: `회원 ${index}`,
    applicationOrder: index + 1,
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

  assert.equal(raw.length, rowCount);
  assert.deepEqual(raw[0].cells, {
    '학기명': '최대 학기', '회원명': '회원 0', '신청순서': '1', '강좌명': '강좌 0', '희망순위': '1',
  });
  assert.deepEqual(raw.at(-1).cells, {
    '학기명': '최대 학기', '회원명': `회원 ${rowCount - 1}`, '신청순서': String(rowCount),
    '강좌명': `강좌 ${(rowCount - 1) % 1_000}`, '희망순위': '1',
  });
  context.diagnostic(JSON.stringify({
    scenario: 'application-workbook-row-limit',
    rows: raw.length,
    xlsxMiB: Math.round(bytes.byteLength / 1024 / 1024 * 10) / 10,
    exportMs: Math.round(exportMs),
    readMs: Math.round(readMs),
    heapDeltaMiB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024),
  }));
});
