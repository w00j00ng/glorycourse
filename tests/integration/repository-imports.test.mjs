import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';
import { seedRepository } from '../helpers/repository.mjs';

import { createImportTemplate } from '../../backend/src/excel/workbooks.ts';
import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import { EnrollmentService } from '../../backend/src/services/enrollments.ts';
import {
  ImportAcknowledgementError,
  ImportCommitService,
  ImportIdempotencyConflictError,
  ImportPreviewStaleError,
} from '../../backend/src/services/import-commit.ts';
import { ImportPreviewService } from '../../backend/src/services/import-preview.ts';

const empty = () => ({
  meta: { storeEpoch: 'import-repository', storeRevision: 0 },
  semesters: [], members: [], courses: [], semesterCourses: [], applications: [],
  applicationChoices: [], enrollments: [], allocationDrafts: [], allocationDraftItems: [],
  importBatches: [], finalizationReceipts: [], restoreReceipts: [],
});

const open = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-repository-imports-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const repository = await openRepository(file, empty());
  t.after(() => repository.close());
  let sequence = 0;
  const dependencies = { id: () => `import-domain-${++sequence}`, now: () => new Date('2026-10-21T00:00:00.000Z') };
  const previews = new ImportPreviewService(repository, dependencies);
  const commits = new ImportCommitService(repository, previews, dependencies);
  return { repository, file, dependencies, previews, commits };
};

const workbook = async (kind, rows, semesterName = '2026 가을', order = 2) => {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await createImportTemplate(kind, {
    semesterName, semesterOrder: order, courses: [{ courseName: '기초', capacity: 10 }],
  }));
  book.getWorksheet(kind === 'APPLICATIONS' ? '수강신청' : '수강이력').addRows(kind === 'APPLICATIONS'
    ? rows.map(([semester, member, ministry, applicationOrder, ...choices]) => (
      [semester, member, ministry, applicationOrder, null, ...choices]
    )) : rows);
  return Buffer.from(await book.xlsx.writeBuffer());
};

const request = (preview, resolutions = []) => ({
  previewId: preview.previewId, idempotencyKey: 'import-request', storeRevision: preview.storeRevision,
  storeEpoch: preview.storeEpoch, warningDigest: preview.warningDigest, resolutions,
});

test('SQL application import shows earlier-course warnings by source rank without requiring acknowledgement', async (t) => {
  const { repository, dependencies, previews, commits } = await open(t);
  const applications = new ApplicationService(repository, dependencies);
  await applications.createSemester({ name: '2025 봄', order: 1 });
  const enrollments = new EnrollmentService(repository, { ...dependencies,
    secret: 'application-import-retake-secret-at-least-32-bytes' });
  const history = enrollments.preview({ action: 'CREATE', semesterName: '2025 봄', memberName: '홍길동', courseName: '기초' });
  await enrollments.execute({ preparedActionToken: history.preparedActionToken,
    acknowledgedWarningDigest: history.warningDigest });
  const bytes = await workbook('APPLICATIONS', [['2026 가을', '홍길동', '청년', 1, '기초', '기초']]);
  const before = repository.snapshot();
  const preview = await previews.preview({ filename: '재수강.xlsx', kind: 'APPLICATIONS', bytes });
  const warnings = preview.issues.filter(({ code }) => code === 'RETAKE');
  assert.deepEqual(warnings.map(({ severity, blockingStages, acknowledgementStages, source }) => ({
    severity, blockingStages, acknowledgementStages, source,
  })), [1, 2].map((rank) => ({ severity: 'WARNING', blockingStages: [], acknowledgementStages: [],
    source: { sheet: '수강신청', row: 2, column: `${rank}순위 강좌` } })));
  assert.deepEqual(repository.snapshot(), before);
  const staged = await previews.stage(preview.previewId);
  const refreshed = previews.repreviewStaged(staged.id);
  assert.deepEqual(refreshed.issues.filter(({ code }) => code === 'RETAKE'), warnings);
  const receipt = await commits.commit(request(refreshed));
  assert.equal(receipt.inserted, 1);
  const choices = repository.snapshot().applicationChoices;
  assert.deepEqual(choices.map(({ preference, sourceRefs }) => ({ preference, sourceRefs })), [1, 2].map((preference) => ({
    preference, sourceRefs: [{ importBatchId: staged.id, sheet: '수강신청', row: 2 }],
  })));
});

