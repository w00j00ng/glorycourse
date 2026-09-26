import { issueText } from './issue-view.js';

/** @typedef {{ code: string, severity: string, source?: { sheet?: string, row?: number, column?: string }, location?: string, detail?: { rowNumber?: number }, message?: string }} Issue */
/**
 * @param {{ byId: (id: string) => any, showMessage: (message: string, error?: boolean) => void }} dependencies
 */
export const createWarningDialog = ({ byId, showMessage }) => {
  /** @param {{ issues: Issue[] }} preview @param {(issue: Issue) => { memberName?: string, courseName?: string }} issueContext */
  const reviewWarnings = (preview, issueContext = () => ({})) => {
    const errors = preview.issues.filter((issue) => issue.severity === 'ERROR');
    if (errors.length) {
      showMessage(errors.map((issue) => issueText(issue, issueContext(issue))).join(' · '), true);
      return Promise.resolve(null);
    }
    const warnings = preview.issues.filter((issue) => issue.severity === 'WARNING');
    if (!warnings.length) return Promise.resolve('');
    const dialog = byId('warning-dialog');
    const form = byId('warning-form');
    form.reset();
    byId('warning-list').replaceChildren(...warnings.map((warning) => {
      const item = document.createElement('li');
      item.textContent = issueText(warning, issueContext(warning));
      return item;
    }));
    dialog.showModal();
    return new Promise((resolve) => {
      /** @param {Event} event */
      const approve = (event) => {
        event.preventDefault();
        cleanup();
        dialog.close();
        resolve(form.elements.note.value.trim());
      };
      const cancel = () => {
        cleanup();
        dialog.close();
        resolve(null);
      };
      const cleanup = () => {
        form.removeEventListener('submit', approve);
        byId('cancel-warning').removeEventListener('click', cancel);
        dialog.removeEventListener('cancel', cancel);
      };
      form.addEventListener('submit', approve);
      byId('cancel-warning').addEventListener('click', cancel);
      dialog.addEventListener('cancel', cancel);
    });
  };

  return reviewWarnings;
};
