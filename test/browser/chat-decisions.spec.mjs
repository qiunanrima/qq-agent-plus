import { expect, test } from '@playwright/test';
import { E2E_GROUP } from './constants.mjs';
import { collectPageErrors, login, switchTo } from './helpers.mjs';

test('会话和存档详情能展开最近决策，窄屏下重渲染仍保留展开状态', async ({ page }) => {
  const errors = collectPageErrors(page);
  const path = `/api/chats/group_${E2E_GROUP}/decisions`;
  expect((await page.request.get(path)).status()).toBe(401);
  await login(page);
  const response = await page.request.get(path);
  expect(response.ok()).toBeTruthy();
  expect((await response.json()).decisions.map((row) => row.outcome)).toEqual(['replied', 'skipped']);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await switchTo(page, 'sessions');
  await page.locator('.session-item').filter({ hasText: E2E_GROUP }).first().click();
  const sessionHistory = page.locator('#session-detail [data-chat-decisions]');
  await sessionHistory.locator('summary').click();
  await expect(sessionHistory.locator('li').first()).toContainText('已回复');
  await expect(sessionHistory.locator('li').first()).toContainText('被艾特');
  await page.locator('#json-mode-btn').click();
  await expect(sessionHistory).toHaveAttribute('open', '');
  await expect(sessionHistory.locator('li').last()).toContainText('未触发');

  await switchTo(page, 'chats');
  await page.locator(`.chat-item[data-key="group:${E2E_GROUP}"]`).click();
  const archiveHistory = page.locator('#chat-detail [data-chat-decisions]');
  await archiveHistory.locator('summary').click();
  await expect(archiveHistory.locator('li')).toHaveCount(2);
  expect(await archiveHistory.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});