test('application import previews retake warnings for a proposed semester order as well as the current order', async (t) => {
  const { repository, dependencies, previews } = await open(t);
  const applications = new ApplicationService(repository, dependencies);
  await applications.createSemester({ name: '2025 봄', order: 2 });
  await applications.createSemester({ name: '2026 가을', order: 1 });
  const enrollments = new EnrollmentService(repository, { ...dependencies,
    secret: 'application-order-retake-secret-at-least-32-bytes' });
  const history = enrollments.preview({ action: 'CREATE', semesterName: '2025 봄', memberName: '홍길동', courseName: '기초' });
  await enrollments.execute({ preparedActionToken: history.preparedActionToken,
    acknowledgedWarningDigest: history.warningDigest });
  const cases = [{ order: 1, expected: false }, { order: 3, expected: true }];
  const before = repository.snapshot();
  for (const { order, expected } of cases) {
    const preview = await previews.preview({ filename: '학기 순서.xlsx', kind: 'APPLICATIONS',
      bytes: await workbook('APPLICATIONS', [['2026 가을', '홍길동', null, 1, '기초']], '2026 가을', order) });
    assert.equal(preview.issues.some(({ code }) => code === 'RETAKE'), expected);
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('application import warns for history order changes and combined semester decisions before commit', async (t) => {
  const cases = [
    { target: 2, history: 3, fileTarget: 2, fileHistory: 1, expected: true },
    { target: 2, history: 1, fileTarget: 2, fileHistory: 3, expected: true },
    { target: 2, history: 3, fileTarget: 2, fileHistory: 4, expected: false },
    { target: 2, history: 4, fileTarget: 2, fileHistory: 3, expected: false },
    { target: 1, history: 3, fileTarget: 2, fileHistory: 1, expected: true },
    { target: 4, history: 3, fileTarget: 2, fileHistory: 5, expected: true },
    { target: 1, history: 3, fileTarget: 2, fileHistory: 4, expected: false },
  ];
  for (const input of cases) {
    const { repository, dependencies, previews, commits } = await open(t);
    const applications = new ApplicationService(repository, dependencies);
    await applications.createSemester({ name: '이력 학기', order: input.history });
    await applications.createSemester({ name: '신청 학기', order: input.target });
    const enrollments = new EnrollmentService(repository, { ...dependencies,
      secret: 'history-order-preview-secret-at-least-32-bytes' });
    const history = enrollments.preview({ action: 'CREATE', semesterName: '이력 학기', memberName: '홍길동', courseName: '기초' });
    await enrollments.execute({ preparedActionToken: history.preparedActionToken,
      acknowledgedWarningDigest: history.warningDigest });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await workbook('APPLICATIONS', [['신청 학기', '홍길동', null, 1, '기초']],
      '신청 학기', input.fileTarget));
    book.getWorksheet('학기').addRow(['이력 학기', input.fileHistory]);
    const before = repository.snapshot();
    const preview = await previews.preview({ filename: '학기 순서 변경.xlsx', kind: 'APPLICATIONS',
      bytes: Buffer.from(await book.xlsx.writeBuffer()) });
    const warnings = preview.issues.filter(({ code }) => code === 'RETAKE');
    assert.equal(warnings.length > 0, input.expected, JSON.stringify(input));
    for (const warning of warnings) {
      assert.deepEqual({ severity: warning.severity, blockingStages: warning.blockingStages,
        acknowledgementStages: warning.acknowledgementStages, source: warning.source }, {
        severity: 'WARNING', blockingStages: [], acknowledgementStages: [],
        source: { sheet: '수강신청', row: 2, column: '1순위 강좌' },
      });
    }
    assert.deepEqual(repository.snapshot(), before);
    if (input === cases[0]) {
      const receipt = await commits.commit(request(preview, [{ entity: 'SEMESTER', field: 'order',
        semesterName: '이력 학기', action: 'APPLY_FILE_VALUE' }]));
      assert.equal(receipt.inserted, 1);
      assert.equal(repository.snapshot().semesters.find(({ name }) => name === '이력 학기').order, 1);
    }
  }
});

test('application import excludes same-semester enrollments from retake history when semester order is unresolved', async (t) => {
  const { repository, dependencies, previews } = await open(t);
  await new ApplicationService(repository, dependencies).createSemester({ name: '현재 학기', order: null });
  const enrollments = new EnrollmentService(repository, { ...dependencies,
    secret: 'same-semester-history-secret-at-least-32-bytes' });
  const enrollment = enrollments.preview({ action: 'CREATE', semesterName: '현재 학기', memberName: '홍길동', courseName: '기초' });
  await enrollments.execute({ preparedActionToken: enrollment.preparedActionToken,
    acknowledgedWarningDigest: enrollment.warningDigest });
  await seedRepository(repository, (data) => { data.semesters[0].order = null; });
  const before = repository.snapshot();
  const preview = await previews.preview({ filename: '같은 학기.xlsx', kind: 'APPLICATIONS',
    bytes: await workbook('APPLICATIONS', [['현재 학기', '홍길동', null, 1, '기초']], '현재 학기', null) });
  assert.deepEqual(preview.issues.filter(({ code }) => ['RETAKE', 'SEMESTER_ORDER_UNRESOLVED'].includes(code)), []);
  assert.deepEqual(repository.snapshot(), before);
});

test('SQL import staging and commit preserve original cells, choice sources and replay receipts after restart', async (t) => {
  const { repository, file, dependencies, previews, commits } = await open(t);
  const bytes = await workbook('APPLICATIONS', [['2026 가을', '홍길동', '청년', 1, '기초']]);
  const originalPreview = await previews.preview({ filename: 'applications.xlsx', kind: 'APPLICATIONS', bytes });
  const staged = await previews.stage(originalPreview.previewId);
  assert.deepEqual(previews.getStaged(staged.id).rawRows, originalPreview.rawRows);
  const exported = new ExcelJS.Workbook();
  await exported.xlsx.load(await previews.exportStagedOriginal(staged.id));
  assert.equal(exported.getWorksheet('수강신청').getCell('B2').text, '홍길동');

  const preview = previews.repreviewStaged(staged.id);
  const receipt = await commits.commit(request(preview));
  assert.equal(receipt.inserted, 1);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(staged.id).status, 'APPLIED');
    assert.equal(db.prepare('SELECT import_batch_id AS id FROM application_choice_source_refs').get().id, staged.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM applications').get().count, 1);
  } finally { db.close(); }

  const reloaded = new ImportCommitService(repository, new ImportPreviewService(repository, dependencies), dependencies);
  assert.deepEqual(await reloaded.commit(request(preview)), receipt);
  await assert.rejects(reloaded.commit({ ...request(preview), resolutions: [{ entity: 'APPLICATION',
    action: 'KEEP_EXISTING', semesterName: '2026 가을', memberName: '홍길동' }] }), ImportIdempotencyConflictError);
  assert.equal(repository.read((queries) => queries.importBatches.getBatch({ id: staged.id })).receipt.receiptId, receipt.receiptId);
});

test('SQL enrollment imports roll back unacknowledged retakes and preserve row acknowledgements when accepted', async (t) => {
  const { repository, dependencies, previews, commits } = await open(t);
  const enrollments = new EnrollmentService(repository, { ...dependencies, secret: 'import-test-enrollment-secret-at-least-32-bytes' });
  const initial = enrollments.preview({ action: 'CREATE', semesterName: '2025 봄', memberName: '홍길동', courseName: '기초' });
  await enrollments.execute({ preparedActionToken: initial.preparedActionToken, acknowledgedWarningDigest: initial.warningDigest });
  const preview = await previews.preview({ filename: 'enrollments.xlsx', kind: 'ENROLLMENTS',
    bytes: await workbook('ENROLLMENTS', [['2026 가을', '홍길동', '장년', '기초', '']]) });
  assert.ok(preview.issues.some(({ code, severity }) => code === 'RETAKE' && severity === 'WARNING'));
  const before = repository.snapshot();
  await assert.rejects(commits.commit(request(preview)), ImportAcknowledgementError);
  assert.deepEqual(repository.snapshot(), before);

  const receipt = await commits.commit(request(preview, [{ entity: 'ENROLLMENT', action: 'ACKNOWLEDGE_WARNING',
    semesterName: '2026 가을', memberName: '홍길동', courseName: '기초',
    warningDigest: preview.warningDigest, acknowledgementNote: '재수강 확인' }]));
  assert.equal(receipt.inserted, 1);
  const saved = enrollments.list({ sort: 'SEMESTER_DESC' })[0];
  assert.equal(saved.ministry, '장년');
  assert.equal(saved.exceptionAcknowledgement.note, '재수강 확인');
});

test('SQL import commit rejects a preview after another connection changes the data', async (t) => {
  const { repository, file, dependencies, previews, commits } = await open(t);
  const preview = await previews.preview({ filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await workbook('APPLICATIONS', [['2026 가을', '가져올 회원', null, 1, '기초']]) });
  const external = await openRepository(file, empty());
  t.after(() => external.close());
  await new ApplicationService(external, dependencies).create({
    semesterName: '2026 가을', memberName: '외부 회원', applicationOrder: 1,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  const before = repository.snapshot();
  await assert.rejects(commits.commit(request(preview)), ImportPreviewStaleError);
  assert.deepEqual(repository.snapshot(), before);
});

test('SQL import rolls back its batch and catalog when a later choice insert fails and can retry', async (t) => {
  const { repository, file, previews, commits } = await open(t);
  const preview = await previews.preview({ filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await workbook('APPLICATIONS', [['2026 가을', '홍길동', '청년', 1, '기초']]) });
  const before = repository.snapshot();
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TRIGGER reject_import_choice BEFORE INSERT ON application_choices
      BEGIN SELECT RAISE(ABORT, 'simulated choice insert failure'); END`);
    await assert.rejects(commits.commit(request(preview)), /simulated choice insert failure/);
    assert.deepEqual(repository.snapshot(), before);
    db.exec('DROP TRIGGER reject_import_choice');
  } finally { db.close(); }
  const receipt = await commits.commit(request(preview));
  assert.equal(receipt.inserted, 1);
  assert.equal(repository.snapshot().applicationChoices.length, 1);
  assert.deepEqual(await commits.commit(request(preview)), receipt);
});
