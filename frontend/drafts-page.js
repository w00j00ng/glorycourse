/** @typedef {Pick<import('../backend/src/storage/store.ts').AllocationDraftRecord, 'id' | 'semesterId' | 'revision' | 'mode' | 'policyId' | 'policyVersion' | 'updatedAt'>} DraftSummary */
/**
 * @param {{
 *   state: { drafts: DraftSummary[], semesters: { id: string, name: string }[], pagination: { draft: { page: number, limit: number, total: number } } },
 *   byId: (id: string) => any,
 *   loadPaged: (name: string, path: string, filters: string, pagination: { page: number, limit: number, total: number }) => Promise<DraftSummary[]>,
 *   cell: (text: string) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 *   resourceName: (items: { id: string, name: string }[], id: string) => string,
 *   policyName: (id: string, version: string) => string,
 *   openDraft: (id: string) => Promise<void>,
 *   deleteDraft: (draft: DraftSummary) => Promise<void>,
 * }} dependencies
 */
export const createDraftsPage = ({ state, byId, loadPaged, cell, actionsCell, resourceName, policyName, openDraft, deleteDraft }) => {
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

  return { load };
};
