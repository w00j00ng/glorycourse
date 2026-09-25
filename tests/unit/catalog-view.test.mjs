import assert from 'node:assert/strict';
import test from 'node:test';

import { copySemesterCourses, parseSemesterCourses } from '../../frontend/catalog-view.js';

test('copies multiple semester courses with capacity and skips courses already in the current semester', () => {
  assert.deepEqual(copySemesterCourses(
    [' 연기 '],
    [
      { courseName: '연기', capacity: 10 },
      { courseName: '발성', capacity: 8 },
      { courseName: ' 발성 ', capacity: 9 },
      { courseName: '합창', capacity: null },
    ],
  ), [
    { courseName: '발성', capacity: 8 },
    { courseName: '합창', capacity: null },
  ]);
});

test('parses typed and spreadsheet course rows with required capacity, including zero', () => {
  assert.deepEqual(parseSemesterCourses('창세기, 10\r\n마태복음\t20\n마가복음, 0'), {
    courses: [
      { courseName: '창세기', capacity: 10 },
      { courseName: '마태복음', capacity: 20 },
      { courseName: '마가복음', capacity: 0 },
    ],
    errors: [],
  });
});

test('reports the row number for invalid course names and capacities', () => {
  assert.deepEqual(parseSemesterCourses(`, 10\n합창, 열명\n${'가'.repeat(201)}, 1\n연기, 1, 초과\n창세기\n마태복음, `), {
    courses: [],
    errors: [
      '1행: 강좌명을 입력하세요.',
      '2행: 정원은 0 이상의 정수로 입력하세요.',
      '3행: 강좌명은 200자 이하로 입력하세요.',
      '4행: 강좌명과 정원만 입력하세요.',
      '5행: 정원을 입력하세요.',
      '6행: 정원을 입력하세요.',
    ],
  });
});
