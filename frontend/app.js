import {
  describeAllocationEvidence,
  draftApplicationSummaries,
  draftDecisionChanged,
  draftFinalSelection,
  draftItemPage,
  filterDraftItems,
  reasonLabel,
  sortDraftItems,
} from './draft-view.js';
import { applicationSemesterFilterValue, choiceSummary, paginationView, viewFromHash } from './list-view.js';
import { reportFilename, templateFilename } from './download-name.js';
import { orderSemesters } from './dashboard-view.js';
import { createDashboardPage } from './dashboard-page.js';
import { createDraftsPage } from './drafts-page.js';
import { createBackupsPage } from './backups-page.js';
import { createFinalizationPage } from './finalization-page.js';
import { createApplicationsPage } from './applications-page.js';
import { createCatalogPage } from './catalog-page.js';
import { createEnrollmentsPage } from './enrollments-page.js';
import { createImportsPage } from './imports-page.js';
import { PAGE_HELP } from './help-content.js';
import { issueText } from './issue-view.js';

const PAGE_LIMIT = 50;

const state = {
  token: '', applications: [], enrollments: [], drafts: [], draft: null, draftContext: null,
  policies: [], semesters: [], members: [], courses: [], catalogContext: null, catalogCopyCourses: [],
  importPreview: null, enrollmentReport: null, draftApplicationSummaries: null, busy: 0, stopping: false,
  applicationSemesterFilterTouched: false,
  selectedSemesterId: null,
  movingSemester: false,
  pagination: {
    application: { page: 1, limit: PAGE_LIMIT, total: 0 },
    enrollment: { page: 1, limit: PAGE_LIMIT, total: 0 },
    draft: { page: 1, limit: PAGE_LIMIT, total: 0 },
    'draft-item': { page: 1, limit: PAGE_LIMIT, total: 0 },
  },
};
const byId = (id) => document.getElementById(id);

const openHelp = (key) => {
  const help = PAGE_HELP[key];
  byId('help-title').textContent = help.title;
  byId('help-summary').textContent = help.summary;
  byId('help-steps').replaceChildren(...help.steps.map((text) => {
    const item = document.createElement('li');
    item.textContent = text;
    return item;
  }));
  byId('help-note').textContent = help.note;
  byId('help-dialog').showModal();
};

const api = async (path, options = {}) => {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(state.token ? { 'X-Glorycourse-Session': state.token } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return undefined;
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.message || '요청을 처리하지 못했습니다.'), data);
  return data;
};

const download = async (path, filename, options = {}) => {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Glorycourse-Session': state.token,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.message || '파일을 내려받지 못했습니다.');
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await response.blob());
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
};

const setStatus = (text) => { byId('save-status').textContent = text; };
const showMessage = (text, error = false) => {
  const message = byId('message');
  message.textContent = text;
  message.classList.toggle('error', error);
  message.hidden = !text;
  const dialogMessage = byId('dialog-message');
  const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
  dialogMessage.textContent = text;
  dialogMessage.classList.toggle('error', error);
  dialogMessage.hidden = !text || !dialog;
  if (text && dialog) dialog.querySelector('form').prepend(dialogMessage);
};

const run = async (action, success) => {
  state.busy++;
  byId('shutdown').disabled = true;
  try {
    setStatus('저장 중');
    showMessage('');
    const result = await action();
    setStatus('저장됨');
    if (success) showMessage(success);
    return result;
  } catch (error) {
    setStatus('저장 실패');
    const message = error.code === 'CONFLICT'
      ? `${error.message} 새로고침 후 다시 검토하세요.`
      : error.message;
    showMessage([message, ...(error.issues ?? []).map((issue) => issueText(issue))].join(' · '), true);
    throw error;
  } finally {
    state.busy--;
    byId('shutdown').disabled = state.busy > 0 || state.stopping;
  }
};

