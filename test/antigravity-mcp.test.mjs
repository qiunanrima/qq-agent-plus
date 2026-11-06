import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRunToolMcp, contextWithToolSignal, normalizeHostToolArguments } from '../src/antigravity-cli/mcp-run.js';
import { McpStdioClient } from '../src/mcp/client.js';
import net from 'node:net';

const tools = [{ name: 'probe', description: 'Offline test only', parameters: {
  type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false
} }];

test('send text alias preserves content and targeting but never overrides explicit messages', () => {
  assert.deepEqual(normalizeHostToolArguments('send_message', { text: 'hello', replyToMessageId: '12' }), { messages: ['hello'], replyToMessageId: '12' });
  const explicit = { messages: [], text: 'must not send' };
  assert.equal(normalizeHostToolArguments('send_message', explicit), explicit);
  const other = { text: 'query' };
  assert.equal(normalizeHostToolArguments('search', other), other);
  assert.deepEqual(normalizeHostToolArguments('send_message', { text: ' ' }), { text: ' ' });
  assert.deepEqual(normalizeHostToolArguments('send_message', { content: ['hello', 'world'] }), { messages: ['hello', 'world'] });
  assert.deepEqual(normalizeHostToolArguments('send_message', { content: 'hello' }), { messages: ['hello'] });
  for (const bad of [{ messages: [], content: ['never'] }, { content: [{ text: 'never' }] }, { content: [''] }, { text: '', content: ['never'] }]) {
    assert.equal(normalizeHostToolArguments('send_message', bad), bad);
  }
});

test('exact qq_run dispatcher envelopes are unwrapped without rerouting or overriding explicit fields', () => {
  const envelope = Arguments => ({ Arguments, ServerName: 'qq_run', ToolName: 'qq_send_message' });
  assert.deepEqual(normalizeHostToolArguments('send_message', envelope({ messages: ['hello', 'world'] })), { messages: ['hello', 'world'] });
  assert.deepEqual(normalizeHostToolArguments('send_message', envelope({ message: 'hello' })), { messages: ['hello'] });
  assert.deepEqual(normalizeHostToolArguments('send_message', envelope('{"messages":["hello"]}')), { messages: ['hello'] });
  assert.deepEqual(normalizeHostToolArguments('send_message', envelope({ messages: [], message: 'never' })), { messages: [], message: 'never' });
  for (const args of [{ ...envelope({ messages: ['never'] }), ServerName: 'other' },
    { ...envelope({ messages: ['never'] }), ToolName: 'qq_other' }, envelope('not JSON'),
    { ...envelope({ messages: ['never'] }), messages: [] }]) {
    assert.equal(normalizeHostToolArguments('send_message', args), args);
  }
});

test('host argument aliases never replace explicit canonical plugin, image or poke fields', () => {
  assert.deepEqual(normalizeHostToolArguments('plugin_call', { name: 'health__query', payload: { days: 1 } }), { tool: 'health__query', args: { days: 1 } });
  const canonical = { tool: 'chosen', args: {}, name: 'other', payload: { days: 2 } };
  assert.equal(normalizeHostToolArguments('plugin_call', canonical), canonical);
  assert.equal(normalizeHostToolArguments('get_message_images', { message_id: '-12' }).messageId, '-12');
  assert.equal(normalizeHostToolArguments('get_message_images', { messageIds: ['-12'] }).messageId, '-12');
  assert.equal(normalizeHostToolArguments('get_message_images', { messageIds: ['12', '13'] }).messageId, undefined);
  assert.equal(normalizeHostToolArguments('get_message_images', { messageId: '', id: '12' }).messageId, '');
  assert.equal(normalizeHostToolArguments('send_poke', { userId: '12345' }).targetUserId, '12345');
  assert.equal(normalizeHostToolArguments('send_poke', { targetUserId: '', userId: '12345' }).targetUserId, '');
});

