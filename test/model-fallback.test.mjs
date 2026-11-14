import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { runModelFallback } from '../src/model-fallback/index.js';
import { normalizeModelFallback } from '../src/model-fallback/config.js';
import { loadCliConfigs, validateCliConfigs } from '../src/core/cli-config.js';
const config = () => ({ modelFallback: { enabled: true, order: ['agy', 'codex', 'api'] }, antigravityCli: { enabled: true, workspace: path.resolve('agy') }, codexCli: { enabled: true, workspace: path.resolve('codex') }, api: { baseUrl: 'https://example.test/v1', model: 'test' } });
const args = () => ({ messages: [], mcpRun: { execute: async () => ({}), allowed: () => true } });
test('default order, reorder validation and CLI coexistence persist', () => {
  assert.deepEqual(normalizeModelFallback().order, ['agy', 'codex', 'api']);
  assert.equal(normalizeModelFallback().enabled, false);
  for (const raw of [{ order: ['api', 'api', 'agy'] }, { enabled: 'yes' }, { order: ['api'] }]) assert.throws(() => normalizeModelFallback(raw));
  const c = config(); loadCliConfigs(c); assert.equal(c.codexCli.enabled, true);
  validateCliConfigs(c, {}, x => new Error(x));
  c.modelFallback.enabled = false;
  assert.throws(() => validateCliConfigs(c, {}, x => new Error(x)), /另一个/);
});
test('falls through agy and codex to API and records actual backend', async () => {
  const c = config(), seen = [], switches = [];
  const result = await runModelFallback(args(), { getConfig: () => c, onFallback: (...p) => switches.push(p), complete: async (_, backend) => {
    seen.push(backend); if (backend !== 'api') throw new Error('quota exhausted'); return { model: 'test' };
  } });
  assert.deepEqual(seen, ['agy', 'codex', 'api']); assert.equal(result.backend, 'api'); assert.equal(result.viaFallback, true); assert.equal(switches.length, 2);
});
test('custom order starts with API; skips disabled and multimodal CLI', async () => {
  const c = config(); c.modelFallback.order = ['api', 'codex', 'agy']; const seen = [];
  await runModelFallback(args(), { getConfig: () => c, complete: async (_, b) => { seen.push(b); return {}; } });
  assert.deepEqual(seen, ['api']);
  c.modelFallback.order = ['agy', 'codex', 'api']; seen.length = 0;
  await runModelFallback({ ...args(), messages: [{ content: [{ type: 'image_url' }] }] }, { getConfig: () => c, complete: async (_, b) => { seen.push(b); return {}; } });
  assert.deepEqual(seen, ['api']);
  c.antigravityCli.enabled = false; seen.length = 0;
  await runModelFallback(args(), { getConfig: () => c, complete: async (_, b) => { seen.push(b); return {}; } });
  assert.deepEqual(seen, ['codex']);
});
test('a successful, failed or unknown host tool attempt prevents replay', async () => {
  for (const fails of [false, true]) {
    const seen = [], a = args(); a.mcpRun.execute = async () => { if (fails) throw new Error('unknown write'); };
    await assert.rejects(runModelFallback(a, { getConfig: config, complete: async (next, b) => {
      seen.push(b); await next.mcpRun.execute('send_message', {}); throw new Error('failed after send');
    } }));
    assert.deepEqual(seen, ['agy']);
  }
});
test('cancellation, disable and revoked access stop fallback', async () => {
  for (const kind of ['abort', 'disable', 'access', 'cancel-code']) {
    const c = config(), a = args(), seen = [], controller = new AbortController(); a.signal = controller.signal;
    a.mcpRun.approvalAllowed = () => true;
    await assert.rejects(runModelFallback(a, { getConfig: () => c, complete: async (_next, b) => {
      seen.push(b);
      if (kind === 'abort') controller.abort();
      if (kind === 'disable') c.modelFallback.enabled = false;
      if (kind === 'access') a.mcpRun.allowed = () => false;
      throw Object.assign(new Error('stopped'), { code: kind === 'cancel-code' ? 'RUN_CANCELLED' : '' });
    } }));
    assert.deepEqual(seen, ['agy'], kind);
  }
});
test('exhaustion reports failure, next request starts at first choice', async () => {
  const seen = [];
  for (let n = 0; n < 2; n++) await assert.rejects(runModelFallback(args(), { getConfig: config, complete: async (_, b) => { seen.push(b); throw new Error('unavailable'); } }), /unavailable/);
  assert.deepEqual(seen, ['agy', 'codex', 'api', 'agy', 'codex', 'api']);
});

test('native permission checks do not block configuration-error fallback', async () => {
  const seen = [], a = args();
  let checks = 0;
  a.mcpRun.approvalAllowed = category => { checks++; return category === 'native'; };
  const result = await runModelFallback(a, { getConfig: config, complete: async (next, backend) => {
    seen.push(backend);
    if (backend === 'agy') {
      assert.equal(next.mcpRun.approvalAllowed('native'), true);
      assert.equal(next.mcpRun.approvalAllowed('native'), true);
      throw new Error('ACP session/set_config_option failed (-32602)');
    }
    return {};
  } });
  assert.deepEqual(seen, ['agy', 'codex']); assert.equal(result.backend, 'codex'); assert.equal(checks, 2);
});
test('native tools remain usable and do not form the QQ host tool replay boundary', async () => {
  const seen = [], nativeCalls = [], a = args();
  a.mcpRun.approvalAllowed = () => true;
  a.mcpRun.nativeProbe = async () => { nativeCalls.push('native'); return { content: 'native result' }; };
  const result = await runModelFallback(a, { getConfig: config, complete: async (next, backend) => {
    seen.push(backend);
    if (backend === 'agy') {
      assert.equal(next.mcpRun.approvalAllowed('native'), true);
      await next.mcpRun.nativeProbe();
      throw new Error('AGY failed after native operation');
    }
    return {};
  } });
  assert.deepEqual(nativeCalls, ['native']); assert.deepEqual(seen, ['agy', 'codex']); assert.equal(result.backend, 'codex');
});
test('QQ host tool start still blocks fallback when native permissions are enabled', async () => {
  const seen = [], a = args(); a.mcpRun.approvalAllowed = () => true;
  await assert.rejects(runModelFallback(a, { getConfig: config, complete: async (next, backend) => {
    seen.push(backend); next.mcpRun.approvalAllowed('native');
    await next.mcpRun.execute('send_message', {});
    throw new Error('failed after QQ send');
  } }), /failed after QQ send/);
  assert.deepEqual(seen, ['agy']);
});