const shutdown = async () => {
  if (state.busy || state.stopping) return;
  state.stopping = true;
  const enabled = [...document.querySelectorAll('button, input, select, textarea')].filter((element) => !element.disabled);
  enabled.forEach((element) => { element.disabled = true; });
  setStatus('저장을 마치고 종료 중');
  showMessage('이미 접수한 작업을 마친 뒤 종료합니다. 잠시 기다려 주세요.');
  try {
    await api('/shutdown', { method: 'POST' });
    document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
    setStatus('종료됨');
    document.querySelector('.status-dot').classList.add('stopped');
    showMessage('프로그램이 종료되었습니다. 이 탭을 닫아도 됩니다. 다시 사용하려면 시작 파일을 실행하세요.');
  } catch {
    state.stopping = false;
    enabled.forEach((element) => { element.disabled = false; });
    setStatus('종료 확인 필요');
    showMessage('종료 완료를 확인하지 못했습니다. 잠시 기다린 뒤 배포 폴더의 종료 파일을 실행하세요. 저장 중인 프로그램을 강제로 종료하지 마세요.', true);
  }
};

const cell = (text) => {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
};

const choicesCell = (choices) => {
  const td = document.createElement('td');
  td.className = 'choices';
  td.textContent = choiceSummary(choices);
  return td;
};

