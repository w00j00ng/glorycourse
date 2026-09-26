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
import { copySemesterCourses, parseSemesterCourses } from './catalog-view.js';
import { reportFilename, templateFilename } from './download-name.js';
import { currentSemester, orderSemesters } from './dashboard-view.js';
import { createDashboardPage } from './dashboard-page.js';
import { createBackupsPage } from './backups-page.js';
import { createFinalizationPage } from './finalization-page.js';
import { createApplicationsPage } from './applications-page.js';
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

const loadEnrollments = async () => {
  const pagination = state.pagination.enrollment = { ...state.pagination.enrollment };
  const items = await loadPaged('enrollment', '/enrollments', recordQuery('enrollment'), pagination);
  if (state.pagination.enrollment !== pagination) return;
  const semester = currentSemester(state.semesters);
  const report = semester
    ? await api(`/semesters/${encodeURIComponent(semester.id)}/enrollment-report`)
    : null;
  if (state.pagination.enrollment !== pagination) return;
  state.enrollments = items;
  state.enrollmentReport = report?.finalized && !report.enrollmentReportIsCurrent
    ? report
    : null;
  renderEnrollments();
};

const renderEnrollments = () => {
  const body = byId('enrollment-rows');
  body.replaceChildren(...state.enrollments.map((item) => {
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
  const reportTask = byId('enrollment-report-task');
  reportTask.hidden = !state.enrollmentReport;
  if (state.enrollmentReport) {
    const semesterName = resourceName(state.semesters, state.enrollmentReport.semesterId);
    byId('enrollment-report-task-description').textContent = `${semesterName} 수강이력을 확인한 뒤 현황 파일을 내려받으면 이번 학기 업무가 완료됩니다.`;
  }
};

const completeEnrollmentReport = async () => {
  const report = state.enrollmentReport;
  if (!report) return;
  await run(() => download(
    `/semesters/${encodeURIComponent(report.semesterId)}/enrollment-report`,
    reportFilename('수강이력'),
    { method: 'POST' },
  ), '현재 학기 수강이력 현황을 다운로드했습니다.');
  await loadEnrollments();
};

const loadDrafts = async () => {
  const pagination = state.pagination.draft = { ...state.pagination.draft };
  const items = await loadPaged('draft', '/allocation-drafts', '', pagination);
  if (state.pagination.draft !== pagination) return;
  state.drafts = items;
  renderDrafts();
};

const renderDrafts = () => {
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

const enrollmentCourseName = (entry) => (
  state.courses.find(({ id }) => id === entry.querySelector('[name="courseId"]').value)?.name
  ?? entry.querySelector('[name="newCourseName"]').value
);

const catalogCourseRow = (course = {}) => {
  const row = document.createElement('tr');
  row.dataset.id = course.id ?? '';
  const nameCell = document.createElement('td');
  const name = document.createElement('input');
  name.name = 'courseName';
  name.required = true;
  name.maxLength = 200;
  name.value = course.courseName ?? '';
  name.setAttribute('list', 'course-options');
  name.setAttribute('aria-label', '강좌명');
  nameCell.append(name);
  const capacityCell = document.createElement('td');
  const capacity = document.createElement('input');
  capacity.name = 'capacity';
  capacity.type = 'number';
  capacity.min = '0';
  capacity.step = '1';
  capacity.required = !course.id;
  capacity.placeholder = course.id ? '미정' : '정원 입력';
  capacity.value = course.capacity ?? '';
  capacity.setAttribute('aria-label', course.id ? '정원' : '새 강좌 정원 (필수)');
  capacityCell.append(capacity);
  const usage = course.id
    ? course.enrollmentCount > 0
      ? `수강이력 ${course.enrollmentCount}건 · 삭제 불가`
      : course.applicationCount > 0
        ? `수강신청 ${course.applicationCount}건`
        : '사용 없음'
    : '저장 전';
  const action = course.id
    ? actionsCell(['삭제', () => deleteSemesterCourse(course), 'delete'])
    : actionsCell(['추가 취소', () => {
      row.remove();
      byId('catalog-course-empty').hidden = byId('catalog-course-rows').children.length !== 0;
    }, 'delete']);
  const deleteButton = action.querySelector('button');
  if (course.enrollmentCount > 0) {
    deleteButton.disabled = true;
    deleteButton.title = '수강이력이 있는 강좌는 삭제할 수 없습니다.';
  }
  row.append(nameCell, capacityCell, cell(usage), action);
  return row;
};

const renderCatalogContext = (context) => {
  state.catalogContext = context;
  const semesterForm = byId('semester-form');
  semesterForm.hidden = state.selectedSemesterId !== context.semester.id;
  semesterForm.elements.name.value = context.semester.name;
  byId('catalog-form').hidden = false;
  byId('catalog-course-rows').replaceChildren(...context.semesterCourses.map(catalogCourseRow));
  byId('catalog-course-empty').hidden = context.semesterCourses.length !== 0;
  byId('catalog-empty').hidden = true;
  byId('copy-catalog-courses').disabled = !state.semesters.some(({ id }) => id !== context.semester.id);
};

const setCatalogTab = (tab) => {
  byId('catalog-semesters-panel').hidden = tab !== 'semesters';
  byId('catalog-courses-panel').hidden = tab !== 'courses';
  document.querySelectorAll('[data-catalog-tab]').forEach((button) => {
    const active = button.dataset.catalogTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
};

const renderSemesterRows = () => {
  const ordered = state.semesters.filter(({ order }) => order !== null);
  byId('catalog-semester-rows').replaceChildren(...state.semesters.map((semester) => {
    const row = document.createElement('tr');
    row.className = 'catalog-semester-row';
    row.dataset.id = semester.id;
    row.tabIndex = 0;
    row.setAttribute('aria-label', semester.order === null
      ? `${semester.name}, 순서 미정. 학기 정보를 저장한 뒤 이동 가능`
      : `${semester.name}, 순서 ${semester.order}. 위아래 화살표로 이동`);
    row.setAttribute('aria-describedby', 'semester-order-help');
    if (semester.id === state.selectedSemesterId) row.classList.add('catalog-semester-selected');
    const index = ordered.findIndex(({ id }) => id === semester.id);
    const actions = actionsCell(
      [semester.id === state.selectedSemesterId ? '선택됨' : '수정', () => selectSemesterRow(semester.id)],
      ['위로', () => moveSemester(semester, 'UP')],
      ['아래로', () => moveSemester(semester, 'DOWN')],
    );
    const [, up, down] = actions.querySelectorAll('button');
    up.disabled = index <= 0;
    down.disabled = index < 0 || index === ordered.length - 1;
    row.addEventListener('keydown', (event) => {
      if (event.target !== row || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      void moveSemester(semester, event.key === 'ArrowUp' ? 'UP' : 'DOWN').catch(() => {});
    });
    row.append(cell(semester.name), cell(semester.order ?? '미정'), actions);
    return row;
  }));
  byId('catalog-semester-empty').hidden = state.semesters.length !== 0;
};

const selectSemesterRow = async (id) => {
  if (state.selectedSemesterId === id) {
    state.selectedSemesterId = null;
    byId('semester-form').hidden = true;
    renderSemesterRows();
    return;
  }
  state.selectedSemesterId = id;
  await loadCatalogManagement(id);
};

const moveSemester = async (semester, direction) => {
  if (state.movingSemester) return;
  const ordered = state.semesters.filter(({ order }) => order !== null);
  const index = ordered.findIndex(({ id }) => id === semester.id);
  const adjacent = ordered[index + (direction === 'UP' ? -1 : 1)];
  if (!adjacent || semester.order === null) return;
  state.movingSemester = true;
  try {
    await run(() => api(`/semesters/${semester.id}/move`, {
      method: 'POST',
      body: JSON.stringify({ direction, expectedOrder: semester.order, adjacentSemesterId: adjacent.id }),
    }), '학기 순서를 변경했습니다.');
    await loadCatalogs();
    await loadCatalogManagement(semester.id);
    [...byId('catalog-semester-rows').children].find(({ dataset }) => dataset.id === semester.id)?.focus();
  } catch (error) {
    if (error.code !== 'CONFLICT') throw error;
    await loadCatalogs();
    await loadCatalogManagement();
    showMessage('학기 순서가 다른 화면에서 바뀌어 목록을 다시 불러왔습니다. 확인 후 다시 이동하세요.', true);
  } finally {
    state.movingSemester = false;
  }
};

const openCatalogAdd = () => {
  const form = byId('catalog-add-form');
  form.reset();
  byId('catalog-add-errors').replaceChildren();
  byId('catalog-add-errors').hidden = true;
  byId('catalog-add-dialog').showModal();
  form.elements.courses.focus();
};

const addCatalogCourses = (event) => {
  event.preventDefault();
  const { courses, errors } = parseSemesterCourses(event.currentTarget.elements.courses.value);
  const errorList = byId('catalog-add-errors');
  const messages = courses.length === 0 && errors.length === 0 ? ['추가할 강좌를 입력하세요.'] : errors;
  errorList.replaceChildren(...messages.map((message) => {
    const item = document.createElement('li');
    item.textContent = message;
    return item;
  }));
  errorList.hidden = messages.length === 0;
  if (messages.length) return;

  const rows = byId('catalog-course-rows');
  const existingNames = [...rows.children].map((row) => row.querySelector('[name="courseName"]').value);
  const added = copySemesterCourses(existingNames, courses);
  rows.append(...added.map(catalogCourseRow));
  byId('catalog-course-empty').hidden = rows.children.length !== 0;
  byId('catalog-add-dialog').close();
  const skipped = courses.length - added.length;
  showMessage(`강좌 ${added.length}개를 추가했습니다.${skipped ? ` 같은 이름 ${skipped}개는 제외했습니다.` : ''}`);
};

const openCatalogCopy = () => {
  const form = byId('catalog-copy-form');
  form.reset();
  state.catalogCopyCourses = [];
  fillSelect(
    form.elements.sourceSemesterId,
    state.semesters.filter(({ id }) => id !== state.catalogContext?.semester.id),
    '가져올 학기를 선택하세요.',
  );
  byId('catalog-copy-course-list').replaceChildren();
  byId('catalog-copy-empty').textContent = '가져올 학기를 선택하세요.';
  byId('catalog-copy-empty').hidden = false;
  byId('catalog-copy-dialog').showModal();
};

const loadCatalogCopyCourses = async () => {
  const sourceSemesterId = byId('catalog-copy-form').elements.sourceSemesterId.value;
  const list = byId('catalog-copy-course-list');
  if (!sourceSemesterId) {
    state.catalogCopyCourses = [];
    list.replaceChildren();
    byId('catalog-copy-empty').textContent = '가져올 학기를 선택하세요.';
    byId('catalog-copy-empty').hidden = false;
    return;
  }
  state.catalogCopyCourses = [];
  list.replaceChildren();
  byId('catalog-copy-empty').textContent = '강좌를 불러오는 중입니다.';
  byId('catalog-copy-empty').hidden = false;
  const context = await api(`/semesters/${sourceSemesterId}/context`);
  if (byId('catalog-copy-form').elements.sourceSemesterId.value !== sourceSemesterId) return;
  state.catalogCopyCourses = context.semesterCourses;
  list.replaceChildren(...context.semesterCourses.map((course) => {
    const label = document.createElement('label');
    label.className = 'catalog-copy-course';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'courseId';
    checkbox.value = course.id;
    checkbox.checked = true;
    const text = document.createElement('span');
    text.textContent = `${course.courseName} · 정원 ${course.capacity ?? '미정'}`;
    label.append(checkbox, text);
    return label;
  }));
  byId('catalog-copy-empty').textContent = '이 학기에 개설된 강좌가 없습니다.';
  byId('catalog-copy-empty').hidden = context.semesterCourses.length !== 0;
};

const copyCatalogCourses = (event) => {
  event.preventDefault();
  const selectedIds = new Set([...event.currentTarget.querySelectorAll('[name="courseId"]:checked')].map(({ value }) => value));
  if (selectedIds.size === 0) {
    showMessage('복사할 강좌를 선택하세요.', true);
    return;
  }
  const selected = state.catalogCopyCourses.filter(({ id }) => selectedIds.has(id));
  const rows = byId('catalog-course-rows');
  const existingNames = [...rows.children].map((row) => row.querySelector('[name="courseName"]').value);
  const copied = copySemesterCourses(existingNames, selected);
  rows.append(...copied.map(catalogCourseRow));
  byId('catalog-course-empty').hidden = rows.children.length !== 0;
  byId('catalog-copy-dialog').close();
  const skipped = selected.length - copied.length;
  showMessage(`강좌 ${copied.length}개를 추가했습니다.${skipped ? ` 같은 이름 ${skipped}개는 제외했습니다.` : ''}`);
};

const loadCatalogManagement = async (preferredId) => {
  const request = state.catalogRequest = Symbol();
  const select = byId('catalog-semester');
  const preferred = preferredId || select.value || state.catalogContext?.semester.id;
  const selected = state.semesters.find(({ id }) => id === preferred)?.id || state.semesters[0]?.id;
  state.catalogContext = null;
  byId('semester-form').hidden = true;
  byId('catalog-form').hidden = true;
  if (state.selectedSemesterId !== selected) state.selectedSemesterId = null;
  fillSelect(select, state.semesters, '학기를 선택하세요.');
  renderSemesterRows();
  if (!selected) {
    byId('catalog-empty').hidden = false;
    return;
  }
  select.value = selected;
  const context = await api(`/semesters/${selected}/context`);
  if (state.catalogRequest !== request) return;
  renderCatalogContext(context);
};

const createSemester = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const context = await run(() => api('/semesters', {
    method: 'POST',
    body: JSON.stringify({
      name: form.elements.name.value,
      order: null,
    }),
  }), '학기를 추가했습니다.');
  byId('semester-create-dialog').close();
  state.selectedSemesterId = context.semester.id;
  await loadCatalogs();
  await loadCatalogManagement(context.semester.id);
};

const submitSemester = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const context = state.catalogContext;
  if (!context || context.semester.id !== byId('catalog-semester').value) return;
  const updated = await run(() => api(`/semesters/${context.semester.id}/context`, {
    method: 'PATCH',
    body: JSON.stringify({
      expectedRevision: context.allocationInputRevision,
      name: form.elements.name.value,
      order: context.order,
      semesterCourses: context.semesterCourses.map(({ id, courseName, capacity }) => ({ id, courseName, capacity })),
    }),
  }), '학기 정보를 저장했습니다.');
  await loadCatalogs();
  await loadCatalogManagement(updated.semester.id);
};

const submitCatalog = async (event) => {
  event.preventDefault();
  const context = state.catalogContext;
  if (!context || context.semester.id !== byId('catalog-semester').value) return;
  const updated = await run(() => api(`/semesters/${context.semester.id}/context`, {
    method: 'PATCH',
    body: JSON.stringify({
      expectedRevision: context.allocationInputRevision,
      name: context.semester.name,
      order: context.order,
      semesterCourses: [...byId('catalog-course-rows').children].map((row) => ({
        ...(row.dataset.id ? { id: row.dataset.id } : {}),
        courseName: row.querySelector('[name="courseName"]').value,
        capacity: row.querySelector('[name="capacity"]').value === ''
          ? null
          : Number(row.querySelector('[name="capacity"]').value),
      })),
    }),
  }), '강좌 정보를 저장했습니다.');
  await loadCatalogs();
  await loadCatalogManagement(updated.semester.id);
};

const deleteSemester = async () => {
  const context = state.catalogContext;
  if (!context) return;
  if (!window.confirm(`${context.semester.name} 학기를 삭제할까요?\n이 학기의 개설 강좌 ${context.semesterCourses.length}개도 함께 제거됩니다.\n신청·수강이력·배정초안·확정 기록이 있는 학기는 삭제할 수 없습니다.`)) return;
  await run(() => api(`/semesters/${context.semester.id}?expectedRevision=${context.allocationInputRevision}`, {
    method: 'DELETE',
  }), '학기를 삭제했습니다.');
  state.catalogContext = null;
  state.selectedSemesterId = null;
  byId('catalog-semester').value = '';
  await loadCatalogs();
  await loadCatalogManagement();
};

const deleteSemesterCourse = async (course) => {
  const context = state.catalogContext;
  if (!context || course.enrollmentCount > 0) return;
  const warning = course.applicationCount > 0
    ? `수강신청 ${course.applicationCount}건에서 ${course.courseName} 선택을 제거합니다.\n다른 희망 강좌가 없는 신청은 신청 전체가 삭제됩니다.`
    : `${course.courseName} 강좌를 이 학기에서 삭제할까요?`;
  if (!window.confirm(`${warning}\n기존 배정초안은 변경된 자료로 표시됩니다.\n저장하지 않은 다른 변경사항은 취소됩니다.`)) return;
  const query = new URLSearchParams({
    expectedRevision: String(context.allocationInputRevision),
    confirmApplications: String(course.applicationCount > 0),
  });
  await run(() => api(
    `/semesters/${context.semester.id}/courses/${course.id}?${query}`,
    { method: 'DELETE' },
  ), '개설 강좌를 삭제했습니다.');
  await loadCatalogs();
  await loadCatalogManagement(context.semester.id);
};

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

const submitEnrollment = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const items = [...byId('enrollment-entry-rows').children].map((entry) => ({
    semesterName: entry.querySelector('[name="semesterName"]').value,
    memberName: entry.querySelector('[name="memberName"]').value,
    courseName: enrollmentCourseName(entry),
  }));
  submit.disabled = true;
  try {
    const preview = await run(() => api(form.dataset.id ? '/enrollments/preview' : '/enrollments/batch/preview', {
      method: 'POST',
      body: JSON.stringify(form.dataset.id
        ? { ...items[0], action: 'UPDATE', enrollmentId: form.dataset.id, expectedRevision: Number(form.dataset.revision) }
        : { items }),
    }));
    const note = await reviewWarnings(preview, (issue) => {
      const row = items[(issue.detail?.rowNumber ?? 1) - 1];
      return { memberName: row?.memberName, courseName: row?.courseName };
    });
    if (note === null) return;
    await run(() => api(form.dataset.id ? `/enrollments/${form.dataset.id}` : '/enrollments/batch', {
      method: form.dataset.id ? 'PATCH' : 'POST',
      body: JSON.stringify({
        preparedActionToken: preview.preparedActionToken,
        acknowledgedWarningDigest: preview.warningDigest,
        ...(note ? { acknowledgementNote: note } : {}),
      }),
    }), form.dataset.id ? '이력을 수정했습니다.' : `이력 ${items.length}건을 등록했습니다.`);
    byId('enrollment-dialog').close();
    await loadCatalogs();
    await loadEnrollments();
  } finally { submit.disabled = false; }
};

const deleteEnrollment = async (item) => {
  if (!window.confirm(`${item.memberName}님의 ${item.semesterName} 수강이력을 삭제할까요?`)) return;
  const preview = await run(() => api('/enrollments/preview', {
    method: 'POST',
    body: JSON.stringify({
      action: 'DELETE', enrollmentId: item.id, expectedRevision: item.revision,
      semesterName: item.semesterName, memberName: item.memberName, courseName: item.courseName,
    }),
  }));
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
  await loadEnrollments();
};

const deleteSemesterEnrollments = async () => {
  const semesterId = byId('enrollment-semester-filter').value;
  if (!semesterId) return;
  const path = `/semesters/${encodeURIComponent(semesterId)}/enrollments`;
  const preview = await run(() => api(path));
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
  await loadEnrollments();
};

const deleteDraft = async (item) => {
  if (!window.confirm('이 배정초안을 삭제할까요? 수강이력은 삭제되지 않습니다.')) return;
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

const openImport = (kind) => {
  const form = byId('import-form');
  form.reset();
  form.elements.kind.value = kind;
  state.importPreview = null;
  byId('import-dialog-title').textContent = kind === 'APPLICATIONS' ? '수강신청 Excel 검토' : '수강이력 Excel 검토';
  byId('import-mode-field').hidden = kind === 'ENROLLMENTS';
  byId('import-preview').hidden = true;
  byId('import-preview-action').hidden = false;
  byId('import-dialog').showModal();
};

const submitImport = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = new FormData(form);
  if (form.elements.kind.value === 'ENROLLMENTS') payload.set('mode', 'MERGE_KEEP_EXISTING');
  const preview = await run(() => api('/imports/preview', { method: 'POST', body: payload }));
  state.importPreview = preview;
  byId('import-source-count').textContent = String(preview.sourceRowCount);
  byId('import-insert-count').textContent = String(preview.insertCandidates);
  byId('import-identical-count').textContent = String(preview.identicalRows);
  byId('import-conflict-count').textContent = String(preview.conflicts);
  byId('import-preview-status').textContent = `아직 저장되지 않음 · ${new Date(preview.expiresAt).toLocaleTimeString()}까지 유효`;
  byId('import-issues').replaceChildren(...(
    preview.issues.length ? preview.issues : [{ severity: 'INFO', message: '추가 검토 항목이 없습니다.' }]
  ).map((issue) => {
    const item = document.createElement('li');
    item.textContent = issueText(issue);
    if (issue.severity === 'INFO') {
      item.classList.add('information');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary import-issue-dismiss';
      button.textContent = '닫기';
      button.setAttribute('aria-label', `${issueText(issue)} 닫기`);
      button.addEventListener('click', () => item.remove());
      item.append(' ', button);
    }
    return item;
  }));
  renderImportCandidates(preview);
  renderImportResolutions(preview);
  const blocksCommit = preview.issues.some((issue) => (
    issue.severity === 'ERROR' && issue.blockingStages.includes('IMPORT_COMMIT')
  )) || (preview.kind === 'ENROLLMENTS' && preview.conflicts > 0);
  byId('commit-import').disabled = blocksCommit;
  byId('import-preview').hidden = false;
  byId('import-preview-action').hidden = true;
};

const renderImportCandidates = (preview) => {
  const candidates = preview.kind === 'APPLICATIONS' ? preview.applications : preview.enrollments;
  byId('import-candidates').replaceChildren(...candidates.map((candidate) => {
    const card = document.createElement('div');
    card.className = 'import-candidate';
    const title = document.createElement('strong');
    title.textContent = `${candidate.semesterName || '학기 미정'} · ${candidate.memberName || '회원 미정'}`;
    const detail = document.createElement('small');
    detail.textContent = preview.kind === 'APPLICATIONS'
      ? `신청순서 ${candidate.applicationOrder ?? '미정'} · ${candidate.choices.map(({ courseName, preference }) => `${preference ?? '?'}순위 ${courseName || '강좌 미정'}`).join(', ')}`
      : candidate.courseName || '강좌 미정';
    card.append(title, detail);
    return card;
  }));
};

const renderImportResolutions = (preview) => {
  const rows = [];
  preview.applications.forEach((candidate, index) => {
    if (preview.conflicts > 0) {
      rows.push(resolutionSelect(
        `신청 충돌 · ${candidate.semesterName} · ${candidate.memberName}`,
        `application-action-${index}`,
        [['KEEP_EXISTING', '기존 신청 유지'], ['REPLACE_APPLICATION', '파일 신청으로 교체']],
        preview.mode === 'REPLACE_APPLICATION' ? 'REPLACE_APPLICATION' : 'KEEP_EXISTING',
      ));
    }
    if (candidate.applicationOrderStatus !== 'NORMAL') {
      rows.push(resolutionNumber(
        `신청순서 확인 · ${candidate.semesterName} · ${candidate.memberName}`,
        `application-order-${index}`,
      ));
    }
  });
  preview.contextChanges.forEach((change, index) => {
    if (change.status !== 'EXISTING_CONFLICT') return;
    rows.push(resolutionSelect(
      `${change.semesterName}${change.courseName ? ` · ${change.courseName}` : ''} ${change.field === 'order' ? '순서' : '정원'}`,
      `context-action-${index}`,
      [['KEEP_EXISTING', '기존 값 유지'], ['APPLY_FILE_VALUE', `파일 값 적용 (${change.fileValue})`]],
      'KEEP_EXISTING',
    ));
  });
  byId('import-resolutions').replaceChildren(...rows);
};

const resolutionSelect = (text, name, options, selected) => {
  const row = document.createElement('label');
  row.className = 'resolution-row';
  row.append(document.createTextNode(text));
  const select = document.createElement('select');
  select.name = name;
  for (const [value, label] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = value === selected;
    select.append(option);
  }
  row.append(select);
  return row;
};

const resolutionNumber = (text, name) => {
  const row = document.createElement('label');
  row.className = 'resolution-row';
  row.append(document.createTextNode(text));
  const input = document.createElement('input');
  input.name = name;
  input.type = 'number';
  input.min = '1';
  input.step = '1';
  input.required = true;
  row.append(input);
  return row;
};

const commitImport = async () => {
  const preview = state.importPreview;
  if (!preview) return;
  let invalidOrder = '';
  const note = await reviewWarnings(preview);
  if (note === null) return;
  const resolutions = preview.kind === 'ENROLLMENTS' && note
    ? preview.enrollments.map(({ semesterName, memberName, courseName }) => ({
      entity: 'ENROLLMENT', action: 'ACKNOWLEDGE_WARNING', semesterName, memberName, courseName,
      warningDigest: preview.warningDigest, acknowledgementNote: note,
    }))
    : [];
  preview.applications.forEach((candidate, index) => {
    const action = byId('import-resolutions').querySelector(`[name="application-action-${index}"]`)?.value;
    if (action) resolutions.push({
      entity: 'APPLICATION', action,
      semesterName: candidate.semesterName, memberName: candidate.memberName,
    });
    if (candidate.applicationOrderStatus !== 'NORMAL') {
      const applicationOrder = Number(byId('import-resolutions').querySelector(`[name="application-order-${index}"]`)?.value);
      if (!Number.isSafeInteger(applicationOrder) || applicationOrder < 1) {
        invalidOrder = candidate.memberName;
        return;
      }
      resolutions.push({
        entity: 'APPLICATION', action: 'CONFIRM_APPLICATION_ORDER',
        semesterName: candidate.semesterName, memberName: candidate.memberName, applicationOrder,
      });
    }
  });
  if (invalidOrder) {
    showMessage(`${invalidOrder}의 신청순서를 확인하세요.`, true);
    return;
  }
  preview.contextChanges.forEach((change, index) => {
    if (change.status !== 'EXISTING_CONFLICT') return;
    resolutions.push({
      entity: change.entity,
      action: byId('import-resolutions').querySelector(`[name="context-action-${index}"]`).value,
      field: change.field,
      semesterName: change.semesterName,
      ...(change.courseName ? { courseName: change.courseName } : {}),
    });
  });
  const receipt = await run(() => api(`/imports/${preview.previewId}/commit`, {
    method: 'POST',
    headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({
      storeRevision: preview.storeRevision,
      storeEpoch: preview.storeEpoch,
      warningDigest: preview.warningDigest,
      resolutions,
    }),
  }), 'Excel 자료를 반영했습니다.');
  byId('import-preview-status').textContent = `반영됨 · 추가 ${receipt.inserted} · 수정 ${receipt.updated} · 동일 ${receipt.skipped}`;
  byId('commit-import').disabled = true;
  await loadCatalogs();
  await Promise.all([loadApplications(), loadEnrollments()]);
};

const openDraftCreate = async () => {
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
  const semesterId = byId('draft-create-form').elements.semesterId.value;
  if (!semesterId) return;
  const [context, enrollments] = await Promise.all([
    api(`/semesters/${semesterId}/context`), api(`/enrollments?semesterId=${encodeURIComponent(semesterId)}&limit=200`),
  ]);
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
  await showDraft(detail, await api(`/semesters/${detail.draft.semesterId}/context`));
};

const openDraft = async (id) => {
  const detail = await api(`/allocation-drafts/${id}`);
  const context = await api(`/semesters/${detail.draft.semesterId}/context`);
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
const { previewFinalization, finalizeDraft } = createFinalizationPage({
  state, api, byId, run, draftCourseName, showMessage, loadDrafts, loadEnrollments,
});
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

const loadCatalogs = async () => {
  const [semesters, members, courses] = await Promise.all([
    loadCatalogItems('/semesters'), loadCatalogItems('/members'), loadCatalogItems('/courses'),
  ]);
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
