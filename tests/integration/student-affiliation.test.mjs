import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from '@excel.js/exceljs';

import { createImportTemplate, exportApplicationRows, exportRawRows } from '../../backend/src/excel/workbooks.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';
import { EnrollmentService } from '../../backend/src/services/enrollments.ts';
import { FinalizationService } from '../../backend/src/services/finalization.ts';
import { ImportPreviewService } from '../../backend/src/services/import-preview.ts';
import { ImportCommitService } from '../../backend/src/services/import-commit.ts';
import { openStore } from '../../backend/src/storage/store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const policy = { policyId: 'policy', policyVersion: '1', policySettings: {
  preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED',
} };
const setup = async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-affiliation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'db.sqlite');
  const store = await openStore(file, empty);
  let sequence = 0;
  const dependencies = { id: () => `affiliation-${++sequence}`, now: () => new Date('2026-10-04T00:00:00Z'), seed: () => 'seed', secret: '0123456789abcdef0123456789abcdef' };
  return { file, store, dependencies, applications: new ApplicationService(store, dependencies),
    drafts: new DraftService(store, dependencies), enrollments: new EnrollmentService(store, dependencies),
    finalization: new FinalizationService(store, dependencies), previews: new ImportPreviewService(store, dependencies) };
};
const application = (semesterName, affiliation) => ({
  semesterName, memberName: '홍길동', affiliation, applicationOrder: 1,
  choices: [{ courseName: '기초', preference: 1 }],
});

test('downloaded templates include student affiliation and four default application preferences', async () => {
  const cases = [
    { kind: 'APPLICATIONS', sheet: '수강신청', expected: ['학기명', '회원명', '학생 소속', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌', '4순위 강좌'] },
    { kind: 'ENROLLMENTS', sheet: '수강이력', expected: ['학기명', '회원명', '학생 소속', '강좌명', '관리자 메모'] },
  ];
  for (const { kind, sheet, expected } of cases) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await createImportTemplate(kind));
    assert.deepEqual(workbook.getWorksheet(sheet).getRow(1).values.slice(1), expected);
  }
});

test('a generated draft keeps its affiliation and transfers its edited value to history after restart', async (t) => {
  const context = await setup(t);
  const { applications, drafts, store, finalization } = context;
  const request = application('2026 봄', '  청년부  ');
  const saved = await applications.create(request);
  assert.equal(saved.affiliation, '청년부');
  await applications.updateSemesterContext({ semesterId: saved.semesterId, expectedRevision: 1, order: 1,
    semesterCourses: [{ id: saved.choices[0].semesterCourseId, courseName: '기초', capacity: 2 }] });
  const draft = await drafts.create({ semesterId: saved.semesterId, mode: 'AUTO', ...policy });
  assert.equal(draft.studentResults[0].affiliation, '청년부');
  assert.equal(draft.applicationSnapshot.applications[0].affiliation, '청년부');
  await applications.update(saved.id, { ...request, affiliation: '장년부', expectedRevision: saved.revision });
  const stale = drafts.get(draft.draft.id);
  assert.equal(stale.isStale, true);
  assert.equal(stale.studentResults[0].affiliation, '청년부');
  const edited = await drafts.updateItem(draft.draft.id, saved.memberId, {
    expectedDraftRevision: 0, affiliation: '  대학부 ', finalDecision: 'SELECTED',
    finalSemesterCourseId: saved.choices[0].semesterCourseId, finalReasonCode: null, finalReasonDetail: null,
  });
  assert.equal(edited.studentResults[0].affiliation, '대학부');
  const preview = finalization.preview(draft.draft.id, { expectedDraftRevision: edited.draft.revision });
  assert.equal(preview.enrollments[0].affiliation, '대학부');
  await finalization.finalize(draft.draft.id, { expectedDraftRevision: edited.draft.revision,
    preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest,
    acknowledgementNote: '', idempotencyKey: 'finalize-affiliation' });
  const next = await applications.create(application('2026 가을', '새 소속'));
  assert.equal(next.memberId, saved.memberId);
  assert.equal(store.read().members.some((member) => 'affiliation' in member), false);
  const reopened = await openStore(context.file, empty);
  assert.equal(new EnrollmentService(reopened, context.dependencies).list()[0].affiliation, '대학부');
  assert.deepEqual(new ApplicationService(reopened, context.dependencies).list().map(({ affiliation }) => affiliation).sort(), ['새 소속', '장년부'].sort());
});

