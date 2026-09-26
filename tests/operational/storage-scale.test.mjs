import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { buildAllocationSnapshot } from '../../backend/src/allocation/snapshot.ts';
import { openStore } from '../../backend/src/storage/store.ts';

const empty = JSON.parse(await readFile(new URL('../fixtures/store/store-valid-empty.json', import.meta.url), 'utf8'));
const timestamp = '2026-09-26T00:00:00.000Z';
const stamped = (record) => ({ ...record, createdAt: timestamp, updatedAt: timestamp });
const named = (id, name) => stamped({ id, name, nameKey: name });

const mixedRecords = (count) => {
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
  data.applications = data.members.map((member, index) => stamped({
    id: `application-${index}`, semesterId: 'current', memberId: member.id, applicationOrder: index + 1,
    applicationOrderStatus: 'NORMAL', orderResolution: 'SOURCE_AGREED', orderResolutionNote: null, revision: 0,
  }));
  data.applicationChoices = data.applications.map((application, index) => stamped({
    id: `choice-${index}`, applicationId: application.id, semesterCourseId: `current-course-${index % 10}`,
    preference: 1, sourceRefs: [{ importBatchId: 'import', sheet: '신청', row: index + 2 }],
  }));
  data.enrollments = data.members.map((member, index) => stamped({
    id: `enrollment-${index}`, semesterCourseId: `past-course-${index % 10}`, memberId: member.id,
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
    id: `draft-item-${index}`, draftId: 'draft', memberId: member.id, sourceApplicationId: `application-${index}`,
    memberNameAtGeneration: member.name, autoSemesterCourseId: null, autoDecision: 'NOT_EVALUATED',
    autoReasonCode: 'MANUAL_ONLY', autoReasonDetail: { preferenceAttempts: [], fallback: null },
    finalSemesterCourseId: null, finalDecision: 'REJECTED', finalReasonCode: null, finalReasonDetail: null,
    updatedAt: timestamp,
  }));
  return data;
};

const editMember = (store, edit) => store.write({}, (data) => {
  data.members[0].name = `수정 회원 ${edit}`;
  data.members[0].nameKey = `수정 회원 ${edit}`;
  data.members[0].updatedAt = `2026-09-26T00:00:0${edit}.000Z`;
});

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
  test(`persists one member edit without rewriting mixed records for ${members} members`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'glorycourse-storage-scale-'));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const initial = mixedRecords(members);
    const file = join(directory, 'data.sqlite');
    const store = await openStore(file, initial);
    const samples = [];
    for (let edit = 1; edit <= 3; edit++) {
      const started = performance.now();
      await editMember(store, edit);
      samples.push(performance.now() - started);
    }
    const changedRows = await changedRowsFor(() => editMember(store, 4));
    const expected = structuredClone(initial);
    expected.meta.storeRevision += 4;
    expected.members[0] = {
      ...expected.members[0], name: '수정 회원 4', nameKey: '수정 회원 4', updatedAt: '2026-09-26T00:00:04.000Z',
    };
    assert.deepEqual(store.read(), expected, 'only the member and store revision change');
    assert.deepEqual((await openStore(file, empty)).read(), expected, 'restart retains every record and snapshot');
    const medianMs = [...samples].sort((left, right) => left - right)[1];
    assert.ok(medianMs < 60_000, `one member edit took ${Math.round(medianMs)} ms`);
    context.diagnostic(JSON.stringify({
      scenario: 'one-member-edit', members, medianMs: Math.round(medianMs * 10) / 10,
      samplesMs: samples.map(Math.round), changedRows,
    }));
    assert.ok(changedRows <= 4, `one member edit changed ${changedRows} SQLite rows`);
  });
}