const badgeCell = (text, warning) => {
  const td = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge${warning ? ' warning' : ''}`;
  badge.textContent = text;
  td.append(badge);
  return td;
};

const actionsCell = (...actions) => {
  const td = document.createElement('td');
  const group = document.createElement('div');
  group.className = 'row-actions';
  for (const [label, action, className] of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (className) button.className = className;
    button.addEventListener('click', () => { void Promise.resolve(action()).catch(() => {}); });
    group.append(button);
  }
  td.append(group);
  return td;
};

let draftOpenRequest = 0;
const deleteDraft = async (item) => {
  if (!window.confirm('이 배정초안을 삭제할까요? 수강이력은 삭제되지 않습니다.')) return;
  draftOpenRequest++;
  await run(() => api(`/allocation-drafts/${item.id}`, {
    method: 'DELETE',
    body: JSON.stringify({ expectedDraftRevision: item.revision }),
  }), '배정초안을 삭제했습니다.');
  await loadDrafts();
};

const reviewWarnings = (preview, issueContext = () => ({})) => {
  const errors = preview.issues.filter((issue) => issue.severity === 'ERROR');
  if (errors.length) {
    showMessage(errors.map((issue) => issueText(issue, issueContext(issue))).join(' · '), true);
    return Promise.resolve(null);
  }
  const warnings = preview.issues.filter((issue) => issue.severity === 'WARNING');
  if (!warnings.length) return Promise.resolve('');
  const dialog = byId('warning-dialog');
  const form = byId('warning-form');
  form.reset();
  byId('warning-list').replaceChildren(...warnings.map((warning) => {
    const item = document.createElement('li');
    item.textContent = issueText(warning, issueContext(warning));
    return item;
  }));
  dialog.showModal();
  return new Promise((resolve) => {
    const approve = (event) => {
      event.preventDefault();
      cleanup();
      dialog.close();
      resolve(form.elements.note.value.trim());
    };
    const cancel = () => {
      cleanup();
      dialog.close();
      resolve(null);
    };
    const cleanup = () => {
      form.removeEventListener('submit', approve);
      byId('cancel-warning').removeEventListener('click', cancel);
      dialog.removeEventListener('cancel', cancel);
    };
    form.addEventListener('submit', approve);
    byId('cancel-warning').addEventListener('click', cancel);
    dialog.addEventListener('cancel', cancel);
  });
};


let draftReadinessRequest = 0;
const openDraftCreate = async () => {
  draftReadinessRequest++;
  if (!state.policies.length) state.policies = (await api('/allocation-policies')).items;
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

const showPolicyDescription = () => {
  const value = byId('draft-create-form').elements.policy.value;
  byId('draft-policy-description').textContent = state.policies.find((policy) => (
    `${policy.policyId}\n${policy.policyVersion}` === value
  ))?.description ?? '';
};

const showDraftReadiness = async () => {
  const request = ++draftReadinessRequest;
  const semesterId = byId('draft-create-form').elements.semesterId.value;
  if (!semesterId) {
    byId('draft-readiness').textContent = '학기를 선택하면 자동 배정 준비 상태를 확인합니다.';
    return;
  }
  const [context, enrollments] = await Promise.all([
    api(`/semesters/${semesterId}/context`), api(`/enrollments?semesterId=${encodeURIComponent(semesterId)}&limit=200`),
  ]);
  if (request !== draftReadinessRequest) return;
  const issueNames = context.issues.map(({ code }) => issueText({ code, severity: 'WARNING' }));
  byId('draft-readiness').textContent = context.readyForAutoAllocation
    ? `자동 배정 준비됨 · 기존 확정 ${enrollments.total}명`
    : `자동 배정 준비 필요: ${issueNames.join(', ')} · 기존 확정 ${enrollments.total}명`;
};

const submitDraft = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
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
  await loadDrafts();
  const context = await api(`/semesters/${detail.draft.semesterId}/context`);
  if (request === draftOpenRequest) await showDraft(detail, context);
};

const openDraft = async (id) => {
  const request = ++draftOpenRequest;
  const detail = await api(`/allocation-drafts/${id}`);
  if (request !== draftOpenRequest) return;
  const context = await api(`/semesters/${detail.draft.semesterId}/context`);
  if (request !== draftOpenRequest) return;
  await showDraft(detail, context);
};

const showDraft = async (detail, context) => {
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
  fillDraftAddFields();
  renderDraftItems();
  if (!byId('draft-dialog').open) byId('draft-dialog').showModal();
};

const renderDraftItems = () => {
  const detail = state.draft;
  if (!detail) return;
  const readonly = detail.draft.status !== 'DRAFT';
  const courseView = byId('draft-grouping').value === 'COURSE';
  const items = sortDraftItems(filterDraftItems(detail.studentResults, {
    query: byId('draft-search').value,
    result: byId('draft-result-filter').value,
    courseName: draftCourseName,
  }), { applications: state.draftApplicationSummaries, courseView, courseName: draftCourseName, sort: byId('draft-sort').value });
  const { items: visibleItems, ...pagination } = draftItemPage(items, state.pagination['draft-item'].page, PAGE_LIMIT);
  state.pagination['draft-item'] = pagination;
  renderPagination('draft-item');
  byId('draft-item-rows').replaceChildren(...visibleItems.map((item) => {
    const row = document.createElement('tr');
    row.classList.toggle('draft-row-changed', draftDecisionChanged(item));
    const finalSelect = document.createElement('select');
    finalSelect.setAttribute('aria-label', `${item.memberNameAtGeneration} 최종 배정`);
    fillSelect(finalSelect, item.finalDecision === 'SELECTED'
      ? [{ id: item.finalSemesterCourseId, name: draftCourseName(item.finalSemesterCourseId) }] : [], '제외');
    finalSelect.value = item.finalDecision === 'SELECTED' ? item.finalSemesterCourseId : '';
    finalSelect.disabled = readonly;
    if (!readonly) finalSelect.addEventListener('focus', () => {
      const selected = finalSelect.value;
      fillSelect(finalSelect, state.draftContext.semesterCourses.map((course) => ({ id: course.id, name: course.courseName })), '제외');
      finalSelect.value = selected;
    }, { once: true });
    const finalCell = document.createElement('td');
    finalCell.append(finalSelect);
    const application = state.draftApplicationSummaries.get(item.sourceApplicationId);
    const orderCell = cell(application ? (application.applicationOrder ?? '미정') : '—');
    orderCell.className = 'draft-order';
    const applicationCell = cell(application?.choices ?? '신청 없음');
    applicationCell.className = 'choices';
    row.append(
      orderCell,
      cell(item.memberNameAtGeneration),
      applicationCell,
      cell(item.autoDecision === 'SELECTED' ? draftCourseName(item.autoSemesterCourseId) : item.autoDecision === 'NOT_EVALUATED' ? '자동 결과 없음' : '제외'),
      draftReasonCell(item),
      finalCell,
    );
    if (readonly) row.append(cell(''));
    else row.append(actionsCell(
      ['저장', () => saveDraftItem(item, finalSelect.value)],
      ...(item.autoDecision === 'NOT_EVALUATED' ? [] : [['자동 복원', () => restoreDraftItem(item)]]),
    ));
    return row;
  }));
  byId('draft-filter-count').textContent = `${items.length} / ${detail.studentResults.length}명`;
  byId('draft-item-empty').textContent = detail.studentResults.length && !items.length
    ? '검색 조건에 맞는 학생이 없습니다.'
    : '검토할 학생이 없습니다.';
  byId('draft-item-empty').hidden = items.length !== 0;
};

const draftReasonCell = (item) => {
  const td = document.createElement('td');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = reasonLabel(item.autoReasonCode);
  const list = document.createElement('ul');
  list.className = 'draft-reason-list';
  details.addEventListener('toggle', () => {
    if (!details.open || list.childElementCount) return;
    list.append(...describeAllocationEvidence(item, draftCourseName).map((text) => {
      const line = document.createElement('li');
      line.textContent = text;
      return line;
    }));
  });
  details.append(summary, list);
  td.append(details);
  return td;
};

const saveDraftItem = async (item, semesterCourseId) => {
  await run(() => api(`/allocation-drafts/${state.draft.draft.id}/items/${item.memberId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      expectedDraftRevision: state.draft.draft.revision,
      ...draftFinalSelection(item, semesterCourseId),
    }),
  }), `${item.memberNameAtGeneration}님의 최종 결정을 저장했습니다.`);
  await Promise.all([openDraft(state.draft.draft.id), loadDrafts()]);
};

