/* global document, innerWidth */
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';
test('model fallback lifecycle and order persist on narrow screens', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.request.post('/api/config', { data: { modelFallback: { enabled: false, graduated: false, order: ['agy', 'codex', 'api'] }, codexCli: { enabled: false }, antigravityCli: { enabled: false } } });
  await page.goto('/'); await switchTo(page, 'settings');
  await page.getByRole('button', { name: '实验功能', exact: true }).click();
  await page.locator('#model-fallback-toggle').click();
  await expect(page.locator('#model-fallback-toggle')).toHaveText('停用');
  await page.locator('#model-fallback-open').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-fallback-move="2"][data-direction="-1"]').click();
  await expect(page.locator('#model-fallback-order')).toContainText('2. api');
  const cfg = await (await page.request.get('/api/config')).json();
  expect(cfg.modelFallback.order).toEqual(['agy', 'api', 'codex']);
  await page.reload(); await switchTo(page, 'settings');
  await page.getByRole('button', { name: '实验功能', exact: true }).click();
  await page.locator('#model-fallback-open').click();
  await expect(page.locator('#model-fallback-order')).toContainText('2. api');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2)).toBe(true);
  expect(errors).toEqual([]);
});
