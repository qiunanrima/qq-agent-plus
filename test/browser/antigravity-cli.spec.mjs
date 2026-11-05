/* global document, innerWidth */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('CLI settings save only their module; lifecycle and displayed route agree without model calls', async ({ page }) => {
  const errors = collectPageErrors(page);
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ui-'));
  expect((await page.request.get('/api/antigravity-cli/status')).status()).toBe(401);
  await login(page);
  await page.request.post('/api/config', { data: { antigravityCli: { enabled: false, graduated: false, workspace } } });
  const read = async () => (await (await page.request.get('/api/config')).json()).antigravityCli;
  const patches = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname === '/api/config' && req.method() === 'POST') patches.push(req.postDataJSON());
  });
  try {
    await page.goto('/');
    await switchTo(page, 'settings');
    await page.click('button[data-section="experiments"]');
    await page.click('#agy-open');
    await expect(page.locator('#agy-save')).toBeVisible();
    await page.fill('#agy-model', 'test-model');
    await page.fill('#agy-maxToolCalls', '7');
    await page.click('#agy-save');
    await expect(page.locator('#agy-save-result')).toContainText('已保存');
    expect((await read()).enabled).toBe(false);
    expect((await read()).maxToolCalls).toBe(7);
    await page.click('#agy-toggle');
    await page.locator('[data-confirm-accept]').click();
    await expect.poll(async () => (await read()).enabled).toBe(true);
    await expect(page.locator('#model-label')).toContainText('反重力 CLI');
    await expect(page.locator('#agy-runtime-status')).toContainText('正在运行 0 个调用');
    expect((await read()).graduated).toBe(false);
    fs.mkdirSync('.codex/antigravity-ui', { recursive: true });
    await page.screenshot({ path: '.codex/antigravity-ui/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    await page.screenshot({ path: '.codex/antigravity-ui/mobile.png', fullPage: true });
    await page.click('#agy-toggle');
    await expect.poll(async () => (await read()).enabled).toBe(false);
    await expect(page.locator('#model-label')).not.toContainText('反重力 CLI');
    await page.click('button[data-section="experiments"]');
    await page.click('#agy-graduate');
    await page.locator('[data-confirm-accept]').click();
    await expect.poll(async () => (await read()).graduated).toBe(true);
    expect((await read()).enabled).toBe(false);
    await expect(page.locator('button[data-section="antigravity-cli"]')).toBeVisible();
    expect(patches.every(patch => Object.keys(patch).join() === 'antigravityCli')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/config', { data: { antigravityCli: { enabled: false, graduated: false } } });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
