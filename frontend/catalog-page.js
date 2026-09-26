import { copySemesterCourses, parseSemesterCourses } from './catalog-view.js';

/** @typedef {import('../backend/src/storage/store.ts').SemesterRecord} Semester */
/** @typedef {ReturnType<import('../backend/src/services/applications.ts').ApplicationService['getSemesterContext']>} CatalogContext */
/**
 * @param {{
 *   state: { semesters: Semester[], selectedSemesterId: string | null, movingSemester: boolean, catalogContext: CatalogContext | null, catalogRequest?: symbol, catalogCopyCourses: CatalogContext['semesterCourses'], catalogCopyRequest?: symbol },
 *   byId: (id: string) => any,
 *   api: (path: string, options?: RequestInit) => Promise<unknown>,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   showMessage: (message: string, error?: boolean) => void,
 *   loadCatalogs: () => Promise<void>,
 *   fillSelect: (select: HTMLSelectElement, items: Semester[], placeholder: string) => void,
 *   cell: (text: string | number) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 * }} dependencies
 */
export const createCatalogPage = ({ state, byId, api, run, showMessage, loadCatalogs, fillSelect, cell, actionsCell }) => {
  /** @param {Partial<CatalogContext['semesterCourses'][number]>} [course] */
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
    capacity.value = String(course.capacity ?? '');
    capacity.setAttribute('aria-label', course.id ? '정원' : '새 강좌 정원 (필수)');
    capacityCell.append(capacity);
    const enrollmentCount = course.enrollmentCount ?? 0;
    const applicationCount = course.applicationCount ?? 0;
    const usage = course.id
      ? enrollmentCount > 0
        ? `수강이력 ${enrollmentCount}건 · 삭제 불가`
        : applicationCount > 0
          ? `수강신청 ${applicationCount}건`
          : '사용 없음'
      : '저장 전';
    const action = course.id
      ? actionsCell(['삭제', () => deleteSemesterCourse(/** @type {CatalogContext['semesterCourses'][number]} */ (course)), 'delete'])
      : actionsCell(['추가 취소', () => {
        row.remove();
        byId('catalog-course-empty').hidden = byId('catalog-course-rows').children.length !== 0;
      }, 'delete']);
    const deleteButton = /** @type {HTMLButtonElement} */ (action.querySelector('button'));
    if (enrollmentCount > 0) {
      deleteButton.disabled = true;
      deleteButton.title = '수강이력이 있는 강좌는 삭제할 수 없습니다.';
    }
    row.append(nameCell, capacityCell, cell(usage), action);
    return row;
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

  /** @param {CatalogContext} context */
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

  /** @param {string} [preferredId] */
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
    const context = /** @type {CatalogContext} */ (await api(`/semesters/${selected}/context`));
    if (state.catalogRequest !== request) return;
    renderCatalogContext(context);
  };

  /** @param {SubmitEvent} event */
  const createSemester = async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const context = /** @type {CatalogContext} */ (await run(() => api('/semesters', {
      method: 'POST',
      body: JSON.stringify({ name: /** @type {HTMLInputElement} */ (form.elements.namedItem('name')).value, order: null }),
    }), '학기를 추가했습니다.'));
    byId('semester-create-dialog').close();
    state.selectedSemesterId = context.semester.id;
    await loadCatalogs();
    await loadCatalogManagement(context.semester.id);
  };

  /** @param {SubmitEvent} event */
  const submitSemester = async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const context = state.catalogContext;
    if (!context || context.semester.id !== byId('catalog-semester').value) return;
    const updated = /** @type {CatalogContext} */ (await run(() => api(`/semesters/${context.semester.id}/context`, {
      method: 'PATCH',
      body: JSON.stringify({
        expectedRevision: context.allocationInputRevision,
        name: /** @type {HTMLInputElement} */ (form.elements.namedItem('name')).value,
        order: context.order,
        semesterCourses: context.semesterCourses.map(({ id, courseName, capacity }) => ({ id, courseName, capacity })),
      }),
    }), '학기 정보를 저장했습니다.'));
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

  /** @param {SubmitEvent} event */
  const submitCatalog = async (event) => {
    event.preventDefault();
    const context = state.catalogContext;
    if (!context || context.semester.id !== byId('catalog-semester').value) return;
    const updated = /** @type {CatalogContext} */ (await run(() => api(`/semesters/${context.semester.id}/context`, {
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
    }), '강좌 정보를 저장했습니다.'));
    await loadCatalogs();
    await loadCatalogManagement(updated.semester.id);
  };

  /** @param {CatalogContext['semesterCourses'][number]} course */
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

  /** @param {string} tab */
  const setCatalogTab = (tab) => {
    byId('catalog-semesters-panel').hidden = tab !== 'semesters';
    byId('catalog-courses-panel').hidden = tab !== 'courses';
    /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('[data-catalog-tab]')).forEach((button) => {
      const active = button.dataset.catalogTab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  };

  const openCatalogAdd = () => {
    const form = byId('catalog-add-form');
    form.reset();
    byId('catalog-add-errors').replaceChildren();
    byId('catalog-add-errors').hidden = true;
    byId('catalog-add-dialog').showModal();
    form.elements.courses.focus();
  };

  /** @param {SubmitEvent} event */
  const addCatalogCourses = (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const input = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('courses'));
    const { courses, errors } = parseSemesterCourses(input.value);
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
    const existingNames = /** @type {HTMLElement[]} */ ([...rows.children]).map((row) =>
      /** @type {HTMLInputElement} */ (row.querySelector('[name="courseName"]')).value);
    const added = copySemesterCourses(existingNames, courses);
    rows.append(...added.map(catalogCourseRow));
    byId('catalog-course-empty').hidden = rows.children.length !== 0;
    byId('catalog-add-dialog').close();
    const skipped = courses.length - added.length;
    showMessage(`강좌 ${added.length}개를 추가했습니다.${skipped ? ` 같은 이름 ${skipped}개는 제외했습니다.` : ''}`);
  };

  /** @param {SubmitEvent} event */
  const copyCatalogCourses = (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement} */ (event.currentTarget);
    const checked = /** @type {NodeListOf<HTMLInputElement>} */ (form.querySelectorAll('[name="courseId"]:checked'));
    const selectedIds = new Set([...checked].map(({ value }) => value));
    if (selectedIds.size === 0) {
      showMessage('복사할 강좌를 선택하세요.', true);
      return;
    }
    const selected = state.catalogCopyCourses.filter(({ id }) => selectedIds.has(id));
    const rows = byId('catalog-course-rows');
    const existingNames = /** @type {HTMLElement[]} */ ([...rows.children]).map((row) =>
      /** @type {HTMLInputElement} */ (row.querySelector('[name="courseName"]')).value);
    const copied = copySemesterCourses(existingNames, selected);
    rows.append(...copied.map(catalogCourseRow));
    byId('catalog-course-empty').hidden = rows.children.length !== 0;
    byId('catalog-copy-dialog').close();
    const skipped = selected.length - copied.length;
    showMessage(`강좌 ${copied.length}개를 추가했습니다.${skipped ? ` 같은 이름 ${skipped}개는 제외했습니다.` : ''}`);
  };

  const openCatalogCopy = () => {
    const form = byId('catalog-copy-form');
    form.reset();
    state.catalogCopyRequest = Symbol();
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
    const request = state.catalogCopyRequest = Symbol();
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
    const context = /** @type {CatalogContext} */ (await api(`/semesters/${sourceSemesterId}/context`));
    if (state.catalogCopyRequest !== request) return;
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

  /** @param {string} id */
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

  /** @param {Semester} semester @param {'UP' | 'DOWN'} direction */
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
      /** @type {HTMLElement[]} */ ([...byId('catalog-semester-rows').children])
        .find(({ dataset }) => dataset.id === semester.id)?.focus();
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'CONFLICT')) throw error;
      await loadCatalogs();
      await loadCatalogManagement();
      showMessage('학기 순서가 다른 화면에서 바뀌어 목록을 다시 불러왔습니다. 확인 후 다시 이동하세요.', true);
    } finally {
      state.movingSemester = false;
    }
  };

  return { loadCatalogManagement, renderSemesterRows, selectSemesterRow, moveSemester,
    createSemester, submitSemester, deleteSemester, submitCatalog, deleteSemesterCourse,
    setCatalogTab, openCatalogAdd, addCatalogCourses, copyCatalogCourses,
    openCatalogCopy, loadCatalogCopyCourses };
};
