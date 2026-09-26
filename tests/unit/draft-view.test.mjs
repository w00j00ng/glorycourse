import assert from 'node:assert/strict';
import test from 'node:test';

import {
  describeAllocationEvidence,
  draftApplicationSummaries,
  draftDecisionChanged,
  draftFinalSelection,
  filterDraftItems,
  draftItemPage,
  sortDraftItems,
} from '../../frontend/draft-view.js';

const courses = new Map([
  ['course-acting', '연기'],
  ['course-voice', '발성'],
  ['course-photo', '사진'],
]);
const courseName = (id) => courses.get(id) ?? id ?? '제외';

const items = [
  {
    memberId: 'member-kim', memberNameAtGeneration: '김새롬', autoDecision: 'SELECTED',
    autoSemesterCourseId: 'course-photo', autoReasonCode: 'RANDOM_FALLBACK',
    finalDecision: 'SELECTED', finalSemesterCourseId: 'course-photo', finalReasonCode: null,
  },
  {
    memberId: 'member-lee', memberNameAtGeneration: '이하늘', autoDecision: 'REJECTED',
    autoSemesterCourseId: null, autoReasonCode: 'FALLBACK_COMPETITION_LOST',
    finalDecision: 'SELECTED', finalSemesterCourseId: 'course-voice', finalReasonCode: 'ADMIN_OVERRIDE',
  },
  {
    memberId: 'member-park', memberNameAtGeneration: '박다정', autoDecision: 'SELECTED',
    autoSemesterCourseId: 'course-acting', autoReasonCode: 'PREFERENCE_ALLOCATED',
    finalDecision: 'SELECTED', finalSemesterCourseId: 'course-acting', finalReasonCode: null,
  },
];

test('pages a large draft after filtering and sorting without losing the selected page', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({ memberId: `member-${index + 1}` }));
  const cases = [
    { input: rows, page: 1, expectedPage: 1, count: 50, first: 'member-1', last: 'member-50' },
    { input: rows, page: 2, expectedPage: 2, count: 50, first: 'member-51', last: 'member-100' },
    { input: rows, page: 201, expectedPage: 200, count: 50, first: 'member-9951', last: 'member-10000' },
    { input: rows.slice(0, 3), page: 20, expectedPage: 1, count: 3, first: 'member-1', last: 'member-3' },
    { input: [], page: 20, expectedPage: 1, count: 0 },
  ];
  for (const { input, page, expectedPage, count, first, last } of cases) {
    const result = draftItemPage(input, page, 50);
    assert.equal(result.page, expectedPage);
    assert.equal(result.total, input.length);
    assert.equal(result.items.length, count);
    assert.equal(result.items[0]?.memberId, first);
    assert.equal(result.items.at(-1)?.memberId, last);
  }
  assert.equal(rows.length, 10_000);
});

test('shows application order separately and keeps ranked choices concise in a draft', () => {
  const snapshot = {
    applications: [
      { id: 'application-1', applicationOrder: 4 },
      { id: 'application-2', applicationOrder: null },
      { id: 'application-3', applicationOrder: 5 },
    ],
    semesterCourses: [
      { id: 'course-genesis', courseName: '창세기' },
      { id: 'course-matthew', courseName: '마태복음' },
    ],
    choices: [
      { applicationId: 'application-1', semesterCourseId: 'course-matthew', preference: 2 },
      { applicationId: 'application-1', semesterCourseId: 'course-genesis', preference: 1 },
      { applicationId: 'application-2', semesterCourseId: 'course-genesis', preference: null },
    ],
  };

  const summaries = draftApplicationSummaries(snapshot);
  assert.deepEqual(summaries.get('application-1'), { applicationOrder: 4, choices: '1. 창세기 · 2. 마태복음' });
  assert.deepEqual(summaries.get('application-2'), { applicationOrder: null, choices: '순위 미정: 창세기' });
  assert.deepEqual(summaries.get('application-3'), { applicationOrder: 5, choices: '희망 강좌 없음' });
  assert.equal(snapshot.choices[0].preference, 2);
});

test('filters a long draft list by the member, visible course, and result category', () => {
  const cases = [
    { request: { query: '김새', result: 'ALL' }, expected: ['member-kim'] },
    { request: { query: '발성', result: 'ALL' }, expected: ['member-lee'] },
    { request: { query: '', result: 'PREFERENCE_ALLOCATED' }, expected: ['member-park'] },
    { request: { query: '', result: 'RANDOM_FALLBACK' }, expected: ['member-kim'] },
    { request: { query: '', result: 'AUTO_REJECTED' }, expected: ['member-lee'] },
    { request: { query: '', result: 'MANUAL_CHANGED' }, expected: ['member-lee'] },
  ];

  for (const { request, expected } of cases) {
    assert.deepEqual(
      filterDraftItems(items, { ...request, courseName }).map(({ memberId }) => memberId),
      expected,
    );
  }
});

test('shows draft members in numeric application order, with members added without applications last', () => {
  const applications = new Map([1, 10, 2, 20, 11].map((order) => [`application-${order}`, { applicationOrder: order }]));
  const rows = [10, 1, 20, 2, 11].map((order) => ({
    memberId: `member-${order}`, memberNameAtGeneration: `회원${order}`,
    sourceApplicationId: `application-${order}`,
    finalSemesterCourseId: order === 1 ? 'course-matthew' : 'course-genesis',
  }));
  rows.push({ memberId: 'manual', memberNameAtGeneration: '관리자 추가', sourceApplicationId: null, finalSemesterCourseId: 'course-genesis' });

  assert.deepEqual(
    sortDraftItems(rows, { applications, courseView: false, courseName }).map(({ memberId }) => memberId),
    ['member-1', 'member-2', 'member-10', 'member-11', 'member-20', 'manual'],
  );
  assert.deepEqual(
    sortDraftItems(rows, { applications, courseView: true, courseName }).map(({ memberId }) => memberId),
    ['member-2', 'member-10', 'member-11', 'member-20', 'manual', 'member-1'],
  );
  assert.equal(rows[0].memberId, 'member-10');
});

