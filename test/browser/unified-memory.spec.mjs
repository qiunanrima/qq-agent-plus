import { test, expect } from '@playwright/test';
import { login, switchTo } from './helpers.mjs';

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
