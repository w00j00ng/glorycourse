import { issueText } from './issue-view.js';

/**
 * @typedef {{
 *   kind: 'APPLICATIONS' | 'ENROLLMENTS', mode: 'MERGE_KEEP_EXISTING' | 'REPLACE_APPLICATION',
 *   previewId: string, storeRevision: number, storeEpoch: string, warningDigest: string,
 *   sourceRowCount: number, insertCandidates: number, identicalRows: number, conflicts: number, expiresAt: string,
 *   issues: { code: string, severity: 'ERROR' | 'WARNING' | 'INFO', message: string,
 *     blockingStages: string[], source?: { sheet?: string, row?: number, column?: string } }[],
 *   applications: { semesterName: string, memberName: string, applicationOrder: number | null,
 *     applicationOrderStatus: string, choices: { courseName: string, preference: number | null }[] }[],
 *   enrollments: { semesterName: string, memberName: string, courseName: string }[],
 *   contextChanges: { entity: string, status: string, semesterName: string, courseName?: string,
 *     field: string, fileValue: number | null }[],
 * }} ImportPreview
 */
/**
 * @param {{
 *   state: { importPreview: ImportPreview | null },
 *   byId: (id: string) => any,
 *   api: (path: string, options?: RequestInit) => Promise<unknown>,
 *   run: (action: () => Promise<unknown>, success?: string) => Promise<unknown>,
 *   reviewWarnings: (preview: ImportPreview) => Promise<string | null>,
 *   showMessage: (message: string, isError?: boolean) => void,
 *   loadCatalogs: () => Promise<void>,
 *   loadApplications: () => Promise<void>,
 *   loadEnrollments: () => Promise<void>,
 * }} dependencies
 */
export const createImportsPage = ({ state, byId, api, run, reviewWarnings, showMessage,
  loadCatalogs, loadApplications, loadEnrollments }) => {
  /** @param {ImportPreview['kind']} kind */
  const open = (kind) => {
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

  /** @param {ImportPreview} preview */
  const renderCandidates = (preview) => {
    const candidates = preview.kind === 'APPLICATIONS' ? preview.applications : preview.enrollments;
    byId('import-candidates').replaceChildren(...candidates.map((candidate) => {
      const card = document.createElement('div');
      card.className = 'import-candidate';
      const title = document.createElement('strong');
      title.textContent = `${candidate.semesterName || '학기 미정'} · ${candidate.memberName || '회원 미정'}`;
      const detail = document.createElement('small');
      detail.textContent = 'choices' in candidate
        ? `신청순서 ${candidate.applicationOrder ?? '미정'} · ${candidate.choices.map(({ courseName, preference }) => `${preference ?? '?'}순위 ${courseName || '강좌 미정'}`).join(', ')}`
        : candidate.courseName || '강좌 미정';
      card.append(title, detail);
      return card;
    }));
  };

  /** @param {string} text @param {string} name @param {[string, string][]} options @param {string} selected */
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

  /** @param {string} text @param {string} name */
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

  /** @param {ImportPreview} preview */
  const renderResolutions = (preview) => {
    /** @type {HTMLLabelElement[]} */
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

  /** @param {SubmitEvent} event */
  const submit = async (event) => {
    event.preventDefault();
    const form = /** @type {HTMLFormElement & { elements: HTMLFormControlsCollection & { kind: HTMLInputElement } }} */ (event.currentTarget);
    const payload = new FormData(form);
    if (form.elements.kind.value === 'ENROLLMENTS') payload.set('mode', 'MERGE_KEEP_EXISTING');
    const preview = /** @type {ImportPreview} */ (await run(() => api('/imports/preview', { method: 'POST', body: payload })));
    state.importPreview = preview;
    byId('import-source-count').textContent = String(preview.sourceRowCount);
    byId('import-insert-count').textContent = String(preview.insertCandidates);
    byId('import-identical-count').textContent = String(preview.identicalRows);
    byId('import-conflict-count').textContent = String(preview.conflicts);
    byId('import-preview-status').textContent = `아직 저장되지 않음 · ${new Date(preview.expiresAt).toLocaleTimeString()}까지 유효`;
    byId('import-issues').replaceChildren(...(
      preview.issues.length ? preview.issues : [{ code: 'NO_ISSUES', severity: 'INFO', message: '추가 검토 항목이 없습니다.' }]
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
    renderCandidates(preview);
    renderResolutions(preview);
    const blocksCommit = preview.issues.some((issue) => (
      issue.severity === 'ERROR' && issue.blockingStages.includes('IMPORT_COMMIT')
    )) || (preview.kind === 'ENROLLMENTS' && preview.conflicts > 0);
    byId('commit-import').disabled = blocksCommit;
    byId('import-preview').hidden = false;
    byId('import-preview-action').hidden = true;
  };

  const commit = async () => {
    const preview = state.importPreview;
    if (!preview) return;
    let invalidOrder = '';
    const note = await reviewWarnings(preview);
    if (note === null) return;
    /** @type {Record<string, unknown>[]} */
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
    const receipt = /** @type {{ inserted: number, updated: number, skipped: number }} */ (await run(() => api(`/imports/${preview.previewId}/commit`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        storeRevision: preview.storeRevision,
        storeEpoch: preview.storeEpoch,
        warningDigest: preview.warningDigest,
        resolutions,
      }),
    }), 'Excel 자료를 반영했습니다.'));
    byId('import-preview-status').textContent = `반영됨 · 추가 ${receipt.inserted} · 수정 ${receipt.updated} · 동일 ${receipt.skipped}`;
    byId('commit-import').disabled = true;
    await loadCatalogs();
    await Promise.all([loadApplications(), loadEnrollments()]);
  };

  return { open, submit, commit };
};
