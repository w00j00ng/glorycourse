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

test('creates, reviews, restores, and replays a local backup through the protected API', async (t) => {
  const workspace = await localWorkspace(t);
  let runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  t.after(() => runtime.close());
  const session = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const headers = { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/json' };
  const createApplication = (memberName) => call(runtime.origin, '/api/v1/applications', {
    method: 'POST', headers, body: JSON.stringify({
      semesterName: '2033 봄', memberName, applicationOrder: 1,
      choices: [{ courseName: '연기', preference: 1 }],
    }),
  });
  assert.equal((await createApplication('복원 회원')).status, 201);

  const backups = await Promise.all([
    call(runtime.origin, '/api/v1/backups', { method: 'POST', headers }),
    call(runtime.origin, '/api/v1/backups', { method: 'POST', headers }),
  ]);
  assert.deepEqual(backups.map(({ status }) => status), [201, 201]);
  const createdBackup = JSON.parse(backups[0].text);
  assert.deepEqual(JSON.parse(backups[1].text), createdBackup);
  assert.equal(createdBackup.storeRevision, 1);
  assert.equal(createdBackup.file, undefined);
  assert.equal((await readdir(join(workspace.data, 'backups'))).length, 1);
  const listed = JSON.parse((await call(runtime.origin, '/api/v1/backups', {
    headers: { 'X-Glorycourse-Session': session.token },
  })).text);
  assert.equal(listed.items.length, 1);
  assert.deepEqual(listed.items[0], createdBackup);

  assert.equal((await createApplication('삭제될 회원')).status, 201);
  const [backupFilename] = await readdir(join(workspace.data, 'backups'));
  const restoreBytes = await readFile(join(workspace.data, 'backups', backupFilename));
  const previewResponse = await call(runtime.origin, '/api/v1/restores/preview', {
    method: 'POST',
    headers: { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/vnd.sqlite3' },
    body: restoreBytes,
  });
  assert.equal(previewResponse.status, 200);
  const preview = JSON.parse(previewResponse.text);
  assert.equal(preview.backupStoreRevision, 1);
  assert.equal(preview.issues[0].severity, 'WARNING');
  assert.deepEqual(await readdir(join(workspace.data, 'recovery-work')), []);

  const restoreRequest = {
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '복원 이후 변경 내용이 사라짐을 확인함',
  };
  const unacknowledged = await call(runtime.origin, '/api/v1/restores', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'restore-request-unacknowledged' },
    body: JSON.stringify({ ...restoreRequest, acknowledgedWarningDigest: 'wrong' }),
  });
  assert.equal(unacknowledged.status, 422);
  assert.equal(runtime.store.read().members.length, 2);
  assert.equal((await createApplication('검토 이후 회원')).status, 201);
  const stale = await call(runtime.origin, '/api/v1/restores', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'restore-request-stale' }, body: JSON.stringify(restoreRequest),
  });
  assert.equal(stale.status, 409);
  assert.equal(JSON.parse(stale.text).code, 'PREVIEW_STALE');
  assert.equal(runtime.store.read().members.length, 3);
  const refreshed = JSON.parse((await call(runtime.origin, '/api/v1/restores/preview', {
    method: 'POST',
    headers: { Origin: runtime.origin, 'X-Glorycourse-Session': session.token, 'Content-Type': 'application/vnd.sqlite3' },
    body: restoreBytes,
  })).text);
  restoreRequest.preparedActionToken = refreshed.preparedActionToken;
  restoreRequest.acknowledgedWarningDigest = refreshed.warningDigest;
  const restored = await call(runtime.origin, '/api/v1/restores', {
    method: 'POST', headers: { ...headers, 'Idempotency-Key': 'restore-request-1' }, body: JSON.stringify(restoreRequest),
  });
  assert.equal(restored.status, 200);
  const receipt = JSON.parse(restored.text);
  assert.equal(receipt.storeRevision, 1);
  assert.notEqual(receipt.storeEpoch, preview.backupStoreEpoch);
  const replay = await call(runtime.origin, '/api/v1/restores', {
    method: 'POST',
    headers: { ...headers, 'Idempotency-Key': 'restore-request-1' },
    body: JSON.stringify({
      acknowledgementNote: restoreRequest.acknowledgementNote,
      acknowledgedWarningDigest: restoreRequest.acknowledgedWarningDigest,
      preparedActionToken: restoreRequest.preparedActionToken,
    }),
  });
  assert.deepEqual(JSON.parse(replay.text), receipt);
  assert.deepEqual(runtime.store.read().members.map(({ name }) => name), ['복원 회원']);

  await runtime.close();
  runtime = await startLocalServer({ dataDirectory: workspace.data, staticDirectory: workspace.static, port: 0 });
  const restartedSession = JSON.parse((await call(runtime.origin, '/api/v1/session', {
    method: 'POST', headers: { Origin: runtime.origin },
  })).text);
  const applications = JSON.parse((await call(runtime.origin, '/api/v1/applications', {
    headers: { 'X-Glorycourse-Session': restartedSession.token },
  })).text);
  assert.deepEqual(applications.items.map(({ memberName }) => memberName), ['복원 회원']);
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
