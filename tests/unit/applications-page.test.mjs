import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplicationsPage } from '../../frontend/applications-page.js';

const manualApplicationNodes = () => {
  const entries = {
    children: [],
    get lastElementChild() { return this.children.at(-1); },
    append(row) { this.children.push(row); row.remove = () => { this.children.splice(this.children.indexOf(row), 1); }; },
    replaceChildren() { this.children = []; },
  };
  const makeEntry = () => {
    const fields = Object.fromEntries(['semesterName', 'memberName', 'applicationOrder'].map((name) => [name, { value: '' }]));
    const choices = { children: [], append(row) { this.children.push(row); } };
    const add = { addEventListener(_event, callback) { this.click = callback; } };
    const removeButton = { hidden: false, addEventListener(_event, callback) { this.click = callback; } };
    const legend = { textContent: '' };
    return {
      fields, choices, removeButton,
      querySelector: (selector) => ({ '.choice-fields': choices, '.add-choice': add,
        '.remove-entry': removeButton, legend })[selector] ?? fields[selector.slice(7, -2)],
    };
  };
  const makeChoice = () => {
    const fields = { courseName: { value: '' }, preference: { value: '' } };
    return { fields, querySelector: (selector) => selector === '.remove-choice'
      ? { addEventListener() {} } : fields[selector.slice(7, -2)] };
  };
  return {
    entries,
    nodes: {
      'application-entry-rows': entries,
      'application-entry-template': { content: { firstElementChild: { cloneNode: makeEntry } } },
      'choice-template': { content: { firstElementChild: { cloneNode: makeChoice } } },
    },
  };
};

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

test('the application list keeps the newest search result when an older request finishes later', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ append() {} }) };
  try {
    const pending = [];
    const state = { semesters: [], applications: [], pagination: { application: { page: 2, limit: 50, total: 100 } } };
    let filter = 'semesterId=old';
    const page = createApplicationsPage({
      state,
      loadPaged: (_name, _path, query, pagination) => new Promise((resolve) => pending.push({ query, pagination, resolve })),
      recordQuery: () => filter,
      byId: () => ({ replaceChildren() {}, textContent: '', hidden: false }),
      cell: () => ({}), choicesCell: () => ({}), badgeCell: () => ({}), actionsCell: () => ({}),
    });

    const oldRequest = page.load();
    filter = 'semesterId=new';
    state.pagination.application.page = 1;
    const newRequest = page.load();
    assert.equal(pending[0].query, 'semesterId=old');
    assert.equal(pending[1].query, 'semesterId=new');
    pending[1].resolve([{ id: 'new', choices: [] }]);
    await newRequest;
    pending[0].resolve([{ id: 'old', choices: [] }]);
    await oldRequest;
    assert.equal(state.applications[0].id, 'new');
  } finally { globalThis.document = previousDocument; }
});

test('registering multiple applications refreshes the catalog before querying the current semester', async () => {
  const makeEntry = (memberName, order) => ({
    querySelector: (selector) => selector === '.choice-fields'
      ? { children: [{ querySelector: (field) => ({ value: field === '[name="courseName"]' ? '창세기' : '1' }) }] }
      : { value: { '[name="semesterName"]': '2026 가을', '[name="memberName"]': memberName,
        '[name="applicationOrder"]': String(order) }[selector] },
  });
  const entries = { children: [makeEntry('김가나', 1), makeEntry('박다라', 2)] };
  const submit = { disabled: false };
  const form = { dataset: {}, querySelector: () => submit };
  const calls = [];
  let currentSemester = 'old';
  const nodes = {
    'application-entry-rows': entries,
    'application-dialog': { close: () => calls.push('close') },
    'application-rows': { replaceChildren() {} },
    'application-empty': {}, 'application-count': {}, 'choice-count': {},
  };
  const page = createApplicationsPage({
    state: { semesters: [], applications: [], pagination: { application: { page: 1, limit: 50, total: 0 } } },
    byId: (id) => nodes[id],
    api: async (path, options) => { calls.push({ path, options }); },
    run: async (action) => action(),
    loadCatalogs: async () => { currentSemester = 'new'; calls.push('catalog'); },
    recordQuery: () => `semesterId=${currentSemester}`,
    loadPaged: async (_name, _path, query) => { calls.push(query); return []; },
  });

  await page.submitApplication({ preventDefault() {}, currentTarget: form });

  assert.equal(calls[0].path, '/applications/batch');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body).items.map((item) => item.memberName), ['김가나', '박다라']);
  assert.deepEqual(calls.slice(1), ['close', 'catalog', 'semesterId=new']);
  assert.equal(submit.disabled, false);
});

test('deleting an application asks for confirmation and refreshes the list', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { confirm: () => true };
  try {
    const requests = [];
    const page = createApplicationsPage({
      state: { semesters: [], applications: [], pagination: { application: { page: 1, limit: 50, total: 0 } } },
      byId: (id) => ({ replaceChildren() {}, hidden: false, textContent: '' }),
      api: async (path, options) => { requests.push({ path, options }); },
      run: async (action) => action(), recordQuery: () => '',
      loadPaged: async () => { requests.push({ path: 'list' }); return []; },
    });

    await page.deleteApplication({ id: 'application-1', revision: 3, memberName: '김가나', semesterName: '2026 가을' });

    assert.deepEqual(requests.map(({ path }) => path), ['/applications/application-1?expectedRevision=3', 'list']);
    assert.equal(requests[0].options.method, 'DELETE');
  } finally { globalThis.window = previousWindow; }
});

test('editing an application opens one prefilled row and a save action', () => {
  const { nodes, entries } = manualApplicationNodes();
  const submit = { textContent: '' };
  const form = { dataset: {}, reset() {}, querySelector: () => submit };
  const title = { textContent: '' };
  const addButton = { hidden: false };
  const dialog = { showModalCalled: false, showModal() { this.showModalCalled = true; } };
  Object.assign(nodes, {
    'application-form': form, 'application-dialog-title': title,
    'add-application-entry': addButton, 'application-dialog': dialog,
  });
  const page = createApplicationsPage({ byId: (id) => nodes[id] });
  const application = { id: 'application-1', revision: 4, memberName: '김가나' };

  page.openApplication(application);

  assert.equal(form.dataset.id, 'application-1');
  assert.equal(form.dataset.revision, 4);
  assert.equal(title.textContent, '신청 수정');
  assert.equal(submit.textContent, '저장');
  assert.equal(addButton.hidden, true);
  assert.equal(entries.children.length, 1);
  assert.equal(entries.children[0].fields.memberName.value, '김가나');
  assert.equal(entries.children[0].removeButton.hidden, true);
  assert.equal(dialog.showModalCalled, true);
});

test('adding application rows carries the semester forward and numbers each request', () => {
  const { nodes, entries } = manualApplicationNodes();
  const page = createApplicationsPage({ byId: (id) => nodes[id], showMessage() {} });

  page.addApplicationEntry();
  entries.children[0].fields.semesterName.value = '2026 가을';
  page.addApplicationEntry();

  assert.equal(entries.children[1].fields.semesterName.value, '2026 가을');
  assert.equal(entries.children[1].choices.children.length, 1);
  assert.equal(entries.children[1].choices.children[0].fields.preference.value, 1);
  assert.deepEqual(entries.children.map((entry) => entry.querySelector('legend').textContent), ['신청 1', '신청 2']);
  entries.children[1].removeButton.click();
  assert.equal(entries.children.length, 1);
});