const restoreDraftItem = async (item) => {
  await run(() => api(`/allocation-drafts/${state.draft.draft.id}/items/${item.memberId}/restore-auto`, {
    method: 'POST',
    body: JSON.stringify({ expectedDraftRevision: state.draft.draft.revision }),
  }), `${item.memberNameAtGeneration}님의 자동 결과를 복원했습니다.`);
  await Promise.all([openDraft(state.draft.draft.id), loadDrafts()]);
};

const fillDraftAddFields = () => {
  if (!state.draft || !state.draftContext) return;
  const memberIds = new Set(state.draft.studentResults.map(({ memberId }) => memberId));
  fillSelect(byId('draft-add-member'), state.members.filter(({ id }) => !memberIds.has(id)), '회원을 선택하세요.');
  fillSelect(byId('draft-add-course'), state.draftContext.semesterCourses.map((course) => ({ id: course.id, name: course.courseName })), '강좌를 선택하세요.');
};

const addDraftItem = async () => {
  const memberId = byId('draft-add-member').value;
  const courseId = byId('draft-add-course').value;
  if (!memberId || !courseId) return showMessage('추가할 회원과 강좌를 선택하세요.', true);
  await run(() => api(`/allocation-drafts/${state.draft.draft.id}/items`, {
    method: 'POST',
    body: JSON.stringify({
      memberId,
      expectedDraftRevision: state.draft.draft.revision,
      finalDecision: 'SELECTED',
      finalSemesterCourseId: courseId,
      finalReasonCode: 'ADMIN_ADDED',
      finalReasonDetail: { note: '관리자가 배정초안에 회원을 추가했습니다.' },
    }),
  }), '회원을 초안에 추가했습니다.');
  await Promise.all([openDraft(state.draft.draft.id), loadDrafts()]);
};

const resourceName = (items, id) => items.find((item) => item.id === id)?.name ?? id;
const policyName = (policyId, policyVersion) => state.policies.find((policy) => (
  policy.policyId === policyId && policy.policyVersion === policyVersion
))?.name ?? `${policyId} ${policyVersion}`;
const draftCourseName = (id) => id ? state.draftContext?.semesterCourses.find((course) => course.id === id)?.courseName ?? id : '제외';
const fillSelect = (select, items, placeholder) => {
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = placeholder;
  select.replaceChildren(empty, ...items.map(({ id, name }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = name;
    return option;
  }));
};

const loadCatalogItems = async (path) => {
  const items = [];
  for (let page = 1; ; page++) {
    const result = await api(`${path}?page=${page}&limit=200`);
    items.push(...result.items);
    if (result.page * result.limit >= result.total) return items;
  }
};

let catalogLoadRequest = 0;
const loadCatalogs = async () => {
  const request = ++catalogLoadRequest;
  const [semesters, members, courses] = await Promise.all([
    loadCatalogItems('/semesters'), loadCatalogItems('/members'), loadCatalogItems('/courses'),
  ]);
  if (request !== catalogLoadRequest) return;
  state.semesters = orderSemesters(semesters);
  state.members = members;
  state.courses = courses;
  fillDatalist('semester-options', state.semesters);
  fillDatalist('member-options', members);
  fillDatalist('course-options', courses);
  const applicationSemester = byId('application-semester-filter');
  const previousSemesterId = applicationSemester.value;
  fillFilterSelect('application-semester-filter', state.semesters);
  applicationSemester.value = applicationSemesterFilterValue(
    state.semesters, applicationSemester.value, state.applicationSemesterFilterTouched,
  );
  if (applicationSemester.value !== previousSemesterId) state.pagination.application.page = 1;
  fillFilterSelect('application-course-filter', courses);
  fillFilterSelect('enrollment-semester-filter', state.semesters);
  fillFilterSelect('enrollment-course-filter', courses);
};

