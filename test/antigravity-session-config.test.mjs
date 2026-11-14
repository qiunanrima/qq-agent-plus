import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configureAntigravitySession } from '../src/antigravity-cli/session-config.js';
const option = (value = 'high') => [{ id: 'thought_level', currentValue: value, options: [{ value: 'low' }, { value: 'high' }] }];
const session = () => ({ configOptions: option(), models: { availableModels: [{ modelId: 'new' }] } });

test('already selected effort does not send redundant configuration request', async () => {
  const seen = [];
  await configureAntigravitySession({ sessionId: 's', session: { configOptions: option('low') }, config: { effort: 'low' }, currentOptions: () => undefined, peer: { call: async m => { seen.push(m); return {}; } } });
  assert.deepEqual(seen, ['session/set_mode']);
});
test('model response or config update replaces stale effort options', async () => {
  for (const notification of [false, true]) {
    let live; const seen = [];
    const peer = { call: async (method, params) => {
      seen.push([method, params]);
      if (method === 'session/set_model') {
        const configOptions = [{ id: 'model_thinking', category: 'thought_level', currentValue: 'high', options: [{ options: [{ value: 'low' }] }] }];
        if (notification) { live = configOptions; return {}; }
        return { configOptions };
      }
      return {};
    } };
    await configureAntigravitySession({ peer, sessionId: 's', session: session(), config: { model: 'new', effort: 'low' }, currentOptions: () => live });
    assert.deepEqual(seen.at(-1), ['session/set_config_option', { sessionId: 's', configId: 'model_thinking', value: 'low' }]);
  }
});
test('rejected configuration remains a hard error with no prompt or silent retry', async () => {
  const seen = [], failure = new Error('ACP session/set_config_option failed (-32602)');
  await assert.rejects(configureAntigravitySession({ sessionId: 's', session: session(), config: { effort: 'low' }, currentOptions: () => undefined,
    peer: { call: async method => { seen.push(method); if (method === 'session/set_config_option') throw failure; return {}; } } }), error => error === failure);
  assert.deepEqual(seen, ['session/set_mode', 'session/set_config_option']);
});

test('configuration rejection goes straight to next fallback backend', async () => {
  const { runModelFallback } = await import('../src/model-fallback/index.js');
  const seen = [];
  const result = await runModelFallback({ messages: [], mcpRun: { execute: async () => {}, allowed: () => true } }, {
    getConfig: () => ({ modelFallback: { enabled: true, order: ['agy', 'codex', 'api'] }, antigravityCli: { enabled: true }, codexCli: { enabled: true } }),
    complete: async (_, backend) => {
      seen.push(backend);
      if (backend === 'agy') await configureAntigravitySession({ sessionId: 's', session: session(), config: { effort: 'low' }, currentOptions: () => undefined,
        peer: { call: async method => { if (method === 'session/set_config_option') throw new Error('ACP session/set_config_option failed (-32602)'); return {}; } } });
      return {};
    }
  });
  assert.deepEqual(seen, ['agy', 'codex']); assert.equal(result.backend, 'codex');
});
