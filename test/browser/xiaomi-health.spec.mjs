/* global document, window */
import { test, expect } from '@playwright/test';
import { E2E_PLUGIN_ID } from './constants.mjs';
import { collectPageErrors, login, switchTo } from './helpers.mjs';

test('健康扫码沿用插件详情，展示服务提示及五分钟有效期，桌面/窄屏可用', async ({ page }, testInfo) => {
  const errors = collectPageErrors(page);
  let requests = 0;
  await page.route('**/api/plugins/call', route => { requests++; return route.fulfill({ json: {
    ok: true, channel: 'console', expiresIn: 300,
    note: '用小米运动健康 App 扫码并确认登录，仅支持中国区账号。',
    qrcodeDataUrl: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="white"/><rect x="10" y="10" width="80" height="80" fill="black"/></svg>').toString('base64')
  } }); });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await page.click('[data-plugin-pane="installed"]');
  await page.locator(`[data-plugin-open="${E2E_PLUGIN_ID}"]`).first().click();
  const block = page.locator(`[data-pd-settings="${E2E_PLUGIN_ID}"]`);
  await expect(block).toBeVisible();
  await block.locator('[data-pd-qr-login]').click();
  await expect(block.locator('.pd-qr-title')).toContainText('小米运动健康 App');
  await expect(block.locator('[data-pd-qr-status]')).toContainText('5 分钟');
  await expect(block.locator('.pd-qr-img')).toBeVisible();
  await block.locator('.pd-qr-img').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('health-qr-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(block.locator('.pd-qr-img')).toBeVisible();
  await block.locator('.pd-qr-img').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('health-qr-mobile.png'), fullPage: true });
  await block.locator('[data-pd-qr-stop]').click();
  const stoppedAt = requests;
  await page.waitForTimeout(3500);
  expect(requests).toBe(stoppedAt);
  expect(errors).toEqual([]);
});
