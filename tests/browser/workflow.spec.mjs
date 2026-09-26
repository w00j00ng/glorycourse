import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
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
        backupFile: async () => join(dataDirectory, 'backups', (await readdir(join(dataDirectory, 'backups')))[0]),
        completeApplicationTemplate: async (bytes) => {
          child.send({ type: 'complete-template', bytes: bytes.toString('base64') });
          const [result] = await once(child, 'message', { signal: AbortSignal.timeout(20_000) });
          if (result.type !== 'template-completed') throw new Error(result.message);
          return { ...result, buffer: Buffer.from(result.bytes, 'base64') };
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

test('an administrator reuses an unchanged backup and restores its reviewed data', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('원래 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('원래 학기');

  await page.getByRole('button', { name: '자료 관리', exact: true }).click();
  await page.locator('#create-backup').click();
  await expect(page.locator('#backup-count')).toHaveText('1');
  const backupFile = await app.backupFile();
  await page.locator('#create-backup').click();
  await expect(page.locator('#backup-count')).toHaveText('1');

  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('복원으로 제거할 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('복원으로 제거할 학기');

  await page.getByRole('button', { name: '자료 관리', exact: true }).click();
  await page.locator('#open-restore').click();
  await page.locator('#restore-form [name="file"]').setInputFiles(backupFile);
  await page.locator('#restore-submit').click();
  await expect(page.locator('#restore-preview')).toBeVisible();
  await expect(page.locator('#restore-current-revision')).toHaveText('2');
  await expect(page.locator('#restore-backup-revision')).toHaveText('1');
  await page.locator('#restore-form [name="note"]').fill('백업 이후 추가한 학기가 제거됨을 확인했습니다.');
  await page.locator('#restore-submit').click();
  await expect(page.locator('#restore-dialog')).toBeHidden();

  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('원래 학기');
  await expect(page.locator('#catalog-semester-rows')).not.toContainText('복원으로 제거할 학기');
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

test('an administrator reviews a completed application template before importing it', async ({ page, app }) => {
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await page.locator('#new-semester').click();
  await page.locator('#semester-create-form [name="name"]').fill('양식 학기');
  await page.locator('#semester-create-form [type="submit"]').click();
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '양식 학기' });
  await page.locator('#add-catalog-course').click();
  await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 2');
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

  await page.locator('#applications-view .import-open').click();
  await page.locator('#import-form [name="file"]').setInputFiles({
    name: '수강신청.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: completed.buffer,
  });
  await page.locator('#import-preview-action [type="submit"]').click();
  await expect(page.locator('#import-source-count')).toHaveText('1');
  await expect(page.locator('#import-insert-count')).toHaveText('1');
  await expect(page.locator('#application-rows tr')).toHaveCount(0);
  await page.locator('#commit-import').click();
  await expect(page.locator('#import-preview-status')).toContainText('반영됨');
  await page.locator('#import-dialog .close-dialog').first().click();
  await expect(page.locator('#application-rows tr')).toHaveCount(1);
  await expect(page.locator('#application-rows')).toContainText('양식 회원');
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
  await page.getByRole('button', { name: '학기·강좌 관리', exact: true }).click();
  await expect(page.locator('#catalog-semester-rows')).toContainText('과거 학기');
  await page.locator('[data-catalog-tab="courses"]').click();
  await page.locator('#catalog-semester').selectOption({ label: '과거 학기' });
  await expect(page.locator('#catalog-course-rows [name="courseName"]')).toHaveCount(2);
  expect((await page.locator('#catalog-course-rows [name="courseName"]').evaluateAll((inputs) => inputs.map((input) => input.value))).sort()).toEqual(['마태복음', '창세기']);
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
  await page.locator('#catalog-add-form [name="courses"]').fill('창세기, 2');
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
  await page.locator('#preview-finalization').click();
  await page.locator('#finalize-form [name="note"]').fill('   ');
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/finalize') && response.status() === 422);
  await page.locator('#finalize-draft').click();
  await rejected;
  await expect(page.locator('#finalize-dialog')).toBeVisible();
  await expect(page.locator('#finalize-dialog #dialog-message')).toContainText('확인 메모를 입력하고');
  await page.locator('#finalize-form [name="note"]').fill('신청과 정원을 확인했습니다.');
  await page.locator('#finalize-draft').click();
  await expect(page.locator('#draft-rows tr')).toHaveCount(0);

  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await expect(page.locator('#enrollment-rows')).toContainText('김가나 수정');
  await expect(page.locator('#enrollment-rows')).toContainText('박다라');
  await page.getByRole('link', { name: 'Glorycourse 홈으로 이동' }).click();
  await expect(page.getByRole('heading', { name: '업무 대시보드' })).toBeVisible();
  await expect(page.locator('#dashboard-enrollment-count')).toHaveText('2');
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

test('draft review pages large results and loads course choices only when editing a row', async ({ page, app }) => {
  await app.seedLarge();
  await page.reload();
  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '검증 학기' });
  await page.locator('#draft-create-form [type="submit"]').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(50);
  await expect(page.locator('#draft-item-page-status')).toContainText('1–50 / 총 500건');
  await expect(page.locator('#draft-item-rows select option')).toHaveCount(100);
  await page.locator('#draft-item-rows select').first().focus();
  await expect(page.locator('#draft-item-rows select').first().locator('option')).toHaveCount(101);
  await page.locator('#draft-item-next-page').click();
  await expect(page.locator('#draft-item-rows tr').first()).toContainText('회원 50');
  await page.locator('#draft-search').fill('회원 499');
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(1);
  await expect(page.locator('#draft-item-page-status')).toContainText('1–1 / 총 1건');
  await page.locator('#draft-item-rows details').first().locator('summary').click();
  await expect(page.locator('#draft-item-rows details li')).toHaveCount(1);
});
