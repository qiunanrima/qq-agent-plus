/* global document, innerWidth */
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('Obscura 的实验开关默认关闭，桌面和窄屏保存后回显', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  const openExperiment = async () => {
    await switchTo(page, 'settings');
    await page.locator('button[data-section="experiments"]').click();
  };

  await page.goto('/');
  await openExperiment();
  const toggle = page.locator('#web-fetch-browser-enabled');
  const status = page.locator('#web-fetch-browser-state');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(status).toHaveText('已启用 · 实验中');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await openExperiment();
  await expect(toggle).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)).toBe(false);
  await toggle.uncheck();
  await expect(status).toHaveText('已停用 · 实验中');
  expect(errors).toEqual([]);
});
