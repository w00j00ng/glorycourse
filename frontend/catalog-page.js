/** @typedef {import('../backend/src/storage/store.ts').SemesterRecord} Semester */
/** @typedef {ReturnType<import('../backend/src/services/applications.ts').ApplicationService['getSemesterContext']>} CatalogContext */
/**
 * @param {{
 *   state: { semesters: Semester[], selectedSemesterId: string | null, movingSemester: boolean, catalogContext: CatalogContext | null, catalogRequest?: symbol },
 *   byId: (id: string) => any,
 *   api: (path: string, options?: RequestInit) => Promise<unknown>,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   showMessage: (message: string, error?: boolean) => void,
 *   loadCatalogs: () => Promise<void>,
 *   fillSelect: (select: HTMLSelectElement, items: Semester[], placeholder: string) => void,
 *   catalogCourseRow: (course: CatalogContext['semesterCourses'][number]) => HTMLElement,
 *   cell: (text: string | number) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 * }} dependencies
 */
export const createCatalogPage = ({ state, byId, api, run, showMessage, loadCatalogs, fillSelect, catalogCourseRow, cell, actionsCell }) => {
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
    createSemester, submitSemester, deleteSemester };
};
