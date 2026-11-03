import { test, expect } from '@playwright/test';
import { login, switchTo, collectPageErrors } from './helpers.mjs';

test('旧印象清空后，海马新人物印象同时显示于人物记忆和统一人物页，不误标成可编辑旧印象', async ({ page }) => {
  const errors = collectPageErrors(page);
  await login(page);
  await page.route('**/api/memory-files', (route) => route.fulfill({ json: { files: [], stats: { entries: 0, people: 0, manual: 0, limits: {}, index: {} } } }));
  await page.route('**/api/memory/hippocampus/people', (route) => route.fulfill({ json: { enabled: true, day: '2026-11-03', entries: [
    { id: 'fresh-card', userId: '12345', personaKey: 'role', content: '新的互动表明甲喜欢绿茶 <script>危险文本</script>', updatedAt: Date.now(), sourceChatKeys: ['group:1'] }
  ] } }));
  await page.route('**/api/assets/identities?*', (route) => route.fulfill({ json: { entries: [] } }));
  await page.route('**/api/assets/memory?*', (route) => route.fulfill({ json: { entries: [] } }));
  await page.goto('/'); await switchTo(page, 'people-memory');
  await expect(page.locator('[data-gm-key="12345"]')).toBeVisible();
  await page.locator('[data-gm-key="12345"]').click();
  await expect(page.locator('#global-memory-detail')).toContainText('甲喜欢绿茶');
  await expect(page.locator('#global-memory-detail script')).toHaveCount(0);
  await expect(page.locator('#gm-delete')).toBeDisabled();
  await expect(page.locator('[data-gm-delete-memory]')).toHaveCount(0);
  await switchTo(page, 'identity');
  await expect(page.locator('#identity-automatic-memories')).toContainText('甲喜欢绿茶');
  await expect(page.locator('#identity-automatic-memories script')).toHaveCount(0);
  await expect(page.locator('#identity-automatic-memories')).toContainText('凌晨3点');
  expect(errors).toEqual([]);
});
