import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpPool } from '../src/antigravity-cli/acp-pool.js';
import { acpCompletion } from '../src/antigravity-cli/acp-completion.js';
import { prepareMcpInvocation } from '../src/antigravity-cli/mcp-invocation.js';
import { listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';
import { createAcpNativeClient } from '../src/antigravity-cli/acp-native-client.js';
import { createAcpPermissionHandler } from '../src/antigravity-cli/acp-permissions.js';

test('fourth chat evicts oldest even busy, concurrent acquisitions stay bounded', async () => {
  const pool = createAcpPool({ maxProcesses: 3, maxTurns: Infinity });
  const live = new Set(), closed = [];
  const acquire = key => pool.acquire(key, 'cfg', async () => {
    live.add(key); assert.ok(live.size <= 3);
    return { peer: { close: async () => { live.delete(key); closed.push(key); } } };
  }, () => true);
  const a = await acquire('a');
  const b = await acquire('b'); await b.release(true);
  const c = await acquire('c');
  const reused = await acquire('b'); await reused.release(true);
  const d = await acquire('d');
  assert.deepEqual(closed, ['a']);
  await a.release(true); // Evicted owner cannot resurrect its lease.
  await Promise.all([acquire('e'), acquire('f')]);
  assert.deepEqual([...live], ['d', 'e', 'f']);
  await c.release(true); await d.release(true);
  await pool.close(); assert.equal(live.size, 0);
});

test('default cap is five and retained worker groups recycle after two turns', async () => {
  const pool = createAcpPool(); const live = new Set();
  const acquire = key => pool.acquire(key, '', async () => {
    live.add(key); assert.ok(live.size <= 5);
    return { peer: { close: async () => { live.delete(key); } } };
  }, () => true);
  for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) await acquire(key);
  assert.deepEqual([...live], ['b', 'c', 'd', 'e', 'f']);
  await pool.close();
  const first = await acquire('one'); await first.release(true);
  const second = await acquire('one'); assert.equal(first.entry, second.entry);
  await second.release(true); assert.equal(live.size, 0);
  await pool.close();
});

test('idle expiry, policy changes, failures and capacity dispose chat processes', async () => {
  let created = 0, disposed = 0, valid = true;
  const pool = createAcpPool({ idleMs: 40, maxIdle: 1 });
  const create = async () => { created++; return { peer: { close: async () => {} }, dispose: async () => { disposed++; } }; };
  const first = await pool.acquire('a', 'cfg', create, () => valid);
  await first.release(true);
  const reused = await pool.acquire('a', 'cfg', create, () => valid);
  assert.equal(created, 1);
  await assert.rejects(pool.acquire('a', 'cfg', create, () => valid), /active/);
  await reused.release(true);
  valid = false;
  const changed = await pool.acquire('a', 'new', create, () => true);
  assert.equal(created, 2); assert.equal(disposed, 1);
  await changed.release(false);
  assert.equal(disposed, 2);
  const a = await pool.acquire('a', 'cfg', create, () => true); await a.release(true);
  const b = await pool.acquire('b', 'cfg', create, () => true); await b.release(true);
  assert.equal(disposed, 3);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(disposed, 4);
  await pool.close();
});

test('pooled timeout revokes pending approval and disposes the process', async t => {
  const pool = createAcpPool(); t.after(() => pool.close());
  let retained = 0, disposed = 0;
  await assert.rejects(acpCompletion({ config: { executable: process.execPath, agent: 'qq-mcp', effort: 'low', timeoutMs: 500, maxToolCalls: 8 },
    invocation: { workspace: os.tmpdir(), acpMcpServers: [{ name: 'qq_run', command: 'offline', args: [], env: [] }],
      mcpReady: () => true, calls: () => 0, finished: () => false, policyChanged: () => false,
      retainWorkspace: () => { retained++; }, releaseWorkspace: async () => { disposed++; } },
    prompt: 'offline', mcpRun: { chatKey: 'private:1', runId: 'timeout', allowed: () => true, approvalAllowed: () => true }, isEnabled: () => true,
    spawnProcess: (_exe, _args, options) => spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-acp.mjs', import.meta.url)), 'hang'], options)
  }, { pool, verify: async () => {} }), /timed out/);
  assert.equal(retained, 1); assert.equal(disposed, 1);
  assert.deepEqual(listCliApprovals(), []);
});

