import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('malformed optional CLI config is disabled without resetting other settings; API validation uses HTTP 400', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-antigravity-config-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    api: { model: 'preserve-this-model' }, antigravityCli: { enabled: true, timeoutMs: -1 }
  }));
  const code = `
    const { getConfig, updateConfig } = await import(${JSON.stringify(new URL('../src/core/config.js', import.meta.url).href)});
    const cfg = getConfig();
    const result = { enabled: cfg.antigravityCli.enabled, model: cfg.api.model, invalidValue: cfg.antigravityCli.timeoutMs };
    updateConfig({ api: { temperature: 0.4 } });
    result.temperature = getConfig().api.temperature;
    try { updateConfig({ antigravityCli: { enabled: true } }); } catch (error) { result.httpStatus = error.httpStatus; }
    console.log(JSON.stringify(result));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, QQ_AGENT_DATA_DIR: dir }, encoding: 'utf8', timeout: 10000
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.deepEqual(result, { enabled: false, model: 'preserve-this-model', invalidValue: -1, temperature: 0.4, httpStatus: 400 });
});
