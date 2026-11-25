/* global document, innerWidth */
import { test, expect } from '@playwright/test';
import { collectPageErrors, login, switchTo } from './helpers.mjs';

test('个人邮箱能保存、测试、停用并保留凭据，窄屏可用', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.goto('/');
  await switchTo(page, 'personal-mail');
  const gmail = page.locator('[data-mail-provider="gmail"]');
  const qq = page.locator('[data-mail-provider="qq"]');
  await expect(qq.locator('[data-mail-state]')).toHaveText('待配置');
  await gmail.getByLabel('OAuth 客户端 ID').fill('smoke-client-id');
  await gmail.getByLabel('OAuth 客户端密钥').fill('smoke-client-secret');
  await gmail.getByLabel('刷新令牌').fill('smoke-refresh-token');
  await gmail.getByRole('checkbox').check();
  await gmail.getByRole('button', { name: '保存', exact: true }).click();
  await expect(gmail.locator('[data-mail-state]')).toHaveText('已启用');
  await expect(gmail.getByLabel('刷新令牌')).toHaveValue('');
  const status = await page.request.get('/api/personal-mail');
  expect(await status.text()).not.toContain('smoke-');

  await page.route('**/api/personal-mail/gmail/test', (route) => route.fulfill({ json: { status: 'ok' } }));
  await gmail.getByRole('button', { name: '测试连接' }).click();
  await expect(gmail.locator('[data-mail-result]')).toHaveText('连接成功。');
  await gmail.getByRole('checkbox').uncheck();
  await gmail.getByRole('button', { name: '保存', exact: true }).click();
  await expect(gmail.locator('[data-mail-state]')).toHaveText('已停用');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await switchTo(page, 'personal-mail');
  await expect(gmail.getByLabel('刷新令牌')).toHaveAttribute('placeholder', '已配置，留空保留');
  await expect(qq.getByRole('button', { name: '测试连接' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBeTruthy();
  expect(errors).toEqual([]);
});
