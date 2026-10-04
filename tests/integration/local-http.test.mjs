import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import ExcelJS from '@excel.js/exceljs';

import { exportApplicationRows } from '../../backend/src/excel/workbooks.ts';
import { startLocalServer } from '../../backend/src/server.ts';
import { InstanceAlreadyRunningError } from '../../backend/src/storage/instance-lock.ts';
import { StoreRecoveryRequiredError } from '../../backend/src/storage/store.ts';

test('serves local files and allows a protected same-origin write without external services', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
    apiHandler: testApi,
  });
  t.after(() => runtime.close());

  assert.equal(runtime.address, '127.0.0.1');
  const page = await call(runtime.origin, '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /로컬 수강 관리/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);

  const session = await call(runtime.origin, '/api/v1/session', {
    method: 'POST',
    headers: { Origin: runtime.origin },
  });
  assert.equal(session.status, 201);
  const { token, expiresAt } = JSON.parse(session.text);
  assert.equal(typeof token, 'string');
  assert.ok(Date.parse(expiresAt) > Date.now());

  const created = await call(runtime.origin, '/api/v1/test/write', {
    method: 'POST',
    headers: {
      Origin: runtime.origin,
      'X-Glorycourse-Session': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '홍길동' }),
  });
  assert.equal(created.status, 201);

  const state = await call(runtime.origin, '/api/v1/test/state', {
    headers: { 'X-Glorycourse-Session': token },
  });
  assert.deepEqual(JSON.parse(state.text), { members: ['홍길동'] });
});

test('rejects forged Host, external Origin, missing tokens, and multipart forms before mutation', async (t) => {
  const workspace = await localWorkspace(t);
  let handlerCalls = 0;
  const runtime = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
    apiHandler: async (...args) => {
      handlerCalls += 1;
      return testApi(...args);
    },
  });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);

  const requests = [
    call(runtime.origin, '/api/v1/test/write', {
      method: 'POST',
      headers: { Host: 'evil.example', Origin: runtime.origin, 'X-Glorycourse-Session': session.token },
      body: '{}',
    }),
    call(runtime.origin, '/api/v1/test/write', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-Glorycourse-Session': session.token },
      body: '{}',
    }),
    call(runtime.origin, '/api/v1/test/write', {
      method: 'POST', headers: { Origin: runtime.origin }, body: '{}',
    }),
    call(runtime.origin, '/api/v1/test/write', {
      method: 'POST',
      headers: { Origin: runtime.origin, 'X-Glorycourse-Session': `${session.token}x` },
      body: '{}',
    }),
    call(runtime.origin, '/api/v1/test/write', {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'Content-Type': 'multipart/form-data; boundary=attack',
      },
      body: '--attack\r\nContent-Disposition: form-data; name="file"\r\n\r\nprivate\r\n--attack--',
    }),
    call(runtime.origin, '/api/v1/session', {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }),
  ];
  const responses = await Promise.all(requests);

  assert.deepEqual(responses.map(({ status }) => status), [403, 403, 403, 403, 403, 403]);
  assert.equal(handlerCalls, 0);
  assert.equal(runtime.store.read().members.length, 0);

  const getMutation = await call(runtime.origin, '/api/v1/test/write', {
    headers: { 'X-Glorycourse-Session': session.token },
  });
  assert.equal(getMutation.status, 405);
  assert.equal(runtime.store.read().members.length, 0);
});

test('returns a readable size error for a streaming upload and accepts the next request', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({
    dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0,
    uploadBytes: 8, apiHandler: testApi,
  });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const result = await new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/api/v1/test/write', runtime.origin), {
      method: 'POST',
      headers: { Origin: runtime.origin, 'X-Glorycourse-Session': session.token },
    }, (response) => {
      request.end();
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('The upload size error was not returned')));
    // Leave the stream open: the server must reject once the received bytes exceed the limit.
    request.write('123456789');
  });
  assert.equal(result.status, 413);
  assert.equal(result.body.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(runtime.store.read().members.length, 0);
  assert.equal((await call(runtime.origin, '/')).status, 200);
});

test('rejects non-object JSON as a client error without changing stored data', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({
    dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0,
  });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const before = runtime.store.read();
  for (const path of ['/allocation-drafts', '/allocation-drafts/missing/finalize-preview', '/enrollments/preview', '/semesters', '/applications', '/imports/missing/stage']) {
    for (const input of [null, [], '잘못된 입력', 1, true]) {
      const response = await call(runtime.origin, `/api/v1${path}`, {
        method: 'POST',
        headers: { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      assert.equal(response.status, 400, `${path}: ${JSON.stringify(input)}`);
      assert.equal(JSON.parse(response.text).code, 'BAD_REQUEST');
    }
  }
  for (const policySettings of [null, undefined, {}]) {
    const response = await call(runtime.origin, '/api/v1/allocation-drafts', {
      method: 'POST',
      headers: { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ semesterId: 'semester', mode: 'AUTO', policyId: 'course-allocation', policyVersion: '1.0.0', policySettings }),
    });
    assert.equal(response.status, 422, `policySettings: ${JSON.stringify(policySettings)}`);
  }
  assert.deepEqual(runtime.store.read(), before);
});

test('persists local data across restart, invalidates the old session, and keeps a single writer', async (t) => {
  const workspace = await localWorkspace(t);
  const first = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
    apiHandler: testApi,
  });
  const session = JSON.parse((await call(first.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: first.origin },
  })).text);
  await call(first.origin, '/api/v1/test/write', {
    method: 'POST',
    headers: {
      Origin: first.origin,
      'X-Glorycourse-Session': session.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: '재시작 회원' }),
  });

  await assert.rejects(startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
    apiHandler: testApi,
  }), InstanceAlreadyRunningError);
  await first.close();

  const second = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
    apiHandler: testApi,
  });
  t.after(() => second.close());
  const rejected = await call(second.origin, '/api/v1/test/state', {
    headers: { 'X-Glorycourse-Session': session.token },
  });
  assert.equal(rejected.status, 403);
  const nextSession = JSON.parse((await call(second.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: second.origin },
  })).text);
  const restored = await call(second.origin, '/api/v1/test/state', {
    headers: { 'X-Glorycourse-Session': nextSession.token },
  });
  assert.deepEqual(JSON.parse(restored.text), { members: ['재시작 회원'] });
});

