import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import ExcelJS from '@excel.js/exceljs';

import { createImportTemplate } from '../../backend/src/excel/workbooks.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import {
  ImportAcknowledgementError,
  ImportCommitConflictError,
  ImportCommitService,
  ImportIdempotencyConflictError,
  ImportPreviewStaleError,
} from '../../backend/src/services/import-commit.ts';
import { ImportPreviewService } from '../../backend/src/services/import-preview.ts';
import { Store, openStore } from '../../backend/src/storage/store.ts';

const now = () => new Date('2026-09-23T00:00:00.000Z');
const emptyStore = () => ({
  meta: { storeEpoch: 'epoch-1', storeRevision: 0 },
  semesters: [],
  members: [],
  courses: [],
  semesterCourses: [],
  applications: [],
  applicationChoices: [],
  enrollments: [],
  allocationDrafts: [],
  allocationDraftItems: [],
  importBatches: [],
  finalizationReceipts: [],
  restoreReceipts: [],
});

const ids = (prefix) => {
  let value = 0;
  return () => `${prefix}-${++value}`;
};

const workbookWithRows = async (kind, rows, { includeCourseContext = true } = {}) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImportTemplate(kind));
  const sheet = workbook.getWorksheet(kind === 'APPLICATIONS' ? '수강신청' : '수강이력');
  for (const row of rows) sheet.addRow(row);
  if (kind === 'APPLICATIONS' && includeCourseContext) {
    const courses = new Map(rows.map(([semesterName, , , courseName]) => [
      `${semesterName}\0${courseName}`, [semesterName, courseName, 10],
    ]));
    for (const course of courses.values()) workbook.getWorksheet('개설강좌').addRow(course);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const applicationWorkbookWithContext = async ({ semesterRows, courseRows, applicationRows }) => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await createImportTemplate('APPLICATIONS'));
  for (const row of semesterRows) workbook.getWorksheet('학기').addRow(row);
  for (const row of courseRows) workbook.getWorksheet('개설강좌').addRow(row);
  for (const row of applicationRows) workbook.getWorksheet('수강신청').addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

const requestFor = (preview, idempotencyKey = 'request-1', resolutions = []) => ({
  previewId: preview.previewId,
  idempotencyKey,
  storeRevision: preview.storeRevision,
  storeEpoch: preview.storeEpoch,
  warningDigest: preview.warningDigest,
  resolutions,
});

const previewService = (store, prefix = 'preview') => new ImportPreviewService(store, {
  id: ids(prefix),
  now,
});

const commitService = (store, previews, prefix = 'commit') => new ImportCommitService(
  store,
  previews,
  { id: ids(prefix), now },
);

test('imports historical enrollments with new semester and course as dismissible information without a note', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const previews = previewService(store);
  const bytes = await workbookWithRows('ENROLLMENTS', [
    ['2024 봄', '홍길동', '창세기'],
    ['2024 봄', '김은혜', '창세기'],
  ]);
  const preview = await previews.preview({ filename: 'history.xlsx', bytes, kind: 'ENROLLMENTS' });

  assert.equal(preview.issues.filter(({ severity }) => severity === 'WARNING').length, 0);
  assert.deepEqual(
    preview.issues.filter(({ severity }) => severity === 'INFO').map(({ code }) => code),
    ['SEMESTER_ORDER_UNRESOLVED', 'CAPACITY_UNRESOLVED', 'SEMESTER_ORDER_UNRESOLVED', 'CAPACITY_UNRESOLVED'],
  );
  const receipt = await commitService(store, previews).commit(requestFor(preview));
  assert.equal(receipt.inserted, 2);
  assert.equal(store.read().semesters[0].order, 1);
  assert.equal(store.read().semesterCourses[0].capacity, null);
  assert.equal(store.read().enrollments.length, 2);
  assert.ok(store.read().enrollments.every(({ exceptionAcknowledgement }) => exceptionAcknowledgement === null));
});

