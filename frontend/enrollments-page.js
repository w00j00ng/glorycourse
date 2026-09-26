import { currentSemester } from './dashboard-view.js';
import { reportFilename } from './download-name.js';

/** @typedef {import('../backend/src/services/enrollments.ts').EnrollmentView} EnrollmentRow */
/** @typedef {ReturnType<import('../backend/src/services/enrollments.ts').EnrollmentService['preview']>} EnrollmentPreview */
/** @typedef {{ semesterId: string, finalized: boolean, enrollmentReportIsCurrent: boolean }} EnrollmentReport */
/**
 * @param {{
 *   state: { semesters: import('./dashboard-view.js').Semester[], courses: { id: string, name: string }[],
 *     enrollments: EnrollmentRow[], enrollmentReport: EnrollmentReport | null,
 *     pagination: { enrollment: { total: number } } },
 *   byId: (id: string) => any,
 *   showMessage: (message: string, error?: boolean) => void,
 *   api: (path: string, options?: RequestInit) => Promise<unknown>,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   download: (path: string, filename: string, options?: RequestInit) => Promise<unknown>,
 *   loadPaged: (name: string, path: string, query: string, pagination: object) => Promise<EnrollmentRow[] | undefined>,
 *   recordQuery: (name: string) => string,
 *   resourceName: (items: { id: string, name: string }[], id: string) => string,
 *   cell: (text: string) => any,
 *   actionsCell: (...actions: any[]) => any,
 *   reviewWarnings: (preview: EnrollmentPreview, issueContext: (issue: import('../backend/src/services/enrollments.ts').EnrollmentIssue) => { memberName: string, courseName: string }) => Promise<string | null>,
 * }} dependencies
 */
