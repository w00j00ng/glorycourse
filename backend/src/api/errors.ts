import type { ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const writeHttpError = (response: ServerResponse, error: unknown): void => {
  const mapped = mapError(error);
  const body = Buffer.from(JSON.stringify({
    code: mapped.code,
    message: mapped.message,
    issues: errorIssues(error),
    ...currentRevision(error),
  }));
  response.writeHead(mapped.status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  response.end(body);
};

const mapError = (error: unknown): { status: number; code: string; message: string } => {
  if (error instanceof HttpError) return error;
  if (error instanceof SyntaxError) return { status: 400, code: 'BAD_REQUEST', message: '요청을 읽을 수 없습니다.' };
  const name = error instanceof Error ? error.name : '';
  if (name === 'WorkbookValidationError') {
    const limit = errorIssues(error).some((issue) => (
      issue !== null
      && typeof issue === 'object'
      && 'code' in issue
      && typeof issue.code === 'string'
      && issue.code.endsWith('_LIMIT')
    ));
    return limit
      ? { status: 413, code: 'PAYLOAD_TOO_LARGE', message: '업로드 파일이 허용 한도를 초과했습니다.' }
      : { status: 400, code: 'BAD_REQUEST', message: 'xlsx 파일을 읽을 수 없습니다.' };
  }
  if (name === 'StoreRecoveryRequiredError') {
    return { status: 503, code: 'STORE_RECOVERY_REQUIRED', message: '저장소 복구가 필요합니다.' };
  }
  if (name === 'InstanceAlreadyRunningError') {
    return { status: 503, code: 'INSTANCE_ALREADY_RUNNING', message: '이미 실행 중인 인스턴스가 있습니다.' };
  }
  if (
    name === 'ImportPreviewNotFoundError'
    || name.includes('Stale')
    || name.includes('TokenError')
  ) return {
    status: 409,
    code: 'PREVIEW_STALE',
    message: '검토 유효 시간이 지났거나 자료가 변경되었습니다. 다시 검토하세요.',
  };
  if (name.includes('NotFound')) return { status: 404, code: 'NOT_FOUND', message: '대상을 찾을 수 없습니다.' };
  if (name === 'ApplicationConflictError') {
    return { status: 409, code: 'CONFLICT', message: '현재 상태와 요청이 충돌합니다.' };
  }
  if (
    name.includes('RevisionConflict')
    || name === 'StoreEpochConflictError'
    || name.includes('IdempotencyConflict')
    || name.includes('ReadOnly')
  ) return { status: 409, code: 'CONFLICT', message: '현재 상태와 요청이 충돌합니다.' };
  if (
    name.includes('Validation')
    || name.includes('Acknowledgement')
    || name.includes('UnsupportedEngine')
    || name.endsWith('ConflictError')
  ) return { status: 422, code: 'UNPROCESSABLE', message: '업무 규칙을 만족하지 못했습니다.' };
  return { status: 500, code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했습니다.' };
};

const errorIssues = (error: unknown): unknown[] => (
  error instanceof Error && 'issues' in error && Array.isArray(error.issues)
    ? structuredClone(error.issues)
    : []
);

const currentRevision = (error: unknown): { currentRevision?: number } => (
  error instanceof Error
  && 'currentRevision' in error
  && Number.isSafeInteger(error.currentRevision)
    ? { currentRevision: error.currentRevision as number }
    : {}
);
