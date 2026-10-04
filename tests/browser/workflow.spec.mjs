import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';

const serverScript = fileURLToPath(new URL('./server.mjs', import.meta.url));

const test = base.extend({
  app: async ({ page }, use) => {
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const dataDirectory = await mkdtemp(join(tmpdir(), 'glorycourse-browser-'));
    const child = spawn(process.execPath, [
      '--experimental-strip-types', '--disable-warning=ExperimentalWarning', serverScript, dataDirectory,
    ], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let errorOutput = '';
    child.stderr.on('data', (bytes) => { errorOutput += bytes.toString(); });
    try {
      const [message] = await Promise.race([
        once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
        once(child, 'exit').then(() => { throw new Error(`Browser test server exited: ${errorOutput}`); }),
      ]);
      if (message.type !== 'ready') throw new Error(`Browser test server did not start: ${errorOutput}`);
      await page.goto(message.origin);
      await use({
        clearApplicationPreferences: async () => {
          child.send({ type: 'clear-application-preferences' });
          const [result] = await once(child, 'message', { signal: AbortSignal.timeout(20_000) });
          if (result.type !== 'preferences-cleared') throw new Error(result.message);
        },
        completeApplicationTemplate: async (bytes, rows) => {
          child.send({ type: 'complete-template', bytes: bytes.toString('base64'), rows });
          const [result] = await once(child, 'message', { signal: AbortSignal.timeout(20_000) });
          if (result.type !== 'template-completed') throw new Error(result.message);
          return { ...result, buffer: Buffer.from(result.bytes, 'base64') };
        },
        completeEnrollmentTemplate: async (bytes, rows, courses = []) => {
          child.send({ type: 'complete-enrollment-template', bytes: bytes.toString('base64'), rows, courses });
          const [result] = await once(child, 'message', { signal: AbortSignal.timeout(20_000) });
          if (result.type !== 'template-completed') throw new Error(result.message);
          return Buffer.from(result.bytes, 'base64');
        },
        inspectEnrollmentWorkbook: async (bytes) => {
          child.send({ type: 'inspect-enrollment-workbook', bytes: bytes.toString('base64') });
          const [result] = await once(child, 'message', { signal: AbortSignal.timeout(20_000) });
          if (result.type !== 'workbook-inspected') throw new Error(result.message);
          return result;
        },
        seedLarge: async () => {
          child.send({ type: 'seed-large' });
          const [result] = await once(child, 'message', { signal: AbortSignal.timeout(20_000) });
          if (result.type !== 'seeded') throw new Error(result.message);
        },
      });
      expect(pageErrors).toEqual([]);
    } finally {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) await Promise.race([
        once(child, 'exit'), new Promise((resolveExit) => setTimeout(resolveExit, 5_000)),
      ]);
      if (child.exitCode === null) child.kill();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  },
});

test('an administrator uses aligned form controls and selects a page size with the keyboard', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  const fields = ['#application-semester-filter', '#application-member-search', '#application-course-filter', '#application-sort'];
  for (const width of [1280, 560]) {
    await page.setViewportSize({ width, height: 900 });
    const heights = [];
    for (const field of fields) {
      const control = page.locator(field);
      await expect(control).toBeVisible();
      heights.push((await control.boundingBox()).height);
    }
    expect(Math.max(...heights) - Math.min(...heights), `aligned fields at ${width}px`).toBeLessThan(1);
  }
  const pageSize = page.getByRole('combobox', { name: '페이지당 표시' });
  await pageSize.selectOption('10');
  await pageSize.focus();
  await pageSize.press('2');
  await pageSize.press('Tab');
  await expect(pageSize).toHaveValue('20');
});

test('an administrator keeps student affiliations separate for each application, draft and enrollment', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#new-enrollment').click();
  await page.locator('#enrollment-form [data-input-warnings-toggle]').check();
  const history = page.locator('#enrollment-entry-rows > fieldset');
  await history.locator('[name="semesterName"]').fill('지난 학기');
  await history.locator('[name="memberName"]').fill('김가나');
  await history.getByRole('textbox', { name: '학생 소속' }).fill('청소년부');
  await history.locator('[name="newCourseName"]').fill('옛 강좌');
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#enrollment-rows')).toContainText('청소년부');

  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#new-application').click();
  await page.locator('#add-application-entry').click();
  for (const [index, semesterName, affiliation] of [[0, '배정 학기', '청년부'], [1, '다음 학기', '대학부']]) {
    const entry = page.locator('#application-entry-rows > fieldset').nth(index);
    await entry.locator('[name="semesterName"]').fill(semesterName);
    await entry.locator('[name="memberName"]').fill('김가나');
    await entry.getByRole('textbox', { name: '학생 소속' }).fill(affiliation);
    await entry.locator('[name="applicationOrder"]').fill('1');
    await entry.locator('[name="courseName"]').fill('창세기');
  }
  await page.locator('#application-form [type="submit"]').click();
  await page.locator('#application-semester-filter').selectOption('');
  await expect(page.locator('#application-rows tr').filter({ hasText: '배정 학기' })).toContainText('청년부');
  await expect(page.locator('#application-rows tr').filter({ hasText: '다음 학기' })).toContainText('대학부');

  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '배정 학기' });
  await page.locator('#draft-create-form [name="mode"]').selectOption('MANUAL');
  await page.locator('#draft-create-form [type="submit"]').click();
  const draftStudent = page.locator('#draft-item-rows tr').filter({ hasText: '김가나' });
  await expect(draftStudent.getByRole('textbox', { name: '김가나 학생 소속' })).toHaveValue('청년부');
  await draftStudent.getByRole('textbox', { name: '김가나 학생 소속' }).fill('사역팀');
  const finalCourse = draftStudent.getByRole('combobox', { name: '김가나 최종 배정' });
  await finalCourse.focus();
  await finalCourse.selectOption({ index: 1 });
  await draftStudent.getByRole('button', { name: '저장', exact: true }).click();
  await expect(draftStudent.getByRole('textbox', { name: '김가나 학생 소속' })).toHaveValue('사역팀');
  await page.locator('#draft-add-member').fill('박다라');
  await page.locator('#draft-add-affiliation').fill('소그룹');
  await page.locator('#draft-add-course').selectOption({ index: 1 });
  await page.locator('#draft-add-item').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(2);
  await page.locator('#preview-finalization').click();
  await expect(page.locator('#finalize-enrollments')).toContainText('사역팀');
  await expect(page.locator('#finalize-enrollments')).toContainText('소그룹');
  await page.locator('#finalize-draft').click();
  await expect(page.locator('#finalize-dialog')).toBeHidden();

  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#enrollment-semester-filter').selectOption('');
  await expect(page.locator('#enrollment-rows tr').filter({ hasText: '지난 학기' })).toContainText('청소년부');
  const finalizedStudent = page.locator('#enrollment-rows tr').filter({ hasText: '김가나' }).filter({ hasText: '배정 학기' });
  await expect(finalizedStudent).toContainText('사역팀');
  await finalizedStudent.getByRole('button', { name: '수정', exact: true }).click();
  await expect(page.locator('#enrollment-entry-rows [name="affiliation"]')).toHaveValue('사역팀');
  await page.locator('#enrollment-entry-rows [name="affiliation"]').fill('');
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(finalizedStudent.locator('td').nth(2)).toHaveText('—');

  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#application-semester-filter').selectOption('');
  await expect(page.locator('#application-rows tr').filter({ hasText: '배정 학기' })).toContainText('청년부');
  await expect(page.locator('#application-rows tr').filter({ hasText: '다음 학기' })).toContainText('대학부');
});

test('an administrator toggles button help across pages and newly rendered controls', async ({ page, app }) => {
  const helpToggle = page.getByRole('checkbox', { name: '버튼 도움말 표시', exact: true });
  await expect(helpToggle).toBeChecked();
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#refresh-catalog').hover();
  await expect(page.locator('#refresh-catalog')).toHaveAttribute('title', '학기와 개설 강좌 목록을 다시 불러옵니다.');

  await helpToggle.uncheck();
  await expect(page.locator('button[title]:not([title=""])')).toHaveCount(0);
  for (const name of ['도움말 이전 학기', '도움말 현재 학기']) {
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill(name);
    await page.locator('#semester-create-form [type="submit"]').click();
    await expect(page.locator('#catalog-semester-rows')).toContainText(name);
  }
  const selectedSemester = page.locator('#catalog-semester-rows').getByRole('button', { name: '선택됨' });
  await selectedSemester.hover();
  await expect(selectedSemester).toHaveAttribute('title', '');
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#copy-catalog-courses').hover();
  await expect(page.locator('#copy-catalog-courses')).toHaveAttribute('title', '');

  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await expect(helpToggle).not.toBeChecked();
  await page.locator('#new-draft').hover();
  await expect(page.locator('#new-draft')).toHaveAttribute('title', '');
  await helpToggle.check();
  await page.locator('#new-draft').focus();
  await expect(page.locator('#new-draft')).toHaveAttribute('title', '학기와 배정 방식을 선택해 배정초안을 만듭니다.');

  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('[data-catalog-tab="semesters"]').click();
  await selectedSemester.hover();
  await expect(selectedSemester).toHaveAttribute('title', '학기 선택을 해제합니다.');
  await page.locator('[data-catalog-tab="courses"]').click();
  for (const [id, description] of [
    ['copy-catalog-courses', '이전 학기의 강좌와 정원을 선택해 편집 목록에 추가합니다.'],
    ['add-catalog-course', '강좌명과 정원을 여러 줄로 입력해 편집 목록에 추가합니다.'],
  ]) {
    await page.locator('#' + id).hover();
    await expect(page.locator('#' + id)).toHaveAttribute('title', description);
  }
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('도움말 강좌, 3');
  await page.locator('#catalog-add-form [type="submit"]').click();
  const cancelAddition = page.locator('#catalog-course-rows').getByRole('button', { name: '추가 취소' });
  await cancelAddition.hover();
  await expect(cancelAddition).toHaveAttribute('title', '아직 저장하지 않은 강좌를 편집 목록에서 제거합니다.');

  await helpToggle.uncheck();
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('도움말 없는 강좌, 2');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await cancelAddition.last().hover();
  await expect(cancelAddition.last()).toHaveAttribute('title', '');
  await page.getByRole('button', { name: '홈', exact: true }).click();
  const workflowButton = page.locator('#dashboard-workflow button').first();
  await workflowButton.hover();
  await expect(workflowButton).toHaveAttribute('title', '');
  await helpToggle.check();
  await workflowButton.focus();
  await expect(workflowButton).toHaveAttribute('title', /.+/);
});

