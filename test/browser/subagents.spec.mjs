import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('受限子代理开关、固化、停用与重载；桌面和窄屏可用', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.request.post('/api/config', { data: { subagent: { enabled: false, graduated: false } } });
  const patches = [];
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/config' && req.method() === 'POST') patches.push(req.postDataJSON());
  });
  const config = async () => (await (await page.request.get('/api/config')).json()).subagent;
  try {
    await page.goto('/'); await switchTo(page, 'settings');
    await page.click('button[data-section="experiments"]');
    await expect(page.locator('#experiment-subagent')).toBeVisible();
    await page.locator('#subagent-enabled').check();
    await expect.poll(async () => (await config()).enabled).toBe(true);
    expect((await config()).graduated).toBe(false);
    await page.locator('#subagent-graduate').click();
    await page.locator('[data-confirm-accept]').click();
    await expect.poll(async () => (await config()).graduated).toBe(true);
    await page.locator('#subagent-enabled').uncheck();
    await expect.poll(async () => (await config()).enabled).toBe(false);
    expect((await config()).graduated).toBe(true);
    await page.reload(); await switchTo(page, 'settings');
    await page.click('button[data-section="experiments"]');
    await expect(page.locator('#experiment-subagent')).toContainText('已停用 · 已固化');
    fs.mkdirSync('_staging', { recursive: true });
    await page.locator('#experiment-subagent').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '_staging/subagents-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#experiment-subagent').scrollIntoViewIfNeeded();
    await expect(page.locator('#subagent-enabled')).toBeVisible();
    await expect(page.locator('#subagent-graduate')).toBeVisible();
    expect(await page.locator('#experiment-subagent').evaluate((node) => node.scrollWidth > node.clientWidth + 1)).toBe(false);
    await page.screenshot({ path: '_staging/subagents-mobile.png', fullPage: true });
    await page.locator('#subagent-graduate').click();
    await page.locator('[data-confirm-accept]').click();
    await expect.poll(async () => (await config()).graduated).toBe(false);
    expect((await config()).enabled).toBe(false);
    expect(patches).toHaveLength(4);
    expect(patches.every((patch) => Object.keys(patch).join() === 'subagent')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/config', { data: { subagent: { enabled: false, graduated: false } } });
  }
});
