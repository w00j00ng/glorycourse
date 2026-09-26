import { templateFilename } from './download-name.js';

/**
 * @param {{ state: { semesters: { id: string, name: string }[] }, byId: (id: string) => any, api: (path: string) => Promise<unknown>, fillSelect: (select: any, items: { id: string, name: string }[], placeholder: string) => void, showMessage: (message: string, error?: boolean) => void, run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>, download: (path: string, filename: string) => Promise<unknown> }} dependencies
 */
export const createApplicationsPage = ({ state, byId, api, fillSelect, showMessage, run, download }) => {
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

  return { showTemplateSummary, openTemplate, downloadTemplate };
};