test('an administrator stores enrollment notes and capacities in Excel and imports them again', async ({ page, app }) => {
  await expect(page.getByRole('button', { name: '자료 관리', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  const [template] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
  const templateBytes = await readFile(await template.path());
  const workbook = await app.inspectEnrollmentWorkbook(templateBytes);
  expect(workbook.version).toBe('3');
  expect(workbook.headers).toEqual(['학기명', '회원명', '학생 소속', '강좌명', '관리자 메모']);
  const note = 'Excel에 보관한 메모\n<img src=x onerror=alert(1)>';
  const input = await app.completeEnrollmentTemplate(templateBytes, [['2028 가을', '홍길동', '창세기', note]], [['2028 가을', '창세기', 20]]);
  const upload = async (bytes) => {
    await page.locator('#enrollments-view .import-open').click();
    await page.locator('#import-form [name="file"]').setInputFiles({ name: 'history.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await page.locator('#import-form [type="submit"]').click();
    await expect(page.locator('#import-preview')).toBeVisible();
    await page.locator('#commit-import').click();
    await expect(page.locator('#import-preview-status')).toContainText('반영됨');
    await page.locator('#import-dialog .close-dialog').first().click();
    await expect(page.locator('#import-dialog')).toBeHidden();
  };
  await upload(input);
  const row = page.locator('#enrollment-rows tr').filter({ hasText: '홍길동' });
  await row.getByText('메모 보기', { exact: true }).click();
  await expect(row.locator('.enrollment-note p')).toHaveText(note);
  await expect(row.locator('.enrollment-note img')).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-export').click()]);
  const saved = await readFile(await download.path());
  const exported = await app.inspectEnrollmentWorkbook(saved);
  expect(exported.courses).toEqual([['2028 가을', '창세기', '20']]);
  expect(exported.enrollments).toEqual([['2028 가을', '홍길동', null, '창세기', note]]);
  await page.locator('#enrollment-semester-filter').selectOption({ label: '2028 가을' });
  page.once('dialog', (dialog) => { void dialog.accept('2028 가을'); });
  await page.locator('#delete-semester-enrollments').click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(0);
  await upload(saved);
  await expect(row).toBeVisible();
  await row.getByText('메모 보기', { exact: true }).click();
  await expect(row.locator('.enrollment-note p')).toHaveText(note);
});

test('an administrator deselects a semester and moves it with the keyboard', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  for (const name of ['2026 봄', '2026 가을']) {
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill(name);
    await page.locator('#semester-create-form [type="submit"]').click();
  }

  const latest = page.locator('#catalog-semester-rows tr').filter({ hasText: '2026 가을' });
  await latest.getByRole('button', { name: '선택됨' }).click();
  await expect(page.locator('#semester-form')).toBeHidden();
  const earlier = page.locator('#catalog-semester-rows tr').filter({ hasText: '2026 봄' });
  await earlier.getByRole('button', { name: '수정' }).click();
  await expect(page.locator('#semester-form')).toBeVisible();
  await earlier.getByRole('button', { name: '선택됨' }).click();
  await expect(page.locator('#semester-form')).toBeHidden();

  await earlier.focus();
  await earlier.press('ArrowUp');
  await expect(page.locator('#catalog-semester-rows tr').first()).toContainText('2026 봄');

  await earlier.getByRole('button', { name: '수정' }).click();
  await page.locator('#semester-form [name="name"]').fill('2026 봄 수정');
  await page.locator('#semester-form [type="submit"]').click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('2026 봄 수정');
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.locator('#delete-semester').click();
  await expect(page.locator('#catalog-semester-rows tr')).toHaveCount(1);
  await expect(page.locator('#catalog-semester-rows')).not.toContainText('2026 봄 수정');
});

test('an administrator copies selected courses from a previous semester', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('2026 봄');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 10\n마태복음, 20');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveCount(2);

  await page.locator('[data-catalog-tab="semesters"]').click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('2026 가을');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#copy-catalog-courses').click();
  await page.locator('#catalog-copy-form [name="sourceSemesterId"]').selectOption({ label: '2026 봄' });
  await expect(page.locator('#catalog-copy-course-list label')).toHaveCount(2);
  await page.locator('#catalog-copy-course-list label').nth(1).locator('input').uncheck();
  await page.locator('#catalog-copy-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveCount(1);
  await expect(page.locator('#catalog-course-rows [name="courseName"]')).toHaveValue('창세기');
  await expect(page.locator('#catalog-course-rows [name="capacity"]')).toHaveValue('10');
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveAttribute('data-id', /.+/);
});

test('an administrator sorts course edits without losing unsaved values or new rows', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('정렬 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await expect(page.locator('#catalog-course-sort')).toHaveCount(1);
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('다 강좌, 10\n가 강좌, 2\n나 강좌, 0\n미정 강좌, 1');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  const rows = page.locator('#catalog-course-rows tr');
  await expect(rows).toHaveCount(4);
  await expect(rows.first()).toHaveAttribute('data-id', /.+/);
  const originalId = await rows.first().getAttribute('data-id');
  await rows.first().locator('[name="courseName"]').fill('다 강좌 수정');
  await rows.first().locator('[name="capacity"]').fill('12');
  await rows.nth(3).locator('[name="capacity"]').fill('');
  const readRows = () => rows.evaluateAll((items) => items.map((row) => [
    row.querySelector('[name="courseName"]').value, row.querySelector('[name="capacity"]').value,
  ]));
  await page.locator('#catalog-course-sort').selectOption('NAME_ASC');
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('라 강좌, 3\n바 강좌, 5');
  await page.locator('#catalog-add-form [type="submit"]').click();
  for (const [sort, expected] of [
    ['NAME_ASC', [['가 강좌', '2'], ['나 강좌', '0'], ['다 강좌 수정', '12'], ['라 강좌', '3'], ['미정 강좌', ''], ['바 강좌', '5']]],
    ['NAME_DESC', [['바 강좌', '5'], ['미정 강좌', ''], ['라 강좌', '3'], ['다 강좌 수정', '12'], ['나 강좌', '0'], ['가 강좌', '2']]],
    ['CAPACITY_ASC', [['나 강좌', '0'], ['가 강좌', '2'], ['라 강좌', '3'], ['바 강좌', '5'], ['다 강좌 수정', '12'], ['미정 강좌', '']]],
    ['CAPACITY_DESC', [['다 강좌 수정', '12'], ['바 강좌', '5'], ['라 강좌', '3'], ['가 강좌', '2'], ['나 강좌', '0'], ['미정 강좌', '']]],
    ['', [['다 강좌 수정', '12'], ['가 강좌', '2'], ['나 강좌', '0'], ['미정 강좌', ''], ['라 강좌', '3'], ['바 강좌', '5']]],
  ]) {
    await page.locator('#catalog-course-sort').selectOption(sort);
    await expect.poll(readRows).toEqual(expected);
  }
  await expect(rows.first()).toHaveAttribute('data-id', originalId);
  await expect(rows.last().getByRole('button', { name: '추가 취소' })).toBeVisible();
  await page.locator('#catalog-course-sort').selectOption('CAPACITY_DESC');
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(rows.nth(1)).toHaveAttribute('data-id', /.+/);
  await page.locator('#refresh-catalog').click();
  await expect(page.locator('#catalog-course-sort')).toHaveValue('CAPACITY_DESC');
  await expect.poll(readRows).toEqual([['다 강좌 수정', '12'], ['바 강좌', '5'], ['라 강좌', '3'], ['가 강좌', '2'], ['나 강좌', '0'], ['미정 강좌', '']]);
  await page.locator('#catalog-course-sort').selectOption('');
  await expect.poll(readRows).toEqual([['다 강좌 수정', '12'], ['가 강좌', '2'], ['나 강좌', '0'], ['미정 강좌', ''], ['라 강좌', '3'], ['바 강좌', '5']]);
});

test('an administrator sorts enrollment history across pages and retains sorting in filters and Excel', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await expect(page.locator('#enrollment-sort')).toHaveCount(1);
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
  const template = await readFile(await download.path());
  const requests = Array.from({ length: 52 }, (_, index) => ['정렬 학기', `회원 ${String(index).padStart(2, '0')}`, index % 2 ? '마태복음' : '창세기']).reverse();
  const buffer = await app.completeEnrollmentTemplate(template, requests);
  await page.locator('#enrollments-view .import-open').click();
  await page.locator('#import-form [name="file"]').setInputFiles({ name: 'history.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await page.locator('#import-form [type="submit"]').click();
  await expect(page.locator('#import-preview')).toBeVisible();
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-preview-status')).toContainText('반영됨');
  await page.locator('#import-dialog .close-dialog').first().click();
  const names = () => page.locator('#enrollment-rows tr td:nth-child(2)').allTextContents();
  await page.locator('#enrollment-sort').selectOption('NAME_ASC');
  await expect.poll(names).toEqual(Array.from({ length: 50 }, (_, index) => `회원 ${String(index).padStart(2, '0')}`));
  await page.locator('#enrollment-next-page').click();
  await expect.poll(names).toEqual(['회원 50', '회원 51']);
  await page.locator('#enrollment-sort').selectOption('NAME_DESC');
  await expect(page.locator('#enrollment-page-status')).toHaveText('1–50 / 총 52건');
  await expect.poll(names).toEqual(Array.from({ length: 50 }, (_, index) => `회원 ${String(51 - index).padStart(2, '0')}`));
  await page.locator('#enrollment-member-search').fill('회원 0');
  await expect.poll(names).toEqual(['회원 09', '회원 08', '회원 07', '회원 06', '회원 05', '회원 04', '회원 03', '회원 02', '회원 01', '회원 00']);
  await page.locator('#enrollment-course-filter').selectOption({ label: '창세기' });
  await expect.poll(names).toEqual(['회원 08', '회원 06', '회원 04', '회원 02', '회원 00']);
  await page.locator('#refresh-enrollments').click();
  await expect(page.locator('#enrollment-sort')).toHaveValue('NAME_DESC');
  const [exported] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-export').click()]);
  const workbook = await app.inspectEnrollmentWorkbook(await readFile(await exported.path()));
  expect(workbook.enrollments.map((row) => row[1])).toEqual(['회원 08', '회원 06', '회원 04', '회원 02', '회원 00']);
});

test('an administrator saves and deletes an unused semester course', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('강좌 관리 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('마태복음, 3');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveCount(1);
  await expect(page.locator('#catalog-course-rows [name="courseName"]')).toHaveValue('마태복음');

  const deleteButton = page.locator('#catalog-course-rows tr').getByRole('button', { name: '삭제', exact: true });
  await expect(deleteButton).toBeVisible();
  for (const width of [1280, 1024, 800, 540, 360]) {
    await page.setViewportSize({ width, height: 900 });
    const label = await deleteButton.evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      return {
        lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
        fits: text.left >= bounds.left && text.right <= bounds.right,
      };
    });
    expect(label, `화면 너비 ${width}px에서 삭제 버튼 문구`).toEqual({ lines: 1, fits: true });
  }

  page.once('dialog', (dialog) => { void dialog.accept(); });
  await deleteButton.click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveCount(0);
  await page.locator('#refresh-catalog').click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveCount(0);
});

test('a late catalog refresh does not hide a semester added afterward', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('기존 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('기존 학기');

  let releaseOldResponse;
  const holdOldResponse = new Promise((resolve) => { releaseOldResponse = resolve; });
  let oldSnapshotReady;
  const oldSnapshot = new Promise((resolve) => { oldSnapshotReady = resolve; });
  let delayed = false;
  await page.route('**/api/v1/semesters?page=*', async (route) => {
    if (delayed) return route.continue();
    delayed = true;
    const response = await route.fetch();
    oldSnapshotReady();
    await holdOldResponse;
    await route.fulfill({ response });
  });

  try {
    await page.locator('#refresh-catalog').click();
    await oldSnapshot;
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill('새 학기');
    await page.locator('#semester-create-form [type="submit"]').click();
    await expect(page.locator('#catalog-semester-rows')).toContainText('새 학기');
    await expect(page.locator('#semester-form')).toBeVisible();

    const refreshContinued = page.waitForRequest((request) =>
      request.method() === 'GET' && /\/api\/v1\/semesters\/[^/]+\/context$/.test(request.url()));
    releaseOldResponse();
    await refreshContinued;
    await expect(page.locator('#catalog-semester-rows')).toContainText('새 학기');
  } finally {
    releaseOldResponse();
  }
});

test('draft readiness follows the semester currently selected', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  for (const name of ['먼저 선택한 학기', '나중에 선택한 학기']) {
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill(name);
    await page.locator('#semester-create-form [type="submit"]').click();
    await expect(page.locator('#catalog-semester-rows')).toContainText(name);
  }
  const oldSemesterId = await page.locator('#catalog-semester-rows tr').filter({ hasText: '먼저 선택한 학기' }).getAttribute('data-id');
  let releaseOldResponse;
  const holdOldResponse = new Promise((resolve) => { releaseOldResponse = resolve; });
  let oldResponseReady;
  const oldResponseCaptured = new Promise((resolve) => { oldResponseReady = resolve; });
  await page.route(`**/api/v1/semesters/${oldSemesterId}/context`, async (route) => {
    const response = await route.fetch();
    const context = await response.json();
    oldResponseReady();
    await holdOldResponse;
    await route.fulfill({ response, json: {
      ...context, readyForAutoAllocation: false, issues: [{ code: 'CAPACITY_UNRESOLVED' }],
    } });
  });

  try {
    await page.getByRole('button', { name: '배정초안', exact: true }).click();
    await page.locator('#new-draft').click();
    const semester = page.locator('#draft-create-form [name="semesterId"]');
    await semester.selectOption({ label: '먼저 선택한 학기' });
    await oldResponseCaptured;
    await semester.selectOption({ label: '나중에 선택한 학기' });
    await expect(page.locator('#draft-readiness')).toContainText('자동 배정 준비됨');

    const oldResponseFinished = page.waitForResponse((response) => response.url().endsWith(`/semesters/${oldSemesterId}/context`));
    releaseOldResponse();
    await oldResponseFinished;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#draft-readiness')).toContainText('자동 배정 준비됨');
    await semester.selectOption('');
    await expect(page.locator('#draft-readiness')).toHaveText('학기를 선택하면 자동 배정 준비 상태를 확인합니다.');
  } finally {
    releaseOldResponse();
  }
});

test('an administrator creates a manual draft without applications and assigns members by name', async ({ page, app }) => {
  // An earlier application supplies an existing member for the name suggestions.
  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#new-application').click();
  await page.locator('#application-entry-rows [name="semesterName"]').fill('이전 학기');
  await page.locator('#application-entry-rows [name="memberName"]').fill('기존 회원');
  await page.locator('#application-entry-rows [name="applicationOrder"]').fill('1');
  await page.locator('#application-entry-rows [name="courseName"]').fill('기초');
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-dialog')).toBeHidden();
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('수동 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '수동 학기' });
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('기초, 1\n심화, 1');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#message')).toContainText('저장');

  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  const policy = page.locator('#draft-create-form [name="policy"]');
  const mode = page.locator('#draft-create-form [name="mode"]');
  await expect(policy).toBeEnabled();
  await policy.selectOption({ index: 1 });
  const selectedPolicy = await policy.inputValue();
  await mode.selectOption('MANUAL');
  await expect(policy).toBeVisible();
  await expect(policy).toBeDisabled();
  await expect(page.locator('#draft-policy-description')).toContainText('적용하지 않습니다');
  await mode.selectOption('AUTO');
  await expect(policy).toBeEnabled();
  await expect(policy).toHaveValue(selectedPolicy);
  await mode.selectOption('MANUAL');
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '수동 학기' });
  await expect(page.locator('#draft-readiness')).toContainText('직접 추가');
  await page.locator('#draft-create-form [type="submit"]').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(0);
  await expect(page.locator('#draft-dialog-meta')).toContainText('정책 미적용');
  await expect(page.locator('#member-options option[value="기존 회원"]')).toHaveCount(1);
  const member = page.locator('#draft-add-member');
  const course = page.locator('#draft-add-course');
  await member.fill('기존 회원');
  await course.selectOption({ index: 1 });
  await page.locator('#draft-add-item').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(1);
  await expect(course.locator('option').filter({ hasText: '기초' })).toContainText('정원 마감');
  await member.fill('기존 회원');
  await page.locator('#draft-add-item').click();
  await expect(page.locator('#dialog-message')).toContainText('이미 이 초안에 있는 회원');
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(1);
  await member.fill('새 회원');
  await course.selectOption({ index: 2 });
  await member.press('Enter');
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(2);
  await expect(page.locator('#draft-dialog')).toBeVisible();
  await expect(page.locator('#draft-stale')).toBeHidden();
  await page.locator('#draft-dialog .close-dialog').first().click();
  await page.locator('#draft-rows tr').getByRole('button', { name: '검토' }).click();
  await expect(page.locator('#draft-item-rows')).toContainText('새 회원');
  await expect(page.locator('#draft-capacity-rows')).toContainText('1 / 1명');
  await page.locator('#preview-finalization').click();
  await expect(page.locator('#finalize-add-count')).toHaveText('2');
  await page.locator('#finalize-draft').click();
  await expect(page.locator('#finalize-dialog')).toBeHidden();
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await expect(page.locator('#enrollment-rows')).toContainText('새 회원');
  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#application-semester-filter').selectOption({ label: '수동 학기' });
  await expect(page.locator('#application-rows tr')).toHaveCount(0);
});

test('a late draft detail does not replace the draft selected afterward', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  for (const name of ['첫째 학기', '둘째 학기']) {
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill(name);
    await page.locator('#semester-create-form [type="submit"]').click();
    await expect(page.locator('#catalog-semester-rows')).toContainText(name);
  }
  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  for (const name of ['첫째 학기', '둘째 학기']) {
    await page.locator('#new-draft').click();
    await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: name });
    await page.locator('#draft-create-form [name="mode"]').selectOption('MANUAL');
    await page.locator('#draft-create-form [type="submit"]').click();
    await expect(page.locator('#draft-dialog-title')).toContainText(name);
    await page.locator('#draft-dialog .close-dialog').first().click();
  }
  await expect(page.locator('#draft-rows tr')).toHaveCount(2);

  let releaseOldResponse;
  const holdOldResponse = new Promise((resolve) => { releaseOldResponse = resolve; });
  let oldResponseReady;
  const oldResponseCaptured = new Promise((resolve) => { oldResponseReady = resolve; });
  let delayed = false;
  let oldDetailUrl;
  await page.route('**/api/v1/allocation-drafts/*', async (route) => {
    if (route.request().method() !== 'GET' || delayed) return route.continue();
    delayed = true;
    oldDetailUrl = route.request().url();
    const response = await route.fetch();
    oldResponseReady();
    await holdOldResponse;
    await route.fulfill({ response });
  });

  try {
    await page.locator('#draft-rows tr').filter({ hasText: '첫째 학기' }).getByRole('button', { name: '검토' }).click();
    await oldResponseCaptured;
    await page.locator('#draft-rows tr').filter({ hasText: '둘째 학기' }).getByRole('button', { name: '검토' }).click();
    await expect(page.locator('#draft-dialog-title')).toContainText('둘째 학기');

    const oldDetailReturned = page.waitForResponse((response) => response.url() === oldDetailUrl);
    releaseOldResponse();
    await oldDetailReturned;
    await page.waitForLoadState('networkidle');
    await expect(page.locator('#draft-dialog-title')).toContainText('둘째 학기');
  } finally {
    releaseOldResponse();
  }
});