test('sorts draft results by selected application order or member name', () => {
  const applications = new Map([
    ['a', { applicationOrder: 10 }], ['b', { applicationOrder: 2 }], ['c', { applicationOrder: 1 }],
  ]);
  const rows = [
    { memberId: 'a', memberNameAtGeneration: '다솔', sourceApplicationId: 'a', finalSemesterCourseId: 'course-voice' },
    { memberId: 'b', memberNameAtGeneration: '가람', sourceApplicationId: 'b', finalSemesterCourseId: 'course-voice' },
    { memberId: 'c', memberNameAtGeneration: '나래', sourceApplicationId: 'c', finalSemesterCourseId: 'course-voice' },
  ];
  const cases = [
    { sort: 'ORDER_ASC', expected: ['c', 'b', 'a'] },
    { sort: 'ORDER_DESC', expected: ['a', 'b', 'c'] },
    { sort: 'NAME_ASC', expected: ['b', 'c', 'a'] },
    { sort: 'NAME_DESC', expected: ['a', 'c', 'b'] },
  ];
  for (const { sort, expected } of cases) {
    assert.deepEqual(
      sortDraftItems(rows, { applications, courseView: false, courseName, sort }).map(({ memberId }) => memberId),
      expected,
      sort,
    );
  }
});

test('builds valid administrator decisions for changing, excluding, and restoring a draft result', () => {
  const automatic = { autoDecision: 'SELECTED', autoSemesterCourseId: 'course-acting' };
  const cases = [
    {
      courseId: 'course-voice',
      expected: {
        finalDecision: 'SELECTED', finalSemesterCourseId: 'course-voice', finalReasonCode: 'ADMIN_OVERRIDE',
        finalReasonDetail: { note: '관리자가 최종 배정 강좌를 변경했습니다.' },
      },
    },
    {
      courseId: '',
      expected: {
        finalDecision: 'REJECTED', finalSemesterCourseId: null, finalReasonCode: 'ADMIN_EXCLUDED',
        finalReasonDetail: { note: '관리자가 최종 배정에서 제외했습니다.' },
      },
    },
    {
      courseId: 'course-acting',
      expected: {
        finalDecision: 'SELECTED', finalSemesterCourseId: 'course-acting', finalReasonCode: null,
        finalReasonDetail: null,
      },
    },
  ];

  for (const { courseId, expected } of cases) {
    assert.deepEqual(draftFinalSelection(automatic, courseId), expected);
  }
});

test('marks a draft row only when the administrator decision differs from the automatic result', () => {
  const cases = [
    { item: { autoDecision: 'SELECTED', autoSemesterCourseId: 'course-acting', finalDecision: 'SELECTED', finalSemesterCourseId: 'course-acting' }, expected: false },
    { item: { autoDecision: 'SELECTED', autoSemesterCourseId: 'course-acting', finalDecision: 'SELECTED', finalSemesterCourseId: 'course-voice' }, expected: true },
    { item: { autoDecision: 'SELECTED', autoSemesterCourseId: 'course-acting', finalDecision: 'REJECTED', finalSemesterCourseId: null }, expected: true },
    { item: { autoDecision: 'REJECTED', autoSemesterCourseId: null, finalDecision: 'REJECTED', finalSemesterCourseId: null }, expected: false },
    { item: { autoDecision: 'REJECTED', autoSemesterCourseId: null, finalDecision: 'SELECTED', finalSemesterCourseId: 'course-voice' }, expected: true },
    { item: { autoDecision: 'NOT_EVALUATED', autoSemesterCourseId: null, finalDecision: 'REJECTED', finalSemesterCourseId: null }, expected: false },
    { item: { autoDecision: 'NOT_EVALUATED', autoSemesterCourseId: null, finalDecision: 'SELECTED', finalSemesterCourseId: 'course-voice' }, expected: false },
  ];

  for (const { item, expected } of cases) assert.equal(draftDecisionChanged(item), expected);
});

test('describes every preference attempt, fallback candidate, and administrator change', () => {
  const item = {
    autoDecision: 'SELECTED', autoSemesterCourseId: 'course-photo', autoReasonCode: 'RANDOM_FALLBACK',
    finalDecision: 'SELECTED', finalSemesterCourseId: 'course-voice', finalReasonCode: 'ADMIN_OVERRIDE',
    autoReasonDetail: {
      preferenceAttempts: [
        { preference: 2, courseNameAtGeneration: '발성', reasonCode: 'ALREADY_TAKEN' },
        { preference: 1, courseNameAtGeneration: '연기', reasonCode: 'CAPACITY_FULL' },
      ],
      fallback: {
        stageCandidateSemesterCourseIds: ['course-photo', 'course-voice'],
        selectedSemesterCourseId: 'course-photo',
        reasonCode: 'RANDOM_FALLBACK',
        totalAssignedInStage: 2,
      },
    },
  };

  assert.deepEqual(describeAllocationEvidence(item, courseName), [
    '1순위 연기: 당시 정원 경쟁 탈락',
    '2순위 발성: 과거 수강',
    '대체 후보: 사진, 발성',
    '대체 선택: 사진 · 대체 단계 총 2명 배정',
    '관리자 변경: 관리자 변경 · 최종 발성',
  ]);
});
