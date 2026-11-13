import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('最近聊天预算与遗忘开关独立保存，刷新回显，桌面和窄屏可用', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.route('**/api/onebot/groups', route => route.fulfill({ json: { groups: [] } }));
  await page.route('**/api/onebot/friends', route => route.fulfill({ json: { friends: [] } }));
  const previous = await (await page.request.get('/api/config')).json();
  const open = async section => {
    await page.goto('/'); await switchTo(page, 'settings');
    await page.click(`.settings-menu-item[data-section="${section}"]`);
  };
  try {
    await open('chat');
    await page.locator('#cfg-history-window').check();
    await page.locator('#cfg-history-count').fill('70');
    await page.locator('#cfg-history-chars').fill('9000');
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    await open('chat');
    await expect(page.locator('#cfg-history-count')).toHaveValue('70');
    await expect(page.locator('#cfg-history-chars')).toHaveValue('9000');
    fs.mkdirSync('_staging', { recursive: true });
    await page.locator('#cfg-history-count').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '_staging/memory-window-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#cfg-history-count').scrollIntoViewIfNeeded();
    expect(await page.locator('#view-settings').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: '_staging/memory-window-mobile.png' });
    await open('memory');
    await page.locator('#cfg-mem-forgetting').uncheck();
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    await open('memory');
    await expect(page.locator('#cfg-mem-forgetting')).not.toBeChecked();
    await page.locator('#cfg-mem-forgetting').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await page.screenshot({ path: '_staging/memory-forgetting-mobile.png' });
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/config', { data: { memory: previous.memory, store: previous.store } });
  }
});