test('an administrator sees which application prevents export and corrects its preference', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#new-application').click();
  const entry = page.locator('#application-entry-rows > fieldset');
  await entry.locator('[name="semesterName"]').fill('과거 학기');
  await entry.locator('[name="memberName"]').fill('순위 미정 회원');
  await entry.locator('[name="applicationOrder"]').fill('1');
  await entry.locator('[name="courseName"]').fill('기초');
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-rows tr')).toHaveCount(1);

  await app.clearApplicationPreferences();
  const [refreshed] = await Promise.all([
    page.waitForResponse((response) => response.url().includes('/api/v1/applications?')),
    page.locator('#refresh-applications').click(),
  ]);
  expect((await refreshed.json()).items[0].choices[0].preference).toBeNull();
  await page.locator('#application-export').click();
  await expect(page.locator('#message')).toContainText('과거 학기 / 순위 미정 회원: 희망순위 1~5를 확인한 뒤 다시 내보내세요.');
  await expect(page.locator('#message')).toContainText('강좌마다 다른 순위를 입력하세요.');
  await expect(page.locator('#message')).not.toContainText('xlsx 파일을 읽을 수 없습니다.');
  await expect(page.locator('#application-rows tr')).toHaveCount(1);

  await page.locator('#application-rows tr').getByRole('button', { name: '수정' }).click();
  await entry.locator('[name="preference"]').fill('1');
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-dialog')).toBeHidden();
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.locator('#application-export').click(),
  ]);
  expect(await download.failure()).toBeNull();
});

