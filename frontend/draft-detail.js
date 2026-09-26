import {
  describeAllocationEvidence,
  draftApplicationSummaries,
  draftDecisionChanged,
  draftItemPage,
  filterDraftItems,
  reasonLabel,
  sortDraftItems,
} from './draft-view.js';

/** @typedef {import('../backend/src/services/drafts.ts').DraftDetail} DraftDetail */
/** @typedef {import('../backend/src/storage/store.ts').AllocationDraftItemRecord} DraftItem */
/** @typedef {ReturnType<import('../backend/src/services/applications.ts').ApplicationService['getSemesterContext']>} DraftContext */

/**
 * @param {{
 *   state: {
 *     draft: DraftDetail | null, draftContext: DraftContext | null,
 *     draftApplicationSummaries: ReturnType<typeof draftApplicationSummaries> | null,
 *     members: { id: string, name: string }[],
 *     pagination: { 'draft-item': { page: number, limit: number, total: number } },
 *   },
 *   byId: (id: string) => any,
 *   fillSelect: (select: HTMLSelectElement, items: { id: string, name: string }[], placeholder: string) => void,
 *   renderPagination: (name: string) => void,
 *   cell: (text: string) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 *   policyName: (id: string, version: string) => string,
 *   saveDraftItem: (item: DraftItem, semesterCourseId: string) => Promise<void>,
 *   restoreDraftItem: (item: DraftItem) => Promise<void>,
 * }} dependencies
 */
