/* global document, innerWidth */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('角色背景Markdown导入、独立保存、保留草稿、清除与移动端', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  // 聊天设置加载协议群列表；夹具未连接QQ，只替换无关的协议读取。
  await page.route('**/api/onebot/groups', (route) => route.fulfill({ json: { groups: [] } }));
  await page.goto('/');
  await switchTo(page, 'settings');
  await page.locator('.settings-menu-item[data-section="persona"]').click();
  const editor = page.locator('#background-content');
  await expect(editor).toBeEnabled();
  await page.locator('#background-file').setInputFiles({ name: '角色背景.md', mimeType: 'text/markdown',
    buffer: Buffer.from('# 角色往事\n曾在白玉楼等待春天。\n## 人物关系\n妖梦照看庭院。') });
  await expect(editor).toHaveValue(/白玉楼/);
  await page.locator('#background-save').click();
  await expect(page.locator('#background-status')).toContainText('已保存');
  await page.reload();
  await switchTo(page, 'settings');
  await page.locator('.settings-menu-item[data-section="persona"]').click();
  await expect(editor).toHaveValue(/妖梦/);
  await expect(page.locator('#background-index')).toContainText('人物关系');
  await editor.fill('# 未保存的草稿\n新的背景');
  await page.locator('.settings-menu-item[data-section="chat"]').click();
  await page.locator('.settings-menu-item[data-section="persona"]').click();
  await expect(editor).toHaveValue(/未保存的草稿/);
  await expect(page.locator('#background-status')).toContainText('未保存');
  await page.locator('#background-save').click();
  await expect(page.locator('#background-status')).toContainText('已保存');
  fs.mkdirSync('_staging', { recursive: true });
  await page.locator('#persona-background').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '_staging/persona-background-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#background-content').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '_staging/persona-background-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)).toBe(false);
  await page.locator('#background-clear').click();
  const dialog = page.locator('.model-modal-overlay');
  await expect(dialog).toContainText('清除当前角色');
  await page.locator('[data-confirm-accept]').click();
  await expect(editor).toHaveValue('');
  await expect(page.locator('#background-status')).toContainText('已清除');
  expect(errors).toEqual([]);
});
