import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ApplicationService } from '../../backend/src/services/applications.ts';
import { EnrollmentService } from '../../backend/src/services/enrollments.ts';
import { openStore } from '../../backend/src/storage/store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const application = (name) => ({ semesterName: '2032 봄', memberName: name, applicationOrder: 1, choices: [{ courseName: '연기', preference: 1 }] });
const enrollment = (name) => ({ semesterName: '2032 봄', memberName: name, courseName: '연기' });
const workspace = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-bulk-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, empty);
  const dependencies = { id: randomUUID, now: () => new Date('2026-09-23T00:00:00.000Z'), secret: 'x'.repeat(32) };
  return { file, store, applications: new ApplicationService(store, dependencies), enrollments: new EnrollmentService(store, dependencies) };
};

test('saves several applications in one SQLite commit and rolls back the whole batch on a duplicate', async (t) => {
  const { file, store, applications } = await workspace(t);
  const rows = await applications.createMany([application('가'), application('나')]);
  assert.equal(rows.length, 2);
  assert.equal(store.read().meta.storeRevision, 1);
  const before = store.read();
  await assert.rejects(applications.createMany([application('다'), application('가')]));
  assert.deepEqual(store.read(), before);
  assert.deepEqual((await openStore(file, empty)).read(), before);
  for (const request of [[], Array(101).fill(application('가')), [null], [application('라'), { ...application('마'), applicationOrder: 0 }]]) {
    await assert.rejects(applications.createMany(request));
    assert.deepEqual(store.read(), before);
  }
});

test('previews all enrollment warnings together and commits all acknowledged rows atomically', async (t) => {
  const { file, store, applications, enrollments } = await workspace(t);
  const first = await applications.create(application('가'));
  await applications.updateSemesterContext({ semesterId: first.semesterId, expectedRevision: 1, order: 1, semesterCourses: [{ courseName: '연기', capacity: 1 }] });
  const before = store.read();
  const preview = enrollments.previewMany([enrollment('가'), enrollment('나')]);
  assert.deepEqual(store.read(), before);
  assert.ok(preview.issues.some((issue) => issue.code === 'CAPACITY_EXCEEDED' && issue.detail.rowNumber === 2));
  const request = { preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest };
  await assert.rejects(enrollments.executeMany(request));
  await assert.rejects(enrollments.executeMany({ ...request, acknowledgementNote: 123 }), { name: 'EnrollmentAcknowledgementError' });
  assert.deepEqual(store.read(), before);
  const saved = await enrollments.executeMany({ ...request, acknowledgementNote: '2행 정원 초과 승인' });
  assert.equal(saved.length, 2);
  assert.equal(saved[1].exceptionAcknowledgement.note, '2행 정원 초과 승인');
  assert.equal((await openStore(file, empty)).read().enrollments.length, 2);
});

test('rejects duplicate enrollment rows and stale or cross-operation tokens without partial registration', async (t) => {
  const { store, applications, enrollments } = await workspace(t);
  for (const request of [[], Array(101).fill(enrollment('가')), [null], [enrollment('가'), { ...enrollment('나'), memberName: '' }]]) {
    assert.throws(() => enrollments.previewMany(request), { name: 'EnrollmentValidationError' });
    assert.deepEqual(store.read(), empty);
  }
  const duplicate = enrollments.previewMany([enrollment('가'), enrollment('가')]);
  assert.ok(duplicate.issues.some((issue) => issue.code === 'SAME_SEMESTER_ENROLLMENT' && issue.detail.rowNumber === 2));
  const execute = (preview) => enrollments.executeMany({ preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest, acknowledgementNote: '확인' });
  await assert.rejects(execute(duplicate));
  assert.deepEqual(store.read(), empty);
  const preview = enrollments.previewMany([enrollment('가'), enrollment('나')]);
  await assert.rejects(enrollments.execute({ preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest, acknowledgementNote: '확인', expectedAction: 'CREATE' }));
  const single = enrollments.preview({ action: 'CREATE', ...enrollment('다') });
  await assert.rejects(execute(single));
  await applications.create(application('라'));
  const before = store.read();
  await assert.rejects(execute(preview));
  assert.deepEqual(store.read(), before);
});

test('requires retake acknowledgement even when the earlier semester appears last in the batch', async (t) => {
  const { store, applications, enrollments } = await workspace(t);
  for (const [semesterName, order] of [['이전 학기', 1], ['다음 학기', 2]]) {
    const created = await applications.create({ ...application('가'), semesterName });
    await applications.updateSemesterContext({ semesterId: created.semesterId, expectedRevision: 1, order, semesterCourses: [{ courseName: '연기', capacity: 10 }] });
  }
  const before = store.read();
  const preview = enrollments.previewMany(['다음 학기', '이전 학기'].map((semesterName) => ({ ...enrollment('가'), semesterName })));
  assert.ok(preview.issues.some((issue) => issue.code === 'RETAKE' && issue.detail.rowNumber === 1));
  const request = { preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest };
  await assert.rejects(enrollments.executeMany(request));
  assert.deepEqual(store.read(), before);
  const saved = await enrollments.executeMany({ ...request, acknowledgementNote: '학기 간 재수강 확인' });
  assert.equal(saved[0].exceptionAcknowledgement.note, '학기 간 재수강 확인');
  assert.equal(saved[1].exceptionAcknowledgement, null);
});
