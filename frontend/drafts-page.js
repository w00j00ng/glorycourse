import { issueText } from './issue-view.js';
import { draftFinalSelection } from './draft-view.js';

/** @typedef {Pick<import('../backend/src/storage/store.ts').AllocationDraftRecord, 'id' | 'semesterId' | 'revision' | 'mode' | 'policyId' | 'policyVersion' | 'updatedAt'>} DraftSummary */
/** @typedef {import('../backend/src/storage/store.ts').AllocationDraftItemRecord} DraftItem */
/** @typedef {{ policyId: string, policyVersion: string, name: string, description: string, settings: unknown }} DraftPolicy */
/**
 * @param {{
 *   state: { draft?: { draft: { id: string, revision: number } } | null, drafts: DraftSummary[], semesters: { id: string, name: string }[], policies: DraftPolicy[], pagination: { draft: { page: number, limit: number, total: number } } },
 *   byId: (id: string) => any,
 *   api: (path: string, options?: RequestInit) => Promise<any>,
 *   run: (action: () => Promise<any>, success?: string) => Promise<any>,
 *   showDraft: (detail: any, context: any) => Promise<void>,
 *   showMessage: (message: string, error?: boolean) => void,
 *   fillSelect: (select: HTMLSelectElement, items: { id: string, name: string }[], placeholder: string) => void,
 *   loadPaged: (name: string, path: string, filters: string, pagination: { page: number, limit: number, total: number }) => Promise<DraftSummary[]>,
 *   cell: (text: string) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 *   resourceName: (items: { id: string, name: string }[], id: string) => string,
 *   policyName: (id: string, version: string) => string,
 * }} dependencies
 */