test('maps recovery failures to a safe 503 response and enforces the upload limit', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
    uploadBytes: 8,
    apiHandler: testApi,
  });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token };

  const recovery = await call(runtime.origin, '/api/v1/test/recovery', {
    method: 'POST', headers,
  });
  assert.equal(recovery.status, 503);
  assert.deepEqual(JSON.parse(recovery.text), {
    code: 'STORE_RECOVERY_REQUIRED',
    message: '저장소 복구가 필요합니다.',
    issues: [],
  });
  assert.doesNotMatch(recovery.text, new RegExp(session.token));

  const tooLarge = await call(runtime.origin, '/api/v1/test/write', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '123456789' }),
  });
  assert.equal(tooLarge.status, 413);
  assert.equal(runtime.store.read().members.length, 0);
});

test('manages catalog and application records through the protected API and keeps them after restart', async (t) => {
  const workspace = await localWorkspace(t);
  const first = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
  });
  t.after(() => first.close());
  const firstSession = JSON.parse((await call(first.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: first.origin },
  })).text);
  const firstHeaders = {
    Origin: first.origin,
    'X-Glorycourse-Session': firstSession.token,
    'Content-Type': 'application/json',
  };

  const semesterResponse = await call(first.origin, '/api/v1/semesters', {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ name: '2026 가을', order: null }),
  });
  assert.equal(semesterResponse.status, 201);
  assert.deepEqual(
    { name: JSON.parse(semesterResponse.text).semester.name, order: JSON.parse(semesterResponse.text).order },
    { name: '2026 가을', order: 1 },
  );

  const unusedSemester = JSON.parse((await call(first.origin, '/api/v1/semesters', {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({ name: '2027 봄', order: 2 }),
  })).text);
  const listedSemesters = JSON.parse((await call(first.origin, '/api/v1/semesters?limit=200', {
    headers: { 'X-Glorycourse-Session': firstSession.token },
  })).text);
  assert.deepEqual(listedSemesters.items.map(({ name, order }) => ({ name, order })), [
    { name: '2027 봄', order: 2 },
    { name: '2026 가을', order: 1 },
  ]);
  const configured = JSON.parse((await call(
    first.origin,
    `/api/v1/semesters/${unusedSemester.semester.id}/context`,
    {
      method: 'PATCH',
      headers: firstHeaders,
      body: JSON.stringify({
        expectedRevision: unusedSemester.allocationInputRevision,
        name: '2027 봄',
        order: 2,
        semesterCourses: [{ courseName: '삭제할 강좌', capacity: 10 }],
      }),
    },
  )).text);
  const applicationTemplate = await call(
    first.origin,
    `/api/v1/applications/template?semesterId=${unusedSemester.semester.id}`,
    { headers: { 'X-Glorycourse-Session': firstSession.token } },
  );
  assert.equal(applicationTemplate.status, 200);
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.load(applicationTemplate.bytes);
  assert.deepEqual(templateWorkbook.getWorksheet('학기').getRow(2).values.slice(1), ['2027 봄', 2]);
  assert.deepEqual(
    templateWorkbook.getWorksheet('개설강좌').getRow(2).values.slice(1),
    ['2027 봄', '삭제할 강좌', 10],
  );
  const deletedCourse = await call(
    first.origin,
    `/api/v1/semesters/${unusedSemester.semester.id}/courses/${configured.semesterCourses[0].id}?expectedRevision=${configured.allocationInputRevision}&confirmApplications=false`,
    { method: 'DELETE', headers: firstHeaders },
  );
  assert.equal(deletedCourse.status, 204);
  const afterCourseDelete = await call(first.origin, `/api/v1/semesters/${unusedSemester.semester.id}/context`, {
    headers: { 'X-Glorycourse-Session': firstSession.token },
  });
  assert.equal(JSON.parse(afterCourseDelete.text).semesterCourses.length, 0);
  const deletedSemester = await call(first.origin,
    `/api/v1/semesters/${unusedSemester.semester.id}?expectedRevision=${JSON.parse(afterCourseDelete.text).allocationInputRevision}`,
    { method: 'DELETE', headers: firstHeaders });
  assert.equal(deletedSemester.status, 204);
  assert.equal((await call(first.origin, `/api/v1/semesters/${unusedSemester.semester.id}/context`, {
    headers: { 'X-Glorycourse-Session': firstSession.token },
  })).status, 404);

  const createdResponse = await call(first.origin, '/api/v1/applications', {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({
      semesterName: '2026 가을',
      memberName: '홍길동',
      applicationOrder: 1,
      choices: [{ courseName: '연기', preference: 1 }],
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = JSON.parse(createdResponse.text);
  assert.equal(created.memberName, '홍길동');
  assert.equal(created.revision, 0);

  const listed = await call(first.origin, `/api/v1/applications?memberName=%ED%99%8D&semesterId=${created.semesterId}`, {
    headers: { 'X-Glorycourse-Session': firstSession.token },
  });
  assert.equal(listed.status, 200);
  assert.deepEqual(JSON.parse(listed.text), {
    items: [created],
    page: 1,
    limit: 50,
    total: 1,
  });
  const runtimeInfo = await call(first.origin, '/api/v1/runtime', {
    headers: { 'X-Glorycourse-Session': firstSession.token },
  });
  const info = JSON.parse(runtimeInfo.text);
  assert.match(info.instanceId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(info, { dataDirectory: workspace.data, application: 'glorycourse', instanceId: info.instanceId, version: 'development' });
  const applicationExport = await call(first.origin, '/api/v1/applications/export', {
    headers: { 'X-Glorycourse-Session': firstSession.token },
  });
  assert.equal(applicationExport.status, 200);
  assert.equal(applicationExport.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(applicationExport.text.slice(0, 2), 'PK');

  const updatedResponse = await call(first.origin, `/api/v1/applications/${created.id}`, {
    method: 'PATCH',
    headers: firstHeaders,
    body: JSON.stringify({
      semesterName: '2026 가을',
      memberName: '홍길동',
      applicationOrder: 2,
      expectedRevision: 0,
      choices: [{ courseName: '연기', preference: 1 }],
    }),
  });
  assert.equal(updatedResponse.status, 200);
  assert.equal(JSON.parse(updatedResponse.text).revision, 1);

  const enrollmentPreviewResponse = await call(first.origin, '/api/v1/enrollments/preview', {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({
      action: 'CREATE',
      semesterName: '2026 가을',
      memberName: '홍길동',
      courseName: '연기',
    }),
  });
  assert.equal(enrollmentPreviewResponse.status, 200);
  const enrollmentPreview = JSON.parse(enrollmentPreviewResponse.text);
  assert.ok(enrollmentPreview.issues.length > 0);
  const enrollmentResponse = await call(first.origin, '/api/v1/enrollments', {
    method: 'POST',
    headers: firstHeaders,
    body: JSON.stringify({
      preparedActionToken: enrollmentPreview.preparedActionToken,
      acknowledgedWarningDigest: enrollmentPreview.warningDigest,
      acknowledgementNote: '학기 순서와 정원을 확인하고 직접 등록함',
    }),
  });
  assert.equal(enrollmentResponse.status, 201);
  const enrollment = JSON.parse(enrollmentResponse.text);
  assert.equal(enrollment.memberName, '홍길동');
  await first.close();

  const second = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
  });
  t.after(() => second.close());
  const secondSession = JSON.parse((await call(second.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: second.origin },
  })).text);
  const restored = await call(second.origin, `/api/v1/applications/${created.id}`, {
    headers: { 'X-Glorycourse-Session': secondSession.token },
  });
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restored.text).applicationOrder, 2);
  const restoredEnrollments = await call(second.origin, '/api/v1/enrollments', {
    headers: { 'X-Glorycourse-Session': secondSession.token },
  });
  assert.equal(JSON.parse(restoredEnrollments.text).items[0].id, enrollment.id);

  const deleted = await call(second.origin, `/api/v1/applications/${created.id}?expectedRevision=1`, {
    method: 'DELETE',
    headers: {
      Origin: second.origin,
      'X-Glorycourse-Session': secondSession.token,
    },
  });
  assert.equal(deleted.status, 204);
  const empty = await call(second.origin, '/api/v1/applications', {
    headers: { 'X-Glorycourse-Session': secondSession.token },
  });
  assert.equal(JSON.parse(empty.text).total, 0);
});

