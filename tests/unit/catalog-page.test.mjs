import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogPage } from '../../frontend/catalog-page.js';

test('selecting a semester twice closes its editor and marks the row unselected', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ dataset: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {}, append() {} }),
  };
  try {
    const rows = { children: [], replaceChildren(...children) { this.children = children; } };
    const form = { hidden: true };
    form.elements = { name: { value: '' } };
    const select = { value: '' };
    const nodes = {
      'catalog-semester-rows': rows, 'catalog-semester-empty': {}, 'semester-form': form,
      'catalog-semester': select, 'catalog-form': {}, 'catalog-course-rows': { replaceChildren() {} },
      'catalog-course-empty': {}, 'catalog-empty': {}, 'copy-catalog-courses': {},
    };
    const state = { semesters: [{ id: 'semester-1', name: '2026 가을', order: 1 }],
      selectedSemesterId: null, movingSemester: false, catalogContext: null };
    const page = createCatalogPage({
      state, byId: (id) => nodes[id], cell: () => ({}),
      actionsCell: () => ({ querySelectorAll: () => [{}, {}, {}] }),
      api: async () => ({ semester: { id: 'semester-1', name: '2026 가을' }, semesterCourses: [] }),
      fillSelect: () => { select.value = ''; },
      catalogCourseRow: () => ({}),
    });

    await page.selectSemesterRow('semester-1');
    assert.equal(state.selectedSemesterId, 'semester-1');
    assert.equal(form.hidden, false);
    await page.selectSemesterRow('semester-1');
    assert.equal(state.selectedSemesterId, null);
    assert.equal(form.hidden, true);
    assert.equal(rows.children.length, 1);
  } finally { globalThis.document = previousDocument; }
});

test('moving a semester sends its neighbor and reloads the selected row', async () => {
  const previousDocument = globalThis.document;
  const steps = [];
  globalThis.document = {
    createElement: () => ({ dataset: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {},
      append() {}, focus: () => steps.push('focus') }),
  };
  try {
    const requests = [];
    const state = {
      semesters: [{ id: 'latest', name: '2026 가을', order: 2 }, { id: 'older', name: '2026 봄', order: 1 }],
      selectedSemesterId: 'older', movingSemester: false, catalogContext: null,
    };
    const rows = { children: [], replaceChildren(...children) { this.children = children; } };
    const select = { value: '' };
    const nodes = {
      'catalog-semester': select, 'catalog-semester-rows': rows, 'catalog-semester-empty': {},
      'semester-form': { hidden: true, elements: { name: {} } }, 'catalog-form': {},
      'catalog-course-rows': { replaceChildren() {} }, 'catalog-course-empty': {},
      'catalog-empty': {}, 'copy-catalog-courses': {},
    };
    const page = createCatalogPage({
      state, byId: (id) => nodes[id],
      api: async (path, options) => {
        requests.push({ path, options });
        return { semester: { id: 'latest', name: '2026 가을' }, semesterCourses: [] };
      },
      run: async (action) => action(),
      loadCatalogs: async () => { steps.push('catalog'); },
      fillSelect: () => { select.value = ''; },
      catalogCourseRow: () => ({}),
      cell: () => ({}), actionsCell: () => ({ querySelectorAll: () => [{}, {}, {}] }),
    });

    await page.moveSemester(state.semesters[0], 'DOWN');

    assert.equal(requests[0].path, '/semesters/latest/move');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      direction: 'DOWN', expectedOrder: 2, adjacentSemesterId: 'older',
    });
    assert.equal(requests[1].path, '/semesters/latest/context');
    assert.deepEqual(steps, ['catalog', 'focus']);
    assert.equal(state.selectedSemesterId, null);
    assert.equal(nodes['semester-form'].hidden, true);
    assert.equal(state.movingSemester, false);
  } finally { globalThis.document = previousDocument; }
});

