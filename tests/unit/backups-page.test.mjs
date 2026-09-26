import assert from 'node:assert/strict';
import test from 'node:test';

import { createBackupsPage } from '../../frontend/backups-page.js';

const preview = {
  preparedActionToken: 'preview-token', warningDigest: 'warnings',
  storeRevision: 2, backupStoreRevision: 1, issues: [],
};

const setup = (api) => {
  const closed = [];
  const form = {
    elements: {
      file: { files: [{ name: 'backup.sqlite' }], disabled: false },
      note: { value: '', required: false },
    },
    reset() { this.elements.note.value = ''; },
  };
  const nodes = {
    'restore-form': form,
    'restore-preview': { hidden: true },
    'restore-submit': { textContent: '' },
    'restore-dialog': { showModal() {}, close: () => closed.push('restore-dialog') },
    'restore-current-revision': {}, 'restore-backup-revision': {},
    'restore-issues': { replaceChildren() {} },
    'backup-rows': { replaceChildren() {} }, 'backup-empty': {},
    'backup-count': {}, 'latest-backup': {},
  };
  const page = createBackupsPage({
    api, byId: (id) => nodes[id], run: (action) => action(),
    showMessage() {}, cell: () => ({}), reloadOtherViews: async () => {},
  });
  const event = { preventDefault() {}, currentTarget: form };
  return { page, form, nodes, closed, event };
};

test('a corrected restore note creates a new request only after rejection', async () => {
  for (const code of ['UNPROCESSABLE', 'INTERNAL_ERROR', undefined]) {
    const requests = [];
    const failure = Object.assign(new Error('Request failed'), code ? { code } : {});
    const { page, form, closed, event } = setup(async (path, options) => {
      if (path === '/restores/preview') return preview;
      if (path === '/backups') return { items: [] };
      requests.push({ path, body: options.body, key: options.headers['Idempotency-Key'] });
      if (requests.length === 1) throw failure;
      return { storeRevision: 4 };
    });
    page.openRestore();
    await page.submitRestore(event);
    form.elements.note.value = code === 'UNPROCESSABLE' ? '   ' : 'Original acknowledgement';
    await assert.rejects(page.submitRestore(event), (error) => error === failure);
    form.elements.note.value = 'Corrected acknowledgement';
    await page.submitRestore(event);

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
    assert.deepEqual(closed, ['restore-dialog']);
  }
});

test('an older failed restore cannot erase a newer corrected retry', async () => {
  const pending = [];
  const { page, form, event } = setup((path, options) => {
    if (path === '/restores/preview') return Promise.resolve(preview);
    return new Promise((resolve, reject) => pending.push({ options, resolve, reject }));
  });
  page.openRestore();
  await page.submitRestore(event);
  form.elements.note.value = '   ';
  const rejected = Object.assign(new Error('Invalid acknowledgement'), { code: 'UNPROCESSABLE' });
  const first = assert.rejects(page.submitRestore(event), { code: 'UNPROCESSABLE' });
  const duplicate = assert.rejects(page.submitRestore(event), { code: 'UNPROCESSABLE' });
  pending[0].reject(rejected);
  await first;
  form.elements.note.value = 'Corrected acknowledgement';
  const corrected = assert.rejects(page.submitRestore(event), /Connection lost/);
  pending[1].reject(rejected);
  await duplicate;
  pending[2].reject(new Error('Connection lost'));
  await corrected;

  const retry = assert.rejects(page.submitRestore(event), /Connection lost/);
  pending[3].reject(new Error('Connection lost'));
  await retry;
  assert.equal(pending[3].options.body, pending[2].options.body);
  assert.equal(pending[3].options.headers['Idempotency-Key'], pending[2].options.headers['Idempotency-Key']);
});
