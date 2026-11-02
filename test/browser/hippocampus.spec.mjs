/* global document, innerWidth */
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('海马独立页展示摘要、长期卡片、分页、错误重试和移动端', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  let fail = false;
  await page.route('**/api/memory/hippocampus?offset=*', (route) => {
    if (fail) return route.fulfill({ status: 500, json: { error: '暂时不可用' } });
    const second = new URL(route.request().url()).searchParams.get('offset') === '40';
    return route.fulfill({ json: { enabled: true, active: false, day: '2026-11-02', pendingDigestion: 1,
      episodeCount: 41, cardCount: 1, episodes: [{ day: second ? '2026-11-01' : '2026-11-02',
        chat: 'group:12345', persona: '角色标识', updated: Date.now(), closed: 1, digested: second ? 1 : 0,
        summary: second ? '昨天讨论过庭院' : '今天讨论过角色背景 <script>危险文本</script>', participants: '[{"name":"甲"}]' }],
      cards: second ? [] : [{ kind: 'personality', title: '历史偏好', subject: 'self', persona: '角色标识', updated: Date.now(), content: '保留供管理员查看的旧记录', sources: '["group:12345"]' }] } });
  });
  await page.goto('/');
  await switchTo(page, 'hippocampus');
  const panel = page.locator('#hippocampus-page');
  await expect(panel).toContainText('今日 · 2026-11-02');
  await expect(panel).toContainText('历史偏好');
  await expect(panel.locator('script')).toHaveCount(0);
  await page.locator('#hip-next').click();
  await expect(panel).toContainText('昨日 · 2026-11-01');
  await expect(panel).toContainText('已消化');
  await expect(page.locator('#hip-next')).toBeDisabled();
  await page.locator('#hip-prev').click();
  await expect(panel).toContainText('今日 · 2026-11-02');
  await page.screenshot({ path: '_staging/hippocampus-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2)).toBe(false);
  await page.screenshot({ path: '_staging/hippocampus-mobile.png' });
  fail = true;
  await page.locator('#hip-refresh').click();
  await expect(panel).toContainText('读取失败');
  fail = false;
  await page.locator('#hip-retry').click();
  await expect(panel).toContainText('今日 · 2026-11-02');
  expect(errors.filter((error) => !/500 \(Internal Server Error\)/.test(error))).toEqual([]);
});
