import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { orderSemesters, currentSemester } from '../../frontend/dashboard-view.js';
import { applicationSemesterFilterValue } from '../../frontend/list-view.js';

const source = await readFile(new URL('../../frontend/app.js', import.meta.url), 'utf8');
const appFunction = (name) => {
  const start = source.indexOf(`const ${name} =`);
  return source.slice(start, source.indexOf('\n};', start) + 3);
};

test('reloads saved records using the catalog and filters shown to the user', async () => {
  const oldSemester = { id: 'old', name: 'Old semester', order: 1 };
  const newSemester = { id: 'new', name: 'New semester', order: 2 };
  const cases = [
    { action: 'submitApplication', touched: false, expectedSemester: 'new', expectedPage: 1 },
    { action: 'commitImport', touched: false, expectedSemester: 'new', expectedPage: 1, expectedReport: 'new' },
    { action: 'submitEnrollment', touched: false, expectedSemester: 'new', expectedPage: 1, expectedReport: 'new' },
    { action: 'submitApplication', touched: true, expectedSemester: 'old', expectedPage: 2 },
  ];

  for (const request of cases) {
    const semesterSelect = { value: 'old' };
    const submit = { disabled: false };
    const inputs = {
      semesterName: { value: 'New semester' }, memberName: { value: 'Member' },
      applicationOrder: { value: '1' }, courseId: { value: '' }, newCourseName: { value: 'Course' },
    };
    const choice = { querySelector: (selector) => ({ value: selector.includes('preference') ? '1' : 'Course' }) };
    const entry = {
      querySelector: (selector) => selector === '.choice-fields'
        ? { children: [choice] }
        : inputs[selector.slice(7, -2)],
    };
    const nodes = {
      'application-entry-rows': { children: [entry] }, 'enrollment-entry-rows': { children: [entry] },
      'application-dialog': { close() {} }, 'enrollment-dialog': { close() {} },
      'application-semester-filter': semesterSelect, 'import-preview-status': {}, 'commit-import': {},
    };
    const queries = [];
    let reportSemester;
    const context = vm.createContext({
      state: {
        semesters: [oldSemester], courses: [], applicationSemesterFilterTouched: request.touched,
        pagination: { application: { page: 2 } },
        importPreview: { kind: 'APPLICATIONS', previewId: 'preview', applications: [], contextChanges: [] },
      },
      byId: (id) => nodes[id],
      api: async (path) => {
        if (path.startsWith('/semesters?')) return { items: [newSemester, oldSemester] };
        if (path.endsWith('/enrollment-report')) {
          reportSemester = path.split('/')[2];
          return { finalized: false };
        }
        return { items: [] };
      },
      loadPaged: async (name, _path, filter) => {
        queries.push({ name, filter });
        return [{ semesterId: filter }];
      },
      recordQuery: () => semesterSelect.value,
      renderApplications() {}, renderEnrollments() {}, fillDatalist() {},
      fillFilterSelect: (id) => { if (id === 'application-semester-filter') semesterSelect.value = 'old'; },
      orderSemesters, currentSemester, applicationSemesterFilterValue,
      run: async (action) => action(), reviewWarnings: async () => '',
      crypto: { randomUUID: () => 'idempotency-key' },
    });
    const functions = [
      'loadApplications', 'loadEnrollments', 'loadCatalogs', 'submitApplication', 'submitEnrollment', 'commitImport',
    ].map(appFunction).join('\n');
    vm.runInContext(`${functions}\nconst enrollmentCourseName = () => 'Course';\nglobalThis.save = ${request.action};`, context);
    await context.save({ preventDefault() {}, currentTarget: { dataset: {}, querySelector: () => submit } });

    assert.equal(semesterSelect.value, request.expectedSemester, request.action);
    assert.equal(context.state.pagination.application.page, request.expectedPage, request.action);
    for (const query of queries.filter(({ name }) => name === 'application')) {
      assert.equal(query.filter, request.expectedSemester, request.action);
      assert.equal(context.state.applications[0].semesterId, request.expectedSemester, request.action);
    }
    if (request.expectedReport) assert.equal(reportSemester, request.expectedReport, request.action);
  }
});

test('clears a semester selection when another semester replaces the editor context', async () => {
  for (const action of ['changeCourseSemester', 'moveOtherSemester']) {
    const semesters = [{ id: 'a', name: 'Semester A', order: 2 }, { id: 'b', name: 'Semester B', order: 1 }];
    const semesterForm = { elements: { name: {} }, hidden: true };
    const select = { value: '' };
    const nodes = {
      'catalog-semester': select, 'semester-form': semesterForm, 'catalog-form': {},
      'catalog-course-rows': { replaceChildren() {} }, 'catalog-course-empty': {},
      'catalog-empty': {}, 'copy-catalog-courses': {},
      'catalog-semester-rows': { children: semesters.map(({ id }) => ({ dataset: { id }, focus() {} })) },
    };
    const context = vm.createContext({
      state: { semesters, selectedSemesterId: null, catalogContext: null },
      byId: (id) => nodes[id],
      api: async (path) => ({
        semester: semesters.find(({ id }) => id === path.split('/')[2]), semesterCourses: [],
      }),
      renderSemesterRows() {}, catalogCourseRow() {}, fillSelect: () => { select.value = ''; },
      loadCatalogs: async () => {}, run: async (operation) => operation(),
    });
    const functions = ['selectSemesterRow', 'loadCatalogManagement', 'renderCatalogContext', 'moveSemester'].map(appFunction).join('\n');
    vm.runInContext(`${functions}\nglobalThis.selectSemesterRow = selectSemesterRow; globalThis.loadCatalogManagement = loadCatalogManagement; globalThis.moveSemester = moveSemester;`, context);

    await context.selectSemesterRow('a');
    assert.equal(semesterForm.hidden, false);
    if (action === 'changeCourseSemester') {
      select.value = 'b';
      await context.loadCatalogManagement();
    } else {
      await context.moveSemester(semesters[1], 'UP');
    }
    assert.equal(context.state.selectedSemesterId, null, action);
    assert.equal(semesterForm.hidden, true, action);

    await context.selectSemesterRow('a');
    assert.equal(context.state.selectedSemesterId, 'a', action);
    assert.equal(semesterForm.hidden, false, action);
    assert.equal(semesterForm.elements.name.value, 'Semester A', action);
  }
});
