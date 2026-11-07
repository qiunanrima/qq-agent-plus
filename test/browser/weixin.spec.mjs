/* global document, innerWidth */
import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('微信独立页面、扫码状态和窄屏身份绑定视图', async ({ page }) => {
  const errors = collectPageErrors(page);
  expect((await page.request.get('/api/weixin/status')).status()).toBe(401);
  await login(page);
  await page.request.post('/api/config', { data: { weixin: { enabled: false, graduated: false } } });
  await page.route('**/api/weixin/status', route => route.fulfill({ json: { enabled: false, running: false, unknownSends: 1,
    account: { id: 'bot' }, peers: [{ id: 'a'.repeat(64), userId: 'verylong-weixin-user-id@wechat'.repeat(3), enabled: true,
      nativeApproval: false, qqId: '12345', summary: '<img src=x onerror=alert(1)>' }], runs: [] } }));
  await page.route('**/api/weixin/login', route => route.fulfill({ json: { id: 'login', qrcodeDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6aUAAAAASUVORK5CYII=' } }));
  await page.route('**/api/weixin/login/login', route => route.fulfill({ json: { status: 'need_verifycode' } }));
  await page.goto('/'); await switchTo(page, 'settings');
  await page.click('button[data-section="experiments"]');
  await expect(page.locator('#wx-peers')).toHaveCount(0);
  await page.click('#wx-open');
  await expect(page.locator('#wx-status')).toContainText('未确认发送 1');
  await expect(page.locator('[data-wx-native]')).not.toBeChecked();
  await expect(page.locator('#wx-peers img')).toHaveCount(0);
  await page.click('#wx-login'); await page.click('#wx-poll');
  await expect(page.locator('#wx-login-status')).toContainText('验证码');
  fs.mkdirSync('.codex/weixin-ui', { recursive: true });
  await page.screenshot({ path: '.codex/weixin-ui/desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-wx-save]').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  await page.screenshot({ path: '.codex/weixin-ui/mobile.png' });
  expect(errors).toEqual([]);
});