test('previews, stages, rechecks, and applies an xlsx import through the protected API', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
  });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await exportApplicationRows([{
    semesterName: '2030 봄',
    memberName: '김새롬',
    applicationOrder: 1,
    courseName: '연기',
    preference: 1,
  }]));
  workbook.getWorksheet('개설강좌').addRow(['2030 봄', '연기', 10]);
  const upload = multipart({ kind: 'APPLICATIONS', mode: 'MERGE_KEEP_EXISTING' }, {
    name: 'file', filename: 'applications.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  const previewResponse = await call(runtime.origin, '/api/v1/imports/preview', {
    method: 'POST',
    headers: {
      Origin: runtime.origin,
      'X-Glorycourse-Session': session.token,
      'Content-Type': upload.contentType,
    },
    body: upload.body,
  });
  assert.equal(previewResponse.status, 200);
  const preview = JSON.parse(previewResponse.text);
  assert.equal(preview.sourceRowCount, 1);
  assert.equal(preview.insertCandidates, 1);
  assert.equal(runtime.store.read().applications.length, 0);

  const stagedResponse = await call(runtime.origin, `/api/v1/imports/${preview.previewId}/stage`, {
    method: 'POST',
    headers: {
      Origin: runtime.origin,
      'X-Glorycourse-Session': session.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ storeRevision: preview.storeRevision, storeEpoch: preview.storeEpoch }),
  });
  assert.equal(stagedResponse.status, 201);
  const staged = JSON.parse(stagedResponse.text);
  assert.equal(staged.status, 'STAGED');
  assert.equal(runtime.store.read().applications.length, 0);

  const refreshedResponse = await call(runtime.origin, `/api/v1/import-batches/${staged.id}/preview`, {
    method: 'POST',
    headers: { Origin: runtime.origin, 'X-Glorycourse-Session': session.token },
  });
  assert.equal(refreshedResponse.status, 200);
  const refreshed = JSON.parse(refreshedResponse.text);
  const committedResponse = await call(runtime.origin, `/api/v1/imports/${refreshed.previewId}/commit`, {
    method: 'POST',
    headers: {
      Origin: runtime.origin,
      'X-Glorycourse-Session': session.token,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'browser-import-1',
    },
    body: JSON.stringify({
      storeRevision: refreshed.storeRevision,
      storeEpoch: refreshed.storeEpoch,
      warningDigest: refreshed.warningDigest,
      resolutions: [],
    }),
  });
  assert.equal(committedResponse.status, 200);
  assert.equal(JSON.parse(committedResponse.text).inserted, 1);
  await assert.rejects(readdir(join(workspace.data, 'backups')), { code: 'ENOENT' });
  const applied = await call(runtime.origin, `/api/v1/import-batches/${staged.id}`, {
    headers: { 'X-Glorycourse-Session': session.token },
  });
  assert.equal(JSON.parse(applied.text).status, 'APPLIED');
  const applications = await call(runtime.origin, '/api/v1/applications', {
    headers: { 'X-Glorycourse-Session': session.token },
  });
  assert.equal(JSON.parse(applications.text).items[0].memberName, '김새롬');
});

