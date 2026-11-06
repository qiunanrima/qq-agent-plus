import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAcpPermissionHandler } from '../src/antigravity-cli/acp-permissions.js';
import { nativeHookDecision } from '../src/antigravity-cli/native-ask-hook.js';
import { acpCompletion } from '../src/antigravity-cli/acp-completion.js';
import { listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';
import fs from 'node:fs/promises';
import { verifyNativeHooks } from '../src/antigravity-cli/verify-native-hooks.js';
import { antigravityCompletion, antigravityStatus } from '../src/antigravity-cli/index.js';

const run = { chatKey: 'private:1', runId: 'test', allowed: () => true, approvalAllowed: () => true };
const options = [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'once' }];
const fakeServers = [{ name: 'qq_run', command: 'offline-only', args: [], env: [] }];
const params = (id = 'call') => ({ sessionId: 'session', toolCall: { toolCallId: id, name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'echo offline' } }, options });
async function waitPending() {
  for (let i = 0; i < 100; i++) {
    const entry = listCliApprovals().find(p => p.category === 'native');
    if (entry) return entry;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('No native approval');
}
test('native hooks force approval every time and never autoapprove native tools', () => {
  for (const name of ['view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'run_command'])
    assert.equal(nativeHookDecision({ toolCall: { name, args: {} } }).decision, 'force_ask');
  for (const name of ['invoke_subagent', 'read_url_content', 'send_message', 'unknown'])
    assert.equal(nativeHookDecision({ toolCall: { name, args: {} } }).decision, 'deny');
});
test('ACP grants only once after explicit decision, binds session and prevents replay', async () => {
  const controller = new AbortController();
  const permit = createAcpPermissionHandler({ sessionId: () => 'session', mcpRun: run, workspace: os.tmpdir(), signal: controller.signal, isEnabled: () => true, maxCalls: 8 });
  const pending = permit(params()); const entry = await waitPending();
  assert.equal(entry.category, 'native'); assert.match(entry.preview, /echo offline/);
  decideCliApproval(entry.id, true);
  assert.deepEqual(await pending, { outcome: { outcome: 'selected', optionId: 'once' } });
  assert.equal((await permit(params())).outcome.outcome, 'cancelled');
  assert.equal((await permit({ ...params('two'), sessionId: 'other' })).outcome.outcome, 'cancelled');
  assert.equal((await permit({ ...params('three'), options: [{ kind: 'allow_always', optionId: 'always' }] })).outcome.outcome, 'cancelled');
  const denied = permit(params('four')); const deniedEntry = await waitPending(); decideCliApproval(deniedEntry.id, false);
  assert.equal((await denied).outcome.outcome, 'cancelled');
  const aborted = permit(params('five')); const abortedEntry = await waitPending(); controller.abort();
  assert.equal((await aborted).outcome.outcome, 'cancelled'); assert.equal(decideCliApproval(abortedEntry.id, true), false);
});
test('protected files, unknown native tools and persistent commands cannot be approved', async () => {
  const permit = createAcpPermissionHandler({ sessionId: () => 'session', mcpRun: run, workspace: os.tmpdir(), signal: new AbortController().signal, isEnabled: () => true, maxCalls: 8 });
  for (const [name, rawInput] of [['unknown', { CommandLine: 'echo x' }], ['view_file', { AbsolutePath: path.join(os.homedir(), '.ssh') }], ['run_command', { CommandLine: 'echo x', RunPersistent: true }]]) {
    assert.equal((await permit({ ...params(name), toolCall: { toolCallId: name, name, rawInput } })).outcome.outcome, 'cancelled');
  }
});
test('real offline ACP subprocess waits for approval, rejection produces no effect', async () => {
  for (const approved of [true, false]) {
    const completion = acpCompletion({ config: { executable: process.execPath, agent: 'qq-mcp', effort: 'low', timeoutMs: 3000, maxToolCalls: 8, model: 'fake-model' },
      invocation: { workspace: os.tmpdir(), acpMcpServers: fakeServers, mcpReady: () => true, calls: () => 0, finished: () => false, policyChanged: () => false },
      prompt: 'offline', mcpRun: run, isEnabled: () => true,
      spawnProcess: (_exe, _args, opts) => spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-acp.mjs', import.meta.url))], opts)
    }, { verify: async () => {} });
    const entry = await waitPending(); decideCliApproval(entry.id, approved);
    const result = await completion;
    assert.equal(result.message.content, approved ? 'effect-confirmed' : 'effect-blocked');
    assert.equal(result.raw.driver, 'acp'); assert.equal(result.usage, undefined);
  }
});

test('ACP deadline revokes unanswered approval and kills the subprocess', async () => {
  const completion = acpCompletion({ config: { executable: process.execPath, agent: 'qq-mcp', effort: 'low', timeoutMs: 500, maxToolCalls: 8 },
    invocation: { workspace: os.tmpdir(), acpMcpServers: fakeServers, mcpReady: () => true, calls: () => 0, finished: () => false, policyChanged: () => false },
    prompt: 'offline', mcpRun: run, isEnabled: () => true,
    spawnProcess: (_exe, _args, opts) => spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-acp.mjs', import.meta.url)), 'hang'], opts)
  }, { verify: async () => {} });
  const rejection = assert.rejects(completion, /timed out/);
  const entry = await waitPending();
  await rejection; assert.equal(decideCliApproval(entry.id, true), false);
  assert.deepEqual(listCliApprovals(), []);
});

test('missing MCP discovery never starts a model prompt', async () => {
  let prompted = false;
  const completion = acpCompletion({ config: { executable: process.execPath, agent: 'qq-mcp', effort: 'low', timeoutMs: 400, maxToolCalls: 8 },
    invocation: { workspace: os.tmpdir(), acpMcpServers: fakeServers, mcpReady: () => false,
      calls: () => 0, finished: () => false, policyChanged: () => false }, prompt: 'offline', mcpRun: run, isEnabled: () => true,
    spawnProcess: (_exe, _args, opts) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-acp.mjs', import.meta.url))], opts);
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => { if (String(args[0]).includes('session/prompt')) prompted = true; return write(...args); };
      return child;
    }
  }, { verify: async () => {} });
  await assert.rejects(completion, /timed out/);
  assert.equal(prompted, false); assert.deepEqual(listCliApprovals(), []);
});

test('native hook verification rejects other hooks and paid-credit profile without model calls', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'native-profile-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const invocation = { workspace: home, hookCommand: 'trusted-command' };
  let queries = 0, extra = false;
  const metadata = async (_exe, args) => {
    queries++;
    if (args[0] === '--version') return { stdout: '1.4.12' };
    assert.ok(args.includes('/hooks'));
    return { stdout: JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'hooks', data: { hooks: [
      { name: 'qq-run-approval', source: path.join(home, '.agents/hooks.json'), actions: [{ event: 'PreToolUse', matcher: '*', command: 'trusted-command' }] },
      ...(extra ? [{ name: 'other' }] : [])
    ] } } }) };
  };
  await verifyNativeHooks({ executable: 'unused', agent: 'qq-mcp' }, invocation, { run: metadata, home });
  extra = true;
  await assert.rejects(verifyNativeHooks({ executable: 'unused' }, invocation, { run: metadata, home }), /Unexpected inherited/);
  await fs.mkdir(path.join(home, '.gemini/config'), { recursive: true });
  await fs.writeFile(path.join(home, '.gemini/config/config.json'), JSON.stringify({ userSettings: { useG1Credits: true } }));
  const count = queries;
  await assert.rejects(verifyNativeHooks({}, invocation, { run: metadata, home }), /credit spending/);
  assert.equal(queries, count);
});

