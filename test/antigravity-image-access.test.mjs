import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunImageAccess } from '../src/antigravity-cli/image-access.js';
import { createAcpPermissionHandler } from '../src/antigravity-cli/acp-permissions.js';
import { listCliApprovals } from '../src/antigravity-cli/approvals.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareMcpInvocation } from '../src/antigravity-cli/mcp-invocation.js';
import { McpStdioClient } from '../src/mcp/client.js';

async function hookDecision(call) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/antigravity-cli/native-ask-hook.js', import.meta.url))], { windowsHide: true });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Hook failed'))); });
  child.stdin.end(JSON.stringify({ toolCall: call }));
  await done;
  return JSON.parse(output);
}

for (const platform of ['qq', 'wechat']) test(`${platform} MCP bridge permits only its run-owned image while native permissions can remain off`, async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-bridge-'));
  const bytes = Buffer.from('image returned by host');
  const controller = new AbortController();
  let invocation, client;
  try {
    invocation = await prepareMcpInvocation({ config: { workspace, agent: 'qq-mcp', nativeApproval: platform === 'qq', qqApproval: false, maxToolCalls: 16, timeoutMs: 3000 },
      tools: [{ function: { name: 'get_message_images', parameters: { type: 'object' } } }],
      mcpRun: { platform, chatKey: 'private:1', runId: 'image-test', allowed: () => true,
        execute: async () => ({ content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } }] }) },
      signal: controller.signal });
    const server = invocation.acpMcpServers[0];
    client = new McpStdioClient({ ...server, id: 'image-test', env: Object.fromEntries(server.env.map(x => [x.name, x.value])) });
    await client.start();
    const result = await client.callTool('qq_get_message_images', {});
    assert.equal(result.isError, false);
    assert.equal(result.content.some(part => part.type === 'image'), false);
    const file = JSON.parse(result.content[0].text.match(/\{"Path":.*?\}/)[0]).Path;
    assert.deepEqual(await fs.readFile(file), bytes);
    const session = '1996c561-1924-4235-9af2-a2ff7ac42804';
    assert.equal(await invocation.imageAccess.allows(file, session), true);
    assert.equal((await hookDecision({ name: 'read_file', args: { Path: file } })).decision, 'force_ask');
    const permit = createAcpPermissionHandler({ sessionId: () => session, workspace: invocation.workspace,
      signal: controller.signal, isEnabled: () => true, maxCalls: 16, imageAccess: invocation.imageAccess,
      mcpRun: { allowed: () => true, approvalAllowed: () => platform === 'qq' } });
    assert.deepEqual(await permit({ sessionId: session, toolCall: { toolCallId: 'image', name: 'read_file', rawInput: { Path: file } },
      options: [{ kind: 'allow_once', optionId: 'once' }] }), { outcome: { outcome: 'selected', optionId: 'once' } });
    await fs.writeFile(file, 'tampered');
    assert.equal(await invocation.imageAccess.allows(file, session), false);
    if (platform === 'wechat') {
      assert.equal((await permit({ sessionId: session, toolCall: { toolCallId: 'tampered', name: 'read_file', rawInput: { Path: file } },
        options: [{ kind: 'allow_once', optionId: 'once' }] })).outcome.outcome, 'cancelled');
      assert.equal(listCliApprovals().length, 0);
    }
  } finally {
    controller.abort(); client?.stop(); await invocation?.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test('only exact current-run MCP image bytes in the current CLI media spool bypass approval', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-image-access-'));
  const session = '1996c561-1924-4235-9af2-a2ff7ac42804';
  const file = path.join(home, '.gemini/antigravity-cli/brain', session, '.system_generated/steps/2/media_0.jpg');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const bytes = Buffer.from('test image bytes');
  await fs.writeFile(file, bytes);
  try {
    const access = createRunImageAccess({ home });
    assert.equal(await access.allows(file, session), false);
    access.observe([{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } }]);
    assert.equal(await access.allows(file, session), true);
    assert.equal(await access.allows(file, '966c63e1-36e0-415f-873b-ab1f6c07428d'), false);
    assert.equal(await access.allows(file, '../escape'), false);
    const other = path.join(home, 'schema.json');
    await fs.writeFile(other, bytes);
    assert.equal(await access.allows(other, session), false);
    const permit = createAcpPermissionHandler({ sessionId: () => session,
      mcpRun: { allowed: () => true, approvalAllowed: () => true }, workspace: home,
      signal: new AbortController().signal, isEnabled: () => true, maxCalls: 16, imageAccess: access });
    for (const [name, field] of [['read_file', 'Path'], ['view_file', 'AbsolutePath']]) {
      // Actual production wire shape: hook must request ACP rather than deny first.
      assert.equal((await hookDecision({ name, args: { [field]: file } })).decision, 'force_ask');
      const request = { sessionId: session, toolCall: { toolCallId: name, name, kind: 'read', rawInput: { [field]: file } },
        options: [{ kind: 'allow_once', optionId: 'once' }] };
      assert.deepEqual(await permit(request), { outcome: { outcome: 'selected', optionId: 'once' } });
      assert.deepEqual(listCliApprovals(), []);
      assert.equal((await permit(request)).outcome.outcome, 'cancelled');
    }
    await fs.writeFile(file, 'changed bytes');
    assert.equal(await access.allows(file, session), false);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
