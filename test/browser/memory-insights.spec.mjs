import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('召回解释只读查询、使用阶段及功能费用在桌面与390px可查看', async ({ page }) => {
  const errors = collectPageErrors(page); await login(page);
  const initial = await (await page.request.get('/api/config')).json();
  await page.request.post('/api/config', { data: { allow: { groups: ['123456'] } } });
  let queries = 0;
  await page.route('**/api/memory/insights?*', route => {
    queries++;
    return route.fulfill({ json: { total: 1, scoring: '按保留率排序，查看不强化', entries: [{ id: 'a', title: '<测试项目>', content: '项目的历史正文', origin: 'hippocampus', status: 'active', sourceChatKeys: ['group:123456'], retention: 0.8, strength: 3.2, recallCount: 2, lexicalMatches: 1 }], events: [{ at: Date.now(), stage: 'used', entries: [{ title: '测试项目' }] }] } });
  });
  await page.route('**/api/usage/stats?*', async route => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ json: { ...data, features: { 'personality-review': { tokens: 1234, calls: 2, cost: 0.02 }, unattributed: { tokens: 40, calls: 0, cost: 0.01 } } } });
  });
  try {
    await page.goto('/'); await switchTo(page, 'memory');
    await page.locator('#memory-items').getByText('123456', { exact: false }).first().click();
    await expect(page.locator('#memory-insights')).toBeAttached();
    expect(queries).toBe(0);
    await page.locator('#memory-insights summary').first().click();
    await page.locator('#memory-insight-query').fill('项目');
    await page.locator('#memory-insight-load').click();
    await expect(page.locator('#memory-insight-result')).toContainText('实际使用 2 次');
    await expect(page.locator('#memory-insight-result')).toContainText('实际采用');
    await expect(page.locator('#memory-insight-result')).toContainText('<测试项目>');
    fs.mkdirSync('_staging', { recursive: true });
    await page.locator('#memory-insights').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '_staging/insights-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#memory-insights').scrollIntoViewIfNeeded();
    expect(await page.locator('#memory-detail').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: '_staging/insights-mobile.png' });
    await switchTo(page, 'usage');
    await expect(page.locator('[data-table="features"]')).toContainText('人格核验');
    await expect(page.locator('[data-table="features"]')).toContainText('历史未分类');
    await page.locator('[data-block="features"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '_staging/insights-usage-mobile.png' });
    expect(errors).toEqual([]);
  } finally { await page.request.post('/api/config', { data: { allow: initial.allow } }); }
});