test('retained process control files remain protected from subsequent turns', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-controls-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const old = path.join(root, 'qq-run-old', '.agents'); await fs.mkdir(old, { recursive: true });
  const file = path.join(old, 'hooks.json'); await fs.writeFile(file, '{}');
  const workspace = path.join(root, 'qq-run-new'); await fs.mkdir(workspace);
  const shared = { sessionId: () => 'new', workspace, controlRoot: root, signal: new AbortController().signal,
    isEnabled: () => true, maxCalls: 8, mcpRun: { allowed: () => true, approvalAllowed: () => true } };
  const native = createAcpNativeClient(shared);
  await assert.rejects(native.request('fs/read_text_file', { sessionId: 'new', path: file }), /Protected/);
  const permit = createAcpPermissionHandler(shared);
  const result = await permit({ sessionId: 'new', toolCall: { toolCallId: 'old', name: 'read_file', rawInput: { Path: file } },
    options: [{ kind: 'allow_once', optionId: 'once' }] });
  assert.equal(result.outcome.outcome, 'cancelled');
  assert.deepEqual(listCliApprovals(), []);
  await native.close();
});

for (const mode of ['pool-probe', 'pool-cancel']) test(`real offline process reused only within chat; MCP and approvals remain turn scoped (${mode})`, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'acp-pool-'));
  const pool = createAcpPool();
  t.after(async () => { await pool.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const config = { executable: process.execPath, workspace, agent: 'qq-mcp', effort: 'low',
    nativeApproval: true, qqApproval: false, timeoutMs: 3000, maxToolCalls: 8, model: 'fake-model' };
  let starts = 0, checks = 0;
  const executed = [], sessions = [];
  let oldInvocation;
  for (const [chatKey, runId] of [['private:1', 'one'], ['private:1', 'two'], ['group:1', 'three']]) {
    let finished = false;
    const mcpRun = { chatKey, runId, allowed: () => true, approvalAllowed: category => category === 'native',
      isFinished: () => finished,
      execute: async name => { executed.push([chatKey, runId, name]); finished = mode === 'pool-cancel'; return { content: 'host-probe-ok' }; } };
    const invocation = await prepareMcpInvocation({ config, tools: [{ function: { name: 'probe' } }], mcpRun });
    const completion = acpCompletion({ config, invocation, prompt: 'offline', mcpRun, isEnabled: () => true,
      spawnProcess: (_exe, _args, options) => {
        starts++;
        return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-acp.mjs', import.meta.url)), mode], options);
      }
    }, { pool, verify: async () => { checks++; } });
    let approval;
    for (let i = 0; i < 200 && !approval; i++) {
      approval = listCliApprovals()[0];
      if (!approval) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(approval); assert.equal(approval.chatKey, chatKey); assert.equal(approval.runId, runId);
    assert.equal(decideCliApproval(approval.id, true), true);
    const result = await completion;
    sessions.push(result.raw.conversation_id);
    assert.equal(result.message.content, mode === 'pool-cancel' ? '' : 'effect-confirmed');
    assert.equal(result.raw.status, mode === 'pool-cancel' ? 'HOST_FINISHED' : 'SUCCESS');
    await invocation.close();
    if (oldInvocation) assert.equal(oldInvocation.calls(), 1);
    oldInvocation = invocation;
    assert.deepEqual(listCliApprovals(), []);
  }
  assert.equal(starts, 2); assert.equal(checks, 2);
  assert.notEqual(sessions[0], sessions[1]);
  assert.deepEqual(executed, [['private:1', 'one', 'probe'], ['private:1', 'two', 'probe'], ['group:1', 'three', 'probe']]);
});