test('an administrator reviews a completed application template before importing it', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('양식 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '양식 학기' });
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 2\n마태복음, 2\n마가복음, 2');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();

  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#application-template').click();
  await page.locator('#application-template-form [name="semesterId"]').selectOption({ label: '양식 학기' });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#application-template-form [type="submit"]').click(),
  ]);
  const completed = await app.completeApplicationTemplate(await readFile(await download.path()));
  expect([completed.semesterName, completed.courseName, completed.capacity]).toEqual(['양식 학기', '창세기', 2]);
  expect(completed.headers).toEqual(['학기명', '회원명', '학생 소속', '신청순서', '1순위 강좌', '2순위 강좌', '3순위 강좌', '4순위 강좌']);

  await page.locator('#applications-view .import-open').click();
  await page.locator('#import-form [name="file"]').setInputFiles({
    name: '수강신청.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: completed.buffer,
  });
  await page.locator('#import-preview-action [type="submit"]').click();
  await expect(page.locator('#import-source-count')).toHaveText('1');
  await expect(page.locator('#import-insert-count')).toHaveText('1');
  await expect(page.locator('#import-candidates')).toContainText('양식 회원');
  await expect(page.locator('#import-candidates')).toContainText('학생 소속: 양식 소속');
  await expect(page.locator('#import-candidates')).toContainText('창세기');
  await expect(page.locator('#import-candidates')).toContainText('4순위 마태복음');
  await expect(page.locator('#import-candidates')).toContainText('5순위 마가복음');
  await expect(page.locator('#application-rows tr')).toHaveCount(0);
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-preview-status')).toContainText('반영됨');
  await page.locator('#import-dialog .close-dialog').first().click();
  await expect(page.locator('#application-rows tr')).toHaveCount(1);
  await expect(page.locator('#application-rows')).toContainText('양식 회원');
  await expect(page.locator('#application-rows')).toContainText('양식 소속');
  await expect(page.locator('#application-rows')).toContainText('4순위 마태복음');
  await expect(page.locator('#application-rows')).toContainText('5순위 마가복음');
  await page.locator('#applications-view .import-open').click();
  await expect(page.locator('#import-dialog-title')).toHaveText('수강신청 Excel 검토');
  await expect(page.locator('#import-preview')).toBeHidden();
  await expect(page.locator('#import-preview-action')).toBeVisible();
  await page.locator('#import-dialog .close-dialog').first().click();
});

test('an administrator turns direct registration warnings off and back on while errors still block saving', async ({ page, app }) => {
  await expect(page.locator('.sidebar [data-input-warnings-toggle]')).toHaveCount(0);
  await expect(page.locator('#input-warnings-ignored')).not.toBeChecked();
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#new-enrollment').click();
  const toggle = page.locator('#enrollment-form [data-input-warnings-toggle]');
  await expect(toggle).toHaveAccessibleName('입력 경고 무시');
  await toggle.check();
  const row = page.locator('#enrollment-entry-rows > fieldset').first();
  await row.locator('[name="semesterName"]').fill('과거 학기');
  await row.locator('[name="memberName"]').fill('김가나');
  await row.locator('[name="newCourseName"]').fill('창세기');
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#enrollment-dialog')).toBeHidden();
  await expect(page.locator('#warning-dialog')).toBeHidden();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(1);
  await expect(page.locator('#input-warnings-ignored')).toBeChecked();

  for (const [memberName, enabled, expectedCount] of [['김가나', false, 1], ['박다라', false, 2], ['이다마', true, 3]]) {
    await page.locator('#new-enrollment').click();
    await expect(toggle).toBeChecked();
    await toggle.setChecked(!enabled);
    await row.locator('[name="semesterName"]').fill('과거 학기');
    await row.locator('[name="memberName"]').fill(memberName);
    await row.locator('[name="courseId"]').selectOption({ label: '창세기' });
    await page.locator('#enrollment-form [type="submit"]').click();
    if (memberName === '김가나') {
      await expect(page.locator('#dialog-message')).toContainText('같은 학기에 수강이력이 이미 있습니다');
      await expect(page.locator('#warning-dialog')).toBeHidden();
      await page.locator('#enrollment-dialog .close-dialog').first().click();
    } else if (enabled) {
      await expect(page.locator('#warning-dialog')).toBeVisible();
      await expect(page.locator('#warning-list')).toContainText('강좌 정원을 초과합니다');
      await page.locator('#warning-form [name="note"]').fill('추가 이력 확인');
      await page.locator('#warning-form [type="submit"]').click();
    }
    await expect(page.locator('#enrollment-dialog')).toBeHidden();
    await expect(page.locator('#enrollment-rows tr')).toHaveCount(expectedCount);
  }
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '과거 학기' });
  await expect(page.locator('#catalog-course-rows [name="capacity"]')).toHaveValue('1');
});

test('an administrator saves without an optional note and reads a saved multiline note after reopening the page', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  const entries = [
    ['첫 회원', '', 1],
    ['메모 없는 회원', '', 2],
    ['메모 있는 회원', '정원 초과를 확인했습니다.\n<img src=x onerror=alert(1)> 상담 후 수강 허용', 3],
  ];
  for (const [memberName, note, count] of entries) {
    await page.locator('#new-enrollment').click();
    const entry = page.locator('#enrollment-entry-rows > fieldset').first();
    await entry.locator('[name="semesterName"]').fill('관리자 메모 학기');
    await entry.locator('[name="memberName"]').fill(memberName);
    if (count === 1) await entry.locator('[name="newCourseName"]').fill('메모 강좌');
    else await entry.locator('[name="courseId"]').selectOption({ label: '메모 강좌' });
    await page.locator('#enrollment-form [type="submit"]').click();
    await expect(page.locator('#warning-dialog')).toBeVisible();
    await expect(page.locator('#warning-form [name="note"]')).not.toHaveAttribute('required');
    await page.locator('#warning-form [name="note"]').fill(note);
    await page.locator('#warning-form [type="submit"]').click();
    await expect(page.locator('#enrollment-dialog')).toBeHidden();
    await expect(page.locator('#enrollment-rows tr')).toHaveCount(count);
  }
  const empty = page.locator('#enrollment-rows tr').filter({ hasText: '메모 없는 회원' });
  await expect(empty.locator('.enrollment-note')).toHaveText('—');
  const noted = page.locator('#enrollment-rows tr').filter({ hasText: '메모 있는 회원' });
  await noted.getByText('메모 보기', { exact: true }).click();
  await expect(noted.locator('.enrollment-note p')).toHaveText(entries[2][1]);
  await expect(noted.locator('.enrollment-note img')).toHaveCount(0);
  await expect(noted.locator('.enrollment-note time')).toHaveText(/\d/);
  await page.reload();
  await noted.getByText('메모 보기', { exact: true }).click();
  await expect(noted.locator('.enrollment-note p')).toHaveText(entries[2][1]);
});

test('an administrator edits enrollment notes without warnings and reads them after reopening the page', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#new-enrollment').click();
  const entry = page.locator('#enrollment-entry-rows > fieldset');
  await entry.locator('[name="semesterName"]').fill('메모 수정 학기');
  await entry.locator('[name="memberName"]').fill('메모 수정 회원');
  await entry.locator('[name="newCourseName"]').fill('메모 수정 강좌');
  await page.locator('#enrollment-form [data-input-warnings-toggle]').check();
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#enrollment-dialog')).toBeHidden();
  await page.reload();

  const row = page.locator('#enrollment-rows tr').filter({ hasText: '메모 수정 회원' });
  let previousNote = '';
  const cases = [
    ['  첫 수정 메모\n<img src=x onerror=alert(1)>  ', '첫 수정 메모\n<img src=x onerror=alert(1)>', false],
    ['경고 확인을 생략해도 메모 유지', '경고 확인을 생략해도 메모 유지', true],
    ['', '', false],
  ];
  for (const [note, expected, warningsIgnored] of cases) {
    await row.getByRole('button', { name: '수정', exact: true }).click();
    const input = page.locator('#enrollment-form [name="adminNote"]');
    await expect(input).toHaveValue(previousNote);
    await expect(input).not.toHaveAttribute('required');
    await expect(input).toHaveAttribute('maxlength', '2000');
    await input.fill(note);
    await page.locator('#enrollment-form [data-input-warnings-toggle]').setChecked(warningsIgnored);
    await page.locator('#enrollment-form [type="submit"]').click();
    await expect(page.locator('#enrollment-dialog')).toBeHidden();
    await expect(page.locator('#warning-dialog')).toBeHidden();
    await page.reload();
    if (expected) {
      await row.getByText('메모 보기', { exact: true }).click();
      await expect(row.locator('.enrollment-note p')).toHaveText(expected);
      await expect(row.locator('.enrollment-note img')).toHaveCount(0);
      await expect(row.locator('.enrollment-note time')).toHaveText(/\d/);
    } else {
      await expect(row.locator('.enrollment-note')).toHaveText('—');
    }
    previousNote = expected;
  }
  await page.locator('#new-enrollment').click();
  await expect(page.locator('#enrollment-form [name="adminNote"]')).toBeHidden();
  await page.locator('#enrollment-dialog .close-dialog').first().click();
});

