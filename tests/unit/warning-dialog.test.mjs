import assert from 'node:assert/strict';
import test from 'node:test';

import { createWarningDialog } from '../../frontend/warning-dialog.js';

test('an administrator sees errors, approves a warning with a reason, or cancels it', async () => {
  const messages = [];
  let warningsEnabled = true;
  const form = Object.assign(new EventTarget(), {
    elements: { note: { value: '' } },
    reset() { this.elements.note.value = ''; },
  });
  const dialog = Object.assign(new EventTarget(), {
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
  });
  const cancel = new EventTarget();
  const list = { items: [], replaceChildren(...items) { this.items = items; } };
  const nodes = {
    'warning-dialog': dialog, 'warning-form': form,
    'warning-list': list, 'cancel-warning': cancel,
  };
  const previousDocument = globalThis.document;
  globalThis.document = { createElement: () => ({ textContent: '' }) };
  try {
    const reviewWarnings = createWarningDialog({
      byId: (id) => nodes[id], showMessage: (message, error) => messages.push({ message, error }),
      warningsEnabled: () => warningsEnabled,
    });
    assert.equal(await reviewWarnings({ issues: [{ code: 'MEMBER_NAME_REQUIRED', severity: 'ERROR' }] }), null);
    assert.match(messages[0].message, /회원명을 입력하세요/);
    assert.equal(messages[0].error, true);
    assert.equal(dialog.open, false);
    assert.equal(await reviewWarnings({ issues: [] }), '');
    assert.equal(await reviewWarnings({ issues: [] }, undefined, '  경고 없는 수정 메모  '), '경고 없는 수정 메모');

    const preview = { issues: [{ code: 'CAPACITY_EXCEEDED', severity: 'WARNING' }] };
    const approved = reviewWarnings(preview);
    assert.equal(dialog.open, true);
    assert.match(list.items[0].textContent, /강좌 정원을 초과합니다/);
    form.elements.note.value = '  정원을 확인했습니다.  ';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(await approved, '정원을 확인했습니다.');
    assert.equal(dialog.open, false);

    const cancelled = reviewWarnings(preview);
    cancel.dispatchEvent(new Event('click'));
    assert.equal(await cancelled, null);
    assert.equal(dialog.open, false);

    const approvedWithoutNote = reviewWarnings(preview);
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(await approvedWithoutNote, '');

    const approvedEdit = reviewWarnings(preview, undefined, '수정 창에서 작성한 메모');
    assert.equal(form.elements.note.value, '수정 창에서 작성한 메모');
    form.elements.note.value = '확인 창에서 보완한 메모';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    assert.equal(await approvedEdit, '확인 창에서 보완한 메모');

    warningsEnabled = false;
    const skipped = reviewWarnings(preview);
    assert.equal(dialog.open, false);
    assert.equal(await skipped, '');
    assert.equal(await reviewWarnings(preview, undefined, '  확인을 생략한 수정 메모  '), '확인을 생략한 수정 메모');
    assert.equal(await reviewWarnings({ issues: [] }), '');
    assert.equal(await reviewWarnings({ issues: [
      ...preview.issues, { code: 'MEMBER_NAME_REQUIRED', severity: 'ERROR' },
    ] }), null);
    assert.match(messages.at(-1).message, /회원명을 입력하세요/);
    assert.equal(messages.at(-1).error, true);

    warningsEnabled = true;
    const restored = reviewWarnings(preview);
    assert.equal(dialog.open, true);
    cancel.dispatchEvent(new Event('click'));
    assert.equal(await restored, null);
  } finally {
    globalThis.document = previousDocument;
  }
});
