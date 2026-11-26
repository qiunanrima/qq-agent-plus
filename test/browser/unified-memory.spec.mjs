import { test, expect } from '@playwright/test';
import { login, switchTo } from './helpers.mjs';

test('统一记忆固化后收起旧记忆导航', async ({ page }) => {
  await login(page);
  const config = await (await page.request.get('/api/config')).json();
  config.memory = { ...config.memory, unifiedEnabled: true, unifiedGraduated: true };
  for (const key of ['livingMemory', 'characterLife', 'personalityMemory']) {
    config[key] = { ...config[key], graduated: true };
  }
  await page.route('**/api/config', route => route.fulfill({ json: config }));
  await page.goto('/');
  await expect(page.locator('[data-tab="unified-memory"]')).not.toHaveClass(/\bhidden\b/);
  for (const tab of ['memory', 'hippocampus', 'living-memory', 'character-life', 'personality-memory']) {
    await expect(page.locator(`[data-tab="${tab}"]`)).toHaveClass(/\bhidden\b/);
  }
});

test('统一记忆停用时仍可切换会话、查看修订和返回', async ({ page }) => {
  await login(page);
  const row = { kind: 'agreement', subject: 'report', source: 'message:12',
    timestamp: 1795651200000, body: { topic: '周报', summary: '周三提交' } };
  await page.route('**/api/unified-memory/status', route => route.fulfill({
    json: { enabled: false, scopes: [{ scope: 'private:1' }, { scope: 'group:2' }] }
  }));
  await page.route('**/api/unified-memory/records?*', route => {
    const query = new URL(route.request().url()).searchParams;
    const records = query.get('scope') === 'group:2' ? [] : query.has('subject')
      ? [row, { ...row, source: 'message:10', body: { topic: '周报', summary: '周四提交' } }] : [row];
    return route.fulfill({ json: { records, total: records.length } });
  });
  await page.goto('/');
  await switchTo(page, 'unified-memory');
  const panel = page.locator('#unified-memory-page');
  await expect(panel).toContainText('记忆已停用');
  await expect(panel).toContainText('周三提交');
  await panel.getByRole('button', { name: '修订历史' }).click();
  await expect(panel).toContainText('周四提交');
  await expect(panel).toContainText('message:10');
  await panel.getByRole('button', { name: '返回当前记录' }).click();
  await expect(panel).not.toContainText('周四提交');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.locator('select').selectOption('group:2');
  await expect(panel).toContainText('暂无记录');
  expect(await panel.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});
