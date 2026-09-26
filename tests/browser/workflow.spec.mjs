import { mkdtemp, rm } from 'node:fs/promises';
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

  await page.getByRole('button', { name: '배정초안', exact: true }).click();
  await page.locator('#new-draft').click();
  await page.locator('#draft-create-form [name="semesterId"]').selectOption({ label: '2026 가을' });
  await page.locator('#draft-create-form [type="submit"]').click();
  await expect(page.locator('#draft-item-rows tr')).toHaveCount(2);
  await expect(page.locator('#draft-item-rows tr').first()).toContainText('김가나');
  await page.locator('#preview-finalization').click();
  await page.locator('#finalize-form [name="note"]').fill('신청과 정원을 확인했습니다.');
  await page.locator('#finalize-draft').click();
  await expect(page.locator('#draft-rows tr')).toHaveCount(0);

  await page.getByRole('button', { name: '수강이력', exact: true }).click();
  await expect(page.locator('#enrollment-rows tr')).toHaveCount(2);
  await expect(page.locator('#enrollment-rows')).toContainText('김가나');
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
