import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('记忆全量清除：确认范围、取消零写入、确认只发一次；桌面和窄屏布局', async ({ page }) => {
  const errors = collectPageErrors(page);
  let writes = 0;
  await page.route('**/api/memory/reset-all', async (route) => {
    writes++;
    expect(route.request().postDataJSON()).toEqual({ confirm: true, scope: 'all', includeArchive: true });
    await route.fulfill({ json: { ok: true, paused: true, backupId: 'browser-fixture-backup', cleared: { context: { messages: 10 } } } });
  });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'people-memory');
  const button = page.locator('#gm-reset-all');
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await expect(page.locator('.model-modal-body')).toContainText('聊天原始存档');
  await expect(page.locator('.model-modal-body')).toContainText('将清除：全部聊天原始存档');
  fs.mkdirSync('_staging', { recursive: true });
  await page.screenshot({ path: '_staging/memory-reset-desktop.png', fullPage: true });
  await page.locator('[data-confirm-cancel]').click();
  await expect(page.locator('[data-confirm-accept]')).toHaveCount(0);
  expect(writes).toBe(0);
  await expect(button).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await button.click();
  await page.screenshot({ path: '_staging/memory-reset-mobile.png', fullPage: true });
  await expect(page.locator('[data-confirm-accept]')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('#gm-reset-status')).toContainText('browser-fixture-backup');
  expect(writes).toBe(1);
  expect(errors).toEqual([]);
});

test('清除后切回存档没有旧消息，新入站消息正常显示', async ({ page }) => {
  let messages = [{ id: 100, text: '清除前的旧存档', senderId: '42', senderName: '甲', ts: Date.now(), read: true, media: [] }];
  await page.route('**/api/chats', (route) => route.fulfill({ json: { chats: [{ key: 'group:123456', total: messages.length,
    unread: 0, failed: 0, held: 0, lastText: messages.at(-1)?.text || '', lastTs: Date.now() }] } }));
  await page.route('**/api/chats/group_123456/messages**', (route) => route.fulfill({ json: {
    messages, total: messages.length, hasMore: false, nextBefore: 0
  } }));
  await page.route('**/api/memory/reset-all', (route) => {
    messages = [];
    return route.fulfill({ json: { ok: true, paused: true, backupId: 'archive-reset-fixture', cleared: { context: { messages: 1 } } } });
  });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'chats');
  await page.locator('.chat-item[data-key="group:123456"]').click();
  await expect(page.locator('#chat-msg-body')).toContainText('清除前的旧存档');
  await switchTo(page, 'people-memory');
  await page.locator('#gm-reset-all').click();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('#gm-reset-status')).toContainText('已清除 1 条消息');
  await expect(page.locator('[data-confirm-accept]')).toHaveCount(0);
  await switchTo(page, 'chats');
  await expect(page.locator('[data-field="chat-msg-count"]')).toContainText('暂无消息');
  await expect(page.locator('#chat-detail')).not.toContainText('清除前的旧存档');
  messages = [{ id: 101, text: '清除后新收到的消息', senderId: '42', senderName: '甲', ts: Date.now(), read: true, media: [] }];
  await switchTo(page, 'people-memory');
  await switchTo(page, 'chats');
  await expect(page.locator('#chat-msg-body')).toContainText('清除后新收到的消息');
  await expect(page.locator('#chat-msg-body')).not.toContainText('清除前的旧存档');
});

test('旧服务只清记忆时不再显示存档清除成功', async ({ page }) => {
  await page.route('**/api/memory/reset-all', (route) => route.fulfill({ json: {
    ok: true, paused: true, backupId: 'old-server-fixture', cleared: { context: { threads: 1 } }
  } }));
  await login(page);
  await page.goto('/');
  await switchTo(page, 'people-memory');
  await page.locator('#gm-reset-all').click();
  await page.locator('[data-confirm-accept]').click();
  await expect(page.locator('#gm-reset-status')).toContainText('当前服务未确认消息存档已清除');
});
