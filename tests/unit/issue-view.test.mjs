import assert from 'node:assert/strict';
import test from 'node:test';

import { issueText } from '../../frontend/issue-view.js';

test('shows allocation and enrollment problems in Korean with the affected person and course', () => {
  const cases = [
    {
      issue: { code: 'CAPACITY_EXCEEDED', severity: 'WARNING', message: 'Course capacity would be exceeded' },
      context: { memberName: '김은혜', courseName: '창세기' },
      expected: '주의 · 김은혜 · 창세기: 강좌 정원을 초과합니다. 인원을 조정하거나, 그대로 진행하려면 사유를 입력하세요.',
    },
    {
      issue: { code: 'SAME_SEMESTER_ENROLLMENT', severity: 'ERROR', message: 'A member can have only one enrollment per semester' },
      context: { memberName: '김은혜' },
      expected: '오류 · 김은혜: 같은 학기에 수강이력이 이미 있습니다. 기존 이력을 확인하세요.',
    },
    {
      issue: { code: 'RETAKE', severity: 'WARNING', message: 'Member has completed this course in an earlier semester', detail: { rowNumber: 2 } },
      expected: '주의 · 2행: 이전 학기에 수강한 강좌입니다. 다시 등록하려면 사유를 입력하세요.',
    },
  ];
  for (const { issue, context, expected } of cases) assert.equal(issueText(issue, context), expected);
});

test('shows Excel review problems with their sheet and row instead of internal status codes', () => {
  const cases = [
    {
      issue: { code: 'SEMESTER_COURSE_CAPACITY_EXISTING_CONFLICT', severity: 'WARNING', message: 'SEMESTER_COURSE capacity requires review', source: { sheet: '개설강좌', row: 3, column: '정원' } },
      expected: '주의 · 개설강좌 시트 3행 정원: 파일의 정원이 기존 값과 다릅니다. 아래에서 유지할 값을 선택하세요.',
    },
    {
      issue: { code: 'APPLICATION_ORDER_MISSING', severity: 'WARNING', message: 'Application order is missing', source: { sheet: '수강신청', row: 2, column: '신청순서' } },
      expected: '주의 · 수강신청 시트 2행 신청순서: 신청순서가 비어 있습니다. 아래에서 순서를 입력하세요.',
    },
    {
      issue: { code: 'SEMESTER_ORDER_UNRESOLVED', severity: 'INFO', message: 'Semester order is unresolved', source: { sheet: '수강이력', row: 2 } },
      expected: '안내 · 수강이력 시트 2행: 새 학기는 다음 순서로 등록됩니다.',
    },
    {
      issue: { code: 'CAPACITY_UNRESOLVED', severity: 'INFO', message: 'Course capacity is unresolved', source: { sheet: '수강이력', row: 2 } },
      expected: '안내 · 수강이력 시트 2행: 새 개설강좌는 정원 미정으로 등록됩니다.',
    },
    {
      issue: { code: 'SEMESTER_COURSE_CAPACITY_MISSING', severity: 'ERROR', message: 'Course capacity is required', source: { sheet: '개설강좌', row: 3, column: '정원' } },
      expected: '오류 · 개설강좌 시트 3행 정원: 강좌 정원을 입력하세요. 0명도 입력할 수 있습니다.',
    },
    {
      issue: { code: 'FORMULA_NOT_ALLOWED', message: 'Formula cells are not evaluated or imported', location: '수강신청!C2' },
      expected: '오류 · 수강신청 C2: 수식은 가져올 수 없습니다. 계산된 값을 입력한 뒤 다시 올리세요.',
    },
  ];
  for (const { issue, expected } of cases) assert.equal(issueText(issue), expected);
});

test('keeps Korean recovery guidance and does not expose unknown English diagnostics', () => {
  assert.equal(issueText({ code: 'RESTORE_REPLACES_CURRENT_DATA', severity: 'WARNING', message: '백업 이후의 현재 자료가 사라집니다.' }), '주의: 백업 이후의 현재 자료가 사라집니다. 계속하려면 복원 내용을 확인하세요.');
  assert.equal(issueText({ code: 'APPLICATION_INPUT_INVALID', severity: 'ERROR', message: '1행: courseName must contain between 1 and 200 characters', detail: { rowNumber: 1 } }), '오류 · 1행: 수강신청 입력값을 확인하세요.');
  assert.equal(issueText({ code: 'SEMESTER_COURSES_CHANGED', severity: 'WARNING', message: 'Allocation input changed after this draft was created' }), '주의: 초안 생성 후 개설강좌가 변경되었습니다. 초안을 다시 만드세요.');
  assert.equal(issueText({ code: 'FUTURE_RULE', severity: 'ERROR', message: 'Internal future error' }), '오류: 자료를 확인한 뒤 다시 시도하세요.');
  assert.equal(issueText({ code: 'FUTURE_ROW_RULE', severity: 'ERROR', message: '1행: Internal future error', detail: { rowNumber: 1 } }), '오류 · 1행: 자료를 확인한 뒤 다시 시도하세요.');
});
