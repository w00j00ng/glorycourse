import assert from 'node:assert/strict';
import test from 'node:test';

import { createFinalizationPage } from '../../frontend/finalization-page.js';

const preview = {
  preparedActionToken: 'preview-token', warningDigest: 'warnings', draftRevision: 3,
  enrollments: [{ memberId: 'member-1' }], issues: [], courseSummary: [],
};

const setup = (api) => {
  const closed = [];
  const opened = [];
  const note = { value: '' };
  const nodes = {
    'finalize-add-count': {}, 'finalize-issue-count': {},
    'finalize-courses': { replaceChildren() {} },
    'finalize-issues': { replaceChildren() {} },
    'finalize-form': { reset() { note.value = ''; } },
    'finalize-draft': {},
    'finalize-dialog': { showModal: () => opened.push('finalize-dialog'), close: () => closed.push('finalize-dialog') },
    'draft-dialog': { close: () => closed.push('draft-dialog') },
  };
  const state = {
    draft: { draft: { id: 'draft', revision: 3 }, studentResults: [] },
    draftContext: { semesterCourses: [] },
  };
  const page = createFinalizationPage({
    state, api, byId: (id) => nodes[id], run: (action) => action(),
    draftCourseName: (id) => id, showMessage() {},
    loadDrafts: async () => {}, loadEnrollments: async () => {},
  });
  const event = { preventDefault() {}, currentTarget: { elements: { note } } };
  return { page, state, note, opened, closed, event };
};

const withDocument = async (action) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({}) };
  try { await action(); } finally { globalThis.document = previous; }
};

test('a corrected finalization note creates a new request only after rejection', async () => withDocument(async () => {
  for (const code of ['UNPROCESSABLE', 'INTERNAL_ERROR', undefined]) {
    const requests = [];
    const failure = Object.assign(new Error('Request failed'), code ? { code } : {});
    const { page, state, note, closed, event } = setup(async (path, options) => {
      if (path.endsWith('/finalize-preview')) return preview;
      requests.push({ path, body: options.body, key: options.headers['Idempotency-Key'] });
      if (requests.length === 1) throw failure;
      return { createdCount: 2 };
    });
    await page.previewFinalization();
    note.value = code === 'UNPROCESSABLE' ? '   ' : 'Original acknowledgement';
    await assert.rejects(page.finalizeDraft(event), (error) => error === failure);
    note.value = 'Corrected acknowledgement';
    await page.finalizeDraft(event);

    assert.equal(requests.length, 2, code);
    assert.equal(requests[1].path, requests[0].path, code);
    assert.equal(requests[1].key, requests[0].key, code);
    const original = JSON.parse(requests[0].body);
    const retried = JSON.parse(requests[1].body);
    if (code === 'UNPROCESSABLE') {
      assert.deepEqual(retried, { ...original, acknowledgementNote: 'Corrected acknowledgement' });
    } else {
      assert.equal(requests[1].body, requests[0].body, 'uncertain outcome must replay the same request');
    }
    assert.equal(state.draft, null);
    assert.deepEqual(closed, ['finalize-dialog', 'draft-dialog']);
  }
}));

test('an older failed finalization cannot erase a newer corrected retry', async () => withDocument(async () => {
  const pending = [];
  const { page, state, note, event } = setup((path, options) => {
    if (path.endsWith('/finalize-preview')) return Promise.resolve(preview);
    return new Promise((resolve, reject) => pending.push({ options, resolve, reject }));
  });
  await page.previewFinalization();
  note.value = '   ';
  const rejected = Object.assign(new Error('Invalid acknowledgement'), { code: 'UNPROCESSABLE' });
  const first = assert.rejects(page.finalizeDraft(event), { code: 'UNPROCESSABLE' });
  const duplicate = assert.rejects(page.finalizeDraft(event), { code: 'UNPROCESSABLE' });
  pending[0].reject(rejected);
  await first;
  note.value = 'Corrected acknowledgement';
  const corrected = assert.rejects(page.finalizeDraft(event), /Connection lost/);
  pending[1].reject(rejected);
  await duplicate;
  pending[2].reject(new Error('Connection lost'));
  await corrected;

  const retry = page.finalizeDraft(event);
  assert.equal(pending[3].options.body, pending[2].options.body);
  assert.equal(pending[3].options.headers['Idempotency-Key'], pending[2].options.headers['Idempotency-Key']);
  pending[3].resolve({ createdCount: 2 });
  await retry;
  assert.equal(state.draft, null);
}));

test('a late preview does not reopen the finalization dialog for another draft', async () => withDocument(async () => {
  let resolvePreview;
  const { page, state, opened } = setup(() => new Promise((resolve) => { resolvePreview = resolve; }));
  const request = page.previewFinalization();
  state.draft = { draft: { id: 'another-draft', revision: 1 }, studentResults: [] };
  resolvePreview(preview);
  await request;
  assert.deepEqual(opened, []);
}));