test('normal adapter selects ACP only on opt-in and cleans isolated workspace and lock', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'native-adapter-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let checked = false, executed = 0;
  const completion = antigravityCompletion({ config: { enabled: true, nativeApproval: true, workspace, executable: process.execPath },
    messages: [{ role: 'user', content: 'offline probe' }], tools: [{ function: { name: 'probe', parameters: { type: 'object' } } }], mcpRun: { ...run,
      execute: async name => { assert.equal(name, 'probe'); executed++; return { content: 'host-probe-ok' }; },
      approvalAllowed: category => category === 'native' } }, {
    verifyNative: async (_config, invocation) => {
      const agent = await fs.readFile(path.join(invocation.workspace, '.agents/agents/qq-mcp/agent.md'), 'utf8');
      assert.match(agent, /inheritCustomizations: true/); assert.doesNotMatch(agent, /commandExecutionPolicy: off/);
      const hooks = JSON.parse(await fs.readFile(path.join(invocation.workspace, '.agents/hooks.json'), 'utf8'));
      assert.equal(hooks['qq-run-approval'].PreToolUse[0].hooks[0].command, invocation.hookCommand);
      checked = true;
    },
    spawnProcess: (_exe, args, opts) => {
      assert.equal(args[0], 'acp');
      assert.ok(args.includes('--include-default-customizations=false'));
      assert.ok(!args.includes('--dangerously-skip-permissions'));
      return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-acp.mjs', import.meta.url)), 'mcp-probe'], opts);
    }
  });
  const entry = await waitPending(); decideCliApproval(entry.id, true);
  const result = await completion;
  assert.equal(result.raw.driver, 'acp'); assert.equal(checked, true);
  assert.equal(result.raw.mcpCalls, 1); assert.equal(executed, 1);
  assert.deepEqual(await fs.readdir(workspace), []);
  assert.deepEqual(antigravityStatus(), { active: 0, queued: 0 });
});
