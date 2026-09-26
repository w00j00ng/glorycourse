import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { orderSemesters, currentSemester } from '../../frontend/dashboard-view.js';
import { createDraftsPage } from '../../frontend/drafts-page.js';
import { createEnrollmentsPage } from '../../frontend/enrollments-page.js';
import { createImportsPage } from '../../frontend/imports-page.js';
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

const withRowDocument = async (action) => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ append() {} }) };
  try { return await action(); } finally { globalThis.document = previousDocument; }
};

test('reloads imported records using the catalog and filters shown to the user', async () => {
  const oldSemester = { id: 'old', name: 'Old semester', order: 1 };
  const newSemester = { id: 'new', name: 'New semester', order: 2 };
  const semesterSelect = { value: 'old' };
  const nodes = {
    'application-semester-filter': semesterSelect, 'import-preview-status': {}, 'commit-import': {},
  };
  const queries = [];
  let loadedSemester;
  let imported;
  const context = vm.createContext({
    catalogLoadRequest: 0,
    state: {
      semesters: [oldSemester], courses: [], applicationSemesterFilterTouched: false,
      pagination: { application: { page: 2 } },
      importPreview: {
        kind: 'APPLICATIONS', previewId: 'preview', storeRevision: 1, storeEpoch: 'epoch',
        warningDigest: '', applications: [], contextChanges: [], issues: [],
      },
    },
    byId: (id) => nodes[id],
    api: async (path) => {
      if (path === '/imports/preview/commit') {
        imported = true;
        return { inserted: 1, updated: 0, skipped: 0 };
      }
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
    run: async (action) => action(),
  });
  const functions = ['loadCatalogItems', 'loadCatalogs'].map(appFunction).join('\n');
  vm.runInContext(`${functions}\nglobalThis.loadCatalogs = loadCatalogs;`, context);
  const { commit } = createImportsPage({
    state: context.state, byId: context.byId, api: context.api, run: context.run,
    reviewWarnings: async () => '', showMessage() {}, loadCatalogs: context.loadCatalogs,
    loadApplications: context.loadApplications, loadEnrollments: context.loadEnrollments,
  });
  await commit();

  assert.equal(imported, true);
  assert.equal(nodes['import-preview-status'].textContent, '반영됨 · 추가 1 · 수정 0 · 동일 0');
  assert.equal(nodes['commit-import'].disabled, true);
  assert.equal(semesterSelect.value, 'new');
  assert.equal(context.state.pagination.application.page, 1);
  assert.deepEqual(queries.filter(({ name }) => name === 'application').map(({ filter }) => filter), ['new']);
  assert.equal(context.state.applications[0].semesterId, 'new');
  assert.equal(loadedSemester, 'new');
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
  await withRowDocument(async () => {
    for (const oldTotal of [0, 100]) {
      const pending = [];
      const rendered = [];
      const nodes = {
        'draft-rows': { replaceChildren() { rendered.push(context.state.drafts); } },
        'draft-empty': { hidden: true }, 'draft-count': { textContent: '' },
      };
      const context = vm.createContext({
        state: { drafts: [], semesters: [], pagination: { draft: { page: 2, limit: 50, total: 100 } } },
        URLSearchParams,
        api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
        renderPagination() {},
      });
      vm.runInContext(`${appFunction('loadPaged')}\nglobalThis.loadPaged = loadPaged;`, context);
      const { load } = createDraftsPage({
        state: context.state, byId: (id) => nodes[id], loadPaged: context.loadPaged,
        cell: () => ({}), actionsCell: () => ({}), resourceName: () => '', policyName: () => '',
      });
      const earlier = load();
      context.state.pagination.draft.page = 1;
      context.state.pagination.draft.limit = 25;
      const latest = load();
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
      assert.equal(nodes['draft-count'].textContent, '1');
      const { page, limit, total } = context.state.pagination.draft;
      assert.deepEqual({ page, limit, total }, { page: 1, limit: 25, total: 1 });
    }
  });
});

test('shows readiness only for the semester currently chosen in the draft form', async () => {
  const pending = [];
  const form = { elements: { semesterId: { value: 'first' } } };
  const readiness = { textContent: '' };
  const { showReadiness } = createDraftsPage({
    state: { drafts: [], semesters: [], policies: [], pagination: { draft: { page: 1, limit: 50, total: 0 } } },
    byId: (id) => ({ 'draft-create-form': form, 'draft-readiness': readiness })[id],
    api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
  });

  const earlier = showReadiness();
  form.elements.semesterId.value = 'second';
  const latest = showReadiness();
  assert.match(pending[0].path, /\/semesters\/first\/context/);
  assert.match(pending[2].path, /\/semesters\/second\/context/);
  pending[2].resolve({ issues: [], readyForAutoAllocation: true });
  pending[3].resolve({ total: 2 });
  await latest;
  pending[0].resolve({ issues: [{ code: 'MISSING_CAPACITY' }], readyForAutoAllocation: false });
  pending[1].resolve({ total: 5 });
  await earlier;
  assert.equal(readiness.textContent, '자동 배정 준비됨 · 기존 확정 2명');

  form.elements.semesterId.value = '';
  await showReadiness();
  assert.equal(readiness.textContent, '학기를 선택하면 자동 배정 준비 상태를 확인합니다.');
  assert.equal(pending.length, 4);
});

test('opening another draft keeps the latest selection when an older context finishes later', async () => {
  const pending = [];
  const shown = [];
  const { openDraft } = createDraftsPage({
    state: { drafts: [], semesters: [], policies: [], pagination: { draft: { page: 1, limit: 50, total: 0 } } },
    api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
    showDraft: async (detail, context) => shown.push([detail.draft.id, context.semester.name]),
  });

  const earlier = openDraft('earlier');
  pending[0].resolve({ draft: { id: 'earlier', semesterId: 'first' } });
  await new Promise((resolve) => setImmediate(resolve));
  const latest = openDraft('latest');
  pending[2].resolve({ draft: { id: 'latest', semesterId: 'second' } });
  await new Promise((resolve) => setImmediate(resolve));
  pending[3].resolve({ semester: { name: '두 번째 학기' } });
  await latest;
  pending[1].resolve({ semester: { name: '첫 번째 학기' } });
  await earlier;

  assert.deepEqual(shown, [['latest', '두 번째 학기']]);
});

test('draft deletion asks for confirmation and refreshes only after deleting the selected revision', async () => {
  const previousWindow = globalThis.window;
  const confirmations = [false, true];
  globalThis.window = { confirm: () => confirmations.shift() };
  try {
    const requests = [];
    const draft = { id: 'draft-1', revision: 7 };
    const nodes = {
      'draft-rows': { replaceChildren() {} },
      'draft-empty': { hidden: true },
      'draft-count': { textContent: '1' },
    };
    const { deleteDraft } = createDraftsPage({
      state: { drafts: [draft], semesters: [], policies: [], pagination: { draft: { page: 1, limit: 50, total: 1 } } },
      byId: (id) => nodes[id],
      api: async (path, options) => { requests.push({ path, options }); },
      run: (action) => action(),
      loadPaged: async (_name, _path, _filters, pagination) => { pagination.total = 0; return []; },
    });

    await deleteDraft(draft);
    assert.equal(requests.length, 0);
    assert.equal(nodes['draft-count'].textContent, '1');
    await deleteDraft(draft);
    assert.deepEqual(requests, [{
      path: '/allocation-drafts/draft-1',
      options: { method: 'DELETE', body: JSON.stringify({ expectedDraftRevision: 7 }) },
    }]);
    assert.equal(nodes['draft-empty'].hidden, false);
    assert.equal(nodes['draft-count'].textContent, '0');
  } finally {
    globalThis.window = previousWindow;
  }
});

test('a completed draft item edit does not reopen an older draft after another draft is selected', async () => {
  const item = {
    memberId: 'member-1', memberNameAtGeneration: '김가나',
    autoDecision: 'SELECTED', autoSemesterCourseId: 'course-1',
  };
  for (const [name, invoke, expectedPath] of [
    ['저장', (page) => page.saveDraftItem(item, 'course-2'), '/allocation-drafts/older/items/member-1'],
    ['자동 복원', (page) => page.restoreDraftItem(item), '/allocation-drafts/older/items/member-1/restore-auto'],
    ['회원 추가', (page) => page.addDraftItem(), '/allocation-drafts/older/items'],
  ]) {
    const requests = [];
    let loads = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const state = {
      draft: { draft: { id: 'older', revision: 7 } }, drafts: [], semesters: [], policies: [],
      pagination: { draft: { page: 1, limit: 50, total: 0 } },
    };
    const nodes = {
      'draft-add-member': { value: 'member-1' }, 'draft-add-course': { value: 'course-2' },
      'draft-rows': { replaceChildren() {} }, 'draft-empty': {}, 'draft-count': {},
    };
    const page = createDraftsPage({
      state, byId: (id) => nodes[id],
      api: async (path, options) => { requests.push({ path, options }); },
      run: async (action) => { await action(); await gate; },
      loadPaged: async () => { loads++; return []; },
    });

    const editing = invoke(page);
    state.draft = { draft: { id: 'newer', revision: 1 } };
    release();
    await editing;
    assert.deepEqual(requests.map(({ path }) => path), [expectedPath], name);
    assert.equal(JSON.parse(requests[0].options.body).expectedDraftRevision, 7, name);
    assert.equal(loads, 1, name);
    assert.equal(state.draft.draft.id, 'newer', name);
  }
});

test('saving the current draft refreshes its detail but leaves a closed dialog closed', async () => {
  const requests = [];
  let loads = 0;
  let shown = 0;
  let gate = Promise.resolve();
  let holdDetail = false;
  let resolveDetail;
  const dialog = { open: true };
  const nodes = {
    'draft-dialog': dialog, 'draft-rows': { replaceChildren() {} },
    'draft-empty': {}, 'draft-count': {},
  };
  const page = createDraftsPage({
    state: {
      draft: { draft: { id: 'draft-1', revision: 7 } }, drafts: [], semesters: [], policies: [],
      pagination: { draft: { page: 1, limit: 50, total: 0 } },
    },
    byId: (id) => nodes[id],
    api: async (path, options) => {
      requests.push({ path, options });
      if (path === '/allocation-drafts/draft-1') {
        if (holdDetail) return new Promise((resolve) => { resolveDetail = resolve; });
        return { draft: { id: 'draft-1', semesterId: 'semester-1' } };
      }
      if (path === '/semesters/semester-1/context') return { semester: { name: '가을' } };
      return {};
    },
    run: async (action) => { await action(); await gate; },
    showDraft: async () => { shown++; },
    loadPaged: async () => { loads++; return []; },
  });
  const item = {
    memberId: 'member-1', memberNameAtGeneration: '김가나',
    autoDecision: 'SELECTED', autoSemesterCourseId: 'course-1',
  };

  await page.saveDraftItem(item, 'course-2');
  assert.equal(shown, 1);
  assert.equal(loads, 1);
  assert.equal(JSON.parse(requests[0].options.body).finalReasonCode, 'ADMIN_OVERRIDE');

  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const saving = page.saveDraftItem(item, 'course-2');
  dialog.open = false;
  release();
  await saving;
  assert.equal(shown, 1);
  assert.equal(loads, 2);

  holdDetail = true;
  dialog.open = true;
  gate = Promise.resolve();
  const refreshing = page.saveDraftItem(item, 'course-2');
  await new Promise((resolve) => setImmediate(resolve));
  dialog.open = false;
  resolveDetail({ draft: { id: 'draft-1', semesterId: 'semester-1' } });
  await refreshing;
  assert.equal(shown, 1);
  assert.equal(loads, 3);
});

test('corrects a removed enrollment page without letting its retry replace a newer list', async () => {
  await withRowDocument(async () => {
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
  await withRowDocument(async () => {
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
  await withRowDocument(async () => {
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
