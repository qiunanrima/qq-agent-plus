// 插件路由模块的依赖注入守卫（2026-10-31 M2 拆分回归）：
// 拆分时曾把注入的 mirrorConfig 与 handler 内同名局部变量写成
// `const mirrorConfig = mirrorConfig()` —— TDZ ReferenceError 只在真正调用端点时暴露，
// 源码锚点测试拦不住。这里用假 router + 假索引直接调用 handler：
// 断言"已经走到下载失败"而不是"访问未初始化变量"，从而证明注入函数可调用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildTar } from './helpers/tar.mjs';
import { normalizePluginIndexEntry, sha256Of } from '../src/plugins/install.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-plugin-routes-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 句柄 */ } });

const { registerPluginRoutes } = await import('../src/console/routes/plugins.js');

function buildRoutes(body, config = { plugins: { publishers: {} } }, overrides = {}) {
  const handlers = new Map();
  const router = { add(method, routePath, handler) { handlers.set(`${method} ${routePath}`, handler); } };
  const calls = [];
  const json = (res, status, payload) => { res.status = status; res.payload = payload; };
  registerPluginRoutes(router, {
    json,
    readBody: async () => body,
    getConfig: () => config,
    updateConfig: (patch) => Object.assign(config, patch),
    auditWrite: () => {},
    log: () => {},
    dataDir,
    hostVersion: '0.0.0',
    pluginRegistry: {},
    loadIndex: async () => ({
      plugins: [{
        id: 'weather',
        url: 'http://127.0.0.1:1/weather.tar.gz',
        sha256: '0'.repeat(64),
        compatible: true,
        source: '测试索引'
      }],
      skipped: [],
      sources: []
    }),
    invalidateIndex: () => calls.push('invalidate'),
    mirrorConfig: () => ({ prefixes: [] }),
    pluginLog: () => {},
    ...overrides
  });
  return { handlers, calls };
}

test('插件市场从索引下载 OpenClaw 包并登记停用配置', async () => {
  const buffer = buildTar([
    { name: 'package/openclaw.plugin.json', data: JSON.stringify({
      mcpServers: { example: { transport: 'stdio', command: 'node', args: ['./server.mjs'] } }
    }) },
    { name: 'package/server.mjs', data: 'throw new Error("must stay disabled");' }
  ]);
  const url = 'https://example.com/openclaw-example.tgz';
  const { entry } = normalizePluginIndexEntry({
    id: 'example', openclawMcp: 'example', url, sha256: sha256Of(buffer)
  });
  const config = { mcp: { enabled: true, servers: [] } };
  const { handlers } = buildRoutes({ id: 'example' }, config, {
    loadIndex: async () => ({ plugins: [entry] }),
    fetchPackage: async (target) => {
      assert.equal(target, url);
      return { buffer };
    }
  });
  const response = {};
  await handlers.get('POST /api/plugins/install')({}, response);
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.deepEqual(response.payload, { ok: true, id: 'openclaw-example', openclawMcp: true });
  const [server] = config.mcp.servers;
  assert.equal(server.enabled, false);
  assert.equal(fs.readFileSync(server.args[0], 'utf8'), 'throw new Error("must stay disabled");');
  await handlers.get('GET /api/plugins/index')({}, response);
  assert.equal(response.payload.plugins[0].mcpInstalled, true);
  await handlers.get('POST /api/plugins/install')({}, response);
  assert.equal(response.status, 400);
  assert.equal(config.mcp.servers.length, 1);
  entry.sha256 = '0'.repeat(64);
  await handlers.get('POST /api/plugins/install')({}, response);
  assert.equal(response.payload.code, 'E_DOWNLOAD');
  assert.equal(config.mcp.servers.length, 1);
});

