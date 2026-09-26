import { templateFilename } from './download-name.js';

/** @typedef {import('../backend/src/services/applications.ts').ApplicationInput['choices'][number]} ApplicationChoice */
/** @typedef {import('../backend/src/services/applications.ts').ApplicationView} ApplicationRow */
/**
 * @param {{
 *   state: { semesters: { id: string, name: string }[], applications: ApplicationRow[], pagination: { application: { total: number } } },
 *   byId: (id: string) => any,
 *   api: (path: string, options?: RequestInit) => Promise<unknown>,
 *   fillSelect: (select: any, items: { id: string, name: string }[], placeholder: string) => void,
 *   showMessage: (message: string, error?: boolean) => void,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   download: (path: string, filename: string) => Promise<unknown>,
 *   cell: (text: string) => any,
 *   choicesCell: (choices: unknown[]) => any,
 *   badgeCell: (text: string, warning: boolean) => any,
 *   actionsCell: (...actions: any[]) => any,
 *   loadPaged: (name: string, path: string, query: string, pagination: object) => Promise<ApplicationRow[] | undefined>,
 *   recordQuery: (name: string) => string,
 *   loadCatalogs: () => Promise<void>,
 * }} dependencies
 */
export const createApplicationsPage = ({ state, byId, api, fillSelect, showMessage, run, download, cell, choicesCell, badgeCell, actionsCell, loadPaged, recordQuery, loadCatalogs }) => {
  const renderApplications = () => {
    const body = byId('application-rows');
    body.replaceChildren(...state.applications.map((item) => {
      const row = document.createElement('tr');
      row.append(
        cell(item.memberName),
        cell(item.semesterName),
        cell(String(item.applicationOrder)),
        choicesCell(item.choices),
        badgeCell(item.applicationOrderStatus === 'NORMAL' ? '정상' : item.applicationOrderStatus, item.applicationOrderStatus !== 'NORMAL'),
        actionsCell(
          ['수정', () => openApplication(item)],
          ['삭제', () => deleteApplication(item), 'delete'],
        ),
      );
      return row;
    }));
    byId('application-empty').hidden = state.applications.length !== 0;
    byId('application-count').textContent = String(state.pagination.application.total);
    byId('choice-count').textContent = String(state.applications.reduce((total, item) => total + item.choices.length, 0));
  };

  const load = async () => {
    const pagination = state.pagination.application = { ...state.pagination.application };
    const items = await loadPaged('application', '/applications', recordQuery('application'), pagination);
    if (state.pagination.application !== pagination) return;
    state.applications = items ?? [];
    renderApplications();
  };

  /** @param {HTMLElement} container @param {Partial<ApplicationChoice>} [choice] */
  const addChoice = (container, choice = {}) => {
    const row = byId('choice-template').content.firstElementChild.cloneNode(true);
    row.querySelector('[name="courseName"]').value = choice.courseName || '';
    row.querySelector('[name="preference"]').value = choice.preference || container.children.length + 1;
    row.querySelector('.remove-choice').addEventListener('click', () => {
      if (container.children.length > 1) row.remove();
    });
    container.append(row);
  };

  /** @param {Partial<ApplicationRow>} [item] @param {boolean} [editing] */
  const addApplicationEntry = (item = {}, editing = false) => {
    const container = byId('application-entry-rows');
    if (container.children.length >= 100) return showMessage('한 번에 최대 100건을 등록할 수 있습니다.', true);
    const row = byId('application-entry-template').content.firstElementChild.cloneNode(true);
    const previous = container.lastElementChild;
    row.querySelector('[name="semesterName"]').value = item.semesterName ?? previous?.querySelector('[name="semesterName"]').value ?? '';
    row.querySelector('[name="memberName"]').value = item.memberName ?? '';
    row.querySelector('[name="applicationOrder"]').value = item.applicationOrder ?? '';
    const choices = row.querySelector('.choice-fields');
    for (const choice of item.choices ?? [{}]) addChoice(choices, choice);
    row.querySelector('.add-choice').addEventListener('click', () => addChoice(choices));
    const remove = row.querySelector('.remove-entry');
    remove.hidden = editing;
    remove.addEventListener('click', () => {
      if (container.children.length > 1) {
        row.remove();
        [...container.children].forEach((entry, index) => { entry.querySelector('legend').textContent = `신청 ${index + 1}`; });
      }
    });
    container.append(row);
    row.querySelector('legend').textContent = `신청 ${container.children.length}`;
  };

  /** @param {ApplicationRow} [item] */
  const openApplication = (item) => {
    const form = byId('application-form');
    form.reset();
    form.dataset.id = item?.id || '';
    form.dataset.revision = item?.revision ?? '';
    byId('application-dialog-title').textContent = item ? '신청 수정' : '신청 등록';
    byId('application-entry-rows').replaceChildren();
    byId('add-application-entry').hidden = Boolean(item);
    form.querySelector('[type="submit"]').textContent = item ? '저장' : '전체 저장';
    addApplicationEntry(item, Boolean(item));
    byId('application-dialog').showModal();
  };

  /** @param {ApplicationRow} item */
  const deleteApplication = async (item) => {
    if (!window.confirm(`${item.memberName}님의 ${item.semesterName} 신청을 삭제할까요?`)) return;
    await run(
      () => api(`/applications/${item.id}?expectedRevision=${item.revision}`, { method: 'DELETE' }),
      '신청을 삭제했습니다.',
    );
    await load();
  };

  /** @param {SubmitEvent} event */
  const submitApplication = async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const submit = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
    if (submit.disabled) return;
    const items = [...byId('application-entry-rows').children].map((entry) => ({
      semesterName: entry.querySelector('[name="semesterName"]').value,
      memberName: entry.querySelector('[name="memberName"]').value,
      applicationOrder: Number(entry.querySelector('[name="applicationOrder"]').value),
      choices: [...entry.querySelector('.choice-fields').children].map((row) => ({
        courseName: row.querySelector('[name="courseName"]').value,
        preference: Number(row.querySelector('[name="preference"]').value),
      })),
    }));
    submit.disabled = true;
    try {
      await run(
        () => api(form.dataset.id ? `/applications/${form.dataset.id}` : '/applications/batch', {
          method: form.dataset.id ? 'PATCH' : 'POST',
          body: JSON.stringify(form.dataset.id ? { ...items[0], expectedRevision: Number(form.dataset.revision) } : { items }),
        }),
        form.dataset.id ? '신청을 수정했습니다.' : `신청 ${items.length}건을 등록했습니다.`,
      );
      byId('application-dialog').close();
      await loadCatalogs();
      await load();
    } finally { submit.disabled = false; }
  };

  const showTemplateSummary = async () => {
    const form = byId('application-template-form');
    const semesterId = form.elements.semesterId.value;
    const summary = byId('application-template-summary');
    if (!semesterId) {
      summary.textContent = '학기를 선택하면 양식에 포함할 강좌를 확인합니다.';
      return;
    }
    summary.textContent = '개설 강좌를 확인하는 중입니다.';
    const context = /** @type {{ semester: { name: string }, semesterCourses: unknown[] }} */ (await api(`/semesters/${semesterId}/context`));
    if (form.elements.semesterId.value !== semesterId) return;
    summary.textContent = context.semesterCourses.length
      ? `${context.semester.name}의 개설 강좌 ${context.semesterCourses.length}개를 양식에 포함합니다.`
      : `${context.semester.name}에 등록된 개설 강좌가 없습니다. 빈 개설강좌 시트로 다운로드합니다.`;
  };

  const openTemplate = () => {
    const form = byId('application-template-form');
    form.reset();
    fillSelect(form.elements.semesterId, state.semesters, '학기를 선택하세요.');
    const filteredSemesterId = byId('application-semester-filter').value;
    if (state.semesters.some(({ id }) => id === filteredSemesterId)) form.elements.semesterId.value = filteredSemesterId;
    byId('application-template-dialog').showModal();
    void showTemplateSummary().catch((error) => showMessage(error.message, true));
  };

  /** @param {SubmitEvent} event */
  const downloadTemplate = async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement & { elements: HTMLFormControlsCollection & { semesterId: HTMLSelectElement } }} */ (event.currentTarget);
    const semesterId = form.elements.semesterId.value;
    await run(
      () => download(`/applications/template?semesterId=${encodeURIComponent(semesterId)}`, templateFilename('수강신청')),
      '선택한 학기의 신청 양식을 다운로드했습니다.',
    );
    byId('application-template-dialog').close();
  };

  return { load, renderApplications, addApplicationEntry, openApplication, submitApplication, deleteApplication, showTemplateSummary, openTemplate, downloadTemplate };
};
