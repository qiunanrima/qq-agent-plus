import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { login, switchTo } from './helpers.mjs';
import { buildTar } from '../helpers/tar.mjs';

test('真实 ClawHub 搜索、下载和停用安装', async ({ page }) => {
  test.skip(process.env.QQ_AGENT_TEST_CLAWHUB_LIVE !== '1', '需要访问 ClawHub');
  test.setTimeout(90000);
  const name = 'episodic-claw';
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await page.locator('#plugins-search').fill(name);
  await page.locator('#plugins-clawhub-search').click();
  const install = page.locator(`[data-plugin-action="install-clawhub"][data-clawhub-name="${name}"]`);
  await expect(install).toBeVisible({ timeout: 25000 });
  const version = await install.getAttribute('data-clawhub-version');
  const response = page.waitForResponse((r) => r.url().endsWith('/api/plugins/install-clawhub'), { timeout: 55000 });
  await install.click();
  const result = await (await response).json();
  expect(result.ok, result.error).toBe(true);
  await expect(page.locator('#plugins-status')).toContainText(`已安装 ${name} ${version}`);
  const { mcp } = await (await page.request.get('/api/config')).json();
  expect(mcp.servers.find(({ id }) => id === result.id)).toMatchObject({
    enabled: false, permissionIsolation: true, clawHub: { name, version }
  });
});

test('控制台上传 OpenClaw 工具包并保存为停用服务', async ({ page }) => {
  const buffer = buildTar([
    { name: 'openclaw.plugin.json', data: '{"id":"upload-echo"}' },
    { name: 'package.json', data: '{"openclaw":{"extensions":["./index.mjs"]}}' },
    { name: 'index.mjs', data: 'export default { id: "upload-echo", register() {} };' }
  ]);
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await page.locator('[data-plugin-pane="manual"]').click();
  await page.locator('#plugins-file').setInputFiles({ name: 'echo.tgz', mimeType: 'application/gzip', buffer });
  await page.locator('#plugins-file-openclaw').check();
  const response = page.waitForResponse((r) => r.url().endsWith('/api/plugins/install-file'));
  await page.locator('#plugins-file-install').click();
  const result = await (await response).json();
  expect(result).toMatchObject({ ok: true, fileName: 'echo.tgz', openclawMcp: true });
  await expect(page.locator('#plugins-status')).toContainText('请在 MCP 设置中检查并启用');
  const { mcp } = await (await page.request.get('/api/config')).json();
  expect(mcp.servers.find(({ id }) => id === result.id)).toMatchObject({
    enabled: false, permissionIsolation: true
  });
});

test('插件市场可搜索 ClawHub 并以文本显示结果', async ({ page }) => {
  let installed = false;
  await page.route('**/api/plugins/clawhub?*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('query')).toBe('weather');
    return route.fulfill({ json: { ok: true, results: [{
      name: 'weather-fixture', title: '<b>Weather</b>', version: '1.0.0', family: 'code-plugin',
      installed, installedVersion: installed ? '1.0.0' : ''
    }] } });
  });
  await page.route('**/api/plugins/install-clawhub', (route) => {
    expect(route.request().postDataJSON()).toEqual({ name: 'weather-fixture', version: '1.0.0' });
    installed = true;
    return route.fulfill({ json: { ok: true, id: 'openclaw-clawhub-fixture' } });
  });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await page.locator('#plugins-search').fill('weather');
  await page.locator('#plugins-clawhub-search').click();
  await expect(page.locator('#plugins-clawhub-results')).toContainText('<b>Weather</b>');
  await expect(page.locator('#plugins-clawhub-results b')).toHaveCount(0);
  await page.locator('#plugins-clawhub-results').getByRole('button', { name: '安装' }).click();
  await expect(page.locator('#plugins-status')).toContainText('已安装 weather-fixture 1.0.0');
  await page.locator('#plugins-clawhub-search').click();
  await expect(page.locator('#plugins-clawhub-results')).toContainText('已安装 1.0.0');
  await expect(page.locator('#plugins-clawhub-results button')).toHaveCount(0);
});

