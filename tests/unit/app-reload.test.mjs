import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { orderSemesters, currentSemester } from '../../frontend/dashboard-view.js';
import { createEnrollmentsPage } from '../../frontend/enrollments-page.js';
import { applicationSemesterFilterValue } from '../../frontend/list-view.js';

const source = await readFile(new URL('../../frontend/app.js', import.meta.url), 'utf8');
const appFunction = (name) => {
  const start = source.indexOf(`const ${name} =`);
  return source.slice(start, source.indexOf('\n};', start) + 3);
};

const enrollmentPage = (context, rendered = []) => {
  const nodes = new Map();
  const byId = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', hidden: false, disabled: false, textContent: '',
      replaceChildren() { if (id === 'enrollment-rows') rendered.push(context.state.enrollments); },
    });
    return nodes.get(id);
  };
  return createEnrollmentsPage({
    state: context.state, byId, showMessage() {}, api: context.api, loadPaged: context.loadPaged,
    async loadCatalogs() {},
    recordQuery: context.recordQuery, resourceName: () => 'Semester',
    cell: () => ({}), actionsCell: () => ({}), async reviewWarnings() { return ''; },
  });
};

const withEnrollmentDocument = async (action) => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ append() {} }) };
  try { return await action(); } finally { globalThis.document = previousDocument; }
};

