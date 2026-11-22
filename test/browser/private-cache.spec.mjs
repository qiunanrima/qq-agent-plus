import { test, expect } from '@playwright/test';
import { login, switchTo } from './helpers.mjs';

test('私聊分块缓存可独立启停，重载保留，窄屏可操作', async ({ page }) => {
  await login(page);
  await page.goto('/');
  const open = async () => {
    await switchTo(page, 'settings');
    await page.locator('button[data-section="experiments"]').click();
  };
  await open();
  const toggle = page.locator('#private-cache-enabled');
  const card = page.locator('#experiment-private-cache');
  try {
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(card).toContainText('已启用 · 实验中');
    await page.reload();
    await open();
    await expect(toggle).toBeChecked();
    await page.setViewportSize({ width: 390, height: 844 });
    await toggle.uncheck();
    await expect(card).toContainText('已停用 · 实验中');
    await page.locator('#private-cache-graduate').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(card).toContainText('已停用 · 已固化');
    expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  } finally {
    await page.request.post('/api/config', { data: { privateCache: { enabled: false, graduated: false } } });
  }
});