test('creates and edits a draft, then replays finalization after the draft is removed', async (t) => {
  const workspace = await localWorkspace(t);
  let runtime = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
  });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = {
    Origin: runtime.origin,
    'X-Glorycourse-Session': session.token,
    'Content-Type': 'application/json',
  };
  const application = JSON.parse((await call(runtime.origin, '/api/v1/applications', {
    method: 'POST', headers,
    body: JSON.stringify({
      semesterName: '2031 봄', memberName: '배정회원', applicationOrder: 1,
      choices: [{ courseName: '발성', preference: 1 }],
    }),
  })).text);
  const context = JSON.parse((await call(runtime.origin, `/api/v1/semesters/${application.semesterId}/context`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      expectedRevision: 1,
      order: 1,
      semesterCourses: [{ courseName: '발성', capacity: 1 }],
    }),
  })).text);
  assert.equal(context.readyForAutoAllocation, true);

  const createdResponse = await call(runtime.origin, '/api/v1/allocation-drafts', {
    method: 'POST', headers,
    body: JSON.stringify({
      semesterId: application.semesterId,
      mode: 'AUTO',
      policyId: 'course-allocation',
      policyVersion: '1.0.0',
      policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' },
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = JSON.parse(createdResponse.text);
  assert.equal(created.studentResults[0].finalDecision, 'SELECTED');
  assert.ok(created.applicationSnapshot);
  assert.equal(created.applicationSnapshot.applications[0].id, application.id);
  assert.equal(created.applicationSnapshot.choices[0].preference, 1);
  assert.equal(created.applicationSnapshot.semesterCourses[0].courseName, '발성');
  const automaticAddition = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/items`, {
    method: 'POST', headers,
    body: JSON.stringify({
      expectedDraftRevision: 0, memberName: '현장 추가', semesterCourseId: context.semesterCourses[0].id,
    }),
  });
  assert.equal(automaticAddition.status, 422);
  assert.match(JSON.parse(automaticAddition.text).issues[0].message, /수동 초안/);
  assert.equal(runtime.store.read().allocationDraftItems.length, 1);
  const archiveAttempt = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/archive`, {
    method: 'POST', headers, body: JSON.stringify({ expectedDraftRevision: 0 }),
  });
  assert.equal(archiveAttempt.status, 404);
  const unfinalizedReport = await call(runtime.origin, `/api/v1/semesters/${application.semesterId}/enrollment-report`, {
    method: 'POST', headers,
  });
  assert.equal(unfinalizedReport.status, 422);

  const rejectedResponse = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/items/${application.memberId}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({
      expectedDraftRevision: 0,
      finalDecision: 'REJECTED',
      finalSemesterCourseId: null,
      finalReasonCode: 'ADMIN_EXCLUDED',
      finalReasonDetail: { note: '검토 제외' },
    }),
  });
  assert.equal(JSON.parse(rejectedResponse.text).finalDecision, 'REJECTED');
  const restoredResponse = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/items/${application.memberId}/restore-auto`, {
    method: 'POST', headers,
    body: JSON.stringify({ expectedDraftRevision: 1 }),
  });
  assert.equal(JSON.parse(restoredResponse.text).finalDecision, 'SELECTED');

  const previewResponse = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/finalize-preview`, {
    method: 'POST', headers,
    body: JSON.stringify({ expectedDraftRevision: 2 }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = JSON.parse(previewResponse.text);
  assert.equal(preview.enrollments.length, 1);
  const finalizationBody = JSON.stringify({
    preparedActionToken: preview.preparedActionToken,
    expectedDraftRevision: 2,
    acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '최종 배정 확인',
  });
  const finalizedResponse = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/finalize`, {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'draft-finalize-browser-1' },
    body: finalizationBody,
  });
  assert.equal(finalizedResponse.status, 200);
  const receipt = JSON.parse(finalizedResponse.text);
  assert.equal(receipt.createdCount, 1);

  await runtime.close();
  runtime = await startLocalServer({
    dataDirectory: workspace.data,
    staticDirectory: workspace.static,
    port: 0,
  });
  const restartedSession = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const replayedResponse = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}/finalize`, {
    method: 'POST',
    headers: {
      Origin: runtime.origin,
      'X-Glorycourse-Session': restartedSession.token,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'draft-finalize-browser-1',
    },
    body: finalizationBody,
  });
  assert.equal(replayedResponse.status, 200);
  assert.deepEqual(JSON.parse(replayedResponse.text), receipt);
  const enrollments = await call(runtime.origin, '/api/v1/enrollments', {
    headers: { 'X-Glorycourse-Session': restartedSession.token },
  });
  assert.equal(JSON.parse(enrollments.text).total, 1);
  const draftList = await call(runtime.origin, '/api/v1/allocation-drafts', {
    headers: { 'X-Glorycourse-Session': restartedSession.token },
  });
  assert.equal(JSON.parse(draftList.text).total, 0);
  const finalized = await call(runtime.origin, `/api/v1/allocation-drafts/${created.draft.id}`, {
    headers: { 'X-Glorycourse-Session': restartedSession.token },
  });
  assert.equal(finalized.status, 404);
  const reportStatusPath = `/api/v1/semesters/${application.semesterId}/enrollment-report`;
  const beforeReport = await call(runtime.origin, reportStatusPath, {
    headers: { 'X-Glorycourse-Session': restartedSession.token },
  });
  assert.equal(JSON.parse(beforeReport.text).enrollmentReportIsCurrent, false);
  const report = await call(runtime.origin, reportStatusPath, {
    method: 'POST',
    headers: {
      Origin: runtime.origin,
      'X-Glorycourse-Session': restartedSession.token,
    },
  });
  assert.equal(report.status, 200);
  assert.equal(report.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(report.bytes.subarray(0, 2).toString('ascii'), 'PK');
  const reportWorkbook = new ExcelJS.Workbook();
  await reportWorkbook.xlsx.load(report.bytes);
  assert.deepEqual(reportWorkbook.getWorksheet('수강이력').getRow(1).values.slice(1), ['학기명', '회원명', '학생 소속', '강좌명', '관리자 메모']);
  assert.equal(reportWorkbook.getWorksheet('개설강좌').getCell('C2').text, '1');
  const currentReport = JSON.parse((await call(runtime.origin, reportStatusPath,
    { headers: { 'X-Glorycourse-Session': restartedSession.token } })).text);
  assert.equal(currentReport.enrollmentReportIsCurrent, true);
  await assert.rejects(readdir(join(workspace.data, 'backups')), { code: 'ENOENT' });
  assert.equal(runtime.store.read().allocationDrafts.length, 0);
  assert.equal(runtime.store.read().allocationDraftItems.length, 0);
  assert.equal(runtime.store.read().enrollments.length, 1);
});

test('moves a semester through the API and shows the new order in the catalog', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const semesters = [];
  for (const name of ['2026 봄', '2026 여름', '2026 가을']) {
    const response = await call(runtime.origin, '/api/v1/semesters', {
      method: 'POST', headers, body: JSON.stringify({ name, order: null }),
    });
    assert.equal(response.status, 201);
    semesters.push(JSON.parse(response.text));
  }
  const path = `/api/v1/semesters/${semesters[2].semester.id}/move`;
  const body = JSON.stringify({ direction: 'DOWN', expectedOrder: 3, adjacentSemesterId: semesters[1].semester.id });
  const moved = await call(runtime.origin, path, { method: 'POST', headers, body });
  assert.equal(moved.status, 200);
  assert.equal(JSON.parse(moved.text).order, 2);
  const listed = await call(runtime.origin, '/api/v1/semesters?limit=200', { headers });
  assert.deepEqual(JSON.parse(listed.text).items.map(({ name, order }) => [name, order]), [
    ['2026 여름', 3], ['2026 가을', 2], ['2026 봄', 1],
  ]);
  assert.equal((await call(runtime.origin, path, { method: 'POST', headers, body })).status, 409);
});

