import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-history-search-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { ChatStore } = await import('../src/core/store.js');
const { buildToolDefs } = await import('../src/tools/tools-core.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');

test('历史检索按会话、人物、时间分页；待处理消息和游戏秘密不可见，SQL字符按正文匹配', async t => {
  const store = new ChatStore(0, { dataDir: root });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const at = Date.parse('2026-11-12T12:00:00+08:00');
  for (const [chat, id, sender, text, eventKind] of [
    ['group:1', '1', '123', '面馆讨论第一天'], ['group:1', '2', '456', '面馆讨论第二天'],
    ['private:123', '3', '123', '面馆私聊秘密'], ['group:1', '4', '123', '面馆游戏秘密', 'game-secret'],
    ['group:1', '5', '123', "字面 %_' SQL"]
  ]) store.appendIncoming(chat, { mid: id, ts: at + Number(id) * 1000, senderId: sender, text, eventKind });
  store.drainUnread('group:1'); store.drainUnread('private:123');
  store.appendIncoming('group:1', { mid: '6', ts: at, senderId: '123', text: '面馆尚未处理' });
  assert.deepEqual(store.searchHistory('group:1', { query: '面馆' }).map(m => m.mid), ['2', '1']);
  assert.deepEqual(store.searchHistory('group:1', { query: '面馆', userId: '123' }).map(m => m.mid), ['1']);
  assert.equal(store.searchHistory('group:1', { query: "%_'" }).length, 1);
  assert.equal(store.searchHistory('group:1', { query: "' OR 1=1 --" }).length, 0);
  assert.deepEqual(store.searchHistory('group:1', { query: '面馆', after: at + 1500 }).map(m => m.mid), ['2']);
  assert.deepEqual(store.searchHistory('group:1', { query: '面馆', limit: 1, offset: 1 }).map(m => m.mid), ['1']);
  const cfg = structuredClone(DEFAULT_CONFIG); cfg.blocklist = { '1': ['456'] }; setRuntimeConfig(cfg);
  const tool = buildToolDefs().find(d => d.name === 'search_history');
  const ctx = { store, chatKey: 'group:1', session: {} };
  const invalid = await tool.execute(ctx, { after: '2026-11-12' });
  assert.equal(invalid.isError, true);
  const result = JSON.parse((await tool.execute(ctx, { query: '面馆', after: '2026-11-12T00:00:00+08:00' })).content);
  assert.equal(result.messages.some(m => m.text.includes('秘密') || m.text.includes('尚未处理')), false);
  assert.deepEqual(result.messages.map(m => m.messageId), ['1'], '屏蔽前存档的成员发言也不返回');
});
