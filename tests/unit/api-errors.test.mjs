import assert from 'node:assert/strict';
import test from 'node:test';

import { writeHttpError } from '../../backend/src/api/errors.ts';
import { exportApplicationRows } from '../../backend/src/excel/workbooks.ts';

const responseFor = (input) => {
  let status;
  let body;
  const response = {
    writeHead(value) { status = value; },
    end(value) { body = JSON.parse(Buffer.from(value).toString('utf8')); },
  };
  const error = typeof input === 'string' ? new Error('internal detail') : input;
  if (typeof input === 'string') error.name = input;
  writeHttpError(response, error);
  return { status, body };
};

test('tells the user to review again when a preview expired or became stale', () => {
  for (const name of ['EnrollmentTokenError', 'EnrollmentStaleError', 'ImportPreviewNotFoundError', 'FinalizationTokenError']) {
    assert.deepEqual(responseFor(name), {
      status: 409,
      body: {
        code: 'PREVIEW_STALE',
        message: '검토 유효 시간이 지났거나 자료가 변경되었습니다. 다시 검토하세요.',
        issues: [],
      },
    });
  }
});

test('keeps an ordinary revision conflict distinct from preview expiry', () => {
  assert.equal(responseFor('RevisionConflictError').body.code, 'CONFLICT');
});

test('identifies the application and recovery steps when invalid preferences prevent export', async () => {
  const row = { semesterName: '2026 봄', memberName: 'Alex 김', applicationOrder: 1, courseName: '기초' };
  const message = '2026 봄 / Alex 김: 희망순위 1~5를 확인한 뒤 다시 내보내세요.';
  const requests = [
    [{ ...row, preference: null }],
    [{ ...row, preference: 0 }],
    [{ ...row, preference: 6 }],
    [{ ...row, preference: 1 }, { ...row, courseName: '심화', preference: 1 }],
  ];
  const expected = {
    status: 422,
    body: {
      code: 'UNPROCESSABLE', message,
      issues: [{ code: 'PREFERENCE_UNRESOLVED', message, location: '수강신청' }],
    },
  };
  for (const request of requests) {
    await assert.rejects(exportApplicationRows(request), (error) => {
      assert.deepEqual(responseFor(error), expected);
      return true;
    });
  }
});

test('tells the user how to correct rejected acknowledgement notes', () => {
  for (const name of [
    'EnrollmentAcknowledgementError', 'FinalizationAcknowledgementError',
    'ImportAcknowledgementError', 'RecoveryAcknowledgementError',
  ]) {
    assert.deepEqual(responseFor(name), {
      status: 422,
      body: {
        code: 'UNPROCESSABLE',
        message: '확인 메모를 입력하고 검토한 경고 내용을 다시 확인하세요.',
        issues: [],
      },
    });
  }
});