test('sorts all applications before dividing them into pages', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = {
    Origin: runtime.origin,
    'X-Glorycourse-Session': session.token,
    'Content-Type': 'application/json',
  };
  for (const { memberName, applicationOrder } of [
    { memberName: '다솔', applicationOrder: 10 },
    { memberName: '나래', applicationOrder: 1 },
    { memberName: '가람', applicationOrder: 2 },
  ]) {
    const created = await call(runtime.origin, '/api/v1/applications', {
      method: 'POST', headers,
      body: JSON.stringify({ semesterName: '2034 봄', memberName, applicationOrder,
        choices: [{ courseName: '창세기', preference: 1 }] }),
    });
    assert.equal(created.status, 201);
  }
  const cases = [
    { query: 'sort=ORDER_ASC&page=1&limit=2', expected: [1, 2] },
    { query: 'sort=ORDER_ASC&page=2&limit=2', expected: [10] },
    { query: 'sort=ORDER_DESC&page=1&limit=2', expected: [10, 2] },
    { query: 'sort=NAME_ASC&page=1&limit=2', expected: [2, 1] },
    { query: 'sort=NAME_DESC&page=1&limit=2', expected: [10, 1] },
  ];
  for (const { query, expected } of cases) {
    const response = await call(runtime.origin, `/api/v1/applications?${query}`, { headers });
    assert.equal(response.status, 200, query);
    const listed = JSON.parse(response.text);
    assert.equal(listed.total, 3, query);
    assert.deepEqual(listed.items.map(({ applicationOrder }) => applicationOrder), expected, query);
  }
  const invalid = await call(runtime.origin, '/api/v1/applications?sort=UNKNOWN', { headers });
  assert.equal(invalid.status, 400);
});

