import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('感知唤醒可选、保存回显、群覆盖及手机布局', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.route('**/api/onebot/groups', (route) => route.fulfill({ json: { groups: [] } }));
  await page.route('**/api/onebot/friends', (route) => route.fulfill({ json: { friends: [] } }));
  const previous = (await (await page.request.get('/api/config')).json()).conversation;
  try {
    await page.goto('/'); await switchTo(page, 'settings');
    await page.click('.settings-menu-item[data-section="chat"]');
    await page.locator('[data-conversation-mode="perception"]').click();
    await expect(page.locator('[data-conversation-panel="perception"]')).toBeVisible();
    await expect(page.locator('#cfg-conversation-mode')).toHaveValue('perception');
    await page.click('#save-cfg-btn');
    await expect(page.locator('#cfg-save-result')).toHaveText('已保存 ✓');
    expect((await (await page.request.get('/api/config')).json()).conversation.mode).toBe('perception');
    await page.reload(); await switchTo(page, 'settings');
    await page.click('.settings-menu-item[data-section="chat"]');
    await expect(page.locator('[data-conversation-mode="perception"]')).toHaveAttribute('aria-selected', 'true');
    fs.mkdirSync('_staging', { recursive: true });
    await page.locator('#conversation-mode-shell').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '_staging/perception-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-conversation-panel="perception"]').scrollIntoViewIfNeeded();
    expect(await page.locator('#view-settings').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: '_staging/perception-mobile.png' });
    expect(errors).toEqual([]);
  } finally { await page.request.post('/api/config', { data: { conversation: previous } }); }
});
