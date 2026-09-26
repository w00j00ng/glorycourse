import { issueText } from './issue-view.js';

/** @typedef {Pick<import('../backend/src/storage/store.ts').AllocationDraftRecord, 'id' | 'semesterId' | 'revision' | 'mode' | 'policyId' | 'policyVersion' | 'updatedAt'>} DraftSummary */
/** @typedef {{ policyId: string, policyVersion: string, name: string, description: string, settings: unknown }} DraftPolicy */
/**
 * @param {{
 *   state: { drafts: DraftSummary[], semesters: { id: string, name: string }[], policies: DraftPolicy[], pagination: { draft: { page: number, limit: number, total: number } } },
 *   byId: (id: string) => any,
 *   api: (path: string) => Promise<unknown>,
 *   fillSelect: (select: HTMLSelectElement, items: { id: string, name: string }[], placeholder: string) => void,
 *   loadPaged: (name: string, path: string, filters: string, pagination: { page: number, limit: number, total: number }) => Promise<DraftSummary[]>,
 *   cell: (text: string) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 *   resourceName: (items: { id: string, name: string }[], id: string) => string,
 *   policyName: (id: string, version: string) => string,
 *   openDraft: (id: string) => Promise<void>,
 *   deleteDraft: (draft: DraftSummary) => Promise<void>,
 * }} dependencies
 */
export const createDraftsPage = ({ state, byId, api, fillSelect, loadPaged, cell, actionsCell, resourceName, policyName, openDraft, deleteDraft }) => {
  let readinessRequest = 0;

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

  return { load, openCreate, showPolicyDescription, showReadiness };
};