test('manual assignment omits enrolled members and warns when their name is typed directly', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  for (const [semesterName, memberName] of [['이전 학기', '과거 수강 회원'], ['현재 학기', '현재 수강 회원']]) {
    await page.locator('#new-enrollment').click();
    await page.locator('#enrollment-form [data-input-warnings-toggle]').check();
    const entry = page.locator('#enrollment-entry-rows > fieldset');
    await entry.locator('[name="semesterName"]').fill(semesterName);
    await entry.locator('[name="memberName"]').fill(memberName);
    await entry.locator('[name="newCourseName"]').fill('기초');
    await page.locator('#enrollment-form [type="submit"]').click();
    await expect(page.locator('#enrollment-dialog')).toBeHidden();
    await expect(page.locator('#enrollment-rows')).toContainText(memberName);
  }
  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '현재 학기' });
  await page.locator('#draft-create-form [name="mode"]').selectOption('MANUAL');
  await page.locator('#draft-create-form [type="submit"]').click();
  const member = page.locator('#draft-add-member');
  await expect(member).toHaveAttribute('list', 'draft-member-options');
  await expect(page.locator('#draft-member-options option[value="현재 수강 회원"]')).toHaveCount(0);
  await expect(page.locator('#draft-member-options option[value="과거 수강 회원"]')).toHaveCount(1);
  await expect(page.locator('#member-options option[value="현재 수강 회원"]')).toHaveCount(1);
  for (const name of ['현재 수강 회원', ` ${'현재 수강 회원'.normalize('NFD')} `]) {
    await member.fill(name);
    await expect(page.locator('#draft-add-member-warning')).toContainText('같은 학기에 수강이력이 있습니다');
    await expect(page.locator('#draft-add-member-warning')).toBeVisible();
  }
  await page.locator('#draft-add-course').selectOption({ index: 1 });
  await page.locator('#draft-add-item').click();
  await expect(page.locator('#dialog-message')).toContainText('같은 학기에 수강이력이 있습니다');
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(0);
  await member.fill('새 회원');
  await expect(page.locator('#draft-add-member-warning')).toBeHidden();
  await member.fill('과거 수강 회원');
  await expect(page.locator('#draft-add-member-warning')).toBeHidden();
  await page.locator('#draft-add-item').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(1);
  await expect(page.locator('#draft-item-rows')).toContainText('과거 수강 회원');
  await expect(page.locator('#draft-add-member-warning')).toBeHidden();
  await page.locator('#draft-dialog .close-dialog').first().click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '이전 학기' });
  await page.locator('#draft-create-form [name="mode"]').selectOption('MANUAL');
  await page.locator('#draft-create-form [type="submit"]').click();
  await expect(page.locator('#draft-member-options option[value="과거 수강 회원"]')).toHaveCount(0);
  await expect(page.locator('#draft-member-options option[value="현재 수강 회원"]')).toHaveCount(1);
});

test('an administrator toggles all Excel registration notices and warnings while retaining errors', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
  const template = await readFile(await download.path());
  const upload = async (rows) => {
    const buffer = await app.completeEnrollmentTemplate(template, rows);
    await page.locator('#enrollments-view .import-open').click();
    await page.getByRole('checkbox', { name: '입력 경고 무시' }).check();
    await page.locator('#import-form [name="file"]').setInputFiles({ name: '이력.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer });
    await page.locator('#import-preview-action [type="submit"]').click();
    await expect(page.locator('#import-preview')).toBeVisible();
  };
  await upload([['과거 학기', '김가나', '창세기'], ['과거 학기', '박다라', '창세기']]);
  const toggle = page.locator('#import-form [data-input-warnings-toggle]');
  const notices = page.locator('#import-issues li.information');
  await expect(toggle).toBeChecked();
  expect(await notices.count()).toBeGreaterThan(0);
  for (const item of await notices.all()) await expect(item).toBeHidden();
  await toggle.uncheck();
  for (const item of await notices.all()) await expect(item).toBeVisible();
  await toggle.check();
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-preview-status')).toContainText('반영됨');
  await expect(page.locator('#warning-dialog')).toBeHidden();
  await page.locator('#import-dialog .close-dialog').first().click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);

  await upload([['과거 학기', '이다마', '창세기'], ['과거 학기', '', '창세기']]);
  const warnings = page.locator('#import-issues li[data-severity="WARNING"]');
  const errors = page.locator('#import-issues li[data-severity="ERROR"]');
  await expect(warnings).toHaveCount(1);
  await expect(warnings).toBeHidden();
  await expect(errors).toBeVisible();
  await expect(page.locator('#commit-import')).toBeDisabled();
  await toggle.uncheck();
  await expect(warnings).toBeVisible();
  await toggle.check();
  await expect(errors).toBeVisible();
  await page.locator('#import-dialog .close-dialog').first().click();

  await upload([['과거 학기', '이다마', '창세기']]);
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-preview-status')).toContainText('반영됨');
  await expect(page.locator('#warning-dialog')).toBeHidden();
  await page.locator('#import-dialog .close-dialog').first().click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(3);
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '과거 학기' });
  await expect(page.locator('#catalog-course-rows [name="capacity"]')).toHaveValue('2');
});

