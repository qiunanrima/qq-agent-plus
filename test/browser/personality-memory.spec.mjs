import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('人格成长独立页：生命周期、停用查看、修正确认与删除，桌面和手机无溢出', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  const config = { enabled: false, graduated: true, autoCapture: true, allowPrivate: false, maxEntriesPerScope: 120 };
  await page.request.post('/api/config', { data: { personalityMemory: config } });
  const entries = [{ id: '12345678-abcd', persona_name: '幽幽子', persona_key: 'character-fixture', scope_key: 'group:12345',
    kind: 'preference', topic: '饮品', content: '我更喜欢茶', status: 'tentative', target_user_id: '',
    supportDays: ['2026-11-01'], evidence: [{ id: 1, self: true, senderId: 'self', quote: '我更喜欢茶，清淡一些的。' }] }];
  let writes = 0;
  await page.route('**/api/personality-memory/status', (route) => route.fulfill({ json: { config, entries, automatic: { scopes: [{ chatKey: 'group:12345', phase: 'saved', checkedAt: Date.now(), newMessages: 20, saved: 1, calls: 2, totalTokens: 360 }] } } }));
  await page.route('**/api/personality-memory/entries/*', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.confirm).toBe(true);
    writes++;
    if (route.request().method() === 'DELETE') entries.splice(0);
    else { entries[0].content = body.content; entries[0].status = body.status; }
    await route.fulfill({ json: { ok: true } });
  });
  try {
    await page.goto('/');
    await switchTo(page, 'personality-memory');
    await expect(page.locator('#pm-status')).toContainText('已停用');
    await expect(page.locator('#pm-capture-status')).toContainText('模型调用 2');
    await expect(page.locator('#pm-collect')).toBeDisabled();
    await expect(page.locator('#pm-min-messages')).toHaveValue('20');
    await expect(page.locator('[data-pm-entry]')).toHaveCount(1);
    await page.locator('[data-pm-confirm]').click();
    await page.locator('[data-confirm-cancel]').click();
    await expect(page.locator('[data-confirm-accept]')).toHaveCount(0);
    expect(writes).toBe(0);
    fs.mkdirSync('_staging', { recursive: true });
    await page.locator('#view-personality-memory').evaluate((node) => { node.scrollTop = 0; });
    await page.screenshot({ path: '_staging/personality-memory-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-pm-entry]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: '_staging/personality-memory-mobile.png', fullPage: true });
    const overflow = await page.locator('#personality-memory-page').evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(overflow).toBe(false);
    await page.locator('[data-pm-content]').fill('更喜欢清淡的绿茶');
    await page.locator('[data-pm-confirm]').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('#pm-entries')).toContainText('已稳定');
    await expect(page.locator('[data-confirm-accept]')).toHaveCount(0);
    expect(writes).toBe(1);
    await page.locator('[data-pm-delete]').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('[data-pm-entry]')).toHaveCount(0);
    expect(writes).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await page.request.post('/api/config', { data: { personalityMemory: { enabled: false, graduated: false } } });
  }
});

test('人格成长实验卡：启用不自动固化，固化和取消固化只提交模块补丁', async ({ page }) => {
  await login(page);
  await page.request.post('/api/config', { data: { personalityMemory: { enabled: false, graduated: false } } });
  const patches = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/config' && request.method() === 'POST') patches.push(request.postDataJSON());
  });
  const config = async () => (await (await page.request.get('/api/config')).json()).personalityMemory;
  try {
    await page.goto('/');
    await switchTo(page, 'settings');
    await page.click('button[data-section="experiments"]');
    await expect(page.locator('#experiment-personality-memory')).toBeVisible();
    await page.locator('#pm-experiment-enabled').check();
    await expect.poll(async () => (await config()).enabled).toBe(true);
    expect((await config()).graduated).toBe(false);
    await expect(page.locator('[data-tab="personality-memory"]')).toBeHidden();
    await page.locator('#pm-graduate').click();
    await page.locator('[data-confirm-accept]').click();
    await expect(page.locator('#pm-open')).toBeVisible();
    await expect(page.locator('[data-tab="personality-memory"]')).toBeVisible();
    await expect.poll(async () => (await config()).graduated).toBe(true);
    await expect(page.locator('[data-confirm-accept]')).toHaveCount(0);
    await page.locator('#pm-graduate').click();
    await page.locator('[data-confirm-accept]').click();
    await expect.poll(async () => (await config()).graduated).toBe(false);
    expect((await config()).enabled).toBe(false);
    expect(patches.length).toBe(3);
    expect(patches.every((patch) => Object.keys(patch).join() === 'personalityMemory')).toBe(true);
  } finally {
    await page.request.post('/api/config', { data: { personalityMemory: { enabled: false, graduated: false } } });
  }
});
