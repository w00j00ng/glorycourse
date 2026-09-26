import { currentSemester } from './dashboard-view.js';
import { reportFilename } from './download-name.js';

/** @typedef {import('../backend/src/services/enrollments.ts').EnrollmentView} EnrollmentRow */
/** @typedef {{ semesterId: string, finalized: boolean, enrollmentReportIsCurrent: boolean }} EnrollmentReport */
/**
 * @param {{
 *   state: { semesters: import('./dashboard-view.js').Semester[], enrollments: EnrollmentRow[], enrollmentReport: EnrollmentReport | null,
 *     pagination: { enrollment: { total: number } } },
 *   byId: (id: string) => any,
 *   api: (path: string) => Promise<unknown>,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   download: (path: string, filename: string, options?: RequestInit) => Promise<unknown>,
 *   loadPaged: (name: string, path: string, query: string, pagination: object) => Promise<EnrollmentRow[] | undefined>,
 *   recordQuery: (name: string) => string,
 *   resourceName: (items: { id: string, name: string }[], id: string) => string,
 *   cell: (text: string) => any,
 *   actionsCell: (...actions: any[]) => any,
 *   openEnrollment: (item: EnrollmentRow) => void,
 *   deleteEnrollment: (item: EnrollmentRow) => Promise<void>,
 * }} dependencies
 */
export const createEnrollmentsPage = ({ state, byId, api, run, download, loadPaged, recordQuery,
  resourceName, cell, actionsCell, openEnrollment, deleteEnrollment }) => {
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

  return { load, completeReport };
};