export const createDraftDetail = ({ state, byId, fillSelect, renderPagination, cell, actionsCell,
  policyName, saveDraftItem, restoreDraftItem }) => {
  /** @param {string | null} id */
  const courseName = (id) => id
    ? state.draftContext?.semesterCourses.find((course) => course.id === id)?.courseName ?? id
    : '제외';

  const fillAddFields = () => {
    if (!state.draft || !state.draftContext) return;
    const memberIds = new Set(state.draft.studentResults.map(({ memberId }) => memberId));
    fillSelect(byId('draft-add-member'), state.members.filter(({ id }) => !memberIds.has(id)), '회원을 선택하세요.');
    fillSelect(byId('draft-add-course'), state.draftContext.semesterCourses.map((course) => ({
      id: course.id, name: course.courseName,
    })), '강좌를 선택하세요.');
  };

  /** @param {DraftItem} item */
  const reasonCell = (item) => {
    const td = document.createElement('td');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = reasonLabel(item.autoReasonCode);
    const list = document.createElement('ul');
    list.className = 'draft-reason-list';
    details.addEventListener('toggle', () => {
      if (!details.open || list.childElementCount) return;
      list.append(...describeAllocationEvidence(item, courseName).map((text) => {
        const line = document.createElement('li');
        line.textContent = text;
        return line;
      }));
    });
    details.append(summary, list);
    td.append(details);
    return td;
  };

  const renderItems = () => {
    const detail = state.draft;
    const context = state.draftContext;
    const applications = state.draftApplicationSummaries;
    if (!detail || !context || !applications) return;
    const readonly = detail.draft.status !== 'DRAFT';
    const courseView = byId('draft-grouping').value === 'COURSE';
    const items = sortDraftItems(filterDraftItems(detail.studentResults, {
      query: byId('draft-search').value,
      result: byId('draft-result-filter').value,
      courseName,
    }), { applications, courseView, courseName, sort: byId('draft-sort').value });
    const { items: visibleItems, ...pagination } = draftItemPage(
      items, state.pagination['draft-item'].page, state.pagination['draft-item'].limit,
    );
    state.pagination['draft-item'] = pagination;
    renderPagination('draft-item');
    byId('draft-item-rows').replaceChildren(...visibleItems.map((item) => {
      const row = document.createElement('tr');
      row.classList.toggle('draft-row-changed', draftDecisionChanged(item));
      const finalSelect = document.createElement('select');
      finalSelect.setAttribute('aria-label', `${item.memberNameAtGeneration} 최종 배정`);
      const selectedId = item.finalDecision === 'SELECTED' ? item.finalSemesterCourseId : null;
      fillSelect(finalSelect, selectedId ? [{ id: selectedId, name: courseName(selectedId) }] : [], '제외');
      finalSelect.value = selectedId ?? '';
      finalSelect.disabled = readonly;
      if (!readonly) finalSelect.addEventListener('focus', () => {
        const selected = finalSelect.value;
        fillSelect(finalSelect, context.semesterCourses.map((course) => ({ id: course.id, name: course.courseName })), '제외');
        finalSelect.value = selected;
      }, { once: true });
      const finalCell = document.createElement('td');
      finalCell.append(finalSelect);
      const application = applications.get(item.sourceApplicationId ?? '');
      const orderCell = cell(application ? String(application.applicationOrder ?? '미정') : '—');
      orderCell.className = 'draft-order';
      const applicationCell = cell(application?.choices ?? '신청 없음');
      applicationCell.className = 'choices';
      row.append(
        orderCell,
        cell(item.memberNameAtGeneration),
        applicationCell,
        cell(item.autoDecision === 'SELECTED' ? courseName(item.autoSemesterCourseId) : item.autoDecision === 'NOT_EVALUATED' ? '자동 결과 없음' : '제외'),
        reasonCell(item),
        finalCell,
      );
      if (readonly) row.append(cell(''));
      else {
        /** @type {[string, () => Promise<void>][]} */
        const actions = [['저장', () => saveDraftItem(item, finalSelect.value)]];
        if (item.autoDecision !== 'NOT_EVALUATED') actions.push(['자동 복원', () => restoreDraftItem(item)]);
        row.append(actionsCell(...actions));
      }
      return row;
    }));
    byId('draft-filter-count').textContent = `${items.length} / ${detail.studentResults.length}명`;
    byId('draft-item-empty').textContent = detail.studentResults.length && !items.length
      ? '검색 조건에 맞는 학생이 없습니다.'
      : '검토할 학생이 없습니다.';
    byId('draft-item-empty').hidden = items.length !== 0;
  };

  /** @param {DraftDetail} detail @param {DraftContext} context */
  const show = (detail, context) => {
    const changedDraft = state.draft?.draft.id !== detail.draft.id;
    state.draft = detail;
    state.draftContext = context;
    state.draftApplicationSummaries = draftApplicationSummaries(detail.applicationSnapshot);
    if (changedDraft) {
      state.pagination['draft-item'].page = 1;
      byId('draft-search').value = '';
      byId('draft-result-filter').value = 'ALL';
      byId('draft-grouping').value = 'STUDENT';
      byId('draft-sort').value = 'ORDER_ASC';
    }
    byId('draft-dialog-title').textContent = `${context.semester.name} 배정초안`;
    byId('draft-dialog-meta').textContent = `${detail.draft.mode} · ${policyName(detail.draft.policyId, detail.draft.policyVersion)} · revision ${detail.draft.revision}`;
    byId('draft-stale').hidden = !detail.isStale;
    const readonly = detail.draft.status !== 'DRAFT';
    byId('draft-stale').textContent = readonly
      ? '이 화면은 초안 생성 당시 자료를 보여주며 현재 수강 자료와 차이가 있습니다.'
      : '초안 생성 뒤 원본 자료가 변경되었습니다. 현재 초안을 확정하지 말고 새 초안을 검토하세요.';
    byId('draft-readonly').hidden = !readonly;
    byId('draft-readonly').textContent = `${detail.draft.status} · 읽기 전용`;
    byId('draft-add-item').hidden = readonly;
    byId('preview-finalization').hidden = readonly;
    fillAddFields();
    renderItems();
    if (!byId('draft-dialog').open) byId('draft-dialog').showModal();
  };

  return { show, renderItems, courseName, fillAddFields };
};
