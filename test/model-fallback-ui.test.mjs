import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { Window } from 'happy-dom';
import { toClassicScript } from './helpers/ui-module-source.mjs';
test('fallback UI persists isolated toggle, order and graduation changes', async () => {
  const window = new Window(), document = window.document;
  const state = { config: { modelFallback: { enabled: false, graduated: false, order: ['agy', 'codex', 'api'] } } };
  const writes = [], alerts = [];
  const ctx = vm.createContext({ document, state, $: selector => document.querySelector(selector), esc: x => String(x), alert: x => alerts.push(x),
    api: async (_url, options) => { const patch = JSON.parse(options.body); writes.push(patch); Object.assign(state.config.modelFallback, patch.modelFallback); return { config: state.config }; },
    renderSettings: () => { document.body.innerHTML = state.settingsSection === 'model-fallback' ? ctx.renderModelFallbackSection(state.config) : ctx.renderModelFallbackExperiment(state.config); ctx.bindModelFallbackSettings(); }
  });
  vm.runInContext(toClassicScript(fs.readFileSync('ui/pages/model-fallback.js', 'utf8')), ctx);
  const click = async selector => { document.querySelector(selector).click(); await new Promise(resolve => setTimeout(resolve, 0)); };
  try {
    ctx.renderSettings(); await click('#model-fallback-toggle'); assert.equal(state.config.modelFallback.enabled, true);
    await click('#model-fallback-graduate'); assert.equal(state.config.modelFallback.graduated, true);
    await click('#model-fallback-open'); assert.equal(state.settingsSection, 'model-fallback');
    await click('[data-fallback-move="2"][data-direction="-1"]');
    assert.deepEqual(Array.from(state.config.modelFallback.order), ['agy', 'api', 'codex']);
    assert.match(document.querySelector('#model-fallback-order').textContent, /2\. api/);
    assert.equal(writes.length, 3); assert.ok(writes.every(patch => Object.keys(patch).join() === 'modelFallback'));
    assert.deepEqual(alerts, []);
  } finally { await window.happyDOM.abort(); window.close(); }
});