test('ClawHub 安装核对版本和 SHA-256，并在拒绝下载时保留配置', async () => {
  const name = '@sample/echo';
  const version = '1.2.3';
  const buffer = buildTar([
    { name: 'package/openclaw.plugin.json', data: JSON.stringify({ id: 'echo' }) },
    { name: 'package/package.json', data: JSON.stringify({ openclaw: { extensions: ['./index.mjs'] } }) },
    { name: 'package/index.mjs', data: 'throw new Error("must stay disabled");' }
  ]);
  const sha256 = sha256Of(buffer);
  const pkg = { name, family: 'code-plugin' };
  let blockedFromDownload = true;
  let downloads = 0;
  const config = { mcp: { servers: [] } };
  const request = { name, version };
  const { handlers } = buildRoutes(request, config, { clawHubTransport: {
    fetchText: async (url) => {
      if (url.includes('/plugins/search?')) {
        return { statusCode: 200, body: JSON.stringify({ results: [{ package: {
          ...pkg, latestVersion: '2.0.0'
        } }] }) };
      }
      assert.match(url, /%40sample%2Fecho\/versions\/(?:1\.2\.3|2\.0\.0)\//);
      const body = url.endsWith('/security')
        ? { package: pkg, release: { version: request.version, artifactSha256: sha256 }, trust: { blockedFromDownload } }
        : { package: pkg, version: request.version, artifact: { kind: 'npm-pack', sha256 } };
      return { statusCode: 200, body: JSON.stringify(body) };
    },
    fetchBinary: async (url) => {
      assert.match(url, /\/artifact\/download$/);
      downloads += 1;
      return { buffer: downloads === 1 ? Buffer.from('wrong content') : buffer };
    }
  } });
  const route = handlers.get('POST /api/plugins/install-clawhub');
  const result = {};
  await route({}, result);
  assert.equal(result.status, 400);
  assert.equal(downloads, 0);
  blockedFromDownload = false;
  await route({}, result);
  assert.equal(result.payload.code, 'E_SHA_MISMATCH');
  assert.deepEqual(config.mcp.servers, []);
  await route({}, result);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(config.mcp.servers[0].enabled, false);
  assert.deepEqual(config.mcp.servers[0].clawHub, { name, version });
  await handlers.get('GET /api/plugins/clawhub')({}, result, {}, new URL('http://localhost/?query=echo'));
  assert.equal(result.payload.results[0].version, '2.0.0');
  assert.equal(result.payload.results[0].installedVersion, version);
  assert.equal(result.payload.results[0].installed, true);
  assert.equal(result.payload.results[0].upgradeAvailable, true);
  const [previous] = config.mcp.servers;
  previous.enabled = true;
  previous.env.CUSTOM = 'keep';
  Object.assign(request, { version: '2.0.0', expectedVersion: version });
  await route({}, result);
  assert.equal(result.status, 409);
  assert.equal(config.mcp.servers[0], previous);
  previous.enabled = false;
  await route({}, result);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  const [next] = config.mcp.servers;
  assert.equal(next.clawHub.version, '2.0.0');
  assert.equal(next.env.CUSTOM, 'keep');
  assert.equal(next.enabled, false);
  assert.notEqual(next.cwd, previous.cwd);
  assert.equal(fs.existsSync(previous.args[1]), true);
  await route({}, result);
  assert.equal(result.status, 409);
  assert.equal(config.mcp.servers[0], next);
});

test('ClawHub 可以安装有 SHA-256 的旧版 ZIP 原生工具包', async () => {
  const buffer = Buffer.from(
    'UEsDBBQAAAAIABN4e13/UZp7EwAAABEAAAAUAAAAb3BlbmNsYXcucGx1Z2luLmpzb26rVspMUbJSqsos0E1NzshXqgUA'
    + 'UEsDBBQAAAAIABN4e13zquo4LQAAACsAAAAMAAAAcGFja2FnZS5qc29uq1bKL0jNS85JLFeyqlZKrShJzSvOzM8rVrKK'
    + 'VtLTz8xLSa3Qy80qVoqtrQUAUEsDBBQAAAAIABN4e11qac4iLQAAACsAAAAJAAAAaW5kZXgubWpzS60oyC8qUUhJTUss'
    + 'zSlRqM5MsVKqyizQTU3OyFfSKUpNzywuSS3S0KyurQUAUEsBAhQAFAAAAAgAE3h7Xf9RmnsTAAAAEQAAABQAAAAAAAAA'
    + 'AAAAAIABAAAAAG9wZW5jbGF3LnBsdWdpbi5qc29uUEsBAhQAFAAAAAgAE3h7XfOq6jgtAAAAKwAAAAwAAAAAAAAAAAAA'
    + 'AIABRQAAAHBhY2thZ2UuanNvblBLAQIUABQAAAAIABN4e11qac4iLQAAACsAAAAJAAAAAAAAAAAAAACAAZwAAABpbmRl'
    + 'eC5tanNQSwUGAAAAAAMAAwCzAAAA8AAAAAAA', 'base64');
  const name = 'zip-echo';
  const version = '1.0.0';
  const pkg = { name, family: 'code-plugin' };
  const config = { mcp: { servers: [] } };
  const { handlers } = buildRoutes({ name, version }, config, { clawHubTransport: {
    fetchText: async (url) => ({
      statusCode: 200,
      body: JSON.stringify(url.endsWith('/security')
        ? { package: pkg, release: { version }, trust: { blockedFromDownload: false } }
        : { package: pkg, version, artifact: { kind: 'legacy-zip', sha256: sha256Of(buffer) } })
    }),
    fetchBinary: async (url) => {
      assert.equal(url, 'https://clawhub.ai/api/v1/packages/zip-echo/download?version=1.0.0');
      return { buffer };
    }
  } });
  const result = {};
  await handlers.get('POST /api/plugins/install-clawhub')({}, result);
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  const [server] = config.mcp.servers;
  assert.equal(server.enabled, false);
  assert.match(fs.readFileSync(server.args[1], 'utf8'), /export default/);
});

test('市场安装的原生工具通过隔离 MCP 子进程注册并执行', async () => {
  const source = `
    import { readFileSync } from 'node:fs';
    import { definePluginEntry, emptyPluginConfigSchema } from 'openclaw/plugin-sdk';
    import type { EchoInput } from './types.ts';
    export default definePluginEntry({
      id: 'native-echo',
      configSchema: {
        safeParse(value: { prefix?: string }) {
          if (!emptyPluginConfigSchema().safeParse({}).success || value.prefix !== 'configured') {
            return { success: false };
          }
          return { success: true, data: { prefix: value.prefix.toUpperCase() } };
        }
      },
      register(api) {
        if (api.pluginConfig.prefix !== 'CONFIGURED') throw new Error('plugin config was not normalized');
        api.registerTool(() => ({
          name: 'factory_echo', description: 'Factory echo',
          parameters: { type: 'object' },
          execute(_id, { text }) { return { content: [{ type: 'text', text }] }; }
        }), { names: ['factory_echo'] });
        api.registerTool(() => { throw new Error('optional factory must stay inactive'); },
          { name: 'optional_tool', optional: true });
        api.registerTool({
          name: 'echo', description: 'Echo the given text',
          parameters: { type: 'object', properties: { text: { type: 'string' } } },
          execute(_id: string, { text }: EchoInput) {
            try {
              readFileSync('../../openclaw-isolation-marker.txt');
              throw new Error('读取了包外文件');
            } catch (error) {
              if (error.code !== 'ERR_ACCESS_DENIED') throw error;
            }
            return { content: [{ type: 'text', text }] };
          }
        });
      }
    });
  `;
  const buffer = buildTar([
    { name: 'openclaw.plugin.json', data: JSON.stringify({ id: 'native-echo' }) },
    { name: 'package.json', data: JSON.stringify({ openclaw: { extensions: ['./dist/index.mts'] } }) },
    { name: 'dist/index.mts', data: source },
    { name: 'dist/types.ts', data: 'export type EchoInput = { text: string };' }
  ]);
  const { entry } = normalizePluginIndexEntry({
    id: 'native-echo', openclawNative: true, url: 'https://example.com/echo.tgz', sha256: sha256Of(buffer)
  });
  const config = { mcp: { servers: [] } };
  fs.writeFileSync(path.join(dataDir, 'openclaw-isolation-marker.txt'), 'outside');
  const { handlers } = buildRoutes({ id: entry.id }, config, {
    loadIndex: async () => ({ plugins: [entry] }),
    fetchPackage: async () => ({ buffer })
  });
  const response = {};
  await handlers.get('POST /api/plugins/install')({}, response);
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(config.mcp.servers[0].enabled, false);
  assert.equal(config.mcp.servers[0].permissionIsolation, true);
  const { McpStdioClient } = await import('../src/mcp/client.js');
  const [server] = config.mcp.servers;
  assert.deepEqual(server.env, { QQ_AGENT_OPENCLAW_PLUGIN_CONFIG: '' });
  const client = new McpStdioClient({ ...server, timeoutMs: 5000,
    env: { QQ_AGENT_OPENCLAW_PLUGIN_CONFIG: JSON.stringify({ prefix: 'configured' }) } });
  try {
    await client.start();
    assert.deepEqual((await client.listTools()).map(({ name }) => name), ['echo', 'factory_echo']);
    assert.deepEqual(await client.callTool('echo', { text: 'hello' }),
      { content: [{ type: 'text', text: 'hello' }] });
    assert.deepEqual(await client.callTool('factory_echo', { text: 'factory' }),
      { content: [{ type: 'text', text: 'factory' }] });
  } finally {
    client.stop();
  }
});

test('内置声明式工具安装后可执行真实时区换算', async () => {
  const config = { mcp: { servers: [] } };
  const { handlers } = buildRoutes({ id: 'openclaw-time-format' }, config);
  const response = {};
  await handlers.get('POST /api/plugins/install')({}, response);
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  const { McpStdioClient } = await import('../src/mcp/client.js');
  const client = new McpStdioClient({ ...config.mcp.servers[0], timeoutMs: 5000 });
  try {
    await client.start();
    const result = await client.callTool('convert_timezone', {
      timestamp: '2026-11-27T08:00:00Z', timeZone: 'Asia/Shanghai'
    });
    assert.match(result.content[0].text, /16:00:00/);
  } finally {
    client.stop();
  }
});

test('OpenClaw 导入只登记停用的 MCP，并拒绝同名覆盖和越界入口', async () => {
  const directory = fs.mkdtempSync(path.join(dataDir, 'openclaw-'));
  const manifest = path.join(directory, 'openclaw.plugin.json');
  const entry = path.join(directory, 'server.mjs');
  fs.writeFileSync(entry, 'throw new Error("import must not run this");');
  fs.writeFileSync(path.join(dataDir, 'outside.mjs'), '');
  const writeManifest = (arg) => fs.writeFileSync(manifest, JSON.stringify({
    mcpServers: { example: { transport: 'stdio', command: 'node', args: [arg] } }
  }));
  writeManifest('./server.mjs');
  const existing = { id: 'existing' };
  const config = { mcp: { enabled: true, servers: [existing] } };
  const { handlers } = buildRoutes({ directory, serverName: 'example' }, config);
  const install = handlers.get('POST /api/plugins/install-openclaw');
  const res = {};
  await install({}, res);
  assert.equal(res.status, 200, JSON.stringify(res.payload));
  assert.deepEqual(config.mcp.servers, [
    existing,
    { id: 'example', enabled: false, transport: 'stdio', command: 'node',
      args: [fs.realpathSync(entry)], cwd: fs.realpathSync(directory), toolMounting: 'meta' }
  ]);
  await install({}, res);
  assert.equal(res.status, 409);
  writeManifest('./../outside.mjs');
  await install({}, res);
  assert.equal(res.status, 400);
  assert.equal(config.mcp.servers.length, 2);
});

test('/api/plugins/upgrade-preview 能调用注入的镜像配置（不是 TDZ 报错）', async () => {
  const { handlers } = buildRoutes({ id: 'weather' });
  const handler = handlers.get('POST /api/plugins/upgrade-preview');
  const res = {};
  await handler({ headers: {}, url: '/api/plugins/upgrade-preview', socket: {} }, res);
  assert.equal(res.status, 400, JSON.stringify(res.payload));
  // 走到镜像下载失败（E_DOWNLOAD）才证明 mirrorConfig() 真的被调用过；
  // 仅排除 TDZ 文案的话，注入返回 undefined 也能蒙混过关。
  assert.equal(res.payload?.code, 'E_DOWNLOAD', JSON.stringify(res.payload));
  assert.doesNotMatch(String(res.payload?.error || ''), /before initialization|is not defined/,
    '出现未初始化/未定义说明依赖注入被同名局部变量遮蔽');
});

test('/api/plugins/install 按索引安装路径同样能调用镜像配置', async () => {
  const { handlers } = buildRoutes({ id: 'weather' });
  const handler = handlers.get('POST /api/plugins/install');
  const res = {};
  await handler({ headers: {}, url: '/api/plugins/install', socket: {} }, res);
  assert.equal(res.status, 400, JSON.stringify(res.payload));
  // 走到镜像下载失败（E_DOWNLOAD）才证明 mirrorConfig() 真的被调用过；
  // 仅排除 TDZ 文案的话，注入返回 undefined 也能蒙混过关。
  assert.equal(res.payload?.code, 'E_DOWNLOAD', JSON.stringify(res.payload));
  assert.doesNotMatch(String(res.payload?.error || ''), /before initialization|is not defined/,
    '出现未初始化/未定义说明依赖注入被同名局部变量遮蔽');
});