test('keeps an existing course with unresolved capacity as an acknowledged enrollment warning', async () => {
  const initial = storeWithPriorEnrollment();
  initial.semesterCourses.find(({ id }) => id === 'new-advanced').capacity = null;
  const store = await Store.open(new MemoryAdapter(initial), emptyStore());
  const previews = previewService(store);
  const preview = await previews.preview({
    filename: 'history.xlsx',
    bytes: await workbookWithRows('ENROLLMENTS', [['2026 봄', '김은혜', '심화']]),
    kind: 'ENROLLMENTS',
  });
  assert.ok(preview.issues.some(({ code, severity }) => code === 'CAPACITY_UNRESOLVED' && severity === 'WARNING'));
  await assert.rejects(commitService(store, previews).commit(requestFor(preview)), ImportAcknowledgementError);
});

test('rejects a blank application course capacity even when the system already has a value', async () => {
  const store = await Store.open(new MemoryAdapter(storeWithPriorEnrollment()), emptyStore());
  const previews = previewService(store);
  const preview = await previews.preview({
    filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await applicationWorkbookWithContext({
      semesterRows: [], courseRows: [['2026 봄', '기초', '']],
      applicationRows: [['2026 봄', '김은혜', '1', '기초', '1']],
    }),
  });
  assert.ok(preview.issues.some(({ code, severity, blockingStages }) => (
    code === 'SEMESTER_COURSE_CAPACITY_MISSING' && severity === 'ERROR' && blockingStages.includes('IMPORT_COMMIT')
  )));
  await assert.rejects(commitService(store, previews).commit(requestFor(preview)), ImportCommitConflictError);
  assert.equal(store.read().applications.length, 0);
});

test('rejects a course with one blank capacity among repeated application rows', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const previews = previewService(store);
  const preview = await previews.preview({
    filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await applicationWorkbookWithContext({
      semesterRows: [], courseRows: [['2026 봄', '창세기', 10], ['2026 봄', '창세기', '']],
      applicationRows: [['2026 봄', '홍길동', '1', '창세기', '1']],
    }),
  });
  assert.ok(preview.issues.some(({ code, severity, source }) => (
    code === 'SEMESTER_COURSE_CAPACITY_MISSING' && severity === 'ERROR' && source.row === 3
  )));
  await assert.rejects(commitService(store, previews).commit(requestFor(preview)), ImportCommitConflictError);
  assert.equal(store.read().applications.length, 0);
});

test('accepts zero capacity and reuses a catalog capacity when the course sheet omits a row', async () => {
  const empty = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const emptyPreviews = previewService(empty);
  const zero = await emptyPreviews.preview({
    filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await applicationWorkbookWithContext({
      semesterRows: [], courseRows: [['2026 봄', '창세기', 0]],
      applicationRows: [['2026 봄', '홍길동', '1', '창세기', '1']],
    }),
  });
  assert.ok(!zero.issues.some(({ code }) => code.includes('CAPACITY_MISSING')));
  assert.equal((await commitService(empty, emptyPreviews).commit(requestFor(zero))).inserted, 1);
  assert.equal(empty.read().semesterCourses[0].capacity, 0);

  const existing = await Store.open(new MemoryAdapter(storeWithPriorEnrollment()), emptyStore());
  const existingPreviews = previewService(existing);
  const omitted = await existingPreviews.preview({
    filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '김은혜', '1', '기초', '1']], { includeCourseContext: false }),
  });
  assert.ok(!omitted.issues.some(({ code }) => code.includes('CAPACITY_MISSING')));
  assert.equal((await commitService(existing, existingPreviews).commit(requestFor(omitted))).inserted, 1);
});

