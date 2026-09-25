import assert from 'node:assert/strict';
import test from 'node:test';

import { currentSemester, nextDashboardTask, orderSemesters } from '../../frontend/dashboard-view.js';

const semester = { id: 'semester-current', name: '2026 가을', order: 3 };
const ready = {
  semester,
  courseCount: 3,
  unresolvedCapacityCount: 0,
  applicationCount: 12,
  latestDraft: null,
  enrollmentCount: 0,
};

test('orders semesters by descending order and keeps unordered history last', () => {
  const semesters = [
    { id: 'old', name: '과거 자료', order: null },
    { id: 'second', name: '2026 봄', order: 2 },
    semester,
  ];

  assert.deepEqual(orderSemesters(semesters).map(({ id }) => id), ['semester-current', 'second', 'old']);
  assert.equal(currentSemester(semesters), semester);
  assert.equal(currentSemester([{ id: 'old', name: '과거 자료', order: null }]), null);
});

test('guides an empty installation and a semester being configured', () => {
  assert.equal(nextDashboardTask({ ...ready, semester: null }).label, '학기 추가');
  assert.equal(nextDashboardTask({ ...ready, courseCount: 0 }).label, '강좌 추가');
  assert.equal(nextDashboardTask({ ...ready, unresolvedCapacityCount: 1 }).label, '강좌 정원 입력');
});

test('guides application intake before allocation', () => {
  assert.equal(nextDashboardTask({ ...ready, applicationCount: 0 }).label, '신청 양식 다운로드 또는 신청 등록');
  assert.equal(nextDashboardTask(ready).label, '배정초안 생성');
});

test('guides stale, reviewing, and finalizable drafts in priority order', () => {
  assert.equal(nextDashboardTask({
    ...ready,
    latestDraft: { status: 'DRAFT', revision: 2, isStale: true },
  }).label, '배정초안 다시 생성');
  assert.equal(nextDashboardTask({
    ...ready,
    latestDraft: { status: 'DRAFT', revision: 0, isStale: false },
  }).label, '배정초안 검토');
  assert.equal(nextDashboardTask({
    ...ready,
    latestDraft: { status: 'DRAFT', revision: 1, isStale: false },
  }).label, '배정 확정');
});

test('guides finalized work through the current enrollment report to completion', () => {
  assert.equal(nextDashboardTask({
    ...ready,
    enrollmentCount: 12,
    latestDraft: { status: 'FINALIZED', revision: 1, isStale: false, enrollmentReportIsCurrent: false },
  }).label, '수강이력 확인 및 현황 다운로드');
  assert.equal(nextDashboardTask({
    ...ready,
    enrollmentCount: 12,
    latestDraft: { status: 'FINALIZED', revision: 1, isStale: false, enrollmentReportIsCurrent: true },
  }).label, '현재 학기 업무가 완료되었습니다');
});

test('treats an archived draft as needing a new draft', () => {
  assert.equal(nextDashboardTask({
    ...ready,
    latestDraft: { status: 'ARCHIVED', revision: 1, isStale: false, enrollmentReportIsCurrent: false },
  }).label, '배정초안 생성');
});
