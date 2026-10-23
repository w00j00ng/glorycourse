import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import {
  EnrollmentAcknowledgementError,
  EnrollmentConflictError,
  EnrollmentService,
  EnrollmentStaleError,
} from '../../backend/src/services/enrollments.ts';

const empty = () => ({
  meta: { storeEpoch: 'enrollment-repository', storeRevision: 0 },
  semesters: [], members: [], courses: [], semesterCourses: [], applications: [],
  applicationChoices: [], enrollments: [], allocationDrafts: [], allocationDraftItems: [],
  importBatches: [], finalizationReceipts: [], restoreReceipts: [],
});

const open = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-repository-enrollments-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const repository = await openRepository(file, empty());
  t.after(() => repository.close());
  let sequence = 0;
  const service = new EnrollmentService(repository, {
    id: () => `enrollment-domain-${++sequence}`,
    now: () => new Date('2026-10-21T00:00:00.000Z'),
    secret: 'repository-enrollment-secret-at-least-32-bytes',
  });
  return { file, repository, service };
};

const create = (service, input) => {
  const preview = service.preview({ action: 'CREATE', ...input });
  return service.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
  });
};

test('SQL enrollment reads preserve literal, case-sensitive name filters and Korean ordering', async (t) => {
  const { service, repository } = await open(t);
  const requests = ['홍길동', '김은혜', 'A%_회원', 'a%_회원'].map((memberName) => ({
    semesterName: '2026 가을', courseName: '기초', memberName,
  }));
  for (const request of requests) await create(service, request);

  for (const { filters, expected } of [
    { filters: { memberName: '%' }, expected: ['A%_회원', 'a%_회원'] },
    { filters: { memberName: 'A%' }, expected: ['A%_회원'] },
    { filters: { memberName: '없는 회원' }, expected: [] },
    { filters: { sort: 'NAME_ASC' }, expected: requests.map(({ memberName }) => memberName).sort((a, b) => a.localeCompare(b, 'ko')) },
  ]) {
    assert.deepEqual(service.list(filters).map(({ memberName }) => memberName), expected);
  }
  const context = repository.read((queries) => queries.enrollments.getContext());
  assert.equal(context.semesterCourses[0].capacity, 1);
  assert.equal(context.enrollments.length, requests.length);
  const expectedNames = requests.map(({ memberName }) => memberName).sort((a, b) => a.localeCompare(b, 'ko'));
  for (const { filters, expectedNames: names, total } of [
    { filters: { sort: 'NAME_ASC', page: 2, limit: 2 }, expectedNames: expectedNames.slice(2), total: 4 },
    { filters: { memberName: '%', sort: 'NAME_ASC', page: 2, limit: 1 },
      expectedNames: ['A%_회원', 'a%_회원'].sort((a, b) => a.localeCompare(b, 'ko')).slice(1), total: 2 },
    { filters: { memberName: '%', page: 3, limit: 1 }, expectedNames: [], total: 2 },
  ]) {
    const page = service.listPage(filters);
    assert.deepEqual(page.items.map(({ memberName }) => memberName), names);
    assert.deepEqual({ page: page.page, limit: page.limit, total: page.total }, {
      page: filters.page, limit: filters.limit, total,
    });
  }
});

test('SQL enrollment writes keep warnings, catalog creation and acknowledgements in one transaction', async (t) => {
  const { service, repository, file } = await open(t);
  const requests = [
    { semesterName: '2025 봄', memberName: '홍길동', courseName: '기초', ministry: '청년' },
    { semesterName: '2026 봄', memberName: '홍길동', courseName: '기초', ministry: '장년' },
  ];
  let semesterSequence = 0;
  const catalog = new ApplicationService(repository, {
    id: () => `semester-${++semesterSequence}`, now: () => new Date('2026-10-21T00:00:00.000Z'),
  });
  for (const [index, { semesterName }] of requests.entries()) {
    await catalog.createSemester({ name: semesterName, order: index + 1 });
  }
  await create(service, requests[0]);
  const preview = service.preview({ action: 'CREATE', ...requests[1] });
  assert.ok(preview.issues.some(({ code }) => code === 'RETAKE'));
  const before = repository.snapshot();
  await assert.rejects(service.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: 'wrong-digest',
  }), EnrollmentAcknowledgementError);
  assert.deepEqual(repository.snapshot(), before);

  const saved = await service.execute({
    preparedActionToken: preview.preparedActionToken,
    acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '재수강 승인',
  });
  assert.equal(saved.exceptionAcknowledgement.note, '재수강 승인');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM enrollments').get().count, 2);
    assert.equal(db.prepare('SELECT note FROM enrollment_acknowledgements WHERE enrollment_id = ?').get(saved.id).note, '재수강 승인');
  } finally { db.close(); }

  const duplicate = service.preview({ action: 'CREATE', ...requests[1], courseName: '다른 강좌' });
  await assert.rejects(service.execute({
    preparedActionToken: duplicate.preparedActionToken,
    acknowledgedWarningDigest: duplicate.warningDigest,
  }), EnrollmentConflictError);
  assert.equal(repository.snapshot().courses.length, 1);
});

test('SQL enrollment previews reject another connection’s changes and bulk deletion preserves other semesters', async (t) => {
  const { service, repository, file } = await open(t);
  const first = await create(service, { semesterName: '2025 봄', memberName: '홍길동', courseName: '기초' });
  await create(service, { semesterName: '2026 봄', memberName: '김은혜', courseName: '심화' });
  const prepared = service.preview({ action: 'UPDATE', enrollmentId: first.id, expectedRevision: first.revision,
    semesterName: first.semesterName, memberName: first.memberName, courseName: first.courseName });
  const external = await openRepository(file, empty());
  t.after(() => external.close());
  await external.write({}, (queries) => {
    const record = queries.enrollments.get({ id: first.id });
    queries.enrollments.update({ record: { ...record, ministry: '외부 변경', revision: record.revision + 1 } });
  });
  assert.equal(service.get(first.id).ministry, '외부 변경');
  await assert.rejects(service.execute({ preparedActionToken: prepared.preparedActionToken,
    acknowledgedWarningDigest: prepared.warningDigest }), EnrollmentStaleError);

  const semesterId = repository.read((queries) => queries.enrollments.getContext())
    .semesters.find(({ name }) => name === '2025 봄').id;
  const deletion = service.previewSemesterDeletion(semesterId);
  assert.equal(deletion.count, 1);
  assert.deepEqual(await service.deleteSemester(semesterId, { confirmationName: deletion.semesterName,
    expectedRevision: deletion.storeRevision, expectedEpoch: deletion.storeEpoch }), { deletedCount: 1 });
  assert.deepEqual(service.list().map(({ memberName }) => memberName), ['김은혜']);
});
