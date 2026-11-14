import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GROUP_ONLY_TOOLS, platformToolAllowed, PLATFORM_TOOL_GATES } from '../src/core/platform-gates.js';
import { pluginChatToolAllowed } from '../src/plugins/chat-tool-policy.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-tool-visibility-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { PluginRegistry } = await import('../src/plugins/registry.js');
process.on('exit', () => { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows handles */ } });

test('group-only tools never mount in private or external chats; compatible private tools remain', () => {
  for (const name of GROUP_ONLY_TOOLS) {
    assert.equal(platformToolAllowed(name, { albumUpload: true }, 'private:12345'), false, name);
    assert.equal(platformToolAllowed(name, { albumUpload: true }, 'wechat:peer'), false, name);
    assert.equal(platformToolAllowed(name, { albumUpload: true }, 'group:12345'), true, name);
  }
  for (const name of ['set_remark', 'recall_message', 'send_voice']) {
    assert.equal(platformToolAllowed(name, {}, 'private:12345'), true, name);
  }
});

test('disabled platform capabilities remain absent, including per-group overrides', () => {
  for (const [gate, names] of Object.entries(PLATFORM_TOOL_GATES)) {
    for (const name of names) {
      const chat = name === 'send_private_file' ? 'private:12345' : 'group:12345';
      assert.equal(platformToolAllowed(name, { [gate]: false }, chat), false, name);
      if (chat.startsWith('group:')) {
        assert.equal(platformToolAllowed(name, { [gate]: true, perGroup: { 12345: { [gate]: false } } }, chat), false, name);
      }
    }
  }
});

test('health chat access requires both settings and owner private chat; login is console-only', () => {
  const on = { acceptUnofficial: true, allowAgentRead: true };
  assert.equal(pluginChatToolAllowed('xiaomi-health', 'query', on, 'private:12345', '12345'), true);
  for (const settings of [{}, { acceptUnofficial: true }, { allowAgentRead: true }]) {
    assert.equal(pluginChatToolAllowed('xiaomi-health', 'query', settings, 'private:12345', '12345'), false);
  }
  for (const chat of ['', 'group:12345', 'private:67890']) {
    assert.equal(pluginChatToolAllowed('xiaomi-health', 'query', on, chat, '12345'), false);
  }
  assert.equal(pluginChatToolAllowed('xiaomi-health', 'login', on, 'private:12345', '12345'), false);
});

for (const toolMounting of ['meta', 'direct']) {
  test(`registry filters actual ${toolMounting} tool catalog and rejects stale access after disabling`, async () => {
    let settings = { acceptUnofficial: true, allowAgentRead: true };
    let calls = 0;
    const tools = ['login', 'query'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } }));
    const registry = new PluginRegistry({ root: dataDir, dataDir, log: () => {},
      getConfig: () => ({ admin: { ownerUin: '12345' }, plugins: { enabled: true,
        enabledIds: ['xiaomi-health'], toolMounting, settings: { 'xiaomi-health': settings } } }) });
    registry.hosts.set('xiaomi-health', { id: 'xiaomi-health', state: 'running',
      manifest: { id: 'xiaomi-health', version: '1.0.7', tools },
      callTool: async () => { calls++; return {}; } });
    assert.deepEqual(registry.toolDefsFor({ chatKey: 'group:12345' }), []);
    const defs = registry.toolDefsFor({ chatKey: 'private:12345' });
    assert.equal(defs.length, 1);
    assert.ok(!JSON.stringify(defs).includes('xiaomi-health__login'));
    assert.ok(JSON.stringify(defs).includes('xiaomi-health__query'));
    settings = {};
    assert.deepEqual(registry.toolDefsFor({ chatKey: 'private:12345' }), []);
    const result = await defs[0].execute({ chatKey: 'private:12345' },
      toolMounting === 'meta' ? { tool: 'xiaomi-health__query', args: {} } : {});
    assert.equal(result.isError, true);
    assert.equal(calls, 0);
  });
}
