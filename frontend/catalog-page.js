/** @typedef {import('../backend/src/storage/store.ts').SemesterRecord} Semester */
/**
 * @param {{
 *   state: { semesters: Semester[], selectedSemesterId: string | null, movingSemester: boolean },
 *   byId: (id: string) => HTMLElement,
 *   api: (path: string, options?: RequestInit) => Promise<unknown>,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   showMessage: (message: string, error?: boolean) => void,
 *   loadCatalogs: () => Promise<void>,
 *   loadCatalogManagement: (id?: string) => Promise<void>,
 *   cell: (text: string | number) => HTMLElement,
 *   actionsCell: (...actions: [string, () => void | Promise<void>, string?][]) => HTMLElement,
 * }} dependencies
 */
export const createCatalogPage = ({ state, byId, api, run, showMessage, loadCatalogs, loadCatalogManagement, cell, actionsCell }) => {
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

  return { renderSemesterRows, selectSemesterRow, moveSemester };
};