test('exports application semester and course settings with filtered students and reimports them on a new store', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const semesters = [];
  for (const [name, order, semesterCourses] of [
    ['2026 봄', 5, [{ courseName: '창세기', capacity: 10 }, { courseName: '마태복음', capacity: 12 }]],
    ['2026 가을', 2, [{ courseName: '창세기', capacity: 0 }, { courseName: '마가복음', capacity: 8 }]],
    ['신청 없는 학기', 9, [{ courseName: '요한복음', capacity: 40 }]],
  ]) {
    const created = await call(runtime.origin, '/api/v1/semesters', {
      method: 'POST', headers, body: JSON.stringify({ name, order }),
    });
    assert.equal(created.status, 201);
    const context = JSON.parse(created.text);
    const configured = await call(runtime.origin, `/api/v1/semesters/${context.semester.id}/context`, {
      method: 'PATCH', headers, body: JSON.stringify({ expectedRevision: context.allocationInputRevision, name, order, semesterCourses }),
    });
    assert.equal(configured.status, 200);
    semesters.push(JSON.parse(configured.text));
  }
  const requests = [
    { semesterName: '2026 봄', memberName: '나 회원', applicationOrder: 2, choices: [{ courseName: '창세기', preference: 1 }] },
    { semesterName: '2026 가을', memberName: '가 회원', applicationOrder: 1, choices: [{ courseName: '창세기', preference: 1 }] },
    { semesterName: '2026 봄', memberName: '다 회원', applicationOrder: 3, choices: [{ courseName: '마태복음', preference: 5 }] },
  ];
  const created = await call(runtime.origin, '/api/v1/applications/batch', {
    method: 'POST', headers, body: JSON.stringify({ items: requests }),
  });
  assert.equal(created.status, 201);
  const before = runtime.store.read();
  let completeBytes;
  for (const [query, expectedMembers, expectedSemesters, expectedCourses] of [
    ['page=1&limit=1', ['나 회원', '가 회원', '다 회원'], [['2026 봄', 5], ['2026 가을', 2]], [
      ['2026 봄', '창세기', 10], ['2026 봄', '마태복음', 12], ['2026 가을', '창세기', 0], ['2026 가을', '마가복음', 8],
    ]],
    [`semesterId=${semesters[0].semester.id}&memberName=${encodeURIComponent('나 회원')}&sort=NAME_DESC`, ['나 회원'], [['2026 봄', 5]], [
      ['2026 봄', '창세기', 10], ['2026 봄', '마태복음', 12],
    ]],
    [`courseId=${semesters[0].semesterCourses[0].courseId}&sort=NAME_ASC`, ['가 회원', '나 회원'], [['2026 가을', 2], ['2026 봄', 5]], [
      ['2026 가을', '창세기', 0], ['2026 가을', '마가복음', 8], ['2026 봄', '창세기', 10], ['2026 봄', '마태복음', 12],
    ]],
    [`memberName=${encodeURIComponent('없는 회원')}`, [], [], []],
  ]) {
    const exported = await call(runtime.origin, `/api/v1/applications/export?${query}`, { headers });
    assert.equal(exported.status, 200);
    completeBytes ??= exported.bytes;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(exported.bytes);
    const values = (sheet) => workbook.getWorksheet(sheet).getSheetValues().slice(2).map((row) => row.slice(1));
    assert.deepEqual(values('수강신청').map((row) => row[1]), expectedMembers, query);
    assert.deepEqual(values('학기'), expectedSemesters, query);
    assert.deepEqual(values('개설강좌'), expectedCourses, query);
  }
  assert.deepEqual(runtime.store.read(), before);

  const restoredWorkspace = await localWorkspace(t);
  const restored = await startLocalServer({ dataDirectory: restoredWorkspace.data, staticDirectory: restoredWorkspace.static, port: 0 });
  t.after(() => restored.close());
  const restoredSession = JSON.parse((await call(restored.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: restored.origin },
  })).text);
  const restoredHeaders = { Origin: restored.origin, 'X-Glorycourse-Session': restoredSession.token };
  const upload = multipart({ kind: 'APPLICATIONS', mode: 'MERGE_KEEP_EXISTING' }, {
    name: 'file', filename: 'applications.xlsx', bytes: completeBytes,
  });
  const previewResponse = await call(restored.origin, '/api/v1/imports/preview', {
    method: 'POST', headers: { ...restoredHeaders, 'Content-Type': upload.contentType }, body: upload.body,
  });
  assert.equal(previewResponse.status, 200);
  const preview = JSON.parse(previewResponse.text);
  assert.deepEqual(preview.issues, []);
  const committed = await call(restored.origin, `/api/v1/imports/${preview.previewId}/commit`, {
    method: 'POST', headers: { ...restoredHeaders, 'Content-Type': 'application/json', 'Idempotency-Key': 'application-context-roundtrip' },
    body: JSON.stringify({ storeRevision: preview.storeRevision, storeEpoch: preview.storeEpoch, warningDigest: preview.warningDigest, resolutions: [] }),
  });
  assert.equal(committed.status, 200);
  assert.equal(JSON.parse(committed.text).inserted, 3);
  for (const semester of semesters.slice(0, 2)) {
    const restoredSemester = restored.store.read().semesters.find(({ name }) => name === semester.semester.name);
    assert.equal(restoredSemester.order, semester.order);
    const response = await call(restored.origin, `/api/v1/semesters/${restoredSemester.id}/context`, { headers: restoredHeaders });
    assert.deepEqual(JSON.parse(response.text).semesterCourses.map(({ courseName, capacity }) => ({ courseName, capacity })),
      semester.semesterCourses.map(({ courseName, capacity }) => ({ courseName, capacity })));
  }
});

test('sorts filtered enrollment history before pagination and exports the same order without modifying data', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const requests = [
    { semesterName: '가 학기', memberName: '나 회원', courseName: '마태복음' },
    { semesterName: '가 학기', memberName: '가 회원', courseName: '창세기' },
    { semesterName: '다 학기', memberName: '다 회원', courseName: '마태복음' },
    { semesterName: '다 학기', memberName: '가 회원', courseName: '출애굽기' },
    { semesterName: '나 학기', memberName: '라 회원', courseName: '요한복음' },
  ];
  const previewResponse = await call(runtime.origin, '/api/v1/enrollments/batch/preview', {
    method: 'POST', headers, body: JSON.stringify({ items: requests }),
  });
  assert.equal(previewResponse.status, 200);
  const preview = JSON.parse(previewResponse.text);
  const created = await call(runtime.origin, '/api/v1/enrollments/batch', {
    method: 'POST', headers, body: JSON.stringify({ preparedActionToken: preview.preparedActionToken,
      acknowledgedWarningDigest: preview.warningDigest }),
  });
  assert.equal(created.status, 201);
  await runtime.store.write({}, (data) => { data.semesters.find(({ name }) => name === '나 학기').order = null; });
  const before = runtime.store.read();
  const key = ({ semesterName, memberName, courseName }) => [semesterName, memberName, courseName];
  for (const [sort, expected] of [
    ['', [0, 1, 2, 3, 4]], ['NAME_ASC', [3, 1, 0, 2, 4]], ['NAME_DESC', [4, 2, 0, 3, 1]],
    ['COURSE_ASC', [2, 0, 4, 1, 3]], ['COURSE_DESC', [3, 1, 4, 2, 0]],
    ['SEMESTER_DESC', [3, 2, 1, 0, 4]], ['SEMESTER_ASC', [1, 0, 3, 2, 4]],
  ]) {
    for (const page of [1, 2, 3]) {
      const query = new URLSearchParams({ page: String(page), limit: '2', ...(sort ? { sort } : {}) });
      const response = await call(runtime.origin, `/api/v1/enrollments?${query}`, { headers });
      assert.equal(response.status, 200, query.toString());
      const result = JSON.parse(response.text);
      assert.equal(result.total, 5);
      assert.deepEqual(result.items.map(key), expected.slice((page - 1) * 2, page * 2).map((index) => key(requests[index])), query.toString());
    }
  }
  const filtered = await call(runtime.origin, '/api/v1/enrollments?sort=SEMESTER_DESC&memberName=' + encodeURIComponent('가 회원'), { headers });
  assert.deepEqual(JSON.parse(filtered.text).items.map(key), [requests[3], requests[1]].map(key));
  const exported = await call(runtime.origin, '/api/v1/enrollments/export?sort=NAME_ASC&memberName=' + encodeURIComponent('가 회원'), { headers });
  assert.equal(exported.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(exported.bytes);
  assert.deepEqual(workbook.getWorksheet('수강이력').getSheetValues().slice(2).map((row) => [row[1], row[2], row[4]]), [requests[3], requests[1]].map(key));
  for (const path of ['/enrollments', '/enrollments/export']) {
    const invalid = await call(runtime.origin, `/api/v1${path}?sort=UNKNOWN`, { headers });
    assert.equal(invalid.status, 400);
    assert.equal(JSON.parse(invalid.text).message, '수강이력 정렬 기준이 올바르지 않습니다.');
  }
  assert.deepEqual(runtime.store.read(), before);
});

