import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('记忆全量清除：确认范围、取消零写入、确认只发一次；桌面和窄屏布局', async ({ page }) => {
  const errors = collectPageErrors(page);
  let writes = 0;
  await page.route('**/api/memory/reset-all', async (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ confirm: true, scope: 'all', includeArchive: true });
    await route.fulfill({ json: { ok: true, paused: true, backupId: 'browser-fixture-backup' } });
  });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'people-memory');
  const button = page.locator('#gm-reset-all');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await expect(page.locator('.model-modal-body')).toContainText('聊天原始存档');
  await expect(page.locator('.model-modal-body')).toContainText('将清除：全部聊天原始存档');
  fs.mkdirSync('_staging', { recursive: true });
  await page.screenshot({ path: '_staging/memory-reset-desktop.png', fullPage: true });
  await page.locator('[data-confirm-cancel]').click();
  await expect(page.locator('[data-confirm-accept]')).toHaveCount(0);
  expect(writes).toBe(0);
  await expect(button).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await button.click();
  await page.screenshot({ path: '_staging/memory-reset-mobile.png', fullPage: true });
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('#gm-reset-status')).toContainText('browser-fixture-backup');
  expect(writes).toBe(1);
  expect(errors).toEqual([]);
});
