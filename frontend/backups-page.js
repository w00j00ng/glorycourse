import { issueText } from './issue-view.js';

/**
 * @typedef {{ createdAt: string, status: string, storeRevision: number, sizeBytes: number, digest: string }} Backup
 * @typedef {{ storeRevision: number, backupStoreRevision: number, preparedActionToken: string, warningDigest: string, issues: { code: string, severity: string }[] }} RestorePreview
 * @typedef {{ preview: RestorePreview, idempotencyKey: string, request: null | { preparedActionToken: string, acknowledgedWarningDigest: string, acknowledgementNote: string } }} RestoreState
 * @typedef {HTMLFormElement & { elements: HTMLFormControlsCollection & { file: HTMLInputElement, note: HTMLTextAreaElement } }} RestoreForm
 * @param {{ api: (path: string, options?: Record<string, unknown>) => Promise<unknown>, byId: (id: string) => any, run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>, showMessage: (text: string) => void, cell: (text: string) => HTMLTableCellElement, reloadOtherViews: () => Promise<void> }} dependencies
 */
export const createBackupsPage = ({ api, byId, run, showMessage, cell, reloadOtherViews }) => {
  /** @type {Backup[]} */
  let backups = [];
  /** @type {RestoreState | null} */
  let restore = null;

  const render = () => {
    byId('backup-rows').replaceChildren(...backups.map((item) => {
      const row = document.createElement('tr');
      row.append(
        cell(new Date(item.createdAt).toLocaleString()),
        cell(item.status === 'INVALID' ? '확인 불가' : item.status === 'NEWER' ? '새 버전 백업' : String(item.storeRevision)),
        cell(`${Math.ceil(item.sizeBytes / 1024).toLocaleString()} KiB`),
        cell(item.digest),
      );
      return row;
    }));
    byId('backup-empty').hidden = backups.length !== 0;
    byId('backup-count').textContent = String(backups.length);
    byId('latest-backup').textContent = backups[0]
      ? new Date(backups[0].createdAt).toLocaleDateString()
      : '없음';
  };

  const load = async () => {
    backups = (/** @type {{ items: Backup[] }} */ (await api('/backups'))).items;
    render();
  };

  const createManualBackup = async () => {
    const backup = /** @type {Backup} */ (await run(() => api('/backups', { method: 'POST' }), '현재 자료의 백업을 확인했습니다.'));
    await load();
    showMessage(`현재 자료는 백업되어 있습니다. 자료 버전 ${backup.storeRevision}`);
  };

  const clearRestorePreview = () => {
    restore = null;
    byId('restore-preview').hidden = true;
    byId('restore-form').elements.file.disabled = false;
    byId('restore-form').elements.note.required = false;
    byId('restore-submit').textContent = '파일 검토';
  };

  const openRestore = () => {
    byId('restore-form').reset();
    clearRestorePreview();
    byId('restore-dialog').showModal();
  };

  /** @param {SubmitEvent} event */
  const submitRestore = async (event) => {
    event.preventDefault();
    const form = /** @type {RestoreForm} */ (event.currentTarget);
    if (!restore) {
      const file = form.elements.file.files?.[0];
      if (!file) return;
      const preview = /** @type {RestorePreview} */ (await run(() => api('/restores/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/vnd.sqlite3' }, body: file,
      }), '백업 파일을 검토했습니다.'));
      restore = { preview, idempotencyKey: crypto.randomUUID(), request: null };
      byId('restore-current-revision').textContent = String(preview.storeRevision);
      byId('restore-backup-revision').textContent = String(preview.backupStoreRevision);
      byId('restore-issues').replaceChildren(...preview.issues.map((issue) => {
        const item = document.createElement('li');
        item.textContent = issueText(issue);
        return item;
      }));
      byId('restore-preview').hidden = false;
      form.elements.file.disabled = true;
      form.elements.note.required = true;
      byId('restore-submit').textContent = '검토 내용으로 복원';
      return;
    }
    const current = restore;
    const request = current.request ??= {
      preparedActionToken: current.preview.preparedActionToken,
      acknowledgedWarningDigest: current.preview.warningDigest,
      acknowledgementNote: form.elements.note.value,
    };
    let receipt;
    try {
      receipt = /** @type {{ storeRevision: number }} */ (await run(() => api('/restores', {
        method: 'POST',
        headers: { 'Idempotency-Key': current.idempotencyKey },
        body: JSON.stringify(request),
      }), '백업 파일로 자료를 복원했습니다.'));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'UNPROCESSABLE' && current.request === request) current.request = null;
      if (code === 'PREVIEW_STALE') clearRestorePreview();
      throw error;
    }
    byId('restore-dialog').close();
    restore = null;
    await Promise.all([reloadOtherViews(), load()]);
    showMessage(`자료를 복원했습니다. 자료 버전 ${receipt.storeRevision}`);
  };

  return { load, createManualBackup, openRestore, clearRestorePreview, submitRestore };
};
