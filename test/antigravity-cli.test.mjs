import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { antigravityCompletion, antigravityStatus, parseAntigravityResult } from '../src/antigravity-cli/index.js';
import { ANTIGRAVITY_DEFAULTS, normalizeAntigravityConfig, usesAntigravity } from '../src/antigravity-cli/config.js';

const workspace = fileURLToPath(new URL('.', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/antigravity-cli.mjs', import.meta.url));
const tools = [{ type: 'function', function: { name: 'send_message', parameters: { type: 'object' } } }];
const config = { ...ANTIGRAVITY_DEFAULTS, enabled: true, workspace, transport: 'json' };
const request = { config, tools, messages: [{ role: 'system', content: '角色卡' }, { role: 'user', content: 'hello $(shell)' }] };
function double(mode = 'ok', inspect = () => {}) {
  return { spawnProcess(executable, args, options) {
    inspect(executable, args, options);
    return spawn(process.execPath, [fixture, mode], options);
  } };
}

test('CLI protocol, stdin privacy, UTF-8, tool mapping and usage', async () => {
  const result = await antigravityCompletion(request, double('ok', (exe, args, options) => {
    assert.equal(exe, 'agy');
    assert.equal(options.shell, false);
    assert.equal(options.cwd, workspace);
    assert.ok(!args.join(' ').includes('hello'));
    assert.ok(!args.includes('--continue'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('--disable-slash-commands'));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
    assert.equal(settings.toolPermission, 'strict');
    assert.equal(settings.useG1Credits, false);
    assert.deepEqual(settings.permissions.allow, []);
    for (const action of ['read_file', 'write_file', 'read_url', 'execute_url', 'command', 'unsandboxed', 'mcp']) {
      assert.ok(settings.permissions.deny.includes(`${action}(*)`));
    }
  }));
  assert.equal(result.message.content, '你好🌸');
  assert.equal(result.message.tool_calls[0].function.name, 'send_message');
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 3);
  assert.equal(antigravityStatus().active, 0);
});

test('invalid streams, exit failures and output limits are not retryable', async () => {
  for (const mode of ['bad', 'exit', 'large', 'unsafe', 'tool']) {
    await assert.rejects(antigravityCompletion(request, double(mode)), e => {
      assert.equal(e.code, 'ANTIGRAVITY_NO_RETRY');
      assert.ok(!e.message.includes('secret diagnostic'));
      return true;
    });
  }
});

test('abort, runtime disable, timeout and concurrency release children', async () => {
  const controller = new AbortController();
  const pending = antigravityCompletion({ ...request, signal: controller.signal }, double('hang'));
  await assert.rejects(antigravityCompletion(request, double()), /busy/);
  controller.abort(new Error('cancelled'));
  await assert.rejects(pending, /cancelled/);
  let enabled = true;
  const disabled = antigravityCompletion({ ...request, isEnabled: () => enabled }, double('hang'));
  enabled = false;
  await assert.rejects(disabled, /disabled/);
  await assert.rejects(antigravityCompletion({ ...request, config: { ...config, timeoutMs: 1000 } }, double('hang')), /timed out/);
  assert.equal(antigravityStatus().active, 0);
});

test('rejects unknown tools, invalid arguments, missing required tools and multimodal input', async () => {
  const envelope = output => ({ status: 'SUCCESS', structured_output: output });
  assert.throws(() => parseAntigravityResult({ ...envelope({ content: 'ok', tool_calls: [] }), denied_actions: [{}] }), /denied native action/);
  assert.throws(() => parseAntigravityResult(envelope({ content: '', tool_calls: [{ name: 'run_command', arguments: '{}' }] }), tools), /tool request/);
  assert.throws(() => parseAntigravityResult(envelope({ content: '', tool_calls: [{ name: 'send_message', arguments: '[]' }] }), tools), /arguments/);
  assert.throws(() => parseAntigravityResult(envelope({ content: 'hi', tool_calls: [] }), tools, 'required'), /required/);
  await assert.rejects(antigravityCompletion({ ...request, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }, double()), /text only/);
});

test('defaults, lifecycle independence and routing boundaries', () => {
  assert.equal(ANTIGRAVITY_DEFAULTS.enabled, false);
  assert.equal(normalizeAntigravityConfig({ graduated: true }).enabled, false);
  assert.throws(() => normalizeAntigravityConfig({ enabled: true }), /absolute workspace/);
  assert.throws(() => normalizeAntigravityConfig({ enabled: 'true' }), /boolean/);
  assert.throws(() => normalizeAntigravityConfig({ timeoutMs: -1 }), /timeoutMs/);
  assert.throws(() => normalizeAntigravityConfig({ transport: 'unknown' }), /transport/);
  assert.throws(() => normalizeAntigravityConfig({ maxToolCalls: 0 }), /maxToolCalls/);
  assert.throws(() => normalizeAntigravityConfig(null), /object/);
  const cfg = { antigravityCli: config };
  assert.equal(usesAntigravity(cfg, { purpose: 'chat' }), true);
  assert.equal(usesAntigravity(cfg, { purpose: 'judge' }), false);
  assert.equal(usesAntigravity(cfg, { purpose: 'chat', overrides: {} }), false);
});
