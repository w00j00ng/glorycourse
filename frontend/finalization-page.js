import { issueText } from './issue-view.js';

/**
 * @typedef {{ code: string, severity: string, message?: string, subject?: { memberId?: string, courseId?: string } }} FinalizationIssue
 * @typedef {{ preparedActionToken: string, draftRevision: number, warningDigest: string, enrollments: unknown[], issues: FinalizationIssue[], courseSummary: { semesterCourseId: string, existingCount: number, addedCount: number, totalCount: number, capacity: number | null }[] }} FinalizationPreview
 * @typedef {{ preview: FinalizationPreview, draftId: string, idempotencyKey: string, request: null | { preparedActionToken: string, expectedDraftRevision: number, acknowledgedWarningDigest: string, acknowledgementNote: string } }} FinalizationState
 * @typedef {{ draft: { id: string, revision: number }, studentResults: { memberId: string, memberNameAtGeneration: string }[] }} DraftDetail
 * @typedef {{ semesterCourses: { courseId: string, courseName: string }[] }} DraftContext
 * @param {{ state: { draft: DraftDetail | null, draftContext: DraftContext | null }, api: (path: string, options?: Record<string, unknown>) => Promise<unknown>, byId: (id: string) => any, run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>, draftCourseName: (id: string) => string, showMessage: (message: string) => void, loadDrafts: () => Promise<void>, loadEnrollments: () => Promise<void> }} dependencies
 */
export const createFinalizationPage = ({ state, api, byId, run, draftCourseName, showMessage, loadDrafts, loadEnrollments }) => {
  /** @type {FinalizationState | null} */
  let finalization = null;

  const previewFinalization = async () => {
    const draft = state.draft;
    if (!draft) return;
    const preview = /** @type {FinalizationPreview} */ (await run(() => api(`/allocation-drafts/${draft.draft.id}/finalize-preview`, {
      method: 'POST', body: JSON.stringify({ expectedDraftRevision: draft.draft.revision }),
    })));
    if (state.draft !== draft) return;
    finalization = { preview, draftId: draft.draft.id, idempotencyKey: crypto.randomUUID(), request: null };
    byId('finalize-add-count').textContent = String(preview.enrollments.length);
    byId('finalize-issue-count').textContent = String(preview.issues.length);
    byId('finalize-courses').replaceChildren(...preview.courseSummary.map((course) => {
      const card = document.createElement('div');
      card.className = 'import-candidate';
      const name = document.createElement('strong');
      name.textContent = draftCourseName(course.semesterCourseId);
      const detail = document.createElement('small');
      detail.textContent = `기존 ${course.existingCount}명 · 이번 추가 ${course.addedCount}명 · 합계 ${course.totalCount}명${course.capacity === null ? ' · 정원 미정' : ` / 정원 ${course.capacity}명`}`;
      card.append(name, detail);
      return card;
    }));
    byId('finalize-issues').replaceChildren(...(preview.issues.length ? preview.issues : [{ code: '', severity: 'INFO', message: '추가 검토 항목이 없습니다.' }]).map((issue) => {
      const item = document.createElement('li');
      const memberName = draft.studentResults.find(({ memberId }) => memberId === issue.subject?.memberId)?.memberNameAtGeneration;
      const courseName = state.draftContext?.semesterCourses.find(({ courseId }) => courseId === issue.subject?.courseId)?.courseName;
      item.textContent = issueText(issue, { memberName, courseName });
      return item;
    }));
    byId('finalize-form').reset();
    byId('finalize-draft').disabled = preview.issues.some(({ severity }) => severity === 'ERROR');
    byId('finalize-dialog').showModal();
  };

  /** @param {SubmitEvent} event */
  const finalizeDraft = async (event) => {
    event.preventDefault();
    const current = finalization;
    if (!current) return;
    const form = /** @type {HTMLFormElement & { elements: HTMLFormControlsCollection & { note: HTMLTextAreaElement } }} */ (event.currentTarget);
    const request = current.request ??= {
      preparedActionToken: current.preview.preparedActionToken,
      expectedDraftRevision: current.preview.draftRevision,
      acknowledgedWarningDigest: current.preview.warningDigest,
      acknowledgementNote: form.elements.note.value,
    };
    let receipt;
    try {
      receipt = /** @type {{ createdCount: number }} */ (await run(() => api(`/allocation-drafts/${current.draftId}/finalize`, {
        method: 'POST',
        headers: { 'Idempotency-Key': current.idempotencyKey },
        body: JSON.stringify(request),
      }), '배정초안을 확정하고 수강이력을 생성했습니다.'));
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code === 'UNPROCESSABLE' && current.request === request) current.request = null;
      throw error;
    }
    byId('finalize-dialog').close();
    byId('draft-dialog').close();
    finalization = null;
    state.draft = null;
    showMessage(`배정을 확정했습니다. 추가된 수강이력 ${receipt.createdCount}건`);
    await Promise.all([loadDrafts(), loadEnrollments()]);
  };

  return { previewFinalization, finalizeDraft };
};
