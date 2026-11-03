import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('私聊主动许可默认关闭，群聊/私聊概率独立保存，0和刷新不丢失；窄屏可用', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  // 聊天设置会读取QQ群/好友选择器；此用例不连接真实OneBot。
  await page.route('**/api/onebot/groups', (route) => route.fulfill({ json: { groups: [] } }));
  await page.route('**/api/onebot/friends', (route) => route.fulfill({ json: { friends: [] } }));
  const previous = (await (await page.request.get('/api/config')).json()).proactive;
  const read = async () => (await (await page.request.get('/api/config')).json()).proactive;
  await page.request.post('/api/config', { data: { proactive: { nonAdminPrivateEnabled: false, probability: 0.25, privateProbability: 0.05 } } });
  try {
    await page.goto('/'); await switchTo(page, 'settings');
    await page.click('.settings-menu-item[data-section="chat"]');
    await expect(page.locator('#cfg-pro-private-non-admin')).not.toBeChecked();
    await expect(page.locator('#cfg-pro-private-prob')).toHaveValue('5');
    await page.locator('#cfg-pro-prob').fill('71');
    await page.locator('#cfg-pro-private-prob').fill('0');
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    await expect.poll(async () => (await read()).privateProbability).toBe(0);
    expect((await read()).probability).toBe(0.71);
    expect((await read()).nonAdminPrivateEnabled).toBe(false);
    await page.reload(); await switchTo(page, 'settings');
    await page.click('.settings-menu-item[data-section="chat"]');
    await expect(page.locator('#cfg-pro-private-prob')).toHaveValue('0');
    await page.locator('#cfg-pro-prob').fill('0');
    await page.locator('#cfg-pro-private-prob').fill('13');
    await page.locator('#cfg-pro-private-non-admin').check();
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    await expect.poll(async () => (await read()).privateProbability).toBe(0.13);
    expect((await read()).probability).toBe(0);
    expect((await read()).nonAdminPrivateEnabled).toBe(true);
    fs.mkdirSync('_staging', { recursive: true });
    await page.locator('#cfg-pro-private-prob').evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: '_staging/private-proactive-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cfg-pro-private-prob').evaluate((node) => node.scrollIntoView({ block: 'center' }));
    await expect.poll(() => page.locator('#view-settings').evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: '_staging/private-proactive-mobile.png', fullPage: true });
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/config', { data: { proactive: previous } });
  }
});