for (const warningsEnabled of [true, false]) {
  test(`an administrator imports a cohort exceeding existing capacity with warnings ${warningsEnabled ? 'on' : 'off'}`, async ({ page, app }) => {
    await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill('기존 학기');
    await page.locator('#semester-create-form [type="submit"]').click();
    await page.locator('[data-catalog-tab="courses"]').click();
    await page.locator('#add-catalog-course').click();
    await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 1');
    await page.locator('#catalog-add-form [type="submit"]').click();
    await page.locator('#catalog-form [type="submit"]').click();

    await page.getByRole('button', { name: '수강이력', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
    const buffer = await app.completeEnrollmentTemplate(await readFile(await download.path()),
      [['기존 학기', '가나', '창세기'], ['기존 학기', '다라', '창세기']]);
    await page.locator('#enrollments-view .import-open').click();
    await page.getByRole('checkbox', { name: '입력 경고 무시' }).setChecked(!warningsEnabled);
    await page.locator('#import-form [name="file"]').setInputFiles({ name: '명단.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.locator('#import-preview-action [type="submit"]').click();
    await expect(page.locator('#import-preview')).toBeVisible();
    await expect(page.locator('#import-candidates')).toBeHidden();
    const warning = page.locator('#import-issues li[data-severity="WARNING"]');
    await expect(warning).toHaveCount(1);
    await expect(warning).toContainText('3행');
    await expect(warning).toContainText('강좌 정원을 초과합니다');
    await expect(warning).toBeVisible({ visible: warningsEnabled });
    await page.locator('#commit-import').click();
    if (warningsEnabled) {
      await expect(page.locator('#warning-dialog')).toBeVisible();
      await page.locator('#cancel-warning').click();
      await expect(page.locator('#commit-import')).toBeEnabled();
      await page.locator('#commit-import').click();
      await expect(page.locator('#warning-dialog')).toBeVisible();
      await page.locator('#warning-form [type="submit"]').click();
    }
    await expect(page.locator('#import-preview-status')).toContainText('반영됨');
    await expect(page.locator('#warning-dialog')).toBeHidden();
    await page.locator('#import-dialog .close-dialog').first().click();
    await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
    await expect(page.locator('#enrollment-rows .enrollment-note')).toHaveText(['—', '—']);
    await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
    await page.locator('[data-catalog-tab="courses"]').click();
    await page.locator('#catalog-semester').selectOption({ label: '기존 학기' });
    await expect(page.locator('#catalog-course-rows [name="capacity"]')).toHaveValue('1');
  });
}

for (const [kind, pageName, view, templateButton, rows] of [
  ['APPLICATIONS', '수강신청', 'applications', 'application-template', [
    ['검토 학기', '처음 회원', 1, '창세기'], ['검토 학기', '다음 회원', 2, '창세기'],
  ]],
  ['ENROLLMENTS', '수강이력', 'enrollments', 'enrollment-template', [
    ['검토 학기', '처음 회원', '창세기'], ['검토 학기', '다음 회원', '창세기'],
  ]],
]) {
  test(`an administrator reviews a newly selected ${kind} file and saves only its contents`, async ({ page, app }) => {
    await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
    await page.locator('#new-semester').click();
    await page.locator('#semester-create-form [name="name"]').fill('검토 학기');
    await page.locator('#semester-create-form [type="submit"]').click();
    await page.locator('[data-catalog-tab="courses"]').click();
    await page.locator('#add-catalog-course').click();
    await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 10');
    await page.locator('#catalog-add-form [type="submit"]').click();
    await page.locator('#catalog-form [type="submit"]').click();
    await page.getByRole('button', { name: pageName, exact: true }).click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#' + templateButton).click();
    if (kind === 'APPLICATIONS') {
      await page.locator('#application-template-form [name="semesterId"]').selectOption({ label: '검토 학기' });
      await page.locator('#application-template-form [type="submit"]').click();
    }
    const template = await readFile(await (await downloadPromise).path());
    const files = [];
    for (const [index, row] of rows.entries()) {
      const completed = kind === 'APPLICATIONS'
        ? (await app.completeApplicationTemplate(template, [row])).buffer
        : await app.completeEnrollmentTemplate(template, [row]);
      files.push({ name: `명단-${index}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: completed });
    }
    await page.locator(`#${view}-view .import-open`).click();
    const selectFile = page.locator('#import-form [name="file"]');
    const review = page.getByRole('button', { name: '파일 검토', exact: true });
    const candidates = page.locator('#import-candidates');
    const candidateSummary = page.locator('#import-candidate-details > summary');
    await selectFile.setInputFiles(files[0]);
    await review.click();
    await expect(candidates).toContainText('처음 회원');
    await expect(candidates).toBeHidden();
    await expect(candidateSummary.getByText('상세보기', { exact: true })).toBeVisible();
    await candidateSummary.click();
    await expect(candidates).toBeVisible();
    await expect(candidateSummary.getByText('상세접기', { exact: true })).toBeVisible();
    await candidateSummary.focus();
    await page.keyboard.press('Space');
    await expect(candidates).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(candidates).toBeVisible();
    await expect(candidates).toContainText('처음 회원');
    await selectFile.setInputFiles(files[1]);
    await expect(review).toBeVisible();
    await expect(review).toBeEnabled();
    await expect(page.locator('#import-preview')).toBeHidden();
    await expect(page.locator('#commit-import')).toBeDisabled();
    await review.click();
    await expect(candidates).toContainText('다음 회원');
    await expect(candidates).not.toContainText('처음 회원');
    await expect(candidates).toBeHidden();
    await candidateSummary.click();
    await expect(candidates).toBeVisible();
    if (kind === 'APPLICATIONS') {
      await page.locator('#import-form [name="mode"]').selectOption('REPLACE_APPLICATION');
      await expect(review).toBeVisible();
      await expect(page.locator('#import-preview')).toBeHidden();
      await review.click();
      await expect(candidates).toContainText('다음 회원');
      await expect(candidates).toBeHidden();
      await candidateSummary.click();
      await expect(candidates).toBeVisible();
    }
    await candidateSummary.click();
    await expect(candidates).toBeHidden();
    await expect(candidateSummary.getByText('상세보기', { exact: true })).toBeVisible();
    await page.locator('#commit-import').click();
    await expect(page.locator('#import-preview-status')).toContainText('반영됨');
    await page.locator('#import-dialog .close-dialog').first().click();
    await expect(page.locator(`#${view === 'applications' ? 'application' : 'enrollment'}-rows`)).toContainText('다음 회원');
    await expect(page.locator(`#${view === 'applications' ? 'application' : 'enrollment'}-rows`)).not.toContainText('처음 회원');
  });
}

for (const [earlierFails, reviewLatest] of [[false, true], [true, true], [false, false]]) {
  test(`an administrator keeps the latest file review when an earlier ${earlierFails ? 'failure' : 'response'} arrives late${reviewLatest ? '' : ' without submitting the replacement'}`, async ({ page, app }) => {
    await page.getByRole('button', { name: '수강이력', exact: true }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
    const template = await readFile(await download.path());
    const files = [];
    for (const [index, member] of ['처음 회원', '다음 회원'].entries()) {
      const buffer = earlierFails && index === 0
        ? Buffer.from('손상된 파일')
        : await app.completeEnrollmentTemplate(template, [['과거 학기', member, '창세기']]);
      files.push({ name: `${member}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    }
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    let firstReceived;
    const received = new Promise((resolve) => { firstReceived = resolve; });
    let requests = 0;
    await page.route('**/api/v1/imports/preview', async (route) => {
      const first = requests++ === 0;
      const response = await route.fetch();
      if (first) { firstReceived(); await delayed; }
      await route.fulfill({ response });
    });
    await page.locator('#enrollments-view .import-open').click();
    await page.getByRole('checkbox', { name: '입력 경고 무시' }).check();
    const file = page.locator('#import-form [name="file"]');
    const review = page.getByRole('button', { name: '파일 검토', exact: true });
    await file.setInputFiles(files[0]);
    await review.click();
    await received;
    await file.setInputFiles(files[1]);
    if (reviewLatest) {
      await review.click();
      await expect(page.locator('#import-candidates')).toContainText('다음 회원');
    }
    const lateResponse = page.waitForResponse('**/api/v1/imports/preview');
    release();
    await lateResponse;
    await expect(page.locator('#shutdown')).toBeEnabled();
    await expect(page.locator('#save-status')).not.toHaveText('저장 중');
    if (!reviewLatest) {
      await expect(review).toBeVisible();
      await expect(review).toBeEnabled();
      await expect(page.locator('#import-preview')).toBeHidden();
      await expect(page.locator('#dialog-message')).toBeHidden();
      return;
    }
    await expect(page.locator('#import-candidates')).toContainText('다음 회원');
    await expect(page.locator('#import-candidates')).not.toContainText('처음 회원');
    await expect(page.locator('#dialog-message')).toBeHidden();
    await page.locator('#commit-import').click();
    await expect(page.locator('#import-preview-status')).toContainText('반영됨');
    await page.locator('#import-dialog .close-dialog').first().click();
    await expect(page.locator('#enrollment-rows')).toContainText('다음 회원');
    await expect(page.locator('#enrollment-rows')).not.toContainText('처음 회원');
  });
}

test('an administrator retries a failed Excel save and cannot submit the same review twice while saving', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
  const buffer = await app.completeEnrollmentTemplate(await readFile(await download.path()), [['과거 학기', '김가나', '창세기']]);
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let saved;
  const committed = new Promise((resolve) => { saved = resolve; });
  let commits = 0;
  await page.route('**/api/v1/imports/*/commit', async (route) => {
    const request = ++commits;
    if (request === 1) {
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({
        code: 'UNAVAILABLE', message: '잠시 후 다시 시도하세요.', issues: [],
      }) });
      return;
    }
    const response = await route.fetch();
    if (request === 2) { saved(); await delayed; }
    await route.fulfill({ response });
  });
  try {
    await page.locator('#enrollments-view .import-open').click();
    await page.locator('#import-form [name="file"]').setInputFiles({ name: '명단.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
    await page.getByRole('button', { name: '파일 검토', exact: true }).click();
    const commit = page.locator('#commit-import');
    await commit.click();
    await expect(page.locator('#dialog-message')).toContainText('잠시 후 다시 시도하세요.');
    await expect(commit).toBeEnabled();
    await commit.dblclick();
    await committed;
    await expect(commit).toBeDisabled();
    const receipt = page.waitForResponse('**/api/v1/imports/*/commit');
    release();
    await receipt;
    await expect(page.locator('#shutdown')).toBeEnabled();
    await expect(page.locator('#save-status')).toHaveText('저장됨');
    await expect(page.locator('#import-preview-status')).toContainText('반영됨');
    await expect(page.locator('#dialog-message')).toContainText('Excel 자료를 반영했습니다.');
    expect(commits).toBe(2);
    await page.locator('#import-dialog .close-dialog').first().click();
    await expect(page.locator('#enrollment-rows tr')).toHaveCount(1);
    await expect(page.locator('#enrollment-rows')).toContainText('김가나');
  } finally {
    release();
  }
});

test('an administrator reviews another file while an earlier commit response is delayed', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
  const template = await readFile(await download.path());
  const files = [];
  for (const member of ['처음 회원', '다음 회원']) {
    const buffer = await app.completeEnrollmentTemplate(template, [['과거 학기', member, '창세기']]);
    files.push({ name: `${member}.xlsx`, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  }
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  let firstCommitted;
  const committed = new Promise((resolve) => { firstCommitted = resolve; });
  let commits = 0;
  await page.route('**/api/v1/imports/*/commit', async (route) => {
    const first = commits++ === 0;
    const response = await route.fetch();
    if (first) { firstCommitted(); await delayed; }
    await route.fulfill({ response });
  });
  await page.locator('#enrollments-view .import-open').click();
  await page.getByRole('checkbox', { name: '입력 경고 무시' }).check();
  const file = page.locator('#import-form [name="file"]');
  const review = page.getByRole('button', { name: '파일 검토', exact: true });
  await file.setInputFiles(files[0]);
  await review.click();
  await expect(page.locator('#import-candidates')).toContainText('처음 회원');
  await page.locator('#commit-import').click();
  await committed;
  await file.setInputFiles(files[1]);
  await review.click();
  await expect(page.locator('#import-candidates')).toContainText('다음 회원');
  const lateReceipt = page.waitForResponse('**/api/v1/imports/*/commit');
  release();
  await lateReceipt;
  await expect(page.locator('#shutdown')).toBeEnabled();
  await expect(page.locator('#import-preview-status')).toContainText('아직 저장되지 않음');
  await expect(page.locator('#commit-import')).toBeEnabled();
  await expect(page.locator('#dialog-message')).toBeHidden();
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-preview-status')).toContainText('반영됨');
  await page.locator('#import-dialog .close-dialog').first().click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await expect(page.locator('#enrollment-rows')).toContainText('처음 회원');
  await expect(page.locator('#enrollment-rows')).toContainText('다음 회원');
});

test('an administrator reads a one-line review notice and its full tooltip on a narrow screen', async ({ page, app }) => {
  await page.setViewportSize({ width: 560, height: 900 });
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#enrollment-template').click()]);
  const buffer = await app.completeEnrollmentTemplate(await readFile(await download.path()), [['과거 학기', '김가나', '창세기']]);
  await page.locator('#enrollments-view .import-open').click();
  await page.locator('#import-form [name="file"]').setInputFiles({ name: '명단.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await page.getByRole('button', { name: '파일 검토', exact: true }).click();
  const notice = page.locator('#import-issues li.information').filter({ hasText: '정원은 이번에 등록하는 학생 수' });
  await expect(notice).toBeVisible();
  const lineCount = await notice.evaluate((item) => {
    const text = [...item.childNodes].find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()) ?? item.querySelector('span');
    const range = document.createRange();
    range.selectNodeContents(text);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  expect(lineCount).toBe(1);
  const text = notice.locator('[title]');
  await expect(text).toHaveAttribute('title', await text.textContent());
  const dismiss = notice.getByRole('button', { name: /닫기$/ });
  await expect(dismiss).toBeVisible();
  await dismiss.click();
  await expect(notice).toHaveCount(0);
});

test('an administrator registers multiple historical enrollments without applications or catalog setup', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#new-enrollment').click();
  await page.locator('#add-enrollment-entry').click();
  for (const [index, memberName, courseName] of [[0, '김가나', '창세기'], [1, '박다라', '마태복음']]) {
    const row = page.locator('#enrollment-entry-rows > fieldset').nth(index);
    await row.locator('[name="semesterName"]').fill('과거 학기');
    await row.locator('[name="memberName"]').fill(memberName);
    await row.locator('[name="newCourseName"]').fill(courseName);
  }
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#warning-dialog')).toBeVisible();
  await expect(page.locator('#warning-list')).toContainText('학기 순서');
  await expect(page.locator('#warning-list')).toContainText('정원');
  await page.locator('#warning-form [name="note"]').fill('과거 이력의 학기와 강좌 정보를 확인했습니다.');
  await page.locator('#warning-form [type="submit"]').click();
  await expect(page.locator('#enrollment-dialog')).toBeHidden();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await expect(page.locator('#enrollment-rows')).toContainText('김가나');
  await expect(page.locator('#enrollment-rows')).toContainText('박다라');
  await page.locator('#enrollment-rows tr').filter({ hasText: '김가나' }).getByRole('button', { name: '수정' }).click();
  await expect(page.locator('#enrollment-entry-rows > fieldset')).toHaveCount(1);
  await expect(page.locator('#add-enrollment-entry')).toBeHidden();
  const editNote = page.locator('#enrollment-form [name="adminNote"]');
  await expect(editNote).toHaveValue('과거 이력의 학기와 강좌 정보를 확인했습니다.');
  await editNote.fill('수정 창에서 강좌 변경 메모를 작성했습니다.');
  await page.locator('#enrollment-entry-rows [name="courseId"]').selectOption({ label: '마태복음' });
  await expect(page.locator('#enrollment-entry-rows [name="newCourseName"]')).toBeHidden();
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#warning-dialog')).toBeVisible();
  await expect(page.locator('#warning-form [name="note"]')).toHaveValue('수정 창에서 강좌 변경 메모를 작성했습니다.');
  await page.locator('#cancel-warning').click();
  await expect(editNote).toHaveValue('수정 창에서 강좌 변경 메모를 작성했습니다.');
  await expect(page.locator('#enrollment-rows tr').filter({ hasText: '김가나' }).locator('.enrollment-note p'))
    .toHaveText('과거 이력의 학기와 강좌 정보를 확인했습니다.');
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#warning-dialog')).toBeVisible();
  await page.locator('#warning-form [name="note"]').fill('기존 수강이력의 강좌를 확인했습니다.');
  await page.locator('#warning-form [type="submit"]').click();
  await expect(page.locator('#enrollment-dialog')).toBeHidden();
  await expect(page.locator('#enrollment-rows tr').filter({ hasText: '김가나' })).toContainText('마태복음');
  await expect(page.locator('#enrollment-rows tr').filter({ hasText: '김가나' }).locator('.enrollment-note p'))
    .toHaveText('기존 수강이력의 강좌를 확인했습니다.');
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('과거 학기');
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '과거 학기' });
  await expect(page.locator('#catalog-course-rows [name="courseName"]')).toHaveCount(2);
  expect((await page.locator('#catalog-course-rows [name="courseName"]').evaluateAll((inputs) => inputs.map((input) => input.value))).sort()).toEqual(['마태복음', '창세기']);
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#enrollment-semester-filter').selectOption({ label: '과거 학기' });
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  page.once('dialog', (dialog) => { void dialog.dismiss(); });
  await page.locator('#enrollment-rows tr').filter({ hasText: '박다라' }).getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.locator('#enrollment-rows tr').filter({ hasText: '박다라' }).getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(1);
  await expect(page.locator('#enrollment-rows')).not.toContainText('박다라');
  page.once('dialog', (dialog) => { void dialog.accept('다른 학기'); });
  await page.locator('#delete-semester-enrollments').click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(1);
  await expect(page.locator('#message')).toContainText('학기명이 일치하지 않아 삭제하지 않았습니다');
  page.once('dialog', (dialog) => { void dialog.accept('과거 학기'); });
  await page.locator('#delete-semester-enrollments').click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(0);
  await expect(page.locator('#enrollment-count')).toHaveText('0');
});

test('an administrator deletes every application in the selected semester after confirming its name and count', async ({ page, app }) => {
  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  const remove = page.getByRole('button', { name: '선택 학기 신청 전체 삭제', exact: true });
  await expect(remove).toBeDisabled();
  await page.locator('#new-application').click();
  for (let index = 0; index < 13; index++) {
    if (index > 0) await page.locator('#add-application-entry').click();
    const entry = page.locator('#application-entry-rows > fieldset').nth(index);
    await entry.locator('[name="semesterName"]').fill(index === 12 ? '다른 학기' : '삭제 학기');
    await entry.locator('[name="memberName"]').fill(index === 11 ? '숨김 회원' : `신청 회원 ${index}`);
    await entry.locator('[name="applicationOrder"]').fill(String(index === 12 ? 1 : index + 1));
    await entry.locator('[name="courseName"]').fill(index === 11 ? '마태복음' : '창세기');
  }
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-dialog')).toBeHidden();
  const semester = page.locator('#application-semester-filter');
  await semester.selectOption('');
  await expect(remove).toBeDisabled();
  await semester.selectOption({ label: '삭제 학기' });
  await page.locator('#application-member-search').fill('신청 회원');
  await page.locator('#application-course-filter').selectOption({ label: '창세기' });
  await page.locator('#application-page-size').selectOption('10');
  await expect(page.locator('#application-count')).toHaveText('11');
  await page.locator('#application-next-page').click();
  await expect(page.locator('#application-rows tr')).toHaveCount(1);
  await expect(page.locator('#application-page-status')).toHaveText('11–11 / 총 11건');
  const deletionRequests = [];
  page.on('request', (request) => {
    if (request.method() === 'DELETE' && request.url().endsWith('/applications')) deletionRequests.push(request.url());
  });
  const canceledPreview = page.waitForEvent('dialog');
  await remove.click();
  const canceledDialog = await canceledPreview;
  expect(canceledDialog.message()).toContain('삭제 학기의 수강신청 12건');
  await canceledDialog.dismiss();
  await expect(page.locator('#application-rows tr')).toHaveCount(1);
  const mismatchedPreview = page.waitForEvent('dialog');
  await remove.click();
  await (await mismatchedPreview).accept('다른 학기');
  await expect(page.locator('#message')).toContainText('학기명이 일치하지 않아 삭제하지 않았습니다');
  expect(deletionRequests).toEqual([]);
  const confirmedPreview = page.waitForEvent('dialog');
  await remove.click();
  await (await confirmedPreview).accept('삭제 학기');
  await expect(page.locator('#message')).toContainText('삭제 학기 수강신청 12건을 삭제했습니다.');
  await expect(page.locator('#application-count')).toHaveText('0');
  await expect(page.locator('#application-rows tr')).toHaveCount(0);
  await expect(page.locator('#application-page-status')).toHaveText('총 0건');
  await expect(page.locator('#application-previous-page')).toBeDisabled();
  expect(deletionRequests).toHaveLength(1);
  await remove.click();
  await expect(page.locator('#message')).toContainText('삭제할 수강신청이 없습니다.');
  expect(deletionRequests).toHaveLength(1);
  await semester.selectOption({ label: '다른 학기' });
  await expect(page.locator('#application-rows tr')).toHaveCount(1);
  await expect(page.locator('#application-rows')).toContainText('신청 회원 12');
});

test('an administrator registers applications, reviews allocation, and sees saved enrollment history', async ({ page, app }) => {
  await expect(page.getByRole('heading', { name: '업무 대시보드' })).toBeVisible();
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('2026 가을');
  await page.locator('#semester-create-form [type="submit"]').click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('2026 가을');

  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '2026 가을' });
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 3');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr')).toHaveAttribute('data-id', /.+/);
  await expect(page.locator('#catalog-course-rows [name="courseName"]')).toHaveValue('창세기');

  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#new-application').click();
  await page.locator('#add-application-entry').click();
  for (const [index, name] of ['김가나', '박다라'].entries()) {
    const row = page.locator('#application-entry-rows > fieldset').nth(index);
    await row.locator('[name="semesterName"]').fill('2026 가을');
    await row.locator('[name="memberName"]').fill(name);
    await row.locator('[name="applicationOrder"]').fill(String(index + 1));
    await row.locator('[name="courseName"]').fill('창세기');
  }
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-rows tr')).toHaveCount(2);

  await page.locator('#application-rows tr').first().getByRole('button', { name: '수정' }).click();
  await expect(page.locator('#application-entry-rows > fieldset')).toHaveCount(1);
  await page.locator('#application-entry-rows [name="memberName"]').fill('김가나 수정');
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-rows')).toContainText('김가나 수정');

  await page.locator('#new-application').click();
  const temporary = page.locator('#application-entry-rows > fieldset');
  await temporary.locator('[name="semesterName"]').fill('2026 가을');
  await temporary.locator('[name="memberName"]').fill('임시 회원');
  await temporary.locator('[name="applicationOrder"]').fill('3');
  await temporary.locator('[name="courseName"]').fill('창세기');
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-rows tr')).toHaveCount(3);
  page.once('dialog', (dialog) => { void dialog.accept(); });
  await page.locator('#application-rows tr').filter({ hasText: '임시 회원' }).getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('#application-rows tr')).toHaveCount(2);

  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '2026 가을' });
  await page.locator('#draft-create-form [type="submit"]').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(2);
  await expect(page.locator('#draft-item-rows tr').first()).toContainText('김가나 수정');
  const changedRow = page.locator('#draft-item-rows tr').filter({ hasText: '김가나 수정' });
  await changedRow.getByRole('combobox', { name: '김가나 수정 최종 배정' }).selectOption('');
  await changedRow.getByRole('button', { name: '저장' }).click();
  await expect(changedRow).toHaveClass(/draft-row-changed/);
  await expect(changedRow.getByRole('combobox', { name: '김가나 수정 최종 배정' })).toHaveValue('');
  await changedRow.getByRole('button', { name: '자동 복원' }).click();
  await expect(changedRow).not.toHaveClass(/draft-row-changed/);
  await expect(changedRow.getByRole('combobox', { name: '김가나 수정 최종 배정' })).not.toHaveValue('');
  await expect(page.getByRole('group', { name: '신청 없는 회원 추가' })).toHaveCount(0);
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(2);
  await expect(page.locator('#draft-item-rows')).not.toContainText('임시 회원');
  await page.locator('#preview-finalization').hover();
  await expect(page.locator('#preview-finalization')).toHaveAttribute('title', '저장된 최종 결정의 경고와 강좌별 인원을 확인하는 확정 검토 창을 엽니다.');
  await page.locator('#preview-finalization').click();
  await expect(page.getByRole('heading', { name: '배정 확정 검토', exact: true })).toBeVisible();
  await expect(page.locator('#finalize-add-count')).toHaveText('2');
  await expect(page.locator('#draft-rows tr')).toHaveCount(1);
  await page.locator('#finalize-form [name="note"]').fill('   ');
  await page.locator('#finalize-draft').click();
  await expect(page.locator('#draft-rows tr')).toHaveCount(0);

  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await expect(page.locator('#enrollment-rows')).toContainText('김가나 수정');
  await expect(page.locator('#enrollment-rows')).toContainText('박다라');
  await expect(page.locator('#enrollment-rows')).not.toContainText('임시 회원');
  await expect(page.locator('#enrollment-rows .enrollment-note')).toHaveText(['—', '—']);
  await expect(page.locator('#enrollment-report-task')).toBeVisible();
  const [enrollmentReport] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#complete-enrollment-report').click(),
  ]);
  expect(enrollmentReport.suggestedFilename()).toMatch(/^수강이력_현황_\d{12}\.xlsx$/);
  await expect(page.locator('#enrollment-report-task')).toBeHidden();
  await page.getByRole('link', { name: 'Glorycourse 홈으로 이동' }).click();
  await expect(page.getByRole('heading', { name: '업무 대시보드' })).toBeVisible();
  await expect(page.locator('#dashboard-enrollment-count')).toHaveText('2');
  await expect(page.locator('#dashboard-next-title')).toHaveText('현재 학기 업무가 완료되었습니다');
  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '수강이력' })).toBeVisible();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await page.getByRole('button', { name: '수강이력 사용 방법' }).click();
  await expect(page.locator('#help-dialog')).toBeVisible();
  await expect(page.locator('#help-dialog')).toContainText('수강신청이나 배정초안이 없어도');
  await page.locator('#help-dialog').getByRole('button', { name: '닫기' }).click();
  await expect(page.locator('#help-dialog')).toBeHidden();
});

test('an administrator sees full courses and live capacity while changing final assignments', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('정원 검토 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '정원 검토 학기' });
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('찬 강좌, 2\n남은 강좌, 2');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr').first()).toHaveAttribute('data-id', /.+/);

  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await page.locator('#new-enrollment').click();
  await page.locator('#enrollment-entry-rows [name="semesterName"]').fill('정원 검토 학기');
  await page.locator('#enrollment-entry-rows [name="memberName"]').fill('기존 회원');
  await page.locator('#enrollment-entry-rows [name="courseId"]').selectOption({ label: '찬 강좌' });
  await page.locator('#enrollment-form [type="submit"]').click();
  await expect(page.locator('#enrollment-dialog')).toBeHidden();

  await page.getByRole('button', { name: '수강신청', exact: true }).click();
  await page.locator('#new-application').click();
  await page.locator('#add-application-entry').click();
  for (const [index, courseName] of ['찬 강좌', '남은 강좌'].entries()) {
    const row = page.locator('#application-entry-rows > fieldset').nth(index);
    await row.locator('[name="semesterName"]').fill('정원 검토 학기');
    await row.locator('[name="memberName"]').fill(`신청 회원 ${index + 1}`);
    await row.locator('[name="applicationOrder"]').fill(String(index + 1));
    await row.locator('[name="courseName"]').fill(courseName);
  }
  await page.locator('#application-form [type="submit"]').click();
  await expect(page.locator('#application-dialog')).toBeHidden();
  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '정원 검토 학기' });
  await page.locator('#draft-create-form [type="submit"]').click();

  const fullCourse = page.locator('#draft-capacity-rows tr').filter({ hasText: '찬 강좌' });
  const availableCourse = page.locator('#draft-capacity-rows tr').filter({ hasText: '남은 강좌' });
  await expect(fullCourse.locator('td')).toHaveText(['찬 강좌', '1', '1', '2 / 2명', '0명', '정원 마감']);
  await expect(availableCourse.locator('td')).toHaveText(['남은 강좌', '0', '1', '1 / 2명', '1명', '잔여 1명']);
  const row = page.locator('#draft-item-rows tr').filter({ hasText: '신청 회원 2' });
  const select = row.getByRole('combobox');
  await select.focus();
  const fullOption = select.locator('option').filter({ hasText: '찬 강좌' });
  await expect(fullOption).toHaveText('찬 강좌 · 2/2명 · 정원 마감');
  const fullId = await fullOption.getAttribute('value');
  const availableId = await select.inputValue();
  const choices = [
    { value: fullId, total: '3 / 2명', status: '정원 초과 1명', availableTotal: '0 / 2명' },
    { value: '', total: '2 / 2명', status: '정원 마감', availableTotal: '0 / 2명' },
    { value: availableId, total: '2 / 2명', status: '정원 마감', availableTotal: '1 / 2명' },
  ];
  for (const { value, total, status, availableTotal } of choices) {
    await select.selectOption(value);
    await expect(fullCourse.locator('td').nth(3)).toHaveText(total);
    await expect(fullCourse.locator('td').last()).toHaveText(status);
    await expect(availableCourse.locator('td').nth(3)).toHaveText(availableTotal);
  }
  await select.selectOption(fullId);
  await expect(page.locator('#draft-capacity-status')).toContainText('저장 전');
  await expect(select.locator('option:checked')).toHaveText('찬 강좌 · 3/2명 · 정원 초과 1명');
  await row.getByRole('button', { name: '저장', exact: true }).click();
  await expect(page.locator('#draft-capacity-status')).not.toContainText('저장 전');
  await expect(fullCourse.locator('td').last()).toHaveText('정원 초과 1명');
  await row.getByRole('button', { name: '자동 복원' }).click();
  await expect(fullCourse.locator('td').last()).toHaveText('정원 마감');
  await expect(availableCourse.locator('td').nth(3)).toHaveText('1 / 2명');

  await page.locator('#draft-dialog .close-dialog').first().click();
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('추가 강좌, 2');
  await page.locator('#catalog-add-form [type="submit"]').click();
  await page.locator('#catalog-form [type="submit"]').click();
  await expect(page.locator('#catalog-course-rows tr[data-id]:not([data-id=""])')).toHaveCount(3);
  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#draft-rows').getByRole('button', { name: '검토', exact: true }).click();
  await expect(page.locator('#draft-stale')).toBeVisible();
  await select.focus();
  const newOption = select.locator('option').filter({ hasText: '추가 강좌' });
  await expect(newOption).toHaveText('추가 강좌 · 현황 미확인 · 새 초안 필요');
  await select.selectOption(await newOption.getAttribute('value'));
  const addedCourse = page.locator('#draft-capacity-rows tr').filter({ hasText: '추가 강좌' });
  await expect(addedCourse.locator('td')).toHaveText(['추가 강좌', '미확인', '1', '미확인', '미확인', '현황 미확인 · 새 초안 필요']);
});

test('draft review pages large results and loads course choices only when editing a row', async ({ page, app }) => {
  await app.seedLarge();
  await page.reload();
  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '검증 학기' });
  await page.locator('#draft-create-form [type="submit"]').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(50);
  await expect(page.locator('#draft-item-page-status')).toContainText('1–50 / 총 500건');
  await expect(page.locator('#draft-capacity-rows tr')).toHaveCount(100);
  const firstCourse = page.locator('#draft-capacity-rows tr').filter({ hasText: /^강좌 0/ });
  await expect(firstCourse.locator('td')).toHaveText(['강좌 0', '0', '5', '5 / 500명', '495명', '잔여 495명']);
  await expect(page.locator('#draft-item-rows select option')).toHaveCount(100);
  await page.locator('#draft-item-rows select').first().focus();
  await expect(page.locator('#draft-item-rows select').first().locator('option')).toHaveCount(101);
  await page.locator('#draft-item-rows select').nth(30).focus();
  for (let step = 0; step < 40; step++) {
    await page.keyboard.press('Shift+Tab');
    const focused = await page.locator(':focus').boundingBox();
    const overview = await page.locator('.draft-capacity').boundingBox();
    expect(focused.y).toBeGreaterThanOrEqual(overview.y + overview.height);
  }
  await page.locator('#draft-item-next-page').click();
  await expect(page.getByRole('heading', { name: '강좌별 정원 현황', exact: true })).toBeInViewport();
  await expect(page.locator('#draft-item-rows tr').first()).toContainText('회원 50');
  await page.locator('#draft-search').fill('회원 499');
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(1);
  await expect(page.locator('#draft-item-page-status')).toContainText('1–1 / 총 1건');
  await expect(firstCourse.locator('td').nth(3)).toHaveText('5 / 500명');
  await page.locator('#draft-item-rows details').first().locator('summary').click();
  await expect(page.locator('#draft-item-rows details li')).toHaveCount(1);
});
