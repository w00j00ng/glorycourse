import {
  describeAllocationEvidence,
  draftApplicationSummaries,
  draftCourseStatuses,
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
 *   fillDatalist: (id: string, items: { name: string }[]) => void,
 *   renderPagination: (name: string) => void,
 *   cell: (text: string) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 *   policyName: (id: string, version: string) => string,
 *   saveDraftItem: (item: DraftItem, semesterCourseId: string, affiliation: string) => Promise<void>,
 *   restoreDraftItem: (item: DraftItem) => Promise<void>,
 * }} dependencies
 */
export const createDraftDetail = ({ state, byId, fillSelect, fillDatalist, renderPagination, cell, actionsCell,
  policyName, saveDraftItem, restoreDraftItem }) => {
  /** @type {Map<string, ReturnType<typeof draftCourseStatuses>[number]>} */
  let courseStatuses = new Map();
  /** @type {Set<string>} */
  let enrolledNames = new Set();

  const showMemberWarning = () => {
    const name = byId('draft-add-member').value.trim().normalize('NFC');
    byId('draft-add-member-warning').hidden = !enrolledNames.has(name);
  };

  const renderMemberOptions = () => {
    const members = state.draft?.currentEnrolledMembers ?? [];
    const enrolledIds = new Set(members.map(({ id }) => id));
    enrolledNames = new Set(members.map(({ name }) => name.trim().normalize('NFC')));
    fillDatalist('draft-member-options', state.members.filter(({ id }) => !enrolledIds.has(id)));
    showMemberWarning();
  };

  /** @param {string | null} id */
  const courseName = (id) => id
    ? state.draftContext?.semesterCourses.find((course) => course.id === id)?.courseName ?? id
    : '제외';

  /** @param {string} id */
  const courseOptionName = (id) => {
    const course = courseStatuses.get(id);
    if (!course || !course.hasSnapshot) return `${courseName(id)} · 현황 미확인 · 새 초안 필요`;
    const count = course.capacity === null ? `${course.totalCount}명` : `${course.totalCount}/${course.capacity}명`;
    return `${courseName(id)} · ${count} · ${course.status}`;
  };

  const renderCapacities = () => {
    if (!state.draft) return;
    const original = new Map(state.draft.studentResults.map((item) => [
      item.memberId, item.finalDecision === 'SELECTED' ? item.finalSemesterCourseId : '',
    ]));
    /** @type {HTMLSelectElement[]} */
    const selects = Array.from(byId('draft-item-rows').querySelectorAll('select'));
    const pending = new Map(selects.filter((select) => select.value !== original.get(select.dataset.memberId ?? ''))
      .map((select) => [select.dataset.memberId ?? '', select.value]));
    const courses = draftCourseStatuses(state.draft, pending);
    courseStatuses = new Map(courses.map((course) => [course.semesterCourseId, course]));
    byId('draft-capacity-status').textContent = `${pending.size
      ? '저장 전 선택 미리보기 · 각 행의 저장으로 반영하세요.' : '저장된 최종 결정 기준.'} 기존 이력 포함 · 초안 생성 당시 정원`;
    byId('draft-capacity-rows').replaceChildren(...courses.map((course) => {
      const row = document.createElement('tr');
      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      const full = course.capacity !== null && course.totalCount >= course.capacity;
      status.className = full || !course.hasSnapshot || course.capacity === null ? 'badge warning' : 'badge';
      status.classList.toggle('draft-capacity-exceeded', course.capacity !== null && course.totalCount > course.capacity);
      status.textContent = course.status;
      statusCell.append(status);
      row.append(cell(courseName(course.semesterCourseId)), cell(course.hasSnapshot ? String(course.existingEnrollmentCount) : '미확인'),
        cell(String(course.finalSelectedCount)), cell(course.hasSnapshot ? `${course.totalCount} / ${course.capacity ?? '미정'}명` : '미확인'),
        cell(!course.hasSnapshot ? '미확인' : course.remaining === null ? '미정' : `${course.remaining}명`), statusCell);
      return row;
    }));
    for (const select of [...selects, byId('draft-add-course')]) {
      for (const option of select.options) if (option.value) option.textContent = courseOptionName(option.value);
    }
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
      finalSelect.dataset.memberId = item.memberId;
      finalSelect.setAttribute('aria-label', `${item.memberNameAtGeneration} 최종 배정`);
      const selectedId = item.finalDecision === 'SELECTED' ? item.finalSemesterCourseId : null;
      fillSelect(finalSelect, selectedId ? [{ id: selectedId, name: courseOptionName(selectedId) }] : [], '제외');
      finalSelect.value = selectedId ?? '';
      finalSelect.disabled = readonly;
      if (!readonly) finalSelect.addEventListener('focus', () => {
        const selected = finalSelect.value;
        fillSelect(finalSelect, context.semesterCourses.map((course) => ({ id: course.id, name: courseOptionName(course.id) })), '제외');
        finalSelect.value = selected;
      }, { once: true });
      finalSelect.addEventListener('change', renderCapacities);
      const finalCell = document.createElement('td');
      finalCell.append(finalSelect);
      const application = applications.get(item.sourceApplicationId ?? '');
      const orderCell = cell(application ? String(application.applicationOrder ?? '미정') : '—');
      orderCell.className = 'draft-order';
      const applicationCell = cell(application?.choices ?? '신청 없음');
      applicationCell.className = 'choices';
      const affiliationCell = cell(item.affiliation ?? '—');
      const affiliation = document.createElement('input');
      if (!readonly) {
        affiliation.value = item.affiliation ?? '';
        affiliation.maxLength = 200;
        affiliation.setAttribute('aria-label', `${item.memberNameAtGeneration} 학생 소속`);
        affiliationCell.replaceChildren(affiliation);
      }
      row.append(
        orderCell,
        cell(item.memberNameAtGeneration),
        affiliationCell,
        applicationCell,
        cell(item.autoDecision === 'SELECTED' ? courseName(item.autoSemesterCourseId) : item.autoDecision === 'NOT_EVALUATED' ? '자동 결과 없음' : '제외'),
        reasonCell(item),
        finalCell,
      );
      if (readonly) row.append(cell(''));
      else {
        /** @type {[string, () => Promise<void>][]} */
        const actions = [['저장', () => saveDraftItem(item, finalSelect.value, affiliation.value)]];
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
    renderCapacities();
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
      byId('draft-add-member').value = '';
      byId('draft-add-affiliation').value = '';
    }
    byId('draft-dialog-title').textContent = `${context.semester.name} 배정초안`;
    byId('draft-dialog-meta').textContent = `${detail.draft.mode === 'MANUAL'
      ? '수동 · 정책 미적용' : `자동 · ${policyName(detail.draft.policyId, detail.draft.policyVersion)}`} · revision ${detail.draft.revision}`;
    byId('draft-stale').hidden = !detail.isStale;
    const readonly = detail.draft.status !== 'DRAFT';
    const manualEntry = byId('draft-manual-entry');
    manualEntry.hidden = readonly || detail.draft.mode !== 'MANUAL';
    manualEntry.disabled = manualEntry.hidden;
    const course = byId('draft-add-course');
    const selectedCourse = changedDraft ? '' : course.value;
    fillSelect(course, context.semesterCourses.map(({ id, courseName }) => ({ id, name: courseName })), '강좌를 선택하세요.');
    if (context.semesterCourses.some(({ id }) => id === selectedCourse)) course.value = selectedCourse;
    renderMemberOptions();
    byId('draft-stale').textContent = readonly
      ? '이 화면은 초안 생성 당시 자료를 보여주며 현재 수강 자료와 차이가 있습니다.'
      : '초안 생성 뒤 원본 자료가 변경되었습니다. 현재 초안을 확정하지 말고 새 초안을 검토하세요.';
    byId('draft-readonly').hidden = !readonly;
    byId('draft-readonly').textContent = `${detail.draft.status} · 읽기 전용`;
    byId('preview-finalization').hidden = readonly;
    renderItems();
    if (!byId('draft-dialog').open) byId('draft-dialog').showModal();
  };

  return { show, renderItems, courseName, renderMemberOptions, showMemberWarning };
};
