import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAntigravityResponse } from '../src/antigravity-cli/response-error.js';
import { parseAntigravityResult } from '../src/antigravity-cli/index.js';
import { runModelFallback } from '../src/model-fallback/index.js';

test('capacity diagnostics and explicit errors fail even when protocol reports success', () => {
  for (const text of ['Model capacity exhausted', '⚠️ Model capacity is exhausted. Please try again later.', 'The model is currently at capacity. Please try again later.', 'Error: Model has insufficient capacity', '模型容量不足，请稍后重试', '当前模型可用容量已耗尽', 'Error: request failed', '[ERROR] upstream unavailable']) {
    assert.throws(() => assertAntigravityResponse(text), /Antigravity/, text);
    assert.throws(() => parseAntigravityResult({ status: 'SUCCESS', structured_output: { content: text, tool_calls: [] } }), /Antigravity/, text);
  }
});
test('warnings and normal answers mentioning capacity remain successful', () => {
  for (const text of ['Warning: quota is running low', '⚠️ Warning: using default settings', '警告：部分功能不可用', '⚠️ 网络有点慢，但请求已完成', '遇到 Model capacity exhausted 时，可以稍后重试。', '正常回复']) {
    assert.doesNotThrow(() => assertAntigravityResponse(text), text);
    assert.equal(parseAntigravityResult({ status: 'SUCCESS', structured_output: { content: text, tool_calls: [] } }).message.content, text);
  }
});
test('capacity error falls back immediately while a warning returns on agy', async () => {
  for (const warning of [false, true]) {
    const seen = [];
    const result = await runModelFallback({ messages: [], mcpRun: { execute: async () => {}, allowed: () => true } }, {
      getConfig: () => ({ modelFallback: { enabled: true, order: ['agy', 'codex', 'api'] }, antigravityCli: { enabled: true }, codexCli: { enabled: true } }),
      complete: async (_, backend) => { seen.push(backend); if (backend === 'agy') assertAntigravityResponse(warning ? 'Warning: using default model' : 'Model capacity exhausted'); return {}; }
    });
    assert.deepEqual(seen, warning ? ['agy'] : ['agy', 'codex']);
    assert.equal(result.backend, warning ? 'agy' : 'codex');
  }
});