test('scoped tool cancellation stays aborted while mutable skill state reaches the host', () => {
  const parent = new AbortController(), scoped = new AbortController();
  const ctx = { signal: parent.signal, activeSkill: null };
  const toolCtx = contextWithToolSignal(ctx, scoped.signal);
  toolCtx.activeSkill = { id: 'skill-test' };
  assert.equal(ctx.activeSkill.id, 'skill-test');
  scoped.abort();
  assert.equal(toolCtx.signal.aborted, true);
  assert.equal(ctx.signal.aborted, false);
  assert.throws(() => { toolCtx.signal = parent.signal; }, TypeError);
});
async function setup(t, options = {}) {
  const calls = [];
  const bridge = await createRunToolMcp({ tools, chatKey: 'group:test-only', runId: 'offline-test',
    authorize: () => true, execute: async call => { calls.push(call); return { content: `pong:${call.arguments.text}` }; }, ...options });
  const client = new McpStdioClient({ id: 'run-test', ...bridge.serverConfig, timeoutMs: 2000 });
  t.after(() => { client.stop(); bridge.close(); });
  await client.start();
  return { bridge, client, calls };
}

test('MCP subprocess discovers only scoped tools and returns host result', async t => {
  const { client, calls, bridge } = await setup(t);
  assert.deepEqual(client.tools.map(tool => tool.name), ['qq_probe']);
  const result = await client.callTool('qq_probe', { text: 'hello' });
  assert.equal(result.content[0].text, 'pong:hello');
  assert.equal(calls[0].chatKey, 'group:test-only');
  assert.equal(calls[0].runId, 'offline-test');
  assert.deepEqual(bridge.ledger(), [{ name: 'probe', state: 'succeeded' }]);
  await assert.rejects(client.callTool('send_message', {}), /Unknown tool/);
});

test('authorization and call budget fail closed', async t => {
  const denied = await setup(t, { authorize: () => false });
  await assert.rejects(denied.client.callTool('qq_probe', { text: 'hello' }), /authorization denied/);
  assert.equal(denied.calls.length, 0);
  const limited = await setup(t, { maxCalls: 1 });
  await limited.client.callTool('qq_probe', {});
  await assert.rejects(limited.client.callTool('qq_probe', {}), /budget exhausted/);
  assert.equal(limited.calls.length, 1);
});

test('run cancellation revokes endpoint and propagates abort to executing tool', async t => {
  const controller = new AbortController();
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const { client, bridge } = await setup(t, { signal: controller.signal, execute: async ({ signal }) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { content: 'late result' };
  } });
  const pending = client.callTool('qq_probe', {});
  const rejected = assert.rejects(pending);
  await running;
  controller.abort();
  await rejected;
  assert.equal(bridge.ledger()[0].state, 'unknown');
});

test('duplicate request ID caches success and unknown outcome without replay', async t => {
  let count = 0;
  const { client } = await setup(t, { execute: async () => { count += 1; throw new Error('ambiguous external write'); } });
  const request = () => {
    client.nextId = 50;
    return client.request('tools/call', { name: 'qq_probe', arguments: {} });
  };
  await assert.rejects(request());
  await assert.rejects(request());
  assert.equal(count, 1);
});

test('missing authorization is rejected before creating any endpoint', async () => {
  await assert.rejects(createRunToolMcp({ tools, execute: () => {}, chatKey: 'x', runId: 'y' }), /authorization/);
});

test('wrong capability token cannot discover or execute tools', async t => {
  const { bridge, calls } = await setup(t);
  const socket = net.createConnection(bridge.serverConfig.env.QQ_AGENT_RUN_PIPE);
  await new Promise(resolve => socket.once('connect', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.on('error', () => {});
  socket.write(JSON.stringify({ token: 'wrong', message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } }) + '\n');
  await closed;
  assert.equal(calls.length, 0);
});

test('successful duplicate request is returned from cache without executing twice', async t => {
  const { client, calls } = await setup(t);
  const request = () => { client.nextId = 80; return client.request('tools/call', { name: 'qq_probe', arguments: { text: 'one' } }); };
  assert.deepEqual(await request(), await request());
  assert.equal(calls.length, 1);
  client.nextId = 80;
  await assert.rejects(client.request('tools/call', { name: 'qq_probe', arguments: { text: 'different' } }), /ID reused/);
});