test('requires a capacity for an application choice absent from the course sheet and catalog', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const previews = previewService(store);
  const preview = await previews.preview({
    filename: 'applications.xlsx', kind: 'APPLICATIONS',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '1', '창세기', '1']], { includeCourseContext: false }),
  });
  assert.ok(preview.issues.some(({ code, severity }) => (
    code === 'APPLICATION_COURSE_CAPACITY_MISSING' && severity === 'ERROR'
  )));
  await assert.rejects(commitService(store, previews).commit(requestFor(preview)), ImportCommitConflictError);
  assert.equal(store.read().applications.length, 0);
});

test('commits one application atomically and returns the persisted receipt after restart', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-commit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'db.sqlite');
  const store = await openStore(dataFile, emptyStore());
  const previews = previewService(store);
  const bytes = await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '15', '기초', '1']]);
  const preview = await previews.preview({
    filename: 'applications.xlsx',
    bytes,
    kind: 'APPLICATIONS',
  });
  const request = requestFor(preview);

  const receipt = await commitService(store, previews).commit(request);

  assert.deepEqual(
    { inserted: receipt.inserted, updated: receipt.updated, skipped: receipt.skipped },
    { inserted: 1, updated: 0, skipped: 0 },
  );
  assert.equal(store.read().applications.length, 1);
  assert.equal(store.read().applicationChoices[0].sourceRefs[0].importBatchId, receipt.importBatchId);
  assert.equal(store.read().importBatches[0].status, 'APPLIED');

  const reopened = await openStore(dataFile, emptyStore());
  const restartedPreviews = previewService(reopened, 'restarted-preview');
  const retried = await commitService(reopened, restartedPreviews, 'retry').commit(request);

  assert.deepEqual(retried, receipt);
  assert.equal(reopened.read().meta.storeRevision, store.read().meta.storeRevision);
  await assert.rejects(
    commitService(reopened, restartedPreviews, 'different').commit({
      ...request,
      resolutions: [{ action: 'KEEP_EXISTING' }],
    }),
    ImportIdempotencyConflictError,
  );

  const oldEpochPreview = await restartedPreviews.preview({
    filename: 'old-epoch.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '이전 Epoch 회원', '16', '기초', '1']]),
    kind: 'APPLICATIONS',
  });
  await reopened.write({}, (data) => { data.meta.storeEpoch = 'epoch-2'; });
  await assert.rejects(
    commitService(reopened, restartedPreviews, 'old-epoch')
      .commit(requestFor(oldEpochPreview, 'old-epoch')),
    ImportPreviewStaleError,
  );
  assert.deepEqual(
    await commitService(reopened, restartedPreviews, 'receipt-after-epoch').commit(request),
    receipt,
  );

  const reupload = await restartedPreviews.preview({ filename: 'same.xlsx', bytes, kind: 'APPLICATIONS' });
  const skipped = await commitService(reopened, restartedPreviews, 'reupload').commit(
    requestFor(reupload, 'request-2'),
  );
  assert.equal(skipped.skipped, 1);
  assert.equal(reopened.read().applications.length, 1);
});

test('rejects a stale preview and a failed write without partial imported data', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const previews = previewService(store);
  const first = await previews.preview({
    filename: 'stale.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '가져올 회원', '15', '기초', '1']]),
    kind: 'APPLICATIONS',
  });
  const applications = new ApplicationService(store, { id: ids('manual'), now });
  await applications.create({
    semesterName: '2026 봄', memberName: '다른 회원', applicationOrder: 16,
    choices: [{ courseName: '심화', preference: 1 }],
  });
  await assert.rejects(
    commitService(store, previews).commit(requestFor(first)),
    ImportPreviewStaleError,
  );
  assert.equal(store.read().members.some(({ name }) => name === '가져올 회원'), false);

  const failingAdapter = new FailingMemoryAdapter(emptyStore());
  const failingStore = await Store.open(failingAdapter, emptyStore());
  const failingPreviews = previewService(failingStore, 'write-fail-preview');
  const writeFailure = await failingPreviews.preview({
    filename: 'write-failure.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [['2026 봄', '쓰기 실패 회원', '18', '기초', '1']]),
    kind: 'APPLICATIONS',
  });
  const beforeWriteFailure = failingStore.read();
  failingAdapter.failNext = true;
  await assert.rejects(
    commitService(failingStore, failingPreviews, 'write-fail')
      .commit(requestFor(writeFailure, 'request-3')),
    /disk write failed/,
  );
  assert.deepEqual(failingStore.read(), beforeWriteFailure);
});