export const createEnrollmentsPage = ({ state, byId, showMessage, api, run, download, loadPaged, recordQuery,
  resourceName, cell, actionsCell, reviewWarnings }) => {
  /** @param {Partial<EnrollmentRow>} [item] @param {boolean} [editing] */
  const addEnrollmentEntry = (item = {}, editing = false) => {
    const container = byId('enrollment-entry-rows');
    if (container.children.length >= 100) return showMessage('한 번에 최대 100건을 등록할 수 있습니다.', true);
    const row = byId('enrollment-entry-template').content.firstElementChild.cloneNode(true);
    const previous = container.lastElementChild;
    row.querySelector('[name="semesterName"]').value = item.semesterName ?? previous?.querySelector('[name="semesterName"]').value ?? '';
    row.querySelector('[name="memberName"]').value = item.memberName ?? '';
    configureEnrollmentCourse(row, item.courseName ?? (previous ? enrollmentCourseName(previous) : ''));
    const remove = row.querySelector('.remove-entry');
    remove.hidden = editing;
    remove.addEventListener('click', () => {
      if (container.children.length > 1) { row.remove(); numberEnrollmentEntries(); }
    });
    container.append(row);
    numberEnrollmentEntries();
  };

  const numberEnrollmentEntries = () => {
    [...byId('enrollment-entry-rows').children].forEach((row, index) => {
      row.querySelector('legend').textContent = `이력 ${index + 1}`;
    });
  };

  /** @param {any} entry @param {string} courseName */
  const configureEnrollmentCourse = (entry, courseName) => {
    const select = entry.querySelector('[name="courseId"]');
    const newCourse = entry.querySelector('[name="newCourseName"]');
    const newOption = document.createElement('option');
    newOption.value = '';
    newOption.textContent = '새 강좌 입력';
    select.replaceChildren(newOption, ...state.courses.map((course) => {
      const option = document.createElement('option');
      option.value = course.id;
      option.textContent = course.name;
      return option;
    }));
    const existing = state.courses.find(({ name }) => name === courseName);
    select.value = existing?.id ?? '';
    newCourse.value = existing ? '' : courseName;
    const sync = () => {
      newCourse.closest('label').hidden = Boolean(select.value);
      newCourse.required = !select.value;
    };
    select.addEventListener('change', sync);
    sync();
  };

  /** @param {any} entry */
  const enrollmentCourseName = (entry) => (
    state.courses.find(({ id }) => id === entry.querySelector('[name="courseId"]').value)?.name
    ?? entry.querySelector('[name="newCourseName"]').value
  );

  /** @param {EnrollmentRow} [item] */
  const openEnrollment = (item) => {
    const form = byId('enrollment-form');
    form.reset();
    form.dataset.id = item?.id || '';
    form.dataset.revision = item?.revision ?? '';
    byId('enrollment-dialog-title').textContent = item ? '이력 수정' : '이력 등록';
    byId('enrollment-entry-rows').replaceChildren();
    byId('add-enrollment-entry').hidden = Boolean(item);
    addEnrollmentEntry(item, Boolean(item));
    byId('enrollment-dialog').showModal();
  };

  const render = () => {
    byId('enrollment-rows').replaceChildren(...state.enrollments.map((item) => {
      const row = document.createElement('tr');
      row.append(
        cell(item.semesterName),
        cell(item.memberName),
        cell(item.courseName),
        actionsCell(
          ['수정', () => openEnrollment(item)],
          ['삭제', () => deleteEnrollment(item), 'delete'],
        ),
      );
      return row;
    }));
    byId('enrollment-empty').hidden = state.enrollments.length !== 0;
    byId('enrollment-count').textContent = String(state.pagination.enrollment.total);
    byId('delete-semester-enrollments').disabled = !byId('enrollment-semester-filter').value;
    byId('enrollment-report-task').hidden = !state.enrollmentReport;
    if (state.enrollmentReport) {
      const semesterName = resourceName(state.semesters, state.enrollmentReport.semesterId);
      byId('enrollment-report-task-description').textContent = `${semesterName} 수강이력을 확인한 뒤 현황 파일을 내려받으면 이번 학기 업무가 완료됩니다.`;
    }
  };

  const load = async () => {
    const pagination = state.pagination.enrollment = { ...state.pagination.enrollment };
    const items = await loadPaged('enrollment', '/enrollments', recordQuery('enrollment'), pagination);
    if (state.pagination.enrollment !== pagination) return;
    const semester = currentSemester(state.semesters);
    const report = semester
      ? /** @type {EnrollmentReport} */ (await api(`/semesters/${encodeURIComponent(semester.id)}/enrollment-report`))
      : null;
    if (state.pagination.enrollment !== pagination) return;
    state.enrollments = items ?? [];
    state.enrollmentReport = report?.finalized && !report.enrollmentReportIsCurrent ? report : null;
    render();
  };

  /** @param {EnrollmentRow} item */
  const deleteEnrollment = async (item) => {
    if (!window.confirm(`${item.memberName}님의 ${item.semesterName} 수강이력을 삭제할까요?`)) return;
    const preview = /** @type {EnrollmentPreview} */ (await run(() => api('/enrollments/preview', {
      method: 'POST',
      body: JSON.stringify({
        action: 'DELETE', enrollmentId: item.id, expectedRevision: item.revision,
        semesterName: item.semesterName, memberName: item.memberName, courseName: item.courseName,
      }),
    })));
    const note = await reviewWarnings(preview, () => ({ memberName: item.memberName, courseName: item.courseName }));
    if (note === null) return;
    await run(() => api(`/enrollments/${item.id}`, {
      method: 'DELETE',
      body: JSON.stringify({
        preparedActionToken: preview.preparedActionToken,
        acknowledgedWarningDigest: preview.warningDigest,
        ...(note ? { acknowledgementNote: note } : {}),
      }),
    }), '이력을 삭제했습니다.');
    await load();
  };

  const completeReport = async () => {
    const report = state.enrollmentReport;
    if (!report) return;
    await run(() => download(
      `/semesters/${encodeURIComponent(report.semesterId)}/enrollment-report`,
      reportFilename('수강이력'),
      { method: 'POST' },
    ), '현재 학기 수강이력 현황을 다운로드했습니다.');
    await load();
  };

  const deleteSemesterEnrollments = async () => {
    const semesterId = byId('enrollment-semester-filter').value;
    if (!semesterId) return;
    const path = `/semesters/${encodeURIComponent(semesterId)}/enrollments`;
    const preview = /** @type {{ count: number, semesterName: string, storeRevision: number, storeEpoch: string }} */ (await run(() => api(path)));
    if (preview.count === 0) {
      showMessage(`${preview.semesterName} 학기에 삭제할 수강이력이 없습니다.`);
      return;
    }
    const confirmationName = window.prompt(
      `${preview.semesterName} 학기의 수강이력 ${preview.count}건을 모두 삭제합니다.\n`+
      '검색 조건이나 페이지에 관계없이 삭제되며 되돌릴 수 없습니다.\n계속하려면 학기명을 정확히 입력하세요.',
    );
    if (confirmationName === null) return;
    if (confirmationName !== preview.semesterName) {
      showMessage('학기명이 일치하지 않아 삭제하지 않았습니다.', true);
      return;
    }
    await run(() => api(path, {
      method: 'DELETE',
      body: JSON.stringify({
        confirmationName, expectedRevision: preview.storeRevision, expectedEpoch: preview.storeEpoch,
      }),
    }), `${preview.semesterName} 학기 수강이력 ${preview.count}건을 삭제했습니다.`);
    await load();
  };

  return { load, completeReport, addEnrollmentEntry, enrollmentCourseName, openEnrollment, deleteSemesterEnrollments };
};
