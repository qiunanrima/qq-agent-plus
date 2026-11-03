/* global document, innerWidth */
import fs from 'node:fs';
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
  await page.locator('#hip-cards-tab').click();
  await expect(page.locator('#hip-cards')).toBeVisible();
  await expect(page.locator('#hip-cards')).toContainText('历史偏好');
  await expect(page.locator('#hip-next')).toBeDisabled();
  await page.locator('#hip-episodes-tab').click();
  await expect(panel).toContainText('昨日 · 2026-11-01');
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

test('海马40条长记录可用滚轮读到底，刷新保持位置；手机可滚动且无横向溢出', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.route('**/api/memory/hippocampus?offset=*', (route) => route.fulfill({ json: {
    enabled: true, active: false, day: '2026-11-03', pendingDigestion: 3, episodeCount: 40, cardCount: 1,
    episodes: Array.from({ length: 40 }, (_, i) => ({ day: '2026-11-03', chat: 'group:12345', persona: '角色标识',
      updated: Date.now(), closed: true, digested: false, summary: `第${i + 1}段 · 甲说起庭院里的桂花，大家一起讨论秋天的日常。`, participants: '[{"id":"42","name":"甲"}]' })),
    cards: [{ kind: 'person', title: '甲的爱好', subject: '42', persona: '角色标识', updated: Date.now(), content: '喜欢讨论庭院植物。', sources: '["group:12345"]' }]
  } }));
  await page.goto('/'); await switchTo(page, 'hippocampus');
  const view = page.locator('#view-hippocampus');
  await expect(page.locator('[data-hip-entry]')).toHaveCount(40);
  await expect(view).toHaveCSS('overflow-y', 'auto');
  const bounds = await view.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height * 0.7);
  await page.mouse.wheel(0, 700);
  await expect.poll(() => view.evaluate((node) => node.scrollTop)).toBeGreaterThan(200);
  const previous = await view.evaluate((node) => node.scrollTop);
  const loaded = page.waitForResponse((res) => res.url().includes('/api/memory/hippocampus?offset='));
  await page.locator('#hip-refresh').evaluate((node) => node.click());
  await loaded;
  await expect(page.locator('#hippocampus-page')).toHaveAttribute('aria-busy', 'false');
  expect(Math.abs(await view.evaluate((node) => node.scrollTop) - previous)).toBeLessThan(3);
  await page.mouse.wheel(0, 30000);
  await expect(page.locator('#hip-top')).toBeVisible();
  await page.locator('#hip-top').click();
  await expect.poll(() => view.evaluate((node) => node.scrollTop)).toBe(0);
  fs.mkdirSync('_staging', { recursive: true });
  await page.screenshot({ path: '_staging/hippocampus-redesign-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => view.evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await view.evaluate((node) => { node.scrollTop = 0; });
  await page.screenshot({ path: '_staging/hippocampus-redesign-mobile.png' });
  const mobile = await view.boundingBox();
  await page.mouse.move(mobile.x + mobile.width / 2, mobile.y + mobile.height * 0.7);
  await page.mouse.wheel(0, 30000);
  await expect(page.locator('#hip-top')).toBeVisible();
  await page.locator('#hip-top').click();
  await page.locator('#hip-cards-tab').click();
  await expect(page.locator('#hip-cards')).toBeVisible();
  await expect(page.locator('#hip-cards')).toContainText('喜欢讨论庭院植物');
  await page.screenshot({ path: '_staging/hippocampus-redesign-cards-mobile.png' });
  expect(errors).toEqual([]);
});
