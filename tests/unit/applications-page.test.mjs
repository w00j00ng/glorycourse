import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplicationsPage } from '../../frontend/applications-page.js';

test('a selected semester opens an application template with its courses and downloads that semester', async () => {
  const semesterId = { value: '' };
  const form = { elements: { semesterId }, reset: () => { semesterId.value = ''; } };
  const summary = { textContent: '' };
  const opened = [];
  const closed = [];
  const downloads = [];
  const nodes = {
    'application-template-form': form,
    'application-template-summary': summary,
    'application-template-dialog': { showModal: () => opened.push(true), close: () => closed.push(true) },
    'application-semester-filter': { value: 'semester-2' },
  };
  const page = createApplicationsPage({
    state: { semesters: [{ id: 'semester-2', name: '현재 학기' }] },
    byId: (id) => nodes[id],
    api: async (path) => {
      assert.equal(path, '/semesters/semester-2/context');
      return { semester: { name: '현재 학기' }, semesterCourses: [{ id: 'course-1' }] };
    },
    fillSelect: () => {}, showMessage: () => {},
    run: (action) => action(),
    download: async (path, filename) => { downloads.push({ path, filename }); },
  });

  page.openTemplate();
  await page.showTemplateSummary();
  assert.deepEqual(opened, [true]);
  assert.equal(semesterId.value, 'semester-2');
  assert.equal(summary.textContent, '현재 학기의 개설 강좌 1개를 양식에 포함합니다.');

  await page.downloadTemplate({ preventDefault() {}, currentTarget: form });
  assert.equal(downloads[0].path, '/applications/template?semesterId=semester-2');
  assert.match(downloads[0].filename, /^수강신청.*\d{12}\.xlsx$/);
  assert.deepEqual(closed, [true]);
});

test('the application list shows its current rows, choices, actions, and empty state', () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }) };
  try {
    const rows = { children: [], replaceChildren(...items) { this.children = items; } };
    const empty = { hidden: true };
    const count = { textContent: '' };
    const choiceCount = { textContent: '' };
    const nodes = {
      'application-rows': rows, 'application-empty': empty,
      'application-count': count, 'choice-count': choiceCount,
    };
    const state = {
      applications: [{ memberName: '홍길동', semesterName: '2026 봄', applicationOrder: 2,
        applicationOrderStatus: 'NORMAL', choices: [{ courseName: '창세기' }] }],
      pagination: { application: { total: 12 } }, semesters: [],
    };
    const page = createApplicationsPage({
      state, byId: (id) => nodes[id],
      cell: (value) => ({ value }), choicesCell: (choices) => ({ choices }),
      badgeCell: (text) => ({ text }), actionsCell: (...actions) => ({ actions }),
      openApplication() {}, deleteApplication() {},
    });

    page.renderApplications();
    assert.equal(rows.children[0].children[0].value, '홍길동');
    assert.equal(rows.children[0].children[3].choices[0].courseName, '창세기');
    assert.deepEqual(rows.children[0].children[5].actions.map(([name]) => name), ['수정', '삭제']);
    assert.equal(count.textContent, '12');
    assert.equal(choiceCount.textContent, '1');
    assert.equal(empty.hidden, true);

    state.applications = [];
    page.renderApplications();
    assert.equal(rows.children.length, 0);
    assert.equal(empty.hidden, false);
    assert.equal(choiceCount.textContent, '0');
  } finally { globalThis.document = previousDocument; }
});