export const createDraftsPage = ({ state, byId, api, run, showDraft, showMessage, fillSelect, loadPaged, cell, actionsCell, resourceName, policyName }) => {
  let readinessRequest = 0;
  let draftOpenRequest = 0;

  const render = () => {
    byId('draft-rows').replaceChildren(...state.drafts.map((item) => {
      const row = document.createElement('tr');
      row.append(
        cell(resourceName(state.semesters, item.semesterId)),
        cell(item.mode === 'AUTO' ? '자동' : '수동'),
        cell(policyName(item.policyId, item.policyVersion)),
        cell(new Date(item.updatedAt).toLocaleString()),
        actionsCell(
          ['검토', () => openDraft(item.id)],
          ['삭제', () => deleteDraft(item), 'delete'],
        ),
      );
      return row;
    }));
    byId('draft-empty').hidden = state.drafts.length !== 0;
    byId('draft-count').textContent = String(state.pagination.draft.total);
  };

  const load = async () => {
    const pagination = state.pagination.draft = { ...state.pagination.draft };
    const items = await loadPaged('draft', '/allocation-drafts', '', pagination);
    if (state.pagination.draft !== pagination) return;
    state.drafts = items;
    render();
  };

  /** @param {DraftSummary} item */
  const deleteDraft = async (item) => {
    if (!window.confirm('이 배정초안을 삭제할까요? 수강이력은 삭제되지 않습니다.')) return;
    draftOpenRequest++;
    await run(() => api(`/allocation-drafts/${item.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedDraftRevision: item.revision }),
    }), '배정초안을 삭제했습니다.');
    await load();
  };

  /** @param {SubmitEvent} event */
  const submitDraft = async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement & { elements: HTMLFormControlsCollection & {
     *   policy: HTMLSelectElement, semesterId: HTMLSelectElement, mode: HTMLSelectElement
     * } }} */ (event.currentTarget);
    const policy = state.policies.find((item) => (
      `${item.policyId}\n${item.policyVersion}` === form.elements.policy.value
    ));
    if (!policy) return;
    const request = ++draftOpenRequest;
    const detail = await run(() => api('/allocation-drafts', {
      method: 'POST',
      body: JSON.stringify({
        semesterId: form.elements.semesterId.value,
        mode: form.elements.mode.value,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        policySettings: policy.settings,
      }),
    }), '배정초안을 생성했습니다.');
    byId('draft-create-dialog').close();
    await load();
    const context = await api(`/semesters/${detail.draft.semesterId}/context`);
    if (request === draftOpenRequest) await showDraft(detail, context);
  };

  /** @param {string} id @param {boolean} [onlyIfOpen] */
  const openDraft = async (id, onlyIfOpen = false) => {
    const request = ++draftOpenRequest;
    const detail = await api(`/allocation-drafts/${id}`);
    if (request !== draftOpenRequest || (onlyIfOpen && !byId('draft-dialog').open)) return;
    const context = await api(`/semesters/${detail.draft.semesterId}/context`);
    if (request !== draftOpenRequest || (onlyIfOpen && !byId('draft-dialog').open)) return;
    await showDraft(detail, context);
  };

  /** @param {string} draftId */
  const refreshAfterItemChange = async (draftId) => {
    if (state.draft?.draft.id === draftId && byId('draft-dialog').open) await Promise.all([openDraft(draftId, true), load()]);
    else await load();
  };

  /** @param {DraftItem} item @param {string} semesterCourseId */
  const saveDraftItem = async (item, semesterCourseId) => {
    if (!state.draft) return;
    const { id, revision } = state.draft.draft;
    await run(() => api(`/allocation-drafts/${id}/items/${item.memberId}`, {
      method: 'PATCH',
      body: JSON.stringify({ expectedDraftRevision: revision, ...draftFinalSelection(item, semesterCourseId) }),
    }), `${item.memberNameAtGeneration}님의 최종 결정을 저장했습니다.`);
    await refreshAfterItemChange(id);
  };

  /** @param {DraftItem} item */
  const restoreDraftItem = async (item) => {
    if (!state.draft) return;
    const { id, revision } = state.draft.draft;
    await run(() => api(`/allocation-drafts/${id}/items/${item.memberId}/restore-auto`, {
      method: 'POST',
      body: JSON.stringify({ expectedDraftRevision: revision }),
    }), `${item.memberNameAtGeneration}님의 자동 결과를 복원했습니다.`);
    await refreshAfterItemChange(id);
  };

  const addDraftItem = async () => {
    if (!state.draft) return;
    const memberId = byId('draft-add-member').value;
    const courseId = byId('draft-add-course').value;
    if (!memberId || !courseId) return showMessage('추가할 회원과 강좌를 선택하세요.', true);
    const { id, revision } = state.draft.draft;
    await run(() => api(`/allocation-drafts/${id}/items`, {
      method: 'POST',
      body: JSON.stringify({
        memberId,
        expectedDraftRevision: revision,
        finalDecision: 'SELECTED',
        finalSemesterCourseId: courseId,
        finalReasonCode: 'ADMIN_ADDED',
        finalReasonDetail: { note: '관리자가 배정초안에 회원을 추가했습니다.' },
      }),
    }), '회원을 초안에 추가했습니다.');
    await refreshAfterItemChange(id);
  };

  const showPolicyDescription = () => {
    const value = byId('draft-create-form').elements.policy.value;
    byId('draft-policy-description').textContent = state.policies.find((policy) => (
      `${policy.policyId}\n${policy.policyVersion}` === value
    ))?.description ?? '';
  };

  const openCreate = async () => {
    readinessRequest++;
    if (!state.policies.length) {
      const response = /** @type {{ items: DraftPolicy[] }} */ (await api('/allocation-policies'));
      state.policies = response.items;
    }
    const form = byId('draft-create-form');
    form.reset();
    fillSelect(form.elements.semesterId, state.semesters, '학기를 선택하세요.');
    form.elements.policy.replaceChildren(...state.policies.map((policy) => {
      const option = document.createElement('option');
      option.value = `${policy.policyId}\n${policy.policyVersion}`;
      option.textContent = policy.name;
      return option;
    }));
    showPolicyDescription();
    byId('draft-readiness').textContent = '학기를 선택하면 자동 배정 준비 상태를 확인합니다.';
    byId('draft-create-dialog').showModal();
  };

  const showReadiness = async () => {
    const request = ++readinessRequest;
    const semesterId = byId('draft-create-form').elements.semesterId.value;
    if (!semesterId) {
      byId('draft-readiness').textContent = '학기를 선택하면 자동 배정 준비 상태를 확인합니다.';
      return;
    }
    const [context, enrollments] = await Promise.all([
      api(`/semesters/${semesterId}/context`), api(`/enrollments?semesterId=${encodeURIComponent(semesterId)}&limit=200`),
    ]);
    if (request !== readinessRequest) return;
    const { issues, readyForAutoAllocation } = /** @type {{ issues: { code: string }[], readyForAutoAllocation: boolean }} */ (context);
    const { total } = /** @type {{ total: number }} */ (enrollments);
    const issueNames = issues.map(({ code }) => issueText({ code, severity: 'WARNING' }));
    byId('draft-readiness').textContent = readyForAutoAllocation
      ? `자동 배정 준비됨 · 기존 확정 ${total}명`
      : `자동 배정 준비 필요: ${issueNames.join(', ')} · 기존 확정 ${total}명`;
  };

  return { load, openCreate, showPolicyDescription, showReadiness, openDraft, deleteDraft, submitDraft,
    saveDraftItem, restoreDraftItem, addDraftItem };
};