test('registers multiple applications and reviewed enrollments atomically through the protected API', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const application = (memberName) => ({ semesterName: '2032 봄', memberName, applicationOrder: 1, choices: [{ courseName: '연기', preference: 1 }] });
  const post = (path, body) => call(runtime.origin, path, { method: 'POST', headers, body: JSON.stringify(body) });
  const created = await post('/api/v1/applications/batch', { items: [application('가'), application('나')] });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.text).items.length, 2);
  const filteredExport = await call(runtime.origin, '/api/v1/applications/export?memberName=%EA%B0%80', {
    headers: { 'X-Glorycourse-Session': session.token },
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(filteredExport.bytes);
  const worksheet = workbook.getWorksheet('수강신청');
  assert.equal(worksheet.actualRowCount, 2);
  assert.equal(worksheet.getCell('B2').value, '가');
  const before = runtime.store.read();
  const failed = await post('/api/v1/applications/batch', { items: [application('다'), application('가')] });
  assert.equal(failed.status, 409);
  assert.equal(JSON.parse(failed.text).issues[0].detail.rowNumber, 2);
  assert.deepEqual(runtime.store.read(), before);
  const invalid = await post('/api/v1/applications/batch', { items: [null] });
  assert.equal(invalid.status, 422);
  const preview = await post('/api/v1/enrollments/batch/preview', {
    items: ['가', '나'].map((memberName) => ({ semesterName: '2032 봄', memberName, courseName: '연기' })),
  });
  assert.equal(preview.status, 200);
  const review = JSON.parse(preview.text);
  assert.deepEqual(runtime.store.read(), before);
  const committed = await post('/api/v1/enrollments/batch', {
    preparedActionToken: review.preparedActionToken,
    acknowledgedWarningDigest: review.warningDigest,
    acknowledgementNote: '전체 행 경고 확인',
  });
  assert.equal(committed.status, 201);
  assert.equal(JSON.parse(committed.text).items.length, 2);
  assert.equal(runtime.store.read().enrollments.length, 2);
  const semesterId = runtime.store.read().semesters[0].id;
  const deletionPath = `/api/v1/semesters/${semesterId}/enrollments`;
  const deletionPreview = JSON.parse((await call(runtime.origin, deletionPath, { headers })).text);
  assert.equal(deletionPreview.count, 2);
  const deletionBody = JSON.stringify({
    confirmationName: deletionPreview.semesterName,
    expectedRevision: deletionPreview.storeRevision,
    expectedEpoch: deletionPreview.storeEpoch,
  });
  const denied = await call(runtime.origin, deletionPath, { method: 'DELETE', body: deletionBody });
  assert.equal(denied.status, 403);
  const deleted = await call(runtime.origin, deletionPath, { method: 'DELETE', headers, body: deletionBody });
  assert.equal(deleted.status, 200);
  assert.deepEqual(JSON.parse(deleted.text), { deletedCount: 2 });
  assert.equal(runtime.store.read().enrollments.length, 0);
  assert.equal(runtime.store.read().applications.length, 2);
});

test('exports distinct course capacities and enrollment notes within the selected report scope', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const inputs = ['홍길동', '김은혜', '박다라', '정원미정 회원'].map((memberName, index) => ({
    semesterName: '2028 가을', memberName, courseName: index < 2 ? '창세기' : index === 2 ? '마가복음' : '미정 강좌',
  }));
  const review = await call(runtime.origin, '/api/v1/enrollments/batch/preview', { method: 'POST', headers, body: JSON.stringify({ items: inputs }) });
  assert.equal(review.status, 200);
  const preview = JSON.parse(review.text);
  assert.equal((await call(runtime.origin, '/api/v1/enrollments/batch', { method: 'POST', headers, body: JSON.stringify({
    preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest,
  }) })).status, 201);
  const note = '자료 보관\n<img src=x onerror=alert(1)>';
  await runtime.store.write({}, (data) => {
    const capacities = { 창세기: 20, 마가복음: 0, '미정 강좌': null };
    for (const offering of data.semesterCourses) offering.capacity = capacities[data.courses.find(({ id }) => id === offering.courseId).name];
    data.enrollments[0].exceptionAcknowledgement = { note, warningDigest: 'recorded', acknowledgedAt: '2028-01-01T00:00:00.000Z' };
  });
  const download = async (query = '') => {
    const response = await call(runtime.origin, `/api/v1/enrollments/export${query}`, { headers });
    assert.equal(response.status, 200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.bytes);
    assert.equal(workbook.getWorksheet('메타').getCell('B1').text, '3');
    return workbook;
  };
  const all = await download();
  assert.deepEqual(all.getWorksheet('수강이력').getRow(1).values.slice(1), ['학기명', '회원명', '학생 소속', '강좌명', '관리자 메모']);
  assert.equal(all.getWorksheet('수강이력').getCell('E2').text, note);
  const courses = all.getWorksheet('개설강좌');
  assert.deepEqual([2, 3, 4].map((row) => courses.getRow(row).values.slice(1)), [
    ['2028 가을', '창세기', '20'], ['2028 가을', '마가복음', '0'], ['2028 가을', '미정 강좌', '미정'],
  ]);
  assert.equal(courses.rowCount, 4);
  const filtered = await download(`?memberName=${encodeURIComponent('홍길동')}`);
  assert.equal(filtered.getWorksheet('수강이력').rowCount, 2);
  assert.equal(filtered.getWorksheet('개설강좌').rowCount, 2);
  assert.equal(filtered.getWorksheet('개설강좌').getCell('C2').text, '20');
});

