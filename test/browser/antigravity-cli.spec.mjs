/* global document, innerWidth */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('separate native and QQ approvals, escaped previews and explicit decisions', async ({ page }) => {
  await login(page);
  expect((await page.request.post('/api/config', { data: { antigravityCli: { enabled: false, nativeApproval: false, qqApproval: false, transport: 'mcp' } } })).ok()).toBe(true);
  let pending = [{ id: 'test-approval-id', category: 'qq', chatKey: 'private:test', runId: 'test-run', tool: 'send_message', preview: '{"AbsolutePath":"<img src=x onerror=alert(1)>"}', expiresAt: Date.now() + 60000 }];
  let approved;
  await page.route('**/api/antigravity-cli/approvals', route => route.fulfill({ json: { pending } }));
  await page.route('**/api/antigravity-cli/approvals/test-approval-id', route => {
    approved = route.request().postDataJSON().approved;
    pending = [];
    return route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto('/'); await switchTo(page, 'settings');
    await page.click('button[data-section="experiments"]'); await page.click('#agy-open');
    await expect(page.locator('#agy-native-approval')).not.toBeChecked();
    await page.check('#agy-qq-approval');
    await page.click('#agy-save');
    await expect(page.locator('#agy-save-result')).toContainText('已保存');
    const cfg = (await (await page.request.get('/api/config')).json()).antigravityCli;
    expect(cfg.nativeApproval).toBe(false); expect(cfg.qqApproval).toBe(true); expect(cfg.enabled).toBe(false);
    await page.check('#agy-native-approval');
    await page.click('#agy-save');
    await expect.poll(async () => (await (await page.request.get('/api/config')).json()).antigravityCli.nativeApproval).toBe(true);
    pending = [{ id: 'test-approval-id', category: 'native', chatKey: 'private:test', runId: 'test-run', tool: 'run_command',
      preview: '{"CommandLine":"echo <img src=x onerror=alert(1)>"}', expiresAt: Date.now() + 60000 }];
    await page.click('#agy-approvals-refresh');
    await expect(page.locator('#agy-approvals')).toContainText('CLI 原生工具：run_command');
    await expect(page.locator('#agy-approvals img')).toHaveCount(0);
    await page.click('[data-cli-approve="test-approval-id"]');
    await expect(page.locator('#agy-approvals')).toContainText('没有待审批工具');
    expect(approved).toBe(true);
    fs.mkdirSync('.codex/antigravity-ui', { recursive: true });
    await page.screenshot({ path: '.codex/antigravity-ui/approval-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#agy-native-approval').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
    await page.screenshot({ path: '.codex/antigravity-ui/approval-mobile.png' });
  } finally {
    await page.request.post('/api/config', { data: { antigravityCli: { enabled: false, nativeApproval: false, qqApproval: false } } });
  }
});

test('quota card queries only on click and displays quota, reset and separate credits on mobile', async ({ page }) => {
  expect((await page.request.post('/api/antigravity-cli/quota')).status()).toBe(401);
  await login(page);
  let queries = 0;
  const fixture = { checkedAt: '2026-11-05T12:00:00Z', remainingCredits: 0, groups: [{ name: 'Gemini Models', buckets: [
    { window: 'weekly', remainingFraction: 0.8, resetTime: '2026-11-12T12:00:00Z' },
    { window: '5h', remainingFraction: null, resetTime: null }
  ] }] };
  await page.route('**/api/antigravity-cli/quota', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: queries ? { ...fixture, cached: true } : { available: false } });
    queries++;
    return route.fulfill({ json: fixture });
  });
  await page.goto('/'); await switchTo(page, 'overview');
  await expect(page.locator('#agy-quota-result')).toContainText('尚未查询');
  expect(queries).toBe(0);
  await page.click('#agy-quota-fetch');
  await expect(page.locator('#agy-quota-result')).toContainText('80.0%');
  await expect(page.locator('#agy-quota-result')).toContainText('剩余 未知');
  await expect(page.locator('#agy-quota-result')).toContainText('额外 AI 积分：0');
  await expect(page.locator('#agy-quota-result')).toContainText('重置');
  fs.mkdirSync('.codex/antigravity-ui', { recursive: true });
  await page.locator('#agy-quota-fetch').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.codex/antigravity-ui/quota-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#agy-quota-fetch').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.codex/antigravity-ui/quota-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)).toBe(false);
  expect(queries).toBe(1);
  await page.reload();
  await expect(page.locator('#agy-quota-result')).toContainText('80.0%');
  await expect(page.locator('#agy-quota-result')).toContainText('缓存结果');
  expect(queries).toBe(1);
});

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
    await page.route('**/api/antigravity-cli/models', route => route.fulfill({ json: { models: [{ id: 'test-model', name: 'Offline model' }] } }));
    await page.click('#agy-model-fetch');
    await page.selectOption('#agy-model-list', 'test-model');
    await expect(page.locator('#agy-model')).toHaveValue('test-model');
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
