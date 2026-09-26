import { allocationDraftStatus, currentSemester, nextDashboardTask } from './dashboard-view.js';
import { PROGRESS_WORKFLOW, WORKFLOW } from './help-content.js';

export const createDashboardPage = ({ state, api, byId }) => {
  const render = (summary) => {
    const next = nextDashboardTask(summary);
    byId('dashboard-semester').textContent = summary.semester?.name ?? '없음';
    byId('dashboard-course-count').textContent = String(summary.courseCount);
    byId('dashboard-application-count').textContent = String(summary.applicationCount);
    byId('dashboard-draft-status').textContent = allocationDraftStatus(summary.latestDraft);
    byId('dashboard-enrollment-count').textContent = String(summary.enrollmentCount);
    byId('dashboard-next-title').textContent = next.label;
    byId('dashboard-next-description').textContent = next.description;
    const action = byId('dashboard-next-action');
    action.textContent = next.action;
    action.dataset.viewTarget = next.view;
    byId('dashboard-progress').replaceChildren(...PROGRESS_WORKFLOW.map((step, index) => {
      const item = document.createElement('li');
      item.textContent = step.title;
      item.classList.toggle('complete', index < next.stage);
      item.classList.toggle('current', index === next.stage);
      return item;
    }));
  };

  const load = async () => {
    const semester = currentSemester(state.semesters);
    if (!semester) {
      render({
        semester: null, courseCount: 0, unresolvedCapacityCount: 0,
        applicationCount: 0, latestDraft: null, enrollmentCount: 0,
      });
      return;
    }
    const semesterId = encodeURIComponent(semester.id);
    const [context, applications, drafts, enrollments, report] = await Promise.all([
      api(`/semesters/${semesterId}/context`),
      api(`/applications?semesterId=${semesterId}&page=1&limit=1`),
      api(`/allocation-drafts?semesterId=${semesterId}&page=1&limit=1`),
      api(`/enrollments?semesterId=${semesterId}&page=1&limit=1`),
      api(`/semesters/${semesterId}/enrollment-report`),
    ]);
    let latestDraft = drafts.items[0] ? { ...drafts.items[0], isStale: false }
      : report.finalized ? { status: 'FINALIZED', enrollmentReportIsCurrent: report.enrollmentReportIsCurrent } : null;
    if (latestDraft?.status === 'DRAFT') {
      const detail = await api(`/allocation-drafts/${encodeURIComponent(latestDraft.id)}`);
      latestDraft = { ...latestDraft, isStale: detail.isStale };
    }
    render({
      semester,
      courseCount: context.semesterCourses.length,
      unresolvedCapacityCount: context.semesterCourses.filter(({ capacity }) => capacity === null).length,
      applicationCount: applications.total,
      latestDraft,
      enrollmentCount: enrollments.total,
    });
  };

  const renderWorkflow = () => {
    byId('dashboard-workflow').replaceChildren(...WORKFLOW.map((step) => {
      const card = document.createElement('article');
      const title = document.createElement('h4');
      title.textContent = step.title;
      const description = document.createElement('p');
      description.textContent = step.description;
      const button = document.createElement('button');
      button.className = 'secondary';
      button.type = 'button';
      button.dataset.viewTarget = step.view;
      button.textContent = `${step.title} 열기`;
      card.append(title, description, button);
      return card;
    }));
  };

  return { load, renderWorkflow };
};