test('choosing another semester closes the previously selected editor', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ dataset: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {}, append() {} }),
  };
  try {
    const semesters = [{ id: 'a', name: '봄', order: 1 }, { id: 'b', name: '가을', order: 2 }];
    const state = { semesters, selectedSemesterId: 'a', movingSemester: false,
      catalogContext: { semester: { id: 'a', name: '봄' } } };
    const select = { value: 'b' };
    const form = { hidden: false, elements: { name: {} } };
    const nodes = {
      'catalog-semester': select, 'catalog-semester-rows': { replaceChildren() {} },
      'catalog-semester-empty': {}, 'semester-form': form, 'catalog-form': {},
      'catalog-course-rows': { replaceChildren() {} }, 'catalog-course-empty': {},
      'catalog-empty': {}, 'copy-catalog-courses': {},
    };
    const page = createCatalogPage({
      state, byId: (id) => nodes[id],
      api: async () => ({ semester: { id: 'b', name: '가을' }, semesterCourses: [] }),
      fillSelect: () => { select.value = ''; }, catalogCourseRow: () => ({}), cell: () => ({}),
      actionsCell: () => ({ querySelectorAll: () => [{}, {}, {}] }),
    });

    await page.loadCatalogManagement();

    assert.equal(state.selectedSemesterId, null);
    assert.equal(form.hidden, true);
    assert.equal(state.catalogContext.semester.id, 'b');
  } finally { globalThis.document = previousDocument; }
});

test('the semester editor keeps the newest selection when an older detail request arrives later', async () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: () => ({ dataset: {}, classList: { add() {} }, setAttribute() {}, addEventListener() {}, append() {} }),
  };
  try {
    for (const sequence of [['a', 'b'], ['a', 'b', 'a'], ['a', null]]) {
      const rows = { children: [], replaceChildren(...children) { this.children = children; } };
      const select = { value: '', replaceChildren() {} };
      const semesterForm = { hidden: true, elements: { name: { value: '' } } };
      const nodes = {
        'catalog-semester': select, 'catalog-semester-rows': rows, 'catalog-semester-empty': {},
        'semester-form': semesterForm, 'catalog-form': { hidden: true },
        'catalog-course-rows': { replaceChildren() {} }, 'catalog-course-empty': {},
        'catalog-empty': { hidden: true }, 'copy-catalog-courses': {},
      };
      const semesters = [{ id: 'a', name: '봄', order: 1 }, { id: 'b', name: '가을', order: 2 }];
      const state = { semesters, selectedSemesterId: null, movingSemester: false, catalogContext: null };
      const pending = [];
      const page = createCatalogPage({
        state, byId: (id) => nodes[id],
        api: (path) => new Promise((resolve) => pending.push({ path, resolve })),
        fillSelect: () => { select.value = ''; },
        catalogCourseRow: () => ({}), cell: () => ({}),
        actionsCell: () => ({ querySelectorAll: () => [{}, {}, {}] }),
      });

      const requests = sequence.map((id) => {
        if (id) return page.selectSemesterRow(id);
        state.semesters = [];
        return page.loadCatalogManagement();
      });
      assert.equal(semesterForm.hidden, true);
      assert.equal(nodes['catalog-form'].hidden, true);
      for (let index = pending.length - 1; index >= 0; index--) {
        const semester = semesters.find(({ id }) => pending[index].path === `/semesters/${id}/context`);
        pending[index].resolve({ semester: { ...semester, name: `${semester.name} ${index}` }, semesterCourses: [] });
      }
      await Promise.all(requests);
      const expected = sequence.at(-1);
      assert.equal(state.catalogContext?.semester.id ?? null, expected);
      assert.equal(semesterForm.hidden, !expected);
      if (expected) assert.equal(semesterForm.elements.name.value, `${semesters.find(({ id }) => id === expected).name} ${sequence.length - 1}`);
    }
  } finally { globalThis.document = previousDocument; }
});