test('keeps conflicting source order and raw rows while allowing the import', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const previews = previewService(store);
  const preview = await previews.preview({
    filename: 'conflict.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [
      ['2026 봄', '홍길동', '15', '기초', '1'],
      ['2026 봄', '홍길동', '16', '심화', '2'],
    ]),
    kind: 'APPLICATIONS',
  });

  await commitService(store, previews).commit(requestFor(preview));

  const data = store.read();
  assert.deepEqual(
    {
      applicationOrder: data.applications[0].applicationOrder,
      applicationOrderStatus: data.applications[0].applicationOrderStatus,
      orderResolution: data.applications[0].orderResolution,
    },
    { applicationOrder: null, applicationOrderStatus: 'CONFLICT', orderResolution: 'UNRESOLVED' },
  );
  assert.deepEqual(data.importBatches[0].rawRows.filter(({ sheet }) => sheet === '수강신청').map(({ cells }) => cells['신청순서']), ['15', '16']);

  const same = await previews.preview({
    filename: 'same-conflict.xlsx',
    bytes: await workbookWithRows('APPLICATIONS', [
      ['2026 봄', '홍길동', '15', '기초', '1'],
      ['2026 봄', '홍길동', '16', '심화', '2'],
    ]),
    kind: 'APPLICATIONS',
  });
  assert.equal(same.identicalRows, 2);

  const confirmed = await commitService(store, previews, 'confirm-order').commit(requestFor(
    same,
    'confirm-order',
    [{
      entity: 'APPLICATION', semesterName: '2026 봄', memberName: '홍길동',
      action: 'CONFIRM_APPLICATION_ORDER', applicationOrder: 15,
    }],
  ));
  assert.equal(confirmed.updated, 1);
  assert.deepEqual(
    {
      applicationOrder: store.read().applications[0].applicationOrder,
      applicationOrderStatus: store.read().applications[0].applicationOrderStatus,
      orderResolution: store.read().applications[0].orderResolution,
    },
    { applicationOrder: 15, applicationOrderStatus: 'NORMAL', orderResolution: 'ADMIN_CONFIRMED' },
  );
});

test('keeps missing choices in merge mode and removes them only after explicit replacement', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const applications = new ApplicationService(store, { id: ids('seed'), now });
  const existing = await applications.create({
    semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 15,
    choices: [
      { courseName: '기초', preference: 1 },
      { courseName: '심화', preference: 2 },
    ],
  });
  await applications.updateSemesterContext({
    semesterId: existing.semesterId,
    expectedRevision: 1,
    order: 1,
    semesterCourses: [{ courseName: '기초', capacity: 10 }, { courseName: '심화', capacity: 10 }],
  });
  const bytes = await workbookWithRows('APPLICATIONS', [['2026 봄', '홍길동', '15', '기초', '1']]);
  const previews = previewService(store);
  const merge = await previews.preview({ filename: 'merge.xlsx', bytes, kind: 'APPLICATIONS' });

  const mergeReceipt = await commitService(store, previews, 'merge').commit(requestFor(
    merge,
    'merge-request',
    [{ entity: 'APPLICATION', semesterName: '2026 봄', memberName: '홍길동', action: 'KEEP_EXISTING' }],
  ));
  assert.equal(mergeReceipt.skipped, 1);
  assert.equal(store.read().applicationChoices.length, 2);

  const replace = await previews.preview({
    filename: 'replace.xlsx', bytes, kind: 'APPLICATIONS', mode: 'REPLACE_APPLICATION',
  });
  assert.deepEqual(replace.applications[0].removedCourseNames, ['심화']);
  const replaceReceipt = await commitService(store, previews, 'replace').commit(requestFor(
    replace,
    'replace-request',
    [{ entity: 'APPLICATION', semesterName: '2026 봄', memberName: '홍길동', action: 'REPLACE_APPLICATION' }],
  ));

  assert.equal(replaceReceipt.updated, 1);
  assert.equal(store.read().applicationChoices.length, 1);
});

