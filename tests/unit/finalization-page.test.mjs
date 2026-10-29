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
  const messages = [];
  const refreshed = [];
  const note = { value: '' };
  const nodes = {
    'finalize-add-count': {}, 'finalize-issue-count': {},
    'finalize-courses': { replaceChildren() {} },
    'finalize-enrollments': { children: [], replaceChildren(...children) { this.children = children; } },
    'finalize-issues': { replaceChildren() {} },
    'finalize-form': { reset() { note.value = ''; } },
    'finalize-draft': {},
    'finalize-dialog': {
      open: false,
      showModal() { this.open = true; opened.push('finalize-dialog'); },
      close() { this.open = false; closed.push('finalize-dialog'); },
    },
    'draft-dialog': { open: true, close() { this.open = false; closed.push('draft-dialog'); } },
  };
  const state = {
    draft: { draft: { id: 'draft', revision: 3 }, studentResults: [] },
    draftContext: { semesterCourses: [] },
  };
  const page = createFinalizationPage({
    state, api, byId: (id) => nodes[id],
    run: async (action, success, isCurrent = () => true) => {
      try {
        const result = await action();
        if (success && isCurrent()) messages.push(success);
        return result;
      } catch (error) {
        if (isCurrent()) messages.push(error.message);
        throw error;
      }
    },
    draftCourseName: (id) => id, showMessage: (message) => messages.push(message),
    loadDrafts: async () => { refreshed.push('drafts'); }, loadEnrollments: async () => { refreshed.push('enrollments'); },
  });
  const event = { preventDefault() {}, currentTarget: { elements: { note } } };
  return { page, state, note, opened, closed, event, nodes, messages, refreshed };
};

const withDocument = async (action) => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ children: [], append(...children) { this.children.push(...children); } }) };
  try { await action(); } finally { globalThis.document = previous; }
};

test('finalization review shows each proposed enrollment ministry', async () => withDocument(async () => {
  const { page, nodes } = setup(async () => ({ ...preview, enrollments: [
    { memberId: 'member-1', memberName: '김가나', courseName: '창세기', ministry: '청년부' },
    { memberId: 'member-2', memberName: '박다라', courseName: '마태복음', ministry: null },
  ] }));

  await page.previewFinalization();

  assert.deepEqual(nodes['finalize-enrollments'].children.map((row) => row.children.map(({ textContent }) => textContent)), [
    ['김가나', '청년부', '창세기'], ['박다라', '—', '마태복음'],
  ]);
}));

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

