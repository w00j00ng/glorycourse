import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { cpus, release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { buildAllocationSnapshot } from '../../backend/src/allocation/snapshot.ts';
import { openRepository } from '../../backend/src/bootstrap/database.ts';
import { ApplicationService } from '../../backend/src/services/applications.ts';
import { DraftService } from '../../backend/src/services/drafts.ts';
import { FinalizationService } from '../../backend/src/services/finalization.ts';
import { startLocalServer } from '../../backend/src/server.ts';
import { fallbackBoundaryInput, fallbackStore } from '../fixtures/fallback-workload.mjs';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const timestamp = '2026-09-26T00:00:00.000Z';
const stamped = (record) => ({ ...record, createdAt: timestamp, updatedAt: timestamp });
const named = (id, name) => stamped({ id, name, nameKey: name });

const mixedRecords = (count, choicesPerApplication = 1) => {
  const data = structuredClone(empty);
  data.semesters = [
    { ...named('current', '현재 학기'), order: 2, allocationInputRevision: 0 },
    { ...named('past', '지난 학기'), order: 1, allocationInputRevision: 0 },
  ];
  data.members = Array.from({ length: count }, (_, index) => named(`member-${index}`, `회원 ${index}`));
  data.courses = Array.from({ length: 10 }, (_, index) => named(`course-${index}`, `강좌 ${index}`));
  data.semesterCourses = data.semesters.flatMap((semester) => data.courses.map((course) => stamped({
    id: `${semester.id}-${course.id}`, semesterId: semester.id, courseId: course.id, capacity: count,
  })));
  data.applications = data.members.map((member, index) => stamped({ applicantNote: null,
    id: `application-${index}`, semesterId: 'current', memberId: member.id, ministry: null, applicationOrder: index + 1,
    applicationOrderStatus: 'NORMAL', orderResolution: 'SOURCE_AGREED', orderResolutionNote: null, revision: 0,
  }));
  data.applicationChoices = data.applications.flatMap((application, index) => (
    Array.from({ length: choicesPerApplication }, (_, rank) => stamped({
      id: `choice-${index}-${rank}`, applicationId: application.id, semesterCourseId: `current-course-${index % 10}`,
      preference: rank + 1, sourceRefs: [{ importBatchId: 'import', sheet: '신청', row: index + 2 }],
    }))
  ));
  data.enrollments = data.members.map((member, index) => stamped({
    id: `enrollment-${index}`, semesterCourseId: `past-course-${index % 10}`, memberId: member.id, ministry: null,
    exceptionAcknowledgement: null, revision: 0,
  }));
  data.importBatches = [{
    id: 'import', kind: 'APPLICATIONS', templateVersion: '1', fileHash: 'synthetic', importedAt: timestamp,
    status: 'STAGED', resolutions: [], receipt: null,
    rawRows: data.members.map((member, index) => ({
      sheet: '신청', row: index + 2,
      cells: { 학기: '현재 학기', 이름: member.name, 강좌: `강좌 ${index % 10}`, 순위: String(index + 1), 비고: null },
    })),
  }];
  data.allocationDrafts = [stamped({
    id: 'draft', semesterId: 'current', status: 'DRAFT', revision: 0, mode: 'MANUAL',
    policyId: 'default', policyVersion: '1', engineVersion: '1.0.0',
    policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' },
    randomSeed: 'storage-scale', sourceRevision: 0, inputFingerprint: 'synthetic',
    inputSnapshot: buildAllocationSnapshot(data, 'current'), finalizedAt: null,
    enrollmentReportDownloadedAt: null, enrollmentReportStoreRevision: null, finalization: null,
  })];
  data.allocationDraftItems = data.members.map((member, index) => ({
    id: `draft-item-${index}`, draftId: 'draft', memberId: member.id, ministry: null, sourceApplicationId: `application-${index}`,
    memberNameAtGeneration: member.name, autoSemesterCourseId: null, autoDecision: 'NOT_EVALUATED',
    autoReasonCode: 'MANUAL_ONLY', autoReasonDetail: { preferenceAttempts: [], fallback: null },
    finalSemesterCourseId: null, finalDecision: 'REJECTED', finalReasonCode: null, finalReasonDetail: null,
    updatedAt: timestamp,
  }));
  return data;
};

// Count SQLite row changes, including foreign-key cascades, outside the timed samples.
const changedRowsFor = async (action) => {
  const close = DatabaseSync.prototype.close;
  let changedRows = 0;
  DatabaseSync.prototype.close = function () {
    changedRows += Number(this.prepare('SELECT total_changes() AS count').get().count);
    return close.call(this);
  };
  try { await action(); }
  finally { DatabaseSync.prototype.close = close; }
  return changedRows;
};

for (const members of [1_000, 10_000]) {
  test(`SQL repository preserves mixed records when editing one of ${members} members`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-repository-scale-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const initial = mixedRecords(members);
    const file = join(directory, 'db.sqlite');
    const repository = await openRepository(file, initial);
    const request = { id: 'member-0', name: '수정 회원', nameKey: '수정 회원', updatedAt: '2026-10-21T00:00:00.000Z' };
    let elapsed;
    const changedRows = await changedRowsFor(async () => {
      const started = performance.now();
      await repository.write({}, (queries) => {
        const current = queries.members.get({ id: request.id });
        queries.members.update({ record: { ...current, ...request } });
      });
      elapsed = performance.now() - started;
    });
    const expected = structuredClone(initial);
    Object.assign(expected.members[0], request);
    expected.meta.storeRevision += 1;
    const reopened = await openRepository(file, empty);
    try {
      assert.deepEqual(reopened.snapshot(), expected);
      assert.equal(changedRows, 2, 'only the member and store revision are persisted');
      assert.ok(elapsed < 60_000, `one SQL edit took ${Math.round(elapsed)} ms`);
      context.diagnostic(JSON.stringify({ scenario: 'repository-one-member-edit', members,
        elapsedMs: Math.round(elapsed * 10) / 10, changedRows }));
    } finally { reopened.close(); repository.close(); }
  });
}