test('manual enrollment inputs normalize affiliations and preserve each semester value', async (t) => {
  const { enrollments } = await setup(t);
  const requests = [
    { semesterName: '2025 봄', memberName: '홍길동', courseName: '기초', affiliation: '  청년부 ', expected: '청년부' },
    { semesterName: '2025 가을', memberName: '홍길동', courseName: '심화', affiliation: '장년부', expected: '장년부' },
    { semesterName: '2026 봄', memberName: '김영희', courseName: '기초', affiliation: ' ', expected: null },
  ];
  const preview = enrollments.previewMany(requests.map(({ expected, ...input }) => input));
  const result = await enrollments.executeMany({ preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest });
  assert.deepEqual(result.map(({ affiliation }) => affiliation), requests.map(({ expected }) => expected));
  const changed = enrollments.preview({ action: 'UPDATE', enrollmentId: result[0].id, expectedRevision: 0,
    ...requests[0], affiliation: '대학부' });
  await enrollments.execute({ preparedActionToken: changed.preparedActionToken, acknowledgedWarningDigest: changed.warningDigest });
  assert.equal(enrollments.get(result[0].id).affiliation, '대학부');
  assert.equal(enrollments.get(result[1].id).affiliation, '장년부');
});

test('manual draft registration accepts affiliation without adding it to the member master', async (t) => {
  const { applications, drafts, finalization } = await setup(t);
  const { semester } = await applications.createSemester({ name: '2026 봄', order: 1 });
  const catalog = await applications.updateSemesterContext({ semesterId: semester.id, expectedRevision: 0, order: 1,
    semesterCourses: [{ courseName: '기초', capacity: 2 }] });
  const draft = await drafts.create({ semesterId: semester.id, mode: 'MANUAL', ...policy });
  const added = await drafts.addManualItem(draft.draft.id, { expectedDraftRevision: 0,
    memberName: '새 회원', affiliation: '청년부', semesterCourseId: catalog.semesterCourses[0].id });
  assert.equal(added.studentResults[0].affiliation, '청년부');
  const preview = finalization.preview(draft.draft.id, { expectedDraftRevision: 1 });
  assert.equal(preview.enrollments[0].affiliation, '청년부');
});

test('updates preserve omitted affiliations and clear only explicit null or blank input', async (t) => {
  const { applications, enrollments } = await setup(t);
  const request = application('2026 봄', '청년부');
  let savedApplication = await applications.create(request);
  const historyRequest = { action: 'CREATE', semesterName: '2025 봄', memberName: '홍길동', courseName: '발성', affiliation: '대학부' };
  const created = enrollments.preview(historyRequest);
  let savedEnrollment = await enrollments.execute({ preparedActionToken: created.preparedActionToken, acknowledgedWarningDigest: created.warningDigest });
  const cases = [
    { input: undefined, application: '청년부', enrollment: '대학부' },
    { input: null, application: null, enrollment: null },
    { input: '  새 소속  ', application: '새 소속', enrollment: '새 소속' },
    { input: ' ', application: null, enrollment: null },
  ];
  for (const { input, application: expectedApplication, enrollment: expectedEnrollment } of cases) {
    const { affiliation: _applicationAffiliation, ...applicationFields } = request;
    const { affiliation: _enrollmentAffiliation, ...enrollmentFields } = historyRequest;
    const patch = input === undefined ? {} : { affiliation: input };
    savedApplication = await applications.update(savedApplication.id, {
      ...applicationFields, ...patch, applicationOrder: 2, expectedRevision: savedApplication.revision,
    });
    const preview = enrollments.preview({ ...enrollmentFields, ...patch, action: 'UPDATE',
      enrollmentId: savedEnrollment.id, expectedRevision: savedEnrollment.revision, courseName: '심화' });
    savedEnrollment = await enrollments.execute({ preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest });
    assert.equal(savedApplication.affiliation, expectedApplication);
    assert.equal(savedEnrollment.affiliation, expectedEnrollment);
  }
});

