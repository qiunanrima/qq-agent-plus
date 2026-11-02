import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personality-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, updateConfig, getConfig } = await import('../src/core/config.js');
const { createApp } = await import('../src/console/app.js');
const { resolvePersona } = await import('../src/personas.js');

test('鉴权、确认、停用管理和全量清除包含人格成长备份', async (t) => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: 'personality-api-token' };
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  cfg.api.priceRemoteUrl = 'none';
  cfg.runtime.mode = 'observe';
  updateConfig(cfg);
  const app = createApp({ log: () => {} });
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await app.start();
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, method = 'GET', body, auth = true) => fetch(origin + url, { method,
    headers: { ...(auth ? { 'x-console-token': cfg.server.token } : {}), 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/api/personality-memory/status', 'GET', null, false)).status, 401);
  assert.equal((await request('/api/memory/hippocampus', 'GET', null, false)).status, 401);
  const hippocampus = await (await request('/api/memory/hippocampus')).json();
  assert.equal(hippocampus.enabled, true);
  assert.equal(hippocampus.episodeCount, 0);
  assert.equal(fs.existsSync(path.join(root, 'hippocampus.sqlite')), false);
  const initial = await (await request('/api/personality-memory/status')).json();
  assert.deepEqual(initial.entries, []);
  assert.equal(fs.existsSync(app.personalityMemory.file), false);
  updateConfig({ personalityMemory: { enabled: true } });
  const row = app.store.appendSelf('group:1', { text: '我更喜欢绿茶', ts: Date.now() });
  const captured = app.personalityMemory.capture({ chatKey: 'group:1', persona: resolvePersona(getConfig(), 'group:1'), store: app.store,
    args: { kind: 'preference', topic: '饮品', content: '更喜欢绿茶', evidence: [{ messageId: row.id, quote: '我更喜欢绿茶' }] } });
  updateConfig({ personalityMemory: { enabled: false } });
  const endpoint = `/api/personality-memory/entries/${captured.id}`;
  assert.equal((await request(endpoint, 'POST', { content: '更喜欢绿茶', status: 'active' })).status, 409);
  assert.equal((await request(endpoint, 'POST', { confirm: true, content: '更喜欢绿茶', status: 'active' })).status, 200);
  assert.equal(app.personalityMemory.list()[0].status, 'active');
  assert.equal((await request(endpoint, 'DELETE', {})).status, 409);
  const reset = await request('/api/memory/reset-all', 'POST', { confirm: true, scope: 'all', includeArchive: true });
  assert.equal(reset.status, 200);
  const result = await reset.json();
  assert.equal(result.cleared.personality.entries, 1);
  assert.equal(fs.existsSync(path.join(root, 'memory-reset-backups', result.backupId, 'personality-memory.sqlite')), true);
  assert.equal(app.personalityMemory.list().length, 0);
  assert.equal(app.store.findByLocalId('group:1', row.id), null);
  assert.equal(getConfig().runtime.paused, true);
});
