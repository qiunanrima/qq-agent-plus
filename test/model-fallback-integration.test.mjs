import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-fallback-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const { DEFAULT_CONFIG, setRuntimeConfig, updateConfig, getConfig } = await import('../src/core/config.js');
const { chatCompletionWithRetry } = await import('../src/llm/llm.js');
test('real routing bypasses failed CLI and uses configured API; config survives save', async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], model: 'mock-api' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.modelFallback = { enabled: true, graduated: false, order: ['agy', 'codex', 'api'] };
    cfg.antigravityCli = { ...cfg.antigravityCli, enabled: true, executable: 'missing-qq-agy-test', workspace: path.join(dir, 'agy') };
    cfg.codexCli = { ...cfg.codexCli, enabled: true, executable: 'missing-qq-codex-test', workspace: path.join(dir, 'codex') };
    cfg.api = { ...cfg.api, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'mock-api', temperature: null };
    setRuntimeConfig(cfg);
    updateConfig({ modelFallback: { order: ['agy', 'api', 'codex'] } });
    assert.deepEqual(getConfig().modelFallback.order, ['agy', 'api', 'codex']);
    assert.equal(getConfig().codexCli.enabled, true);
    const result = await chatCompletionWithRetry({ purpose: 'chat', messages: [{ role: 'user', content: 'test' }], mcpRun: { chatKey: 'private:1', runId: 'test', allowed: () => true, execute: () => { throw new Error('must not execute'); } } }, 0);
    assert.equal(result.message.content, 'ok'); assert.equal(result.backend, 'api'); assert.equal(result.viaFallback, true); assert.equal(calls, 1);
    updateConfig({ modelFallback: { order: ['agy', 'codex', 'api'] } });
    const second = await chatCompletionWithRetry({ purpose: 'chat', messages: [{ role: 'user', content: 'test' }], mcpRun: { chatKey: 'private:1', runId: 'test2', allowed: () => true, execute: () => { throw new Error('must not execute'); } } }, 0);
    assert.equal(second.backend, 'api'); assert.equal(calls, 2);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(disk.modelFallback.order, ['agy', 'codex', 'api']);
  } finally { await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
