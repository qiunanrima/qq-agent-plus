import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { antigravityCompletion } from '../src/antigravity-cli/index.js';
import { createMcpHostRun } from '../src/antigravity-cli/mcp-run.js';

test('successful audited host finish ends a hanging CLI without retry or invented usage', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-finish-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const controller = new AbortController();
  const transcript = { messages: [], auditMessages: [], toolResults: [], imageUserMessages: [] };
  const calls = [];
  const mcpRun = createMcpHostRun({ chatKey: 'test:finish', runId: 'finish-run', signal: controller.signal,
    allowed: () => true, transcript, execute: async call => {
      const name = call.function.name;
      if (mcpRun.isFinished()) return { isError: true, content: 'finished' };
      calls.push(name);
      transcript.toolResults.push({ role: 'tool', tool_call_id: call.id, content: 'ok' });
      return { content: 'ok' };
    } });
  let spawned = 0;
  const response = await antigravityCompletion({ config: { enabled: true, workspace, timeoutMs: 2000 },
    messages: [], tools: ['probe', 'finish'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    mcpRun
  }, { spawnProcess: (_exe, _args, options) => {
    spawned++;
    return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-mcp-cli.mjs', import.meta.url)), 'hang-after-finish'], options);
  } });
  assert.equal(spawned, 1);
  assert.deepEqual(calls, ['probe', 'finish']);
  assert.equal(response.raw.status, 'HOST_FINISHED');
  assert.equal(response.raw.usageUnavailable, true);
  assert.equal(response.usage, undefined);
  assert.equal(response.message.tool_calls, undefined);
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('MCP completion dispatches scoped host tool once, returns no replayable tool_calls and removes per-run workspace', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mcp-invocation-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  const result = await antigravityCompletion({ config: { enabled: true, workspace, transport: 'mcp', agent: 'qq-mcp' },
    messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: {
      name: 'probe', description: 'probe', parameters: { type: 'object', properties: {}, additionalProperties: false }
    } }], toolChoice: 'required',
    mcpRun: { chatKey: 'test:scope', runId: 'test-run', allowed: () => true,
      execute: async (name, args) => { calls.push({ name, args }); return { content: 'pong' }; } }
  }, { spawnProcess: (_exe, args, options) => {
    assert.ok(!args.includes('--json-schema'));
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).toolPermission, 'request-review');
    return spawn(process.execPath, [fileURLToPath(new URL('./fixtures/antigravity-mcp-cli.mjs', import.meta.url))], options);
  } });
  assert.equal(result.toolsExecutedViaMcp, true);
  assert.equal(result.message.tool_calls, undefined);
  assert.deepEqual(calls, [{ name: 'probe', args: {} }]);
  assert.deepEqual(fs.readdirSync(workspace), []);
});

test('MCP refuses to start without host authorization and never creates an active child', async () => {
  let spawned = false;
  await assert.rejects(antigravityCompletion({ config: { enabled: true, workspace: os.tmpdir(), transport: 'mcp' }, messages: [] },
    { spawnProcess: () => { spawned = true; } }), error => error.code === 'ANTIGRAVITY_NO_RETRY');
  assert.equal(spawned, false);
});
