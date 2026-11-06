import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAcpNativeClient } from '../src/antigravity-cli/acp-native-client.js';
import { listCliApprovals, decideCliApproval } from '../src/antigravity-cli/approvals.js';

async function pending() {
  for (let i = 0; i < 100; i++) {
    const entry = listCliApprovals()[0]; if (entry) return entry;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('No native approval');
}
async function fixture(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'native-client-'));
  const controller = new AbortController();
  const client = createAcpNativeClient({ sessionId: () => 'session', workspace, signal: controller.signal, isEnabled: () => true, maxCalls: 16,
    mcpRun: { chatKey: 'private:test', runId: 'run', allowed: () => true, approvalAllowed: () => true } });
  t.after(async () => { controller.abort(); await client.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return { workspace, client, controller, request: (method, params) => client.request(method, { sessionId: 'session', ...params }) };
}
test('ACP file writes and reads require real approval and preserve denied file contents', async t => {
  const f = await fixture(t), file = path.join(f.workspace, 'probe.txt');
  const write = f.request('fs/write_text_file', { path: file, content: 'one\ntwo\nthree' });
  const entry = await pending();
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  decideCliApproval(entry.id, true); await write;
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\nthree');
  const read = f.request('fs/read_text_file', { path: file, line: 2, limit: 1 });
  decideCliApproval((await pending()).id, true); assert.deepEqual(await read, { content: 'two' });
  const denied = f.request('fs/write_text_file', { path: file, content: 'never' });
  const rejection = assert.rejects(denied, /not approved/);
  decideCliApproval((await pending()).id, false); await rejection;
  assert.equal(await fs.readFile(file, 'utf8'), 'one\ntwo\nthree');
});
test('ACP terminal actually executes only after approval and returns protocol exit status', async t => {
  const f = await fixture(t), marker = path.join(f.workspace, 'marker');
  const command = f.request('terminal/create', { command: process.execPath, args: ['-e', 'require("fs").writeFileSync("marker","done"); process.stdout.write("native-ok")'], cwd: f.workspace });
  const entry = await pending();
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
  assert.equal(entry.tool, 'terminal/create'); decideCliApproval(entry.id, true);
  const { terminalId } = await command;
  assert.equal((await f.request('terminal/wait_for_exit', { terminalId })).exitCode, 0);
  const result = await f.request('terminal/output', { terminalId });
  assert.equal(result.output, 'native-ok'); assert.equal(result.exitStatus.exitCode, 0);
  assert.equal(await fs.readFile(marker, 'utf8'), 'done');
  await f.request('terminal/release', { terminalId });
  await assert.rejects(f.request('terminal/output', { terminalId }), /Unknown/);
});
test('native methods reject other sessions and protected paths; cancellation kills running command', async t => {
  const f = await fixture(t);
  await assert.rejects(f.client.request('terminal/create', { sessionId: 'other', command: 'never' }), /outside active/);
  await assert.rejects(f.request('fs/write_text_file', { path: path.join(f.workspace, '.agents/hooks.json'), content: 'never' }));
  assert.deepEqual(listCliApprovals(), []);
  const start = f.request('terminal/create', { command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], cwd: f.workspace });
  decideCliApproval((await pending()).id, true); await start;
  f.controller.abort(); await f.client.close();
  await assert.rejects(f.request('terminal/output', { terminalId: 'any' }), /outside active/);
});
