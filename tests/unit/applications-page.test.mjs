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
