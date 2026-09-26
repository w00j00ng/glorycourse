import assert from 'node:assert/strict';
import test from 'node:test';

import { writeHttpError } from '../../backend/src/api/errors.ts';

const responseFor = (name) => {
  let status;
  let body;
  const response = {
    writeHead(value) { status = value; },
    end(value) { body = JSON.parse(Buffer.from(value).toString('utf8')); },
  };
  const error = new Error('internal detail');
  error.name = name;
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