test('an administrator filters 10000 applications with five repeated choices without multiplying applicants', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-application-filter-scale-'));
  const repository = await openRepository(join(directory, 'db.sqlite'), mixedRecords(10_000, 5));
  context.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  const applications = new ApplicationService(repository, { id: () => 'unused', now: () => new Date(timestamp) });
  const started = performance.now();
  const result = applications.listPage({ semesterId: 'current', courseId: 'course-0', page: 1, limit: 50 });
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  assert.equal(result.total, 1_000);
  assert.equal(result.items.length, 50);
  for (const application of result.items) {
    assert.deepEqual(application.choices.map(({ preference }) => preference), [1, 2, 3, 4, 5]);
    assert.deepEqual(application.warnings.map(({ code, preferences }) => ({ code, preferences })),
      [{ code: 'RETAKE', preferences: [1, 2, 3, 4, 5] }]);
  }
  context.diagnostic(JSON.stringify({ scenario: 'repeated-choice-course-filter', applicants: 10_000,
    choices: 50_000, matchedApplicants: result.total, elapsedMs }));
  assert.ok(elapsedMs < 10_000, `application course filter took ${elapsedMs} ms`);
});

test('dense fallback lifecycle', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'glorycourse-dense-fallback-'));
  const file = join(directory, 'db.sqlite');
  let runtime;
  let reopened;
  context.after(async () => {
    await runtime?.close();
    reopened?.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = fallbackBoundaryInput(100_000);
  input.semesterCourses.pop();
  const initial = await openRepository(file, fallbackStore(input));
  initial.close();
  runtime = await startLocalServer({ dataDirectory: directory, staticDirectory: directory, port: 0 });
  let nextId = 0;
  const dependencies = { id: () => `dense-${++nextId}`, now: () => new Date(timestamp), seed: () => 'storage-dense-fallback' };
  const drafts = new DraftService(runtime.repository, dependencies);
  const finalization = new FinalizationService(runtime.repository, { ...dependencies, secret: '0123456789abcdef0123456789abcdef' });
  const bytes = async (path) => {
    try { return (await stat(path)).size; }
    catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
  };
  const disk = async () => ({ databaseBytes: await bytes(file), walBytes: await bytes(`${file}-wal`) });
  const candidateCount = () => {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return Number(db.prepare('SELECT COUNT(*) AS count FROM allocation_item_fallback_candidates').get().count); }
    finally { db.close(); }
  };
  const phases = {};
  const measure = async (name, action) => {
    const before = await disk();
    let result;
    const started = performance.now();
    const changedRows = await changedRowsFor(async () => { result = await action(); });
    const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
    phases[name] = { elapsedMs, changedRows, maxRssMiB: process.resourceUsage().maxRSS / 1024, before, after: await disk() };
    return result;
  };
  let created = await measure('createPersist', () => drafts.create({ semesterId: 'current', mode: 'AUTO',
    policyId: 'default', policyVersion: '1',
    policySettings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' } }));
  const draftId = created.draft.id;
  const assignments = created.studentResults.map(({ memberId, autoSemesterCourseId }) => [memberId, autoSemesterCourseId]);
  assert.equal(assignments.length, 1_000);
  assert.ok(created.studentResults.every(({ autoReasonCode }) => autoReasonCode === 'RANDOM_FALLBACK'));
  assert.equal(created.studentResults.reduce((sum, item) => sum + item.autoReasonDetail.fallback.stageCandidateSemesterCourseIds.length, 0), 99_000);
  created = null;
  const persistedCandidates = candidateCount();
  assert.equal(persistedCandidates, 99_000);
  const session = await fetch(`${runtime.origin}/api/v1/session`, { method: 'POST', headers: { Origin: runtime.origin } }).then((response) => response.json());
  let download = await measure('httpReadDownload', async () => {
    const response = await fetch(`${runtime.origin}/api/v1/allocation-drafts/${draftId}`, { headers: { 'X-Glorycourse-Session': session.token } });
    assert.equal(response.status, 200);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), body.byteLength);
    return body;
  });
  const httpJsonBytes = download.byteLength;
  let read = JSON.parse(download.toString('utf8'));
  download = null;
  assert.deepEqual(read.studentResults.map(({ memberId, autoSemesterCourseId }) => [memberId, autoSemesterCourseId]), assignments);
  assert.equal(read.isStale, false);
  read = null;
  let preview = await measure('preview', () => finalization.preview(draftId, { expectedDraftRevision: 0 }));
  assert.equal(preview.enrollments.length, 1_000);
  assert.deepEqual(preview.issues, []);
  const confirmation = { idempotencyKey: 'dense-fallback-finalization', expectedDraftRevision: 0,
    preparedActionToken: preview.preparedActionToken, acknowledgedWarningDigest: preview.warningDigest };
  preview = null;
  const receipt = await measure('finalize', () => finalization.finalize(draftId, confirmation));
  assert.equal(receipt.createdCount, 1_000);
  assert.equal(candidateCount(), 0, 'finalization removes the draft and its candidate rows');
  await runtime.close();
  runtime = undefined;
  await measure('reopen', async () => { reopened = await openRepository(file, empty); });
  const saved = reopened.snapshot();
  assert.deepEqual(saved.enrollments.map(({ memberId, semesterCourseId }) => [memberId, semesterCourseId]).sort(), assignments.sort());
  assert.equal(saved.allocationDrafts.length, 0);
  assert.equal(saved.allocationDraftItems.length, 0);
  assert.equal(saved.finalizationReceipts.length, 1);
  assert.deepEqual(saved.finalizationReceipts[0].receipt, receipt);
  const createSaveReadMs = phases.createPersist.elapsedMs + phases.httpReadDownload.elapsedMs;
  const databaseGrowthBytes = phases.createPersist.after.databaseBytes - phases.createPersist.before.databaseBytes;
  context.diagnostic(JSON.stringify({ scenario: 'dense-fallback-lifecycle', environment: { node: process.version,
    platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, tempDirectory: tmpdir() },
    applicants: 1_000, fallbackCourses: 99, persistedCandidates, httpJsonBytes, phases, createSaveReadMs,
    peakRssMiB: process.resourceUsage().maxRSS / 1024, databaseGrowthBytes,
    proposedTargets: { createSaveReadMs: 10_000, peakRssMiB: 512, databaseGrowthBytes: 64 * 1024 * 1024 } }));
});