test('a late finalization success preserves the draft or review opened afterward', async () => withDocument(async () => {
  const scenarios = [
    { name: 'another draft being edited', draftId: 'another-draft', review: false },
    { name: 'another draft being reviewed', draftId: 'another-draft', review: true },
    { name: 'the same draft reopened', draftId: 'draft', review: false },
    { name: 'the same draft reopened for review', draftId: 'draft', review: true },
    { name: 'a new review of the open draft', draftId: 'draft', review: true, sameDetail: true },
    { name: 'a duplicate success after another draft opens', draftId: 'another-draft', review: true, duplicate: true },
  ];
  for (const scenario of scenarios) {
    const pending = [];
    const requests = [];
    let previews = 0;
    const replacementPreview = { ...preview, preparedActionToken: 'replacement-token', warningDigest: 'replacement-warnings' };
    const { page, state, note, event, nodes, closed, messages, refreshed } = setup((path, options) => {
      if (path.endsWith('/finalize-preview')) return Promise.resolve(previews++ === 0 ? preview : replacementPreview);
      requests.push({ path, body: options.body, key: options.headers['Idempotency-Key'] });
      return new Promise((resolve) => pending.push(resolve));
    });
    await page.previewFinalization();
    note.value = 'First acknowledgement';
    let first = page.finalizeDraft(event);
    if (scenario.duplicate) {
      const duplicate = page.finalizeDraft(event);
      pending[0]({ createdCount: 1 });
      await first;
      assert.deepEqual(requests[1], requests[0], scenario.name);
      first = duplicate;
    }
    nodes['finalize-dialog'].close();
    nodes['draft-dialog'].close();
    const replacementDraft = scenario.sameDetail ? state.draft : {
      draft: { id: scenario.draftId, revision: 3 }, studentResults: [],
    };
    state.draft = replacementDraft;
    nodes['draft-dialog'].open = true;
    if (scenario.review) await page.previewFinalization();
    note.value = 'Replacement acknowledgement';
    closed.length = 0;
    messages.length = 0;
    refreshed.length = 0;

    pending.at(-1)({ createdCount: 1 });
    await first;

    assert.equal(state.draft, replacementDraft, scenario.name);
    assert.equal(nodes['draft-dialog'].open, true, scenario.name);
    assert.equal(nodes['finalize-dialog'].open, scenario.review, scenario.name);
    assert.equal(closed.includes('draft-dialog'), false, scenario.name);
    assert.equal(note.value, 'Replacement acknowledgement', scenario.name);
    assert.deepEqual(messages, [], scenario.name);
    assert.deepEqual(refreshed, ['drafts', 'enrollments'], scenario.name);

    if (!scenario.review) {
      await page.previewFinalization();
      note.value = 'Replacement acknowledgement';
    }
    const replacement = page.finalizeDraft(event);
    assert.equal(requests.at(-1).path, `/allocation-drafts/${scenario.draftId}/finalize`, scenario.name);
    assert.deepEqual(JSON.parse(requests.at(-1).body), {
      preparedActionToken: replacementPreview.preparedActionToken,
      expectedDraftRevision: replacementPreview.draftRevision,
      acknowledgedWarningDigest: replacementPreview.warningDigest,
      acknowledgementNote: 'Replacement acknowledgement',
    }, scenario.name);
    assert.notEqual(requests.at(-1).key, requests[0].key, scenario.name);
    pending.at(-1)({ createdCount: 2 });
    await replacement;
    assert.equal(state.draft, null, scenario.name);
    assert.equal(nodes['finalize-dialog'].open, false, scenario.name);
    assert.equal(nodes['draft-dialog'].open, false, scenario.name);
    assert.match(messages.at(-1), /2건/, scenario.name);
  }
}));

test('a late finalization failure leaves the newer review and its acknowledgement usable', async () => withDocument(async () => {
  for (const code of ['INTERNAL_ERROR', 'UNPROCESSABLE']) {
    const pending = [];
    const requests = [];
    const { page, state, note, event, nodes, messages, refreshed } = setup((path, options) => {
      if (path.endsWith('/finalize-preview')) return Promise.resolve(preview);
      requests.push({ path, body: options.body });
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    });
    await page.previewFinalization();
    const first = assert.rejects(page.finalizeDraft(event), { code });
    nodes['finalize-dialog'].close();
    state.draft = { draft: { id: 'another-draft', revision: 3 }, studentResults: [] };
    const replacementDraft = state.draft;
    await page.previewFinalization();
    note.value = 'Replacement acknowledgement';
    pending[0].reject(Object.assign(new Error('First finalization failed'), { code }));
    await first;

    assert.equal(state.draft, replacementDraft, code);
    assert.equal(nodes['finalize-dialog'].open, true, code);
    assert.equal(nodes['draft-dialog'].open, true, code);
    assert.equal(note.value, 'Replacement acknowledgement', code);
    assert.deepEqual(messages, [], code);
    assert.deepEqual(refreshed, [], code);
    const replacement = page.finalizeDraft(event);
    assert.equal(requests[1].path, '/allocation-drafts/another-draft/finalize', code);
    assert.equal(JSON.parse(requests[1].body).acknowledgementNote, 'Replacement acknowledgement', code);
    pending[1].resolve({ createdCount: 2 });
    await replacement;
    assert.equal(state.draft, null, code);
  }
}));