test('keeps existing semester context by default and applies file values only after explicit approval', async () => {
  const store = await Store.open(new MemoryAdapter(emptyStore()), emptyStore());
  const applications = new ApplicationService(store, { id: ids('context-seed'), now });
  const application = await applications.create({
    semesterName: '2026 봄', memberName: '홍길동', applicationOrder: 15,
    choices: [{ courseName: '기초', preference: 1 }],
  });
  await applications.updateSemesterContext({
    semesterId: application.semesterId,
    expectedRevision: 1,
    order: 1,
    semesterCourses: [{ courseName: '기초', capacity: 5 }],
  });
  const bytes = await applicationWorkbookWithContext({
    semesterRows: [['2026 봄', '2']],
    courseRows: [['2026 봄', '기초', '10']],
    applicationRows: [['2026 봄', '홍길동', '15', '기초', '1']],
  });
  const previews = previewService(store, 'context-preview');
  const keepPreview = await previews.preview({ filename: 'context.xlsx', bytes, kind: 'APPLICATIONS' });
  assert.deepEqual(
    keepPreview.contextChanges.map(({ entity, status, existingValue, fileValue }) => ({ entity, status, existingValue, fileValue })),
    [
      { entity: 'SEMESTER', status: 'EXISTING_CONFLICT', existingValue: 1, fileValue: 2 },
      { entity: 'SEMESTER_COURSE', status: 'EXISTING_CONFLICT', existingValue: 5, fileValue: 10 },
    ],
  );
  await assert.rejects(
    commitService(store, previews, 'context-unresolved').commit(requestFor(keepPreview, 'context-1')),
    ImportCommitConflictError,
  );
  await commitService(store, previews, 'context-keep').commit(requestFor(
    keepPreview,
    'context-2',
    [
      { entity: 'SEMESTER', field: 'order', semesterName: '2026 봄', action: 'KEEP_EXISTING' },
      { entity: 'SEMESTER_COURSE', field: 'capacity', semesterName: '2026 봄', courseName: '기초', action: 'KEEP_EXISTING' },
    ],
  ));
  assert.equal(store.read().semesters[0].order, 1);
  assert.equal(store.read().semesterCourses[0].capacity, 5);

  const applyPreview = await previews.preview({ filename: 'context.xlsx', bytes, kind: 'APPLICATIONS' });
  await commitService(store, previews, 'context-apply').commit(requestFor(
    applyPreview,
    'context-3',
    [
      { entity: 'SEMESTER', field: 'order', semesterName: '2026 봄', action: 'APPLY_FILE_VALUE' },
      { entity: 'SEMESTER_COURSE', field: 'capacity', semesterName: '2026 봄', courseName: '기초', action: 'APPLY_FILE_VALUE' },
    ],
  ));
  assert.equal(store.read().semesters[0].order, 2);
  assert.equal(store.read().semesterCourses[0].capacity, 10);
});

