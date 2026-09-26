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
    const nodes = { 'catalog-semester-rows': rows, 'catalog-semester-empty': {}, 'semester-form': form };
    const state = { semesters: [{ id: 'semester-1', name: '2026 가을', order: 1 }], selectedSemesterId: null, movingSemester: false };
    const loaded = [];
    const page = createCatalogPage({
      state, byId: (id) => nodes[id], cell: () => ({}),
      actionsCell: () => ({ querySelectorAll: () => [{}, {}, {}] }),
      loadCatalogManagement: async (id) => { loaded.push(id); form.hidden = false; },
    });

    await page.selectSemesterRow('semester-1');
    assert.equal(state.selectedSemesterId, 'semester-1');
    assert.deepEqual(loaded, ['semester-1']);
    await page.selectSemesterRow('semester-1');
    assert.equal(state.selectedSemesterId, null);
    assert.equal(form.hidden, true);
    assert.equal(rows.children.length, 1);
  } finally { globalThis.document = previousDocument; }
});

test('moving a semester sends its neighbor and reloads the selected row', async () => {
  const requests = [];
  const steps = [];
  const state = {
    semesters: [{ id: 'latest', name: '2026 가을', order: 2 }, { id: 'older', name: '2026 봄', order: 1 }],
    selectedSemesterId: null, movingSemester: false,
  };
  const page = createCatalogPage({
    state,
    byId: () => ({ children: [{ dataset: { id: 'latest' }, focus: () => steps.push('focus') }] }),
    api: async (path, options) => { requests.push({ path, options }); },
    run: async (action) => action(),
    loadCatalogs: async () => { steps.push('catalog'); },
    loadCatalogManagement: async (id) => { steps.push(id); },
  });

  await page.moveSemester(state.semesters[0], 'DOWN');

  assert.equal(requests[0].path, '/semesters/latest/move');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    direction: 'DOWN', expectedOrder: 2, adjacentSemesterId: 'older',
  });
  assert.deepEqual(steps, ['catalog', 'latest', 'focus']);
  assert.equal(state.movingSemester, false);
});
