/* global document, innerWidth */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('搜索设置显示新工具名，用量合并新旧工具记录，桌面与窄屏可用', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.route('**/api/usage/stats?*', (route) => route.fulfill({ json: {
    searchCount: 7, toolCounts: { search_web: 2, web_search: 1, fetch_url: 3, web_fetch: 1 },
    totals: {}, today: {}, days: [], chats: [], models: [], recent: []
  } }));
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.locator('.settings-menu-item[data-section="search"]').click();
  const label = page.locator('label[for="cfg-websearch"]');
  await label.scrollIntoViewIfNeeded();
  await expect(label).toContainText('search_web / fetch_url');
  const checkbox = page.locator('#cfg-websearch');
  const before = await checkbox.isChecked();
  await label.click();
  expect(await checkbox.isChecked()).toBe(!before);
  await label.click();
  fs.mkdirSync('_staging', { recursive: true });
  await page.screenshot({ path: '_staging/search-tools-settings.png' });
  // 恢复勾选状态后，设置页仍可能保留编辑标记，直接重载再切页。
  await page.reload();
  await switchTo(page, 'usage');
  const sub = page.locator('[data-field="search-sub"]');
  await expect(sub).toContainText('搜索 3 次');
  await expect(sub).toContainText('抓网页 4 次');
  await page.setViewportSize({ width: 390, height: 844 });
  await sub.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '_staging/search-tools-mobile.png' });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
  expect(overflow).toBe(false);
  expect(errors).toEqual([]);
});