const fillFilterSelect = (id, items) => {
  const select = byId(id);
  const selected = select.value;
  fillSelect(select, items, '전체');
  if ([...select.options].some(({ value }) => value === selected)) select.value = selected;
};

const recordQuery = (prefix) => new URLSearchParams([
  ['memberName', byId(`${prefix}-member-search`).value],
  ['semesterId', byId(`${prefix}-semester-filter`).value],
  ['courseId', byId(`${prefix}-course-filter`).value],
  ...(prefix === 'application' ? [['sort', byId('application-sort').value]] : []),
].filter(([, value]) => value)).toString();

const loadPaged = async (name, path, filters = '', pagination = state.pagination[name]) => {
  const query = new URLSearchParams(filters);
  query.set('page', String(pagination.page));
  query.set('limit', String(pagination.limit));
  const result = await api(`${path}?${query}`);
  if (state.pagination[name] !== pagination) return;
  const lastPage = Math.max(1, Math.ceil(result.total / result.limit));
  if (result.page > lastPage) {
    pagination.page = lastPage;
    return loadPaged(name, path, filters, pagination);
  }
  Object.assign(pagination, { page: result.page, limit: result.limit, total: result.total });
  renderPagination(name);
  return result.items;
};

const { load: loadDrafts } = createDraftsPage({
  state, byId, loadPaged, cell, actionsCell, resourceName, policyName, openDraft, deleteDraft,
});

const { load: loadEnrollments, completeReport: completeEnrollmentReport,
  addEnrollmentEntry, openEnrollment, submitEnrollment, deleteSemesterEnrollments } = createEnrollmentsPage({
  state, byId, showMessage, api, run, download, loadPaged, loadCatalogs, recordQuery, resourceName, cell, actionsCell,
  reviewWarnings,
});
const { previewFinalization, finalizeDraft } = createFinalizationPage({
  state, api, byId, run, draftCourseName, showMessage, loadDrafts, loadEnrollments,
});

const { loadCatalogManagement, createSemester, submitSemester, deleteSemester,
  submitCatalog, setCatalogTab, openCatalogAdd, addCatalogCourses, copyCatalogCourses,
  openCatalogCopy, loadCatalogCopyCourses } = createCatalogPage({
  state, byId, api, run, showMessage, loadCatalogs, fillSelect, cell, actionsCell,
});

const {
  load: loadApplications,
  addApplicationEntry,
  openApplication,
  submitApplication,
  showTemplateSummary: showApplicationTemplateSummary,
  openTemplate: openApplicationTemplate,
  downloadTemplate: downloadApplicationTemplate,
} = createApplicationsPage({
  state, byId, api, fillSelect, showMessage, run, download,
  cell, choicesCell, badgeCell, actionsCell,
  loadPaged, recordQuery, loadCatalogs,
});
const { open: openImport, submit: submitImport, commit: commitImport } = createImportsPage({
  state, byId, api, run, reviewWarnings, showMessage, loadCatalogs, loadApplications, loadEnrollments,
});

const {
  load: loadBackups, createManualBackup, openRestore, clearRestorePreview, submitRestore,
} = createBackupsPage({
  api, byId, run, showMessage, cell,
  reloadOtherViews: async () => {
    await loadCatalogs();
    await Promise.all([loadApplications(), loadEnrollments(), loadDrafts()]);
  },
});

const { load: loadDashboard, renderWorkflow: renderDashboardWorkflow } = createDashboardPage({ state, api, byId });

const renderPagination = (name) => {
  const view = paginationView(state.pagination[name]);
  byId(`${name}-page-status`).textContent = view.label;
  byId(`${name}-previous-page`).disabled = view.previousDisabled;
  byId(`${name}-next-page`).disabled = view.nextDisabled;
};

const changePage = (name, offset, load) => {
  state.pagination[name].page += offset;
  void load();
};

const resetPage = (name, load) => {
  state.pagination[name].page = 1;
  void load();
};

const fillDatalist = (id, items) => {
  byId(id).replaceChildren(...items.map(({ name }) => {
    const option = document.createElement('option');
    option.value = name;
    return option;
  }));
};

const debounce = (action, wait = 180) => {
  let timer;
  return () => { clearTimeout(timer); timer = setTimeout(action, wait); };
};

