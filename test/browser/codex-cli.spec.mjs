/* global document, innerWidth */
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('Codex ACP settings have independent lifecycle, persistence and responsive layout', async ({ page }) => {
  const errors = collectPageErrors(page);
  expect((await page.request.get('/api/codex-cli/status')).status()).toBe(401);
  expect((await page.request.post('/api/codex-cli/models')).status()).toBe(401);
  await login(page);
  const workspace = fs.mkdtempSync(path.resolve('.codex/codex-browser-'));
  fs.mkdirSync(path.join(workspace, 'codex-home'));
  const patch = async data => expect((await page.request.post('/api/config', { data })).ok()).toBe(true);
  try {
    await patch({ antigravityCli: { enabled: false }, codexCli: { enabled: false, graduated: false, workspace } });
    await page.goto('/'); await switchTo(page, 'settings');
    await page.locator('button[data-section="experiments"]').click();
    await page.locator('#codex-open').click();
    await expect(page.locator('#codex-save')).toBeVisible();
    let modelQueries = 0;
    await page.route('**/api/codex-cli/models', route => {
      modelQueries++;
      return route.fulfill({ json: { models: [{ id: 'test-model', name: '<Test model>' }], currentModel: 'test-model' } });
    });
    expect(modelQueries).toBe(0);
    await page.locator('#codex-models-refresh').click();
    await expect(page.locator('#codex-models-result')).toContainText('已获取 1 个模型');
    await expect(page.locator('#codex-model')).toHaveValue('');
    await page.locator('#codex-model-catalog').selectOption('test-model');
    await expect(page.locator('#codex-model')).toHaveValue('test-model');
    await page.locator('#codex-maxToolCalls').fill('7');
    await page.locator('#codex-save').click();
    await expect(page.locator('#codex-result')).toHaveText('已保存');
    expect((await (await page.request.get('/api/config')).json()).codexCli.maxToolCalls).toBe(7);
    expect((await (await page.request.get('/api/config')).json()).codexCli.model).toBe('test-model');
    await page.route('**/api/codex-cli/models', route => route.fulfill({ status: 502, json: { error: '请检查登录状态' } }));
    await page.locator('#codex-models-refresh').click();
    await expect(page.locator('#codex-models-result')).toContainText('请检查登录状态');
    await expect(page.locator('#codex-model')).toHaveValue('test-model');
    expect(errors.splice(0)).toEqual(['console: Failed to load resource: the server responded with a status of 502 (Bad Gateway)']);
    page.on('dialog', dialog => dialog.accept());
    await page.locator('#codex-toggle').click();
    await page.locator('[data-confirm-accept]').click();
    await expect.poll(async () => (await (await page.request.get('/api/config')).json()).codexCli.enabled).toBe(true);
    expect((await (await page.request.get('/api/config')).json()).codexCli.graduated).toBe(false);
    await page.locator('#codex-toggle').click();
    await expect.poll(async () => (await (await page.request.get('/api/config')).json()).codexCli.enabled).toBe(false);
    await page.locator('button[data-section="experiments"]').click();
    await page.locator('#codex-graduate').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('button[data-section="codex-cli"]')).toBeVisible();
    expect((await (await page.request.get('/api/config')).json()).codexCli.enabled).toBe(false);
    await page.locator('button[data-section="codex-cli"]').click();
    await expect(page.locator('#codex-status')).toContainText('ACP');
    fs.mkdirSync('.codex/codex-ui', { recursive: true });
    await page.locator('#codex-model-catalog').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.codex/codex-ui/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#codex-model-catalog').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '.codex/codex-ui/mobile.png', fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.reload(); await switchTo(page, 'settings');
    await page.locator('button[data-section="codex-cli"]').click();
    await expect(page.locator('#codex-maxToolCalls')).toHaveValue('7');
    await expect(page.locator('#codex-model')).toHaveValue('test-model');
    expect(errors).toEqual([]);
  } finally {
    await patch({ codexCli: { enabled: false, graduated: false } });
    const target = path.resolve(workspace);
    if (path.dirname(target) !== path.resolve('.codex') || !path.basename(target).startsWith('codex-browser-')) throw new Error('Invalid cleanup');
    fs.rmSync(target, { recursive: true, force: true });
  }
});

