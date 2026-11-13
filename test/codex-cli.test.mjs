import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { codexCompletion, codexStatus } from '../src/codex-cli/index.js';
import { CODEX_DEFAULTS, normalizeCodexConfig, usesCodex } from '../src/codex-cli/config.js';
const fixture = fileURLToPath(new URL('./fixtures/codex-acp.mjs', import.meta.url));
async function setup(t, mode = 'ok') {
  const workspace = await fs.mkdtemp(path.resolve('.codex/qq-codex-test-'));
  await fs.mkdir(path.join(workspace, 'codex-home'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [];
  let finished = false, spawned = 0;
  const request = { config: { enabled: true, workspace, timeoutMs: 5000 }, messages: [{ role: 'user', content: 'private $(shell)' }],
    tools: ['probe', 'finish'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {}, additionalProperties: false } } })),
    mcpRun: { chatKey: workspace, runId: 'test-run', allowed: () => true, isFinished: () => finished,
      execute: async name => { calls.push(name); if (name === 'finish') finished = true; return { content: 'host-probe-ok' }; } } };
  const deps = { spawnProcess: (exe, args, options) => {
    spawned++;
    assert.equal(options.shell, false); assert.ok(!args.join(' ').includes('private'));
    assert.equal(options.env.CODEX_HOME, path.join(workspace, 'codex-home'));
    assert.equal(JSON.parse(options.env.CODEX_CONFIG).features.shell_tool, false);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    return spawn(process.execPath, [fixture, mode], options);
  } };
  return { workspace, request, deps, calls, spawned: () => spawned };
}
test('Codex lifecycle defaults and chat-only routing', () => {
  assert.equal(CODEX_DEFAULTS.enabled, false);
  assert.equal(normalizeCodexConfig({ graduated: true }).enabled, false);
  assert.equal(usesCodex({ codexCli: { enabled: true } }, { purpose: 'chat' }), true);
  assert.equal(usesCodex({ codexCli: { enabled: true } }, { purpose: 'memory' }), false);
  assert.equal(usesCodex({ codexCli: { enabled: true } }, { purpose: 'chat', overrides: {} }), false);
  assert.throws(() => normalizeCodexConfig({ enabled: true }), /absolute/);
  assert.throws(() => normalizeCodexConfig({ maxConcurrent: 0 }));
});
test('Codex ACP denies native permissions, calls scoped MCP once and cleans temporary workspace', async t => {
  const s = await setup(t);
  const result = await codexCompletion(s.request, s.deps);
  assert.deepEqual(s.calls, ['probe']); assert.equal(s.spawned(), 1);
  assert.equal(result.message.content, 'native-denied-mcp-ok'); assert.equal(result.message.tool_calls, undefined);
  assert.equal(result.toolsExecutedViaMcp, true); assert.equal(result.usage, undefined);
  assert.deepEqual(await fs.readdir(s.workspace), ['codex-home']); assert.equal(codexStatus().active, 0);
});
test('host finish closes hanging ACP without replay or invented usage', async t => {
  const s = await setup(t, 'finish');
  const result = await codexCompletion(s.request, s.deps);
  assert.deepEqual(s.calls, ['probe', 'finish']); assert.equal(s.spawned(), 1);
  assert.equal(result.raw.status, 'HOST_FINISHED'); assert.equal(result.raw.usageUnavailable, true);
});

test('Codex native operation is denied while correlated host MCP permission allows actual execution', async t => {
  const s = await setup(t, 'approval');
  const result = await codexCompletion(s.request, s.deps);
  assert.deepEqual(s.calls, ['probe']);
  assert.deepEqual(result.raw.permissions, { hostAllowed: 1, denied: 1 });
  assert.equal(s.spawned(), 1);
});

test('queued Codex completion starts no child until the active request releases its slot', async t => {
  const first = await setup(t, 'hang'), second = await setup(t);
  const controller = new AbortController();
  const active = codexCompletion({ ...first.request, signal: controller.signal }, first.deps);
  await new Promise(resolve => setTimeout(resolve, 150));
  const queued = codexCompletion(second.request, second.deps);
  assert.equal(codexStatus().queued, 1); assert.equal(second.spawned(), 0);
  controller.abort(); await assert.rejects(active, e => e.code === 'CODEX_NO_RETRY');
  assert.equal((await queued).message.content, 'native-denied-mcp-ok');
  assert.equal(second.spawned(), 1); assert.deepEqual(codexStatus(), { active: 0, queued: 0, driver: 'acp' });
});
test('cancel, disable and deadline revoke ACP children and release concurrency slots', async t => {
  for (const mode of ['abort', 'disable', 'timeout']) {
    const s = await setup(t, 'hang'); const controller = new AbortController(); let enabled = true;
    const pending = codexCompletion({ ...s.request, config: { ...s.request.config, timeoutMs: 1000 }, signal: controller.signal, isEnabled: () => enabled }, s.deps);
    await new Promise(resolve => setTimeout(resolve, 150));
    const queuedController = new AbortController();
    const queued = codexCompletion({ ...s.request, signal: queuedController.signal }, s.deps);
    assert.equal(codexStatus().queued, 1);
    queuedController.abort(); await assert.rejects(queued, e => e.code === 'CODEX_NO_RETRY');
    if (mode === 'abort') controller.abort(); if (mode === 'disable') enabled = false;
    await assert.rejects(pending, e => e.code === 'CODEX_NO_RETRY');
    assert.equal(codexStatus().active, 0); assert.deepEqual(await fs.readdir(s.workspace), ['codex-home']);
  }
});
test('disabled, malformed input and personal config fail before spawning', async t => {
  const s = await setup(t);
  await assert.rejects(codexCompletion({ ...s.request, config: { ...s.request.config, enabled: false } }, s.deps));
  await assert.rejects(codexCompletion({ ...s.request, messages: [{ content: [{ type: 'image_url' }] }] }, s.deps), /text only/);
  await fs.writeFile(path.join(s.workspace, 'codex-home', 'config.toml'), '[mcp_servers.untrusted]');
  await assert.rejects(codexCompletion(s.request, s.deps), /must not contain/);
  assert.equal(s.spawned(), 0); assert.equal(codexStatus().active, 0);
});
test('empty ACP end_turn is not a successful conversation', async t => {
  const s = await setup(t, 'empty'); await assert.rejects(codexCompletion(s.request, s.deps), /Empty Codex/);
});

test('selected base model uses config option, then sets supported reasoning effort', async t => {
  const s = await setup(t);
  s.request.config.model = 'test-model';
  assert.equal((await codexCompletion(s.request, s.deps)).message.content, 'native-denied-mcp-ok');
  s.request.config.model = 'missing-model';
  await assert.rejects(codexCompletion(s.request, s.deps), /model unavailable/);
});

test('unknown host-tool outcomes cancel the run and never spawn another ACP child', async t => {
  const s = await setup(t);
  s.request.mcpRun.execute = async () => { throw new Error('external write outcome unknown'); };
  await assert.rejects(codexCompletion(s.request, s.deps), e => e.code === 'CODEX_NO_RETRY');
  assert.equal(s.spawned(), 1); assert.equal(codexStatus().active, 0);
});
