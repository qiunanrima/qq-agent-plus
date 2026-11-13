import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readCodexModels, parseCodexModels } from '../src/codex-cli/models.js';
import { registerCodexRoutes } from '../src/codex-cli/routes.js';
const fixture = fileURLToPath(new URL('./fixtures/codex-acp.mjs', import.meta.url));

test('model discovery while disabled sends no prompt or MCP and cleans process workspace', async t => {
  const workspace = await fs.mkdtemp(path.resolve('.codex/codex-catalog-'));
  await fs.mkdir(path.join(workspace, 'codex-home'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const query = mode => ({ spawnProcess: (_exe, _args, options) => {
    assert.equal(options.env.CODEX_HOME, path.join(workspace, 'codex-home'));
    assert.ok(options.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter));
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    return spawn(process.execPath, [fixture, mode], options);
  }, timeoutMs: mode === 'catalog-hang' ? 500 : 5000 });
  const cfg = { workspace, enabled: false };
  const result = await readCodexModels(cfg, query('catalog'));
  assert.deepEqual(result.models.map(m => m.id), ['test-model', 'other-model']);
  assert.equal(result.currentModel, 'test-model');
  assert.deepEqual(await fs.readdir(workspace), ['codex-home']);
  await assert.rejects(readCodexModels(cfg, query('catalog-hang')));
  assert.deepEqual(await fs.readdir(workspace), ['codex-home']);
  await fs.writeFile(path.join(workspace, 'codex-home', 'config.toml'), '');
  await assert.rejects(readCodexModels(cfg, query('catalog')), /must not contain/);
});

test('model catalog preserves base IDs, supports groups, removes duplicates and rejects invalid catalogs', () => {
  const session = { configOptions: [{ id: 'model', currentValue: 'test-model', options: [
    { options: [{ value: 'test-model', name: 'Test' }] }, { value: 'test-model' }, { value: '--bad' }, { value: 'x[low]' }
  ] }] };
  assert.deepEqual(parseCodexModels(session), { models: [{ id: 'test-model', name: 'Test' }], currentModel: 'test-model' });
  assert.throws(() => parseCodexModels({}), /unavailable/);
});

test('model route serializes queries, hides remote diagnostics and recovers after failure', async () => {
  const routes = new Map();
  let finish;
  registerCodexRoutes({ add: (method, url, handler) => routes.set(method + url, handler) }, {
    getConfig: () => ({ codexCli: {} }), json: (_res, status, body) => ({ status, body }),
    listModels: () => new Promise((resolve, reject) => { finish = { resolve, reject }; })
  });
  const handler = routes.get('POST/api/codex-cli/models');
  const pending = handler({}, {});
  assert.equal((await handler({}, {})).status, 409);
  finish.reject(new Error('secret diagnostic'));
  const failed = await pending;
  assert.equal(failed.status, 502);
  assert.ok(!JSON.stringify(failed).includes('secret'));
  const next = handler({}, {});
  finish.resolve({ models: [{ id: 'test-model', name: 'Test' }] });
  assert.equal((await next).status, 200);
});
