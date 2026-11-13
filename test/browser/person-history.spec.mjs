import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('按QQ搜索保留群/私聊归属，分页与窄屏可用，正文安全显示', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.route('**/api/history/person?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const next = params.get('offset') === '30';
    return route.fulfill({ json: { userId: '3240978073', nextOffset: next ? null : 30,
      messages: [{ chatKey: next ? 'private:3240978073' : 'group:818199088', localId: 2, time: 1794000000000,
        senderId: '3240978073', senderName: '测试人物', self: false, text: next ? '私聊结果' : '<script>群消息</script>' }] } });
  });
  await page.goto('/'); await switchTo(page, 'chats');
  await page.locator('#archive-person-id').fill('3240978073');
  await page.locator('#archive-person-form button').click();
  await expect(page.locator('#chat-detail')).toContainText('<script>群消息</script>');
  await expect(page.locator('#chat-detail')).toContainText('818199088');
  expect(await page.locator('#chat-detail script').count()).toBe(0);
  await page.locator('#person-history-next').click();
  await expect(page.locator('#chat-detail')).toContainText('私聊结果');
  await expect(page.locator('#person-history-next')).toBeDisabled();
  fs.mkdirSync('_staging', { recursive: true });
  await page.screenshot({ path: '_staging/person-history-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.locator('#view-chats').evaluate(node => node.scrollWidth > node.clientWidth + 1)).toBe(false);
  await page.screenshot({ path: '_staging/person-history-mobile.png' });
  expect(errors).toEqual([]);
});