test('rejects duplicate enrollment rows and requires acknowledgement for retaking a course', async () => {
  const store = await Store.open(new MemoryAdapter(storeWithPriorEnrollment()), emptyStore());
  const previews = previewService(store);
  const duplicates = await previews.preview({
    filename: 'duplicates.xlsx',
    bytes: await workbookWithRows('ENROLLMENTS', [
      ['2026 봄', '홍길동', '기초'],
      ['2026 봄', '홍길동', '심화'],
    ]),
    kind: 'ENROLLMENTS',
  });
  await assert.rejects(
    commitService(store, previews, 'duplicate').commit(requestFor(duplicates)),
    ImportCommitConflictError,
  );

  const retake = await previews.preview({
    filename: 'retake.xlsx',
    bytes: await workbookWithRows('ENROLLMENTS', [['2026 봄', '홍길동', '기초']]),
    kind: 'ENROLLMENTS',
  });
  assert.ok(retake.issues.some(({ code }) => code === 'RETAKE'));
  await assert.rejects(
    commitService(store, previews, 'unacknowledged').commit(requestFor(retake, 'retake')),
    ImportAcknowledgementError,
  );

  const receipt = await commitService(store, previews, 'acknowledged').commit(requestFor(
    retake,
    'retake',
    [{
      entity: 'ENROLLMENT', action: 'ACKNOWLEDGE_WARNING', semesterName: '2026 봄', memberName: '홍길동', courseName: '기초',
      warningDigest: retake.warningDigest, acknowledgementNote: '재수강 이력을 확인함',
    }],
  ));
  assert.equal(receipt.inserted, 1);
  assert.equal(store.read().enrollments[1].exceptionAcknowledgement.note, '재수강 이력을 확인함');

  const same = await previews.preview({
    filename: 'same-retake.xlsx',
    bytes: await workbookWithRows('ENROLLMENTS', [['2026 봄', '홍길동', '기초']]),
    kind: 'ENROLLMENTS',
  });
  assert.equal(same.identicalRows, 1);
  assert.equal(same.issues.some(({ code }) => code === 'SAME_SEMESTER_ENROLLMENT'), false);
});

const storeWithPriorEnrollment = () => ({
  ...emptyStore(),
  semesters: [
    { id: 'semester-old', name: '2025 가을', nameKey: '2025 가을', order: 1, allocationInputRevision: 0, createdAt: now().toISOString(), updatedAt: now().toISOString() },
    { id: 'semester-new', name: '2026 봄', nameKey: '2026 봄', order: 2, allocationInputRevision: 0, createdAt: now().toISOString(), updatedAt: now().toISOString() },
  ],
  members: [{ id: 'member-1', name: '홍길동', nameKey: '홍길동', createdAt: now().toISOString(), updatedAt: now().toISOString() }],
  courses: [
    { id: 'course-basic', name: '기초', nameKey: '기초', createdAt: now().toISOString(), updatedAt: now().toISOString() },
    { id: 'course-advanced', name: '심화', nameKey: '심화', createdAt: now().toISOString(), updatedAt: now().toISOString() },
  ],
  semesterCourses: [
    { id: 'old-basic', semesterId: 'semester-old', courseId: 'course-basic', capacity: 10, createdAt: now().toISOString(), updatedAt: now().toISOString() },
    { id: 'new-basic', semesterId: 'semester-new', courseId: 'course-basic', capacity: 10, createdAt: now().toISOString(), updatedAt: now().toISOString() },
    { id: 'new-advanced', semesterId: 'semester-new', courseId: 'course-advanced', capacity: 10, createdAt: now().toISOString(), updatedAt: now().toISOString() },
  ],
  enrollments: [{
    id: 'enrollment-old', semesterCourseId: 'old-basic', memberId: 'member-1',
    exceptionAcknowledgement: null, revision: 0,
    createdAt: now().toISOString(), updatedAt: now().toISOString(),
  }],
});

class MemoryAdapter {
  constructor(data) {
    this.data = structuredClone(data);
  }

  async read() {
    return structuredClone(this.data);
  }

  async write(data) {
    this.data = structuredClone(data);
  }
}

class FailingMemoryAdapter extends MemoryAdapter {
  failNext = false;

  async write(data) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk write failed');
    }
    await super.write(data);
  }
}