test('staged current templates preserve affiliation text and version after restart and commit', async (t) => {
  const cases = [
    { kind: 'APPLICATIONS', sheet: '수강신청', row: ['2027 봄', '신청 회원', '  =청년부  ', 1, '기초'], candidates: 'applications' },
    { kind: 'ENROLLMENTS', sheet: '수강이력', row: ['2026 가을', '이력 회원', '  =대학부  ', '발성', ''], candidates: 'enrollments' },
  ];
  for (const { kind, sheet, row, candidates } of cases) {
    const { file, dependencies, previews } = await setup(t);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await createImportTemplate(kind));
    workbook.getWorksheet(sheet).addRow(row);
    if (kind === 'APPLICATIONS') {
      workbook.getWorksheet('학기').addRow(['2027 봄', 2]);
      workbook.getWorksheet('개설강좌').addRow(['2027 봄', '기초', 2]);
    }
    const preview = await previews.preview({ filename: '신규.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()), kind });
    const staged = await previews.stage(preview.previewId);
    assert.equal(staged.templateVersion, '3');
    const reopened = await openStore(file, empty);
    const restarted = new ImportPreviewService(reopened, dependencies);
    const reviewed = restarted.repreviewStaged(staged.id);
    assert.equal(reviewed[candidates][0].affiliation, row[2].trim());
    const exported = await restarted.preview({ filename: '보관 원본.xlsx', bytes: await restarted.exportStagedOriginal(staged.id), kind });
    assert.deepEqual(exported.rawRows, preview.rawRows);
    await new ImportCommitService(reopened, restarted, dependencies).commit({ previewId: reviewed.previewId,
      idempotencyKey: `stage-${kind}`, storeRevision: reviewed.storeRevision, storeEpoch: reviewed.storeEpoch,
      warningDigest: reviewed.warningDigest, resolutions: [] });
    assert.equal(reopened.read()[candidates][0].affiliation, row[2].trim());
    assert.equal(reopened.getImportBatch(staged.id).templateVersion, '3');
  }
});

test('manual input rejects invalid affiliations before changing data', async (t) => {
  const { applications, enrollments, store } = await setup(t);
  for (const affiliation of [42, {}, '가'.repeat(201)]) {
    const revision = store.version().storeRevision;
    await assert.rejects(applications.create(application('2026 봄', affiliation)), /소속|affiliation/);
    assert.throws(() => enrollments.preview({ action: 'CREATE', semesterName: '2026 봄', memberName: '홍길동', courseName: '기초', affiliation }), /소속|affiliation/);
    assert.equal(store.version().storeRevision, revision);
  }
});

test('new Excel data roundtrips affiliations and legacy templates import blank affiliation', async (t) => {
  const { store, dependencies, previews, applications, enrollments } = await setup(t);
  const commit = new ImportCommitService(store, previews, dependencies);
  const contexts = [{ semesterName: '2026 봄', semesterOrder: 1, courses: [{ courseName: '기초', capacity: 2 }] }];
  const bytes = await exportApplicationRows([{ semesterName: '2026 봄', memberName: '홍길동', affiliation: '청년부',
    applicationOrder: 1, courseName: '기초', preference: 4 }], contexts);
  const preview = await previews.preview({ filename: '신청.xlsx', bytes, kind: 'APPLICATIONS' });
  assert.equal(preview.applications[0].affiliation, '청년부');
  assert.equal(preview.applications[0].choices[0].preference, 4);
  await commit.commit({ previewId: preview.previewId, idempotencyKey: 'import-affiliation',
    storeRevision: preview.storeRevision, storeEpoch: preview.storeEpoch, warningDigest: preview.warningDigest, resolutions: [] });
  assert.equal(applications.list()[0].affiliation, '청년부');
  const historyBytes = await exportRawRows('ENROLLMENTS', [{ sheet: '수강이력', row: 2,
    cells: { 학기명: '2025 봄', 회원명: '홍길동', '학생 소속': '대학부', 강좌명: '발성', '관리자 메모': '' } }]);
  const history = await previews.preview({ filename: '이력.xlsx', bytes: historyBytes, kind: 'ENROLLMENTS' });
  assert.equal(history.enrollments[0].affiliation, '대학부');
  await commit.commit({ previewId: history.previewId, idempotencyKey: 'import-history-affiliation',
    storeRevision: history.storeRevision, storeEpoch: history.storeEpoch, warningDigest: history.warningDigest, resolutions: [] });
  assert.equal(enrollments.list()[0].affiliation, '대학부');
  for (const ranks of [3, 4, 5]) {
    const legacy = new ExcelJS.Workbook();
    await legacy.xlsx.load(await createImportTemplate('APPLICATIONS'));
    legacy.getWorksheet('메타').getCell('B1').value = '2';
    legacy.getWorksheet('수강신청').getRow(1).values = ['학기명', '회원명', '신청순서', ...Array.from({ length: ranks }, (_, index) => `${index + 1}순위 강좌`)];
    legacy.getWorksheet('수강신청').addRow(['2026 봄', '기존 회원', 2, '기초']);
    const result = await previews.preview({ filename: '기존.xlsx', bytes: Buffer.from(await legacy.xlsx.writeBuffer()), kind: 'APPLICATIONS' });
    assert.equal(result.applications[0].affiliation, null);
  }
});

test('Excel review treats a changed affiliation as changed data rather than an identical row', async (t) => {
  const { applications, enrollments, previews } = await setup(t);
  const saved = await applications.create(application('2026 봄', '청년부'));
  await applications.updateSemesterContext({ semesterId: saved.semesterId, expectedRevision: 1, order: 1,
    semesterCourses: [{ id: saved.choices[0].semesterCourseId, courseName: '기초', capacity: 2 }] });
  const contexts = [{ semesterName: '2026 봄', semesterOrder: 1, courses: [{ courseName: '기초', capacity: 2 }] }];
  const changedBytes = await exportApplicationRows([{ semesterName: '2026 봄', memberName: '홍길동', affiliation: '대학부',
    applicationOrder: 1, courseName: '기초', preference: 1 }], contexts);
  const changed = await previews.preview({ filename: '신청.xlsx', bytes: changedBytes, kind: 'APPLICATIONS', mode: 'REPLACE_APPLICATION' });
  assert.equal(changed.identicalRows, 0);
  assert.equal(changed.conflicts, 1);
  const direct = enrollments.preview({ action: 'CREATE', semesterName: '2025 봄', memberName: '홍길동', courseName: '발성', affiliation: '청년부' });
  await enrollments.execute({ preparedActionToken: direct.preparedActionToken, acknowledgedWarningDigest: direct.warningDigest });
  const bytes = await exportRawRows('ENROLLMENTS', [{ sheet: '수강이력', row: 2,
    cells: { 학기명: '2025 봄', 회원명: '홍길동', '학생 소속': '대학부', 강좌명: '발성', '관리자 메모': '' } }]);
  const reviewed = await previews.preview({ filename: '이력.xlsx', bytes, kind: 'ENROLLMENTS' });
  assert.equal(reviewed.identicalRows, 0);
  assert.equal(reviewed.conflicts, 1);
  assert.ok(reviewed.issues.some(({ code, severity }) => code === 'ENROLLMENT_AFFILIATION_CONFLICT' && severity === 'ERROR'));
  assert.equal(enrollments.list()[0].affiliation, '청년부');
});
