import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ChatStore } from '../src/core/store.js';
import { registerPersonHistoryRoutes } from '../src/console/routes/person-history.js';

test('按人跨QQ会话查找：群只返回本人，私聊包括双方，隔离其他私聊和平台，分页不串', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-person-history-'));
  const store = new ChatStore(0, { dataDir: dir });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let time = Date.now();
  const add = (chat, senderId, text, eventKind = 'message') => {
    store.appendIncoming(chat, { mid: String(time), ts: time++, senderId, senderName: '<script>', text, eventKind });
    store.drainUnread(chat);
  };
  add('group:1', '123', '目标群发言'); add('group:2', '123', '第二群发言');
  add('group:1', '456', '别人的群发言');
  add('private:123', '123', '目标私聊');
  store.appendSelf('private:123', { mid: String(time), ts: time++, text: '机器人私聊回复' });
  add('private:456', '456', '另一人的私聊');
  add('private:456', '123', '错归属私聊');
  add('group:wechat_' + 'a'.repeat(64), '123', '微信记录');
  add('private:123', '123', '游戏秘密', 'game-secret');
  store.appendIncoming('private:123', { mid: String(time), ts: time++, senderId: '123', text: '待处理' });
  const rows = store.searchPersonHistory({ userId: '123' }).messages;
  assert.deepEqual(new Set(rows.map(row => row.text)), new Set(['目标群发言', '第二群发言', '目标私聊', '机器人私聊回复']));
  assert.equal(rows.every(row => row.chatKey === 'private:123' || row.chatKey.startsWith('group:')), true);
  assert.equal(store.searchPersonHistory({ userId: '123', scope: 'group' }).messages.length, 2);
  assert.equal(store.searchPersonHistory({ userId: '123', scope: 'private' }).messages.length, 2);
  assert.equal(store.searchPersonHistory({ userId: '123', query: '第二群' }).messages.length, 1);
  const first = store.searchPersonHistory({ userId: '123', limit: 2 });
  assert.equal(first.nextOffset, 2);
  const second = store.searchPersonHistory({ userId: '123', limit: 2, offset: first.nextOffset });
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.messages, ...second.messages].map(row => row.chatKey + ':' + row.localId)).size, 4);
  assert.throws(() => store.searchPersonHistory({ userId: "' OR 1=1" }));
  let handler;
  registerPersonHistoryRoutes({ add: (_method, route, fn, opts) => {
    assert.equal(route, '/api/history/person'); assert.notEqual(opts?.auth, false); handler = fn;
  } }, { store, json: (_res, status, body) => ({ status, body }) });
  assert.equal((await handler({}, {}, {}, new URL('http://local/api/history/person?userId=no'))).status, 400);
  assert.equal((await handler({}, {}, {}, new URL('http://local/api/history/person?userId=123'))).body.messages.length, 4);
});
