import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestCliApproval, listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';
import { prepareMcpInvocation } from '../src/antigravity-cli/mcp-invocation.js';
import { normalizeAntigravityConfig } from '../src/antigravity-cli/config.js';
import { McpStdioClient } from '../src/mcp/client.js';
import { verifyNativeHooks } from '../src/antigravity-cli/verify-native-hooks.js';

const waitPending = async category => {
  for (let i = 0; i < 150; i++) {
    const entry = listCliApprovals().find(item => item.category === category);
    if (entry) return entry;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Expected pending approval');
};

test('approval is single-use, expires on cancellation/time/policy changes and has no future grant', async () => {
  const options = { category: 'qq', chatKey: 'private:test', runId: 'run', tool: 'send_message', args: { messages: ['hello'] } };
  const first = requestCliApproval(options);
  const entry = await waitPending('qq');
  assert.equal(decideCliApproval(entry.id, true), true);
  assert.equal(await first, true);
  assert.equal(decideCliApproval(entry.id, true), false);
  const controller = new AbortController();
  const cancelled = requestCliApproval({ ...options, signal: controller.signal });
  const cancelledEntry = await waitPending('qq');
  controller.abort();
  assert.equal(await cancelled, false);
  assert.equal(decideCliApproval(cancelledEntry.id, true), false);
  assert.equal(await requestCliApproval({ ...options, timeoutMs: 1 }), false);
  let allowed = true;
  const changed = requestCliApproval({ ...options, allowed: () => allowed });
  const changedEntry = await waitPending('qq'); allowed = false;
  assert.equal(decideCliApproval(changedEntry.id, true), false);
  assert.equal(await changed, false);
  assert.deepEqual(listCliApprovals(), []);
});

test('native hook asks before returning auto_approve; denial executes nothing and hook disconnect preserves MCP', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-approval-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let executed = 0;
  const invocation = await prepareMcpInvocation({ config: normalizeAntigravityConfig({ enabled: true, nativeApproval: true, qqApproval: true, workspace: root }),
    tools: [{ function: { name: 'probe', parameters: { type: 'object' } } }],
    mcpRun: { chatKey: 'private:test', runId: 'approval-run', allowed: () => true, execute: async () => { executed++; return { content: 'ok' }; } } });
  t.after(() => invocation.close());
  assert.match(fs.readFileSync(path.join(invocation.workspace, '.agents/agents/qq-mcp/agent.md'), 'utf8'), /inheritCustomizations: true/);
  const hook = name => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/antigravity-cli/native-hook.js', import.meta.url))], { cwd: invocation.workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error('Hook failed'))); });
    child.stdin.end(JSON.stringify({ toolCall: { name, args: { AbsolutePath: path.join(root, 'test.txt') } } }));
    return done;
  };
  const rejected = hook('view_file');
  let entry = await waitPending('native');
  assert.equal(executed, 0);
  assert.equal(decideCliApproval(entry.id, false), true);
  assert.equal((await rejected).decision, 'deny');
  const accepted = hook('view_file');
  entry = await waitPending('native');
  assert.equal(decideCliApproval(entry.id, true), true);
  assert.equal((await accepted).decision, 'auto_approve');
  assert.equal(executed, 0); // Hook tests never execute an actual native operation.
  const server = JSON.parse(fs.readFileSync(path.join(invocation.workspace, '.agents/mcp_config.json'))).mcpServers.qq_run;
  const client = new McpStdioClient({ id: 'qq_run', ...server, timeoutMs: 3000 });
  t.after(() => client.stop());
  await client.start();
  const call = client.callTool('qq_probe', {});
  entry = await waitPending('qq');
  assert.equal(executed, 0);
  decideCliApproval(entry.id, true);
  assert.equal((await call).isError, false);
  assert.equal(executed, 1);
  const pending = hook('view_file');
  entry = await waitPending('native'); invocation.revoke();
  assert.equal((await pending).decision, 'deny');
  assert.equal(decideCliApproval(entry.id, true), false);
});

test('native hook verification rejects inherited customization files, unexpected hooks and old CLI before model work', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-hook-verify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const invocation = { workspace: home, hookCommand: 'trusted command', settings: {} };
  const config = { executable: 'fake-agy', agent: 'qq-mcp' };
  let extra = false;
  const run = async (_exe, args) => ({ stdout: args[0] === '--version' ? '1.4.12' : JSON.stringify({ status: 'SUCCESS', num_turns: 0, command: { name: 'hooks', data: { hooks: [
    { name: 'qq-run-approval', enabled: true, source: path.join(home, '.agents/hooks.json'), actions: [{ event: 'PreToolUse', matcher: '*', command: 'trusted command' }] },
    ...(extra ? [{ name: 'unexpected', enabled: true }] : [])
  ] } } }) });
  await verifyNativeHooks(config, invocation, { home, run });
  extra = true;
  await assert.rejects(verifyNativeHooks(config, invocation, { home, run }), /Unexpected inherited hooks/);
  const oldCalls = [];
  await assert.rejects(verifyNativeHooks(config, invocation, { home, run: async (_exe, args) => { oldCalls.push(args); return { stdout: '1.0.0' }; } }), /supported CLI/);
  assert.deepEqual(oldCalls, [['--version']]);
  const dir = path.join(home, '.gemini/config/rules'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'private.md'), 'private context');
  await assert.rejects(verifyNativeHooks(config, invocation, { home, run: () => { throw new Error('must not run CLI'); } }), /isolated CLI customizations/);
});
