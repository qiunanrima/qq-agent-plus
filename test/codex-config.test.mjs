import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadCliConfigs, validateCliConfigs } from '../src/core/cli-config.js';
const invalid = message => new Error(message);
test('CLI backend exclusivity rejects activation without changing other feature state', () => {
  assert.throws(() => validateCliConfigs({ codexCli: { enabled: true, workspace: path.resolve('codex') }, antigravityCli: { enabled: true, workspace: path.resolve('agy') } }, { codexCli: { enabled: true } }, invalid), /另一个/);
});
test('disabled malformed settings remain repairable and runtime flags do not imply graduation', () => {
  const cfg = { codexCli: { enabled: true, graduated: true, workspace: '' }, antigravityCli: {} };
  loadCliConfigs(cfg);
  assert.equal(cfg.codexCli.enabled, false); assert.equal(cfg.codexCli.graduated, true);
  assert.equal(cfg.codexCli.workspace, '');
  validateCliConfigs(cfg, { api: {} }, invalid);
  assert.throws(() => validateCliConfigs({ codexCli: { timeoutMs: 0 }, antigravityCli: {} }, { codexCli: {} }, invalid), /timeoutMs/);
});
test('a persisted double enable fails closed without erasing Codex configuration', () => {
  const cfg = { codexCli: { enabled: true, graduated: true, workspace: path.resolve('codex'), model: 'chosen' }, antigravityCli: { enabled: true, workspace: path.resolve('agy') } };
  loadCliConfigs(cfg);
  assert.equal(cfg.codexCli.enabled, false); assert.equal(cfg.codexCli.model, 'chosen'); assert.equal(cfg.codexCli.graduated, true);
});
