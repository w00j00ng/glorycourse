import assert from 'node:assert/strict';
import test from 'node:test';

import { reportFilename, templateFilename } from '../../frontend/download-name.js';

test('names each template in Korean with the local download timestamp', () => {
  const downloadedAt = new Date(2026, 8, 25, 4, 5, 6);

  assert.equal(templateFilename('수강신청', downloadedAt), '수강신청_양식_260925040506.xlsx');
  assert.equal(templateFilename('수강이력', downloadedAt), '수강이력_양식_260925040506.xlsx');
});

test('names each status report in Korean with the local download timestamp', () => {
  const downloadedAt = new Date(2026, 8, 25, 4, 5, 6);

  assert.equal(reportFilename('수강신청', downloadedAt), '수강신청_현황_260925040506.xlsx');
  assert.equal(reportFilename('수강이력', downloadedAt), '수강이력_현황_260925040506.xlsx');
});