test('removes the manual backup and restore API without changing stored data', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token };
  const before = runtime.store.read();
  for (const [path, method] of [['/backups', 'GET'], ['/backups', 'POST'], ['/restores/preview', 'POST'], ['/restores', 'POST'], ['/backup-folder', 'GET']]) {
    assert.equal((await call(runtime.origin, `/api/v1${path}`, { method, headers })).status, 404, `${method} ${path}`);
  }
  assert.deepEqual(runtime.store.read(), before);
});

const testApi = async (request, { store }) => {
  if (request.method === 'GET' && request.path === '/api/v1/test/state') {
    return { status: 200, json: { members: store.read().members.map(({ name }) => name) } };
  }
  if (request.path === '/api/v1/test/write') {
    if (request.method !== 'POST') return { status: 405, json: error('METHOD_NOT_ALLOWED', 'Method not allowed') };
    const input = JSON.parse(request.body.toString('utf8'));
    await store.write({}, (data) => {
      data.members.push(named({ id: `member-${data.members.length + 1}`, name: input.name }));
    });
    return { status: 201, json: { created: input.name } };
  }
  if (request.method === 'POST' && request.path === '/api/v1/test/recovery') {
    throw new StoreRecoveryRequiredError();
  }
  return undefined;
};

test('previews semester application deletion and requires matching confirmation and current data before deleting', async (t) => {
  const workspace = await localWorkspace(t);
  const runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', { method: 'POST', headers: { Origin: runtime.origin } })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const create = async (semesterName, memberName, applicationOrder) => {
    const response = await call(runtime.origin, '/api/v1/applications', { method: 'POST', headers,
      body: JSON.stringify({ semesterName, memberName, applicationOrder, choices: [{ courseName: '기초', preference: 1 }] }) });
    assert.equal(response.status, 201);
    return JSON.parse(response.text);
  };
  const target = await create('삭제 학기', '회원1', 1);
  await create('삭제 학기', '회원2', 2);
  const retained = await create('다른 학기', '회원3', 1);
  const path = `/api/v1/semesters/${target.semesterId}/applications`;
  const previewResponse = await call(runtime.origin, `${path}?memberName=회원1&page=2&limit=1`, { headers });
  assert.equal(previewResponse.status, 200);
  const preview = JSON.parse(previewResponse.text);
  assert.deepEqual(preview, { semesterName: '삭제 학기', count: 2, ...runtime.store.version() });
  const deleteRequest = { confirmationName: preview.semesterName, expectedRevision: preview.storeRevision, expectedEpoch: preview.storeEpoch };
  await create('삭제 학기', '회원4', 3);
  let before = runtime.store.read();
  const stale = await call(runtime.origin, path, { method: 'DELETE', headers, body: JSON.stringify(deleteRequest) });
  assert.equal(stale.status, 409);
  assert.deepEqual(runtime.store.read(), before);
  const current = JSON.parse((await call(runtime.origin, path, { headers })).text);
  const currentRequest = { confirmationName: current.semesterName, expectedRevision: current.storeRevision, expectedEpoch: current.storeEpoch };
  for (const [body, expected] of [[null, 400], [{ ...currentRequest, confirmationName: '다른 학기' }, 422],
    [{ ...currentRequest, expectedEpoch: 'old-epoch' }, 409]]) {
    const response = await call(runtime.origin, path, { method: 'DELETE', headers, body: JSON.stringify(body) });
    assert.equal(response.status, expected);
    assert.deepEqual(runtime.store.read(), before);
  }
  assert.equal((await call(runtime.origin, path, { method: 'PUT', headers })).status, 405);
  assert.equal((await call(runtime.origin, '/api/v1/semesters/missing/applications', { headers })).status, 404);
  const deleted = await call(runtime.origin, path, { method: 'DELETE', headers, body: JSON.stringify(currentRequest) });
  assert.equal(deleted.status, 200);
  assert.deepEqual(JSON.parse(deleted.text), { deletedCount: 3 });
  assert.deepEqual(runtime.store.read().applications.map(({ id }) => id), [retained.id]);
  assert.deepEqual(runtime.store.read().applicationChoices.map(({ applicationId }) => applicationId), [retained.id]);
  before = runtime.store.read();
  const empty = JSON.parse((await call(runtime.origin, path, { headers })).text);
  assert.equal(empty.count, 0);
  assert.equal((await call(runtime.origin, path, { method: 'DELETE', headers, body: JSON.stringify({
    confirmationName: empty.semesterName, expectedRevision: empty.storeRevision, expectedEpoch: empty.storeEpoch,
  }) })).status, 422);
  assert.deepEqual(runtime.store.read(), before);
});

const localWorkspace = async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'glorycourse-http-'));
  const data = join(root, 'data');
  const staticDirectory = join(root, 'static');
  await mkdir(staticDirectory);
  await writeFile(join(staticDirectory, 'index.html'), '<!doctype html><h1>로컬 수강 관리</h1>');
  t.after(() => rm(root, { recursive: true, force: true }));
  return { data, static: staticDirectory };
};

const call = (origin, path, options = {}) => new Promise((resolve, reject) => {
  const url = new URL(path, origin);
  const body = options.body ? Buffer.from(options.body) : undefined;
  const request = httpRequest(url, {
    method: options.method ?? 'GET',
    headers: { ...(body ? { 'Content-Length': body.byteLength } : {}), ...options.headers },
  }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      const bytes = Buffer.concat(chunks);
      resolve({ status: response.statusCode, headers: response.headers, bytes, text: bytes.toString('utf8') });
    });
  });
  request.on('error', reject);
  if (body) request.write(body);
  request.end();
});

const multipart = (fields, file) => {
  const boundary = 'glorycourse-test-boundary';
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`));
  chunks.push(file.bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
};

const timestamp = '2026-09-23T00:00:00.000Z';
const named = (value) => ({
  ...value,
  nameKey: value.name,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const error = (code, message) => ({ code, message, issues: [] });