test('reloads imported records using the catalog and filters shown to the user', async () => {
  const oldSemester = { id: 'old', name: 'Old semester', order: 1 };
  const newSemester = { id: 'new', name: 'New semester', order: 2 };
  const cases = [
    { action: 'commitImport', touched: false, expectedSemester: 'new', expectedPage: 1 },
  ];

  for (const request of cases) {
    const semesterSelect = { value: 'old' };
    const nodes = {
      'application-semester-filter': semesterSelect, 'import-preview-status': {}, 'commit-import': {},
    };
    const queries = [];
    let loadedSemester;
    const context = vm.createContext({
      catalogLoadRequest: 0,
      state: {
        semesters: [oldSemester], courses: [], applicationSemesterFilterTouched: request.touched,
        pagination: { application: { page: 2 } },
        importPreview: { kind: 'APPLICATIONS', previewId: 'preview', applications: [], contextChanges: [] },
      },
      byId: (id) => nodes[id],
      api: async (path) => {
        if (path.startsWith('/semesters?')) return { items: [newSemester, oldSemester], page: 1, limit: 200, total: 2 };
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
      loadEnrollments: async () => { loadedSemester = currentSemester(context.state.semesters)?.id; },
      fillDatalist() {},
      fillFilterSelect: (id) => { if (id === 'application-semester-filter') semesterSelect.value = 'old'; },
      orderSemesters, currentSemester, applicationSemesterFilterValue,
      run: async (action) => action(), reviewWarnings: async () => '',
      crypto: { randomUUID: () => 'idempotency-key' },
    });
    const functions = [
      'loadCatalogItems', 'loadCatalogs', 'commitImport',
    ].map(appFunction).join('\n');
    vm.runInContext(`${functions}\nglobalThis.save = ${request.action};`, context);
    await context.save();

    assert.equal(semesterSelect.value, request.expectedSemester, request.action);
    assert.equal(context.state.pagination.application.page, request.expectedPage, request.action);
    for (const query of queries.filter(({ name }) => name === 'application')) {
      assert.equal(query.filter, request.expectedSemester, request.action);
      assert.equal(context.state.applications[0].semesterId, request.expectedSemester, request.action);
    }
    assert.equal(loadedSemester, request.expectedSemester, request.action);
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
        catalogLoadRequest: 0,
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

test('keeps the latest draft list and page when earlier requests finish later', async () => {
  for (const oldTotal of [0, 100]) {
    const pending = [];
    const rendered = [];
    const context = vm.createContext({
      state: { pagination: { draft: { page: 2, limit: 50, total: 100 } } },
      URLSearchParams,
      api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
      renderPagination() {},
      renderDrafts: () => rendered.push(context.state.drafts),
    });
    vm.runInContext(`${appFunction('loadPaged')}\n${appFunction('loadDrafts')}\nglobalThis.load = loadDrafts;`, context);
    const earlier = context.load();
    context.state.pagination.draft.page = 1;
    context.state.pagination.draft.limit = 25;
    const latest = context.load();
    assert.match(pending[0].path, /page=2&limit=50/);
    assert.match(pending[1].path, /page=1&limit=25/);
    pending[1].resolve({ items: [{ id: 'latest' }], page: 1, limit: 25, total: 1 });
    await latest;
    pending[0].resolve({ items: [{ id: 'earlier' }], page: 2, limit: 50, total: oldTotal });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2);
    await earlier;
    assert.equal(context.state.drafts[0].id, 'latest');
    assert.deepEqual(rendered.map((items) => items[0].id), ['latest']);
    const { page, limit, total } = context.state.pagination.draft;
    assert.deepEqual({ page, limit, total }, { page: 1, limit: 25, total: 1 });
  }
});

test('corrects a removed enrollment page without letting its retry replace a newer list', async () => {
  await withEnrollmentDocument(async () => {
    for (const interrupted of [false, true]) {
      const pending = [];
      const context = vm.createContext({
        state: { semesters: [], pagination: { enrollment: { page: 3, limit: 50 } } },
        URLSearchParams, api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
        recordQuery: () => '', renderPagination() {},
      });
      vm.runInContext(`${appFunction('loadPaged')}\nglobalThis.loadPaged = loadPaged;`, context);
      const { load } = enrollmentPage(context);
      const correcting = load();
      pending[0].resolve({ items: [], page: 3, limit: 50, total: 51 });
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(pending[1].path, /page=2&limit=50/);
      if (interrupted) {
        context.state.pagination.enrollment.page = 1;
        const latest = load();
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
});

test('keeps the latest enrollment filter and page when an earlier request finishes later', async () => {
  await withEnrollmentDocument(async () => {
    for (const oldTotal of [0, 100]) {
      const pending = [];
      const rendered = [];
      let filter = 'semesterId=old';
      const context = vm.createContext({
        state: { semesters: [], pagination: { enrollment: { page: 2, limit: 50, total: 100 } } },
        URLSearchParams, api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
        recordQuery: () => filter, renderPagination() {},
      });
      vm.runInContext(`${appFunction('loadPaged')}\nglobalThis.loadPaged = loadPaged;`, context);
      const { load } = enrollmentPage(context, rendered);
      const earlier = load();
      filter = 'semesterId=new';
      context.state.pagination.enrollment.page = 1;
      context.state.pagination.enrollment.limit = 25;
      const latest = load();
      assert.match(pending[0].path, /semesterId=old.*page=2&limit=50/);
      assert.match(pending[1].path, /semesterId=new.*page=1&limit=25/);
      pending[1].resolve({ items: [{ id: 'latest' }], page: 1, limit: 25, total: 1 });
      await latest;
      pending[0].resolve({ items: [{ id: 'earlier' }], page: 2, limit: 50, total: oldTotal });
      await earlier;
      assert.equal(pending.length, 2);
      assert.equal(context.state.enrollments[0].id, 'latest');
      assert.deepEqual(rendered.map((items) => items[0].id), ['latest']);
      const { page, limit, total } = context.state.pagination.enrollment;
      assert.deepEqual({ page, limit, total }, { page: 1, limit: 25, total: 1 });
    }
  });
});

test('keeps the latest enrollment report when an earlier report finishes later', async () => {
  await withEnrollmentDocument(async () => {
    const reports = [];
    const rendered = [];
    let list = 0;
    const context = vm.createContext({
      state: { semesters: [{ id: 'semester', order: 1 }], pagination: { enrollment: { page: 1, limit: 50 } } },
      URLSearchParams,
      api: (path) => path.endsWith('/enrollment-report')
        ? new Promise((resolve) => reports.push(resolve))
        : Promise.resolve({ items: [{ id: ++list }], page: 1, limit: 50, total: 1 }),
      recordQuery: () => '', renderPagination() {},
    });
    vm.runInContext(`${appFunction('loadPaged')}\nglobalThis.loadPaged = loadPaged;`, context);
    const { load } = enrollmentPage(context, rendered);
    const earlier = load();
    await new Promise((resolve) => setImmediate(resolve));
    const latest = load();
    await new Promise((resolve) => setImmediate(resolve));
    reports[1]({ finalized: true, enrollmentReportIsCurrent: true });
    await latest;
    reports[0]({ finalized: true, enrollmentReportIsCurrent: false });
    await earlier;
    assert.equal(context.state.enrollmentReport, null);
    assert.equal(context.state.enrollments[0].id, 2);
    assert.deepEqual(rendered.map((items) => items[0].id), [2]);
  });
});