test('默认市场安装 OpenClaw 时区换算，并在控制台隔离启用和停用', async ({ page }) => {
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  const button = page.locator('[data-plugin-action="install"][data-plugin-id="openclaw-time-format"]');
  await page.locator('#plugins-search').fill('OpenClaw 时区换算');
  await button.click();
  await expect(page.locator('#plugins-status')).toContainText('已安装 openclaw-time-format');
  const { mcp } = await (await page.request.get('/api/config')).json();
  expect(mcp.servers.find(({ id }) => id === 'openclaw-time-format')).toMatchObject({
    enabled: false, permissionIsolation: true
  });
  await switchTo(page, 'settings');
  await page.locator('.settings-menu-item[data-section="mcp"]').click();
  const server = page.locator('.mcp-server[data-id="openclaw-time-format"]');
  await server.locator('summary').click();
  await page.locator('#cfg-mcp-enabled').check();
  await server.locator('.mcp-enabled').check();
  await page.locator('#save-cfg-btn').click();
  const status = async () => (await (await page.request.get('/api/mcp')).json())
    .status.find(({ id }) => id === 'openclaw-time-format');
  await expect.poll(status).toMatchObject({
    enabled: true, ready: true, permissionActive: true, tools: ['convert_timezone']
  });
  if (!(await server.locator('.mcp-enabled').isVisible())) await server.locator('summary').click();
  await server.locator('.mcp-enabled').uncheck();
  await page.locator('#save-cfg-btn').click();
  await expect.poll(status).toMatchObject({ enabled: false, ready: false, tools: [] });
});

test('市场目录里的 OpenClaw 条目可以安装并回显状态', async ({ page }) => {
  let installed = false;
  await page.route('**/api/plugins/index', (route) => route.fulfill({ json: {
    ok: true,
    plugins: [{
      id: 'openclaw-market-fixture', name: 'OpenClaw 市场测试工具', openclawMcp: 'tool',
      version: '1.0.0', compatible: true, mcpInstalled: installed
    }]
  } }));
  await page.route('**/api/plugins/install', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ id: 'openclaw-market-fixture' });
    installed = true;
    await route.fulfill({ json: { ok: true, id: 'openclaw-openclaw-market-fixture', openclawMcp: true } });
  });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await page.locator('[data-plugin-action="install"][data-plugin-id="openclaw-market-fixture"]').click();
  await expect(page.locator('#plugins-status')).toContainText('请在 MCP 设置中检查并启用');
  await expect(page.locator('#plugins-index')).toContainText('已安装');
});

test('插件市场在窄屏导入 OpenClaw 服务并保持停用', async ({ page }, testInfo) => {
  const directory = testInfo.outputPath('openclaw');
  const serverName = 'openclaw-browser-test';
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'openclaw.plugin.json'), JSON.stringify({
    mcpServers: { [serverName]: { transport: 'stdio', command: 'node', args: ['./server.mjs'] } }
  }));
  await writeFile(path.join(directory, 'server.mjs'), 'throw new Error("must remain disabled");');

  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.goto('/');
  await switchTo(page, 'plugins');
  await page.locator('[data-plugin-pane="manual"]').click();
  await page.getByRole('textbox', { name: 'OpenClaw 插件目录' }).fill(directory);
  await page.getByRole('textbox', { name: 'OpenClaw MCP 服务名' }).fill(serverName);
  await page.getByRole('button', { name: '导入 OpenClaw' }).click();
  await expect(page.locator('#plugins-status')).toContainText(`已导入 ${serverName}`);
  const { mcp } = await (await page.request.get('/api/config')).json();
  expect(mcp.servers.find(({ id }) => id === serverName)).toMatchObject({
    enabled: false, command: 'node', toolMounting: 'meta'
  });
});
