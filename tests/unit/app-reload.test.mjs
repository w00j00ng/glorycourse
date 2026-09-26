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
    { action: 'commitImport', touched: false, expectedSemester: 'new', expectedPage: 1, expectedReport: 'new' },
    { action: 'submitEnrollment', touched: false, expectedSemester: 'new', expectedPage: 1, expectedReport: 'new' },
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
      'enrollment-entry-rows': { children: [entry] }, 'enrollment-dialog': { close() {} },
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
        if (path.startsWith('/semesters?')) return { items: [newSemester, oldSemester], page: 1, limit: 200, total: 2 };
        if (path.endsWith('/enrollment-report')) {
          reportSemester = path.split('/')[2];
          return { finalized: false };
        }
        return { items: [], page: 1, limit: 200, total: 0 };
      },
      loadPaged: async (name, _path, filter) => {
        queries.push({ name, filter });
        return [{ semesterId: filter }];
      },
      recordQuery: () => semesterSelect.value,
      loadApplications: async () => {
        const items = await context.loadPaged('application', '/applications', semesterSelect.value);
        context.state.applications = items;
      },
      renderEnrollments() {}, fillDatalist() {},
      fillFilterSelect: (id) => { if (id === 'application-semester-filter') semesterSelect.value = 'old'; },
      orderSemesters, currentSemester, applicationSemesterFilterValue,
      run: async (action) => action(), reviewWarnings: async () => '',
      crypto: { randomUUID: () => 'idempotency-key' },
    });
    const functions = [
      'loadEnrollments', 'loadCatalogItems', 'loadCatalogs', 'submitEnrollment', 'commitImport',
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

test('keeps all catalog choices beyond 200 records and preserves the selected filters', async () => {
  for (const count of [0, 200, 201, 401]) {
    for (const touched of [false, true]) {
      const catalogs = Object.fromEntries(['semesters', 'members', 'courses'].map((name) => [name,
        Array.from({ length: count }, (_, index) => ({ id: `${name}-${index + 1}`, name: `${name} ${index + 1}`, order: index + 1 })),
      ]));
      const selectedSemester = count ? `semesters-${Math.max(1, count - 1)}` : '';
      const selectedCourse = count ? `courses-${count}` : '';
      const select = (value = '') => ({
        value, options: [],
        replaceChildren(...options) { this.options = options; this.value = options[0]?.value ?? ''; },
      });
      const nodes = {
        'semester-options': select(), 'member-options': select(), 'course-options': select(),
        'application-semester-filter': select(selectedSemester), 'application-course-filter': select(selectedCourse),
        'enrollment-semester-filter': select(selectedSemester), 'enrollment-course-filter': select(selectedCourse),
        'draft-add-member': select(), 'draft-add-course': select(),
      };
      const requested = [];
      const context = vm.createContext({
        state: {
          semesters: [], members: [], courses: [], applicationSemesterFilterTouched: touched,
          pagination: { application: { page: 2 } },
          draft: { studentResults: [{ memberId: 'members-1' }] }, draftContext: { semesterCourses: [] },
        },
        byId: (id) => nodes[id], document: { createElement: () => ({}) },
        orderSemesters, applicationSemesterFilterValue,
        api: async (path) => {
          const url = new URL(path, 'http://localhost');
          const items = catalogs[url.pathname.slice(1)];
          const page = Number(url.searchParams.get('page') ?? 1);
          const limit = Number(url.searchParams.get('limit'));
          requested.push({ path: url.pathname, page });
          return { items: items.slice((page - 1) * limit, page * limit), page, limit, total: items.length };
        },
      });
      const functions = ['loadCatalogItems', 'loadCatalogs', 'fillSelect', 'fillFilterSelect', 'fillDatalist', 'fillDraftAddFields'].map(appFunction).join('\n');
      vm.runInContext(`${functions}\nglobalThis.load = loadCatalogs; globalThis.fillMembers = fillDraftAddFields;`, context);
      await context.load();
      context.fillMembers();

      for (const [name, items] of Object.entries(catalogs)) {
        assert.equal(context.state[name].length, count, `${name}: complete catalog`);
        assert.equal(nodes[`${name.slice(0, -1)}-options`].options.length, count, `${name}: all suggestions`);
        assert.deepEqual(requested.filter(({ path }) => path === `/${name}`).map(({ page }) => page),
          Array.from({ length: Math.max(1, Math.ceil(count / 200)) }, (_, index) => index + 1));
        if (count) assert.ok(context.state[name].some(({ id }) => id === items.at(-1).id), `${name}: last record`);
      }
      assert.equal(nodes['application-semester-filter'].value, touched ? selectedSemester : count ? `semesters-${count}` : '');
      assert.equal(nodes['enrollment-semester-filter'].value, selectedSemester);
      assert.equal(nodes['application-course-filter'].value, selectedCourse);
      assert.equal(nodes['enrollment-course-filter'].value, selectedCourse);
      assert.equal(nodes['draft-add-member'].options.length, Math.max(0, count - 1) + 1);
      if (count) assert.equal(nodes['draft-add-member'].options.at(-1).value, `members-${count}`);
      assert.equal(context.state.pagination.application.page, !touched && count > 1 ? 1 : 2);
    }
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

test('keeps the latest list and page when earlier filter or page requests finish later', async () => {
  const cases = [
    { name: 'enrollment', loader: 'loadEnrollments', rows: 'enrollments' },
    { name: 'draft', loader: 'loadDrafts', rows: 'drafts' },
  ];
  for (const request of cases) {
    for (const oldTotal of [0, 100]) {
      const pending = [];
      const rendered = [];
      let filter = 'semesterId=old';
      const context = vm.createContext({
        state: { semesters: [], pagination: { [request.name]: { page: 2, limit: 50, total: 100 } } },
        URLSearchParams, currentSemester,
        api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
        recordQuery: () => filter, renderPagination() {},
        renderEnrollments: () => rendered.push(context.state.enrollments),
        renderDrafts: () => rendered.push(context.state.drafts),
      });
      vm.runInContext(`${appFunction('loadPaged')}\n${appFunction(request.loader)}\nglobalThis.load = ${request.loader};`, context);
      const earlier = context.load();
      filter = 'semesterId=new';
      context.state.pagination[request.name].page = 1;
      context.state.pagination[request.name].limit = 25;
      const latest = context.load();
      assert.match(pending[0].path, /page=2&limit=50/);
      assert.match(pending[1].path, /page=1&limit=25/);
      if (request.name !== 'draft') {
        assert.match(pending[0].path, /semesterId=old/);
        assert.match(pending[1].path, /semesterId=new/);
      }
      pending[1].resolve({ items: [{ id: 'latest' }], page: 1, limit: 25, total: 1 });
      await latest;
      pending[0].resolve({ items: [{ id: 'earlier' }], page: 2, limit: 50, total: oldTotal });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(pending.length, 2, `${request.name}: stale pages must not trigger another request`);
      await earlier;
      assert.equal(context.state[request.rows][0].id, 'latest', request.name);
      assert.deepEqual(rendered.map((items) => items[0].id), ['latest'], request.name);
      const { page, limit, total } = context.state.pagination[request.name];
      assert.deepEqual({ page, limit, total }, { page: 1, limit: 25, total: 1 }, request.name);
    }
  }
});

test('corrects a removed enrollment page without letting its retry replace a newer list', async () => {
  for (const interrupted of [false, true]) {
    const pending = [];
    const context = vm.createContext({
      state: { semesters: [], pagination: { enrollment: { page: 3, limit: 50 } } },
      URLSearchParams, api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
      currentSemester, recordQuery: () => '', renderPagination() {}, renderEnrollments() {},
    });
    vm.runInContext(`${appFunction('loadPaged')}\n${appFunction('loadEnrollments')}\nglobalThis.load = loadEnrollments;`, context);
    const correcting = context.load();
    pending[0].resolve({ items: [], page: 3, limit: 50, total: 51 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(pending[1].path, /page=2&limit=50/);
    if (interrupted) {
      context.state.pagination.enrollment.page = 1;
      const latest = context.load();
      pending[2].resolve({ items: [{ id: 'latest' }], page: 1, limit: 50, total: 1 });
      await latest;
    }
    pending[1].resolve({ items: [{ id: 'corrected' }], page: 2, limit: 50, total: 51 });
    await correcting;
    assert.equal(context.state.enrollments[0].id, interrupted ? 'latest' : 'corrected');
    assert.equal(context.state.pagination.enrollment.page, interrupted ? 1 : 2);
    assert.equal(context.state.pagination.enrollment.total, interrupted ? 1 : 51);
  }
});

test('keeps the latest enrollment report when an earlier report finishes later', async () => {
  const reports = [];
  const rendered = [];
  let list = 0;
  const context = vm.createContext({
    state: { semesters: [{ id: 'semester', order: 1 }], pagination: { enrollment: { page: 1, limit: 50 } } },
    URLSearchParams, currentSemester,
    api: (path) => path.endsWith('/enrollment-report')
      ? new Promise((resolve) => reports.push(resolve))
      : Promise.resolve({ items: [{ id: ++list }], page: 1, limit: 50, total: 1 }),
    recordQuery: () => '', renderPagination() {},
    renderEnrollments: () => rendered.push(context.state.enrollmentReport),
  });
  vm.runInContext(`${appFunction('loadPaged')}\n${appFunction('loadEnrollments')}\nglobalThis.load = loadEnrollments;`, context);
  const earlier = context.load();
  await new Promise((resolve) => setImmediate(resolve));
  const latest = context.load();
  await new Promise((resolve) => setImmediate(resolve));
  reports[1]({ finalized: true, enrollmentReportIsCurrent: true });
  await latest;
  reports[0]({ finalized: true, enrollmentReportIsCurrent: false });
  await earlier;
  assert.equal(context.state.enrollmentReport, null);
  assert.equal(context.state.enrollments[0].id, 2);
  assert.deepEqual(rendered, [null]);
});

test('shows only the latest semester editor when semester selections finish out of order', async () => {
  for (const sequence of [['a', 'b'], ['a', 'b', 'a'], ['a', null]]) {
    const semesters = [{ id: 'a', name: 'Semester A' }, { id: 'b', name: 'Semester B' }];
    const select = { value: '' };
    const nodes = {
      'catalog-semester': select, 'semester-form': { elements: { name: {} }, hidden: false },
      'catalog-form': { hidden: false }, 'catalog-empty': {}, 'catalog-course-empty': {},
      'catalog-course-rows': { replaceChildren() {} }, 'copy-catalog-courses': {},
    };
    const pending = [];
    const context = vm.createContext({
      state: { semesters, selectedSemesterId: null, catalogContext: { semester: semesters[0] } },
      byId: (id) => nodes[id],
      api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
      fillSelect: () => { select.value = ''; }, renderSemesterRows() {}, catalogCourseRow() {},
    });
    const functions = ['selectSemesterRow', 'loadCatalogManagement', 'renderCatalogContext'].map(appFunction).join('\n');
    vm.runInContext(`${functions}\nglobalThis.select = selectSemesterRow; globalThis.load = loadCatalogManagement;`, context);
    const requests = [];
    for (const id of sequence) {
      if (id) requests.push(context.select(id));
      else { context.state.semesters = []; requests.push(context.load()); }
    }
    assert.equal(nodes['semester-form'].hidden, true, 'old semester editor is unavailable while loading');
    assert.equal(nodes['catalog-form'].hidden, true, 'old courses are unavailable while loading');
    for (let index = pending.length - 1; index >= 0; index--) {
      const semester = semesters.find(({ id }) => id === pending[index].path.split('/')[2]);
      pending[index].resolve({ semester: { ...semester, name: `${semester.name} ${index}` }, semesterCourses: [] });
      await requests[index];
    }
    await Promise.all(requests);
    const expected = sequence.at(-1);
    assert.equal(context.state.catalogContext?.semester.id ?? null, expected);
    assert.equal(nodes['semester-form'].hidden, !expected);
    if (expected) assert.equal(nodes['semester-form'].elements.name.value, `Semester ${expected.toUpperCase()} ${sequence.length - 1}`);
  }
});