const activateView = (name) => {
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.viewTarget === name));
  document.querySelectorAll('.view').forEach((view) => { view.hidden = view.id !== `${name}-view`; });
  history.replaceState(null, '', `#${name}`);
};

const viewLoaders = {
  home: loadDashboard,
  applications: loadApplications,
  enrollments: loadEnrollments,
  drafts: loadDrafts,
  catalog: loadCatalogManagement,
  backups: loadBackups,
};
const navigateTo = async (name) => {
  activateView(name);
  await viewLoaders[name]();
};
renderDashboardWorkflow();
document.addEventListener('click', (event) => {
  const control = event.target.closest('[data-view-target]');
  if (!control) return;
  event.preventDefault();
  void navigateTo(control.dataset.viewTarget).catch((error) => showMessage(error.message, true));
});
const initialView = viewFromHash(location.hash);
activateView(initialView);
document.querySelectorAll('.help-button').forEach((button) => button.addEventListener('click', () => openHelp(button.dataset.help)));
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
byId('shutdown').addEventListener('click', () => byId('shutdown-dialog').showModal());
byId('confirm-shutdown').addEventListener('click', () => {
  byId('shutdown-dialog').close();
  void shutdown();
});
byId('open-data-folder').addEventListener('click', () => { void api('/data-folder', { method: 'POST' }).catch((error) => showMessage(error.message, true)); });
document.querySelectorAll('.import-open').forEach((button) => button.addEventListener('click', () => openImport(button.dataset.kind)));
byId('new-application').addEventListener('click', () => openApplication());
byId('new-enrollment').addEventListener('click', () => openEnrollment());
byId('new-draft').addEventListener('click', () => { void openDraftCreate().catch(() => {}); });
byId('new-semester').addEventListener('click', () => {
  byId('semester-create-form').reset();
  byId('semester-create-dialog').showModal();
});
byId('add-catalog-course').addEventListener('click', openCatalogAdd);
byId('catalog-add-form').addEventListener('submit', addCatalogCourses);
byId('copy-catalog-courses').addEventListener('click', openCatalogCopy);
byId('catalog-copy-form').elements.sourceSemesterId.addEventListener('change', () => {
  void loadCatalogCopyCourses().catch((error) => showMessage(error.message, true));
});
byId('catalog-copy-form').addEventListener('submit', copyCatalogCourses);
byId('add-application-entry').addEventListener('click', () => addApplicationEntry());
byId('add-enrollment-entry').addEventListener('click', () => addEnrollmentEntry());
byId('application-form').addEventListener('submit', (event) => { void submitApplication(event).catch(() => {}); });
byId('enrollment-form').addEventListener('submit', (event) => { void submitEnrollment(event).catch(() => {}); });
byId('semester-create-form').addEventListener('submit', (event) => { void createSemester(event).catch(() => {}); });
byId('semester-form').addEventListener('submit', (event) => { void submitSemester(event).catch(() => {}); });
byId('delete-semester').addEventListener('click', () => { void deleteSemester().catch(() => {}); });
byId('catalog-form').addEventListener('submit', (event) => { void submitCatalog(event).catch(() => {}); });
byId('catalog-semester').addEventListener('change', () => { void loadCatalogManagement().catch(() => {}); });
document.querySelectorAll('[data-catalog-tab]').forEach((button) => button.addEventListener('click', () => setCatalogTab(button.dataset.catalogTab)));
byId('refresh-catalog').addEventListener('click', () => {
  void loadCatalogs().then(() => loadCatalogManagement()).catch(() => {});
});
byId('draft-create-form').addEventListener('submit', (event) => { void submitDraft(event).catch(() => {}); });
byId('draft-create-form').elements.policy.addEventListener('change', showPolicyDescription);
byId('draft-create-form').elements.semesterId.addEventListener('change', () => { void showDraftReadiness().catch(() => {}); });
byId('draft-grouping').addEventListener('change', () => resetPage('draft-item', renderDraftItems));
byId('draft-sort').addEventListener('change', () => resetPage('draft-item', renderDraftItems));
byId('draft-result-filter').addEventListener('change', () => resetPage('draft-item', renderDraftItems));
byId('draft-search').addEventListener('input', () => resetPage('draft-item', renderDraftItems));
byId('draft-item-previous-page').addEventListener('click', () => changePage('draft-item', -1, renderDraftItems));
byId('draft-item-next-page').addEventListener('click', () => changePage('draft-item', 1, renderDraftItems));
byId('add-draft-item').addEventListener('click', () => { void addDraftItem().catch(() => {}); });
byId('preview-finalization').addEventListener('click', () => { void previewFinalization().catch(() => {}); });
byId('finalize-form').addEventListener('submit', (event) => { void finalizeDraft(event).catch(() => {}); });
byId('import-form').addEventListener('submit', (event) => { void submitImport(event).catch(() => {}); });
byId('commit-import').addEventListener('click', () => { void commitImport().catch(() => {}); });
byId('refresh-applications').addEventListener('click', () => { void loadApplications(); });
byId('refresh-enrollments').addEventListener('click', () => { void loadEnrollments(); });
byId('refresh-drafts').addEventListener('click', () => { void loadDrafts(); });
byId('refresh-backups').addEventListener('click', () => { void loadBackups(); });
byId('create-backup').addEventListener('click', () => { void createManualBackup().catch(() => {}); });
byId('open-restore').addEventListener('click', openRestore);
byId('restore-form').addEventListener('submit', (event) => { void submitRestore(event).catch(() => {}); });
byId('restore-form').elements.file.addEventListener('change', clearRestorePreview);
byId('application-template').addEventListener('click', openApplicationTemplate);
byId('application-template-form').elements.semesterId.addEventListener('change', () => {
  void showApplicationTemplateSummary().catch((error) => showMessage(error.message, true));
});
byId('application-template-form').addEventListener('submit', (event) => {
  void downloadApplicationTemplate(event).catch(() => {});
});
byId('application-export').addEventListener('click', () => { void run(() => download(`/applications/export?${recordQuery('application')}`, reportFilename('수강신청'))).catch(() => {}); });
byId('enrollment-template').addEventListener('click', () => { void run(() => download('/enrollments/template', templateFilename('수강이력'))).catch(() => {}); });
byId('enrollment-export').addEventListener('click', () => { void run(() => download(`/enrollments/export?${recordQuery('enrollment')}`, reportFilename('수강이력'))).catch(() => {}); });
byId('delete-semester-enrollments').addEventListener('click', () => { void deleteSemesterEnrollments().catch(() => {}); });
byId('complete-enrollment-report').addEventListener('click', () => { void completeEnrollmentReport().catch(() => {}); });
byId('application-member-search').addEventListener('input', debounce(() => resetPage('application', loadApplications)));
byId('application-sort').addEventListener('change', () => resetPage('application', loadApplications));
byId('application-page-size').addEventListener('change', (event) => {
  state.pagination.application.limit = Number(event.currentTarget.value);
  resetPage('application', loadApplications);
});
byId('enrollment-member-search').addEventListener('input', debounce(() => resetPage('enrollment', loadEnrollments)));
for (const id of ['application-semester-filter', 'application-course-filter']) {
  byId(id).addEventListener('change', () => {
    if (id === 'application-semester-filter') state.applicationSemesterFilterTouched = true;
    resetPage('application', loadApplications);
  });
}
for (const id of ['enrollment-semester-filter', 'enrollment-course-filter']) {
  byId(id).addEventListener('change', () => resetPage('enrollment', loadEnrollments));
}
byId('application-previous-page').addEventListener('click', () => changePage('application', -1, loadApplications));
byId('application-next-page').addEventListener('click', () => changePage('application', 1, loadApplications));
byId('enrollment-previous-page').addEventListener('click', () => changePage('enrollment', -1, loadEnrollments));
byId('enrollment-next-page').addEventListener('click', () => changePage('enrollment', 1, loadEnrollments));
byId('draft-previous-page').addEventListener('click', () => changePage('draft', -1, loadDrafts));
byId('draft-next-page').addEventListener('click', () => changePage('draft', 1, loadDrafts));

try {
  const session = await api('/session', { method: 'POST' });
  state.token = session.token;
  const runtime = await api('/runtime');
  byId('data-directory').textContent = runtime.dataDirectory;
  byId('data-directory').title = `Glorycourse ${runtime.version}`;
  setStatus('저장됨');
  const policies = await api('/allocation-policies');
  state.policies = policies.items;
  await loadCatalogs();
  await viewLoaders[initialView]();
  byId('shutdown').disabled = false;
  byId('open-data-folder').disabled = false;
} catch (error) {
  setStatus('연결 실패');
  showMessage(error.message, true);
}
