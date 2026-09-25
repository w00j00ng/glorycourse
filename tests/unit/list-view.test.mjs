import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applicationSemesterFilterValue,
  choiceSummary,
  paginationView,
  viewFromHash,
} from '../../frontend/list-view.js';

test('shows preferred courses in one ordered line', () => {
  assert.equal(choiceSummary([
    { courseName: '마태복음', preference: 2 },
    { courseName: '창세기', preference: 1 },
    { courseName: '마가복음', preference: 3 },
  ]), '1순위 창세기 · 2순위 마태복음 · 3순위 마가복음');
});

test('describes empty, first, middle, and last list pages', () => {
  const cases = [
    { page: { page: 1, limit: 50, total: 0 }, expected: { label: '총 0건', previousDisabled: true, nextDisabled: true } },
    { page: { page: 1, limit: 50, total: 120 }, expected: { label: '1–50 / 총 120건', previousDisabled: true, nextDisabled: false } },
    { page: { page: 2, limit: 50, total: 120 }, expected: { label: '51–100 / 총 120건', previousDisabled: false, nextDisabled: false } },
    { page: { page: 3, limit: 50, total: 120 }, expected: { label: '101–120 / 총 120건', previousDisabled: false, nextDisabled: true } },
    { page: { page: 1, limit: 10, total: 25 }, expected: { label: '1–10 / 총 25건', previousDisabled: true, nextDisabled: false } },
    { page: { page: 2, limit: 20, total: 25 }, expected: { label: '21–25 / 총 25건', previousDisabled: false, nextDisabled: true } },
  ];

  for (const { page, expected } of cases) assert.deepEqual(paginationView(page), expected);
});

test('restores a known page from the URL and falls back to home', () => {
  assert.equal(viewFromHash('#home'), 'home');
  assert.equal(viewFromHash('#enrollments'), 'enrollments');
  assert.equal(viewFromHash('#drafts'), 'drafts');
  assert.equal(viewFromHash('#catalog'), 'catalog');
  assert.equal(viewFromHash('#backups'), 'backups');
  assert.equal(viewFromHash(''), 'home');
  assert.equal(viewFromHash('#unknown'), 'home');
});

test('starts applications at the current semester and respects a manually chosen filter', () => {
  const semesters = [
    { id: 'old', name: '과거 자료', order: null },
    { id: 'fall', name: '가을학기', order: 2 },
    { id: 'spring', name: '봄학기', order: 1 },
  ];
  const newerSemesters = [{ id: 'winter', name: '겨울학기', order: 3 }, ...semesters];
  const cases = [
    { name: 'first visit', semesters, selected: '', userSelected: false, expected: 'fall' },
    { name: 'new current semester', semesters: newerSemesters, selected: 'fall', userSelected: false, expected: 'winter' },
    { name: 'explicit all semesters', semesters, selected: '', userSelected: true, expected: '' },
    { name: 'explicit past semester', semesters, selected: 'spring', userSelected: true, expected: 'spring' },
    { name: 'no semester', semesters: [], selected: '', userSelected: false, expected: '' },
    { name: 'unordered history only', semesters: [semesters[0]], selected: '', userSelected: false, expected: '' },
  ];

  for (const { name, semesters: items, selected, userSelected, expected } of cases) {
    assert.equal(applicationSemesterFilterValue(items, selected, userSelected), expected, name);
  }
});
