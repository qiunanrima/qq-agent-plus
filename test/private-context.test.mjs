import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-private-context-'));
process.env.QQ_AGENT_DATA_DIR = root;
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } });

const { ChatStore } = await import('../src/core/store.js');
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildPastState } = await import('../src/llm/prompt.js');
const { buildToolDefs, executeTool } = await import('../src/tools/tools.js');

function seed() {
  const now = Date.now();
  const store = new ChatStore(0);
  store.appendIncoming('group:9', { mid: 91, ts: now - 3500, senderId: '9', senderName: '群友', text: '群里说的话' });
  store.appendIncoming('private:1', { mid: 11, ts: now - 3000, senderId: '1', senderName: 'A', text: '和 A 说的话' });
  store.appendIncoming('private:2', { mid: 22, ts: now - 2000, senderId: '2', senderName: 'B', text: '[引用#22·B：原话] 和 B 说的话' });
  store.appendIncoming('group:8', { mid: 81, ts: now - 1500, senderId: '8', senderName: '别群群友', text: '另一个群的话' });
  store.appendIncoming('private:1', { mid: 12, ts: now - 1000, senderId: '1', senderName: 'A', text: 'A 又说了一句' });
  store.drainUnread('group:9');
  store.drainUnread('group:8');
  store.drainUnread('private:1');
  store.drainUnread('private:2');
  return store;
}

function configWith(shared, cross = false, blocklist = null) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.privateSharedContext = shared;
  cfg.memory.crossScopeSharedContext = cross;
  if (blocklist) cfg.blocklist = blocklist;
  cfg.store.allCount = 500;
  cfg.store.pastStateMaxChars = 100000;
  setRuntimeConfig(cfg);
}

test('store.recent(scope=private) 跨私聊按时间读取，默认仍只读当前会话', () => {
  configWith(false);
  const store = seed();
  const only = store.recent('private:1', { limit: 10 });
  assert.deepEqual(only.map((m) => m.text), ['和 A 说的话', 'A 又说了一句']);
  assert.equal(only[0].chatKey, 'private:1');

  const all = store.recent('private:1', { limit: 10, scope: 'private' });
  assert.deepEqual(all.map((m) => m.text), ['和 A 说的话', '[引用#22·B：原话] 和 B 说的话', 'A 又说了一句']);
  assert.deepEqual(all.map((m) => m.chatKey), ['private:1', 'private:2', 'private:1']);
  store.close();
});

test('私聊共享上下文：历史带 [与 <QQ>] 标签，别的会话 mid 不暴露；默认关仍隔离', async () => {
  configWith(true);
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.match(state.text, /和 B 说的话/);
  assert.match(state.text, /\[与 2\]/);
  assert.doesNotMatch(state.text, /#22/, '别的私聊的 mid 不能出现在引用块里');
  assert.match(state.text, /#11/);

  // 本地 id 冲突：当前会话的 excludeIds 不能误伤别的私聊同号消息
  const withExclude = buildPastState(store, 'private:1', { excludeIds: [2] });
  assert.match(withExclude.text, /和 B 说的话/);

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  const cross = payload.messages.find((m) => m.text.includes('和 B 说的话'));
  assert.ok(cross);
  assert.match(cross.text, /^\[与 2\]/);
  assert.equal(cross.messageId, undefined);

  configWith(false);
  const isolated = buildPastState(store, 'private:1');
  assert.doesNotMatch(isolated.text, /和 B 说的话/);
  store.close();
});

test('群聊与私聊共用上下文：跨会话消息带来源标签、无 mid；默认关仍隔离', async () => {
  configWith(false, true);
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.match(state.text, /群里说的话/);
  assert.match(state.text, /\[群 9\]/);
  assert.match(state.text, /另一个群的话/);
  assert.match(state.text, /\[群 8\]/);
  assert.match(state.text, /\[与 2\]/, '私聊之间也一起共享');
  assert.doesNotMatch(state.text, /#91/, '别的群的 mid 不能暴露');
  assert.doesNotMatch(state.text, /#81/);
  assert.match(state.text, /#11/, '当前会话的 mid 保留');

  const groupView = buildPastState(store, 'group:9');
  assert.match(groupView.text, /和 A 说的话/);
  assert.match(groupView.text, /\[与 1\]/, '群聊里也能看到私聊来源，并标明 QQ');

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  const fromGroup = payload.messages.find((m) => m.text.includes('群里说的话'));
  assert.ok(fromGroup, '翻页也要能看到跨会话消息');
  assert.match(fromGroup.text, /^\[群 9\]/);
  assert.equal(fromGroup.messageId, undefined, '别的群的 mid 在当前会话无效');

  configWith(false, false);
  const isolated = buildPastState(store, 'private:1');
  assert.doesNotMatch(isolated.text, /群里说的话/);
  store.close();
});

test('跨会话共享时屏蔽名单按消息自己的群过滤（提示词与翻页同口径）', async () => {
  configWith(false, true, { 9: ['9'] });
  const store = seed();
  const state = buildPastState(store, 'private:1');
  assert.doesNotMatch(state.text, /群里说的话/, '被屏蔽群员的消息不能随共享漏进别的会话');
  assert.match(state.text, /另一个群的话/, '别的群不受影响');

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1',
    store,
    session: { pastStateCount: 0 }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const payload = JSON.parse(result.content);
  assert.ok(payload.messages.some((m) => m.text.includes('另一个群的话')), '未屏蔽的群仍可翻到');
  assert.ok(!payload.messages.some((m) => m.text.includes('群里说的话')), '翻页不能绕过屏蔽名单');
  store.close();
});

test('私聊长回复下轮仍看得到结尾选项', () => {
  configWith(false);
  const store = seed();
  try {
    store.appendSelf('private:1', { text: '甲'.repeat(9200) + '第二项是小提琴', mid: 999, ts: 5000 });
    assert.match(buildPastState(store, 'private:1').text, /第二项是小提琴/);
  } finally { store.close(); }
});

test('私聊快照变化并追加历史时，已有的历史仍是共同前缀', async () => {
  const { buildUserPrompt } = await import('../src/llm/prompt.js');
  configWith(false);
  const store = seed();
  const sample = (historyFirst, snapshot, text) => {
    const snapshotParts = [snapshot];
    const prompt = buildUserPrompt({ historyFirst, snapshotParts, store, kind: 'private', chatKey: 'private:1',
      memory: { formatForPrompt: () => '' }, triggerEntries: [{ id: 999, text, senderId: '1' }] });
    return historyFirst ? prompt : snapshotParts.join('\n\n') + '\n\n' + prompt;
  };
  const prefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  try {
    const oldFirst = sample(false, '交接：周末听歌', '想听哪首');
    const newFirst = sample(true, '交接：周末听歌', '想听哪首');
    store.appendSelf('private:1', { mid: 200, text: '那首钢琴曲', ts: 6000 });
    const oldNext = sample(false, '交接：换个话题', '今天去哪里');
    const newNext = sample(true, '交接：换个话题', '今天去哪里');
    assert.ok(newNext.indexOf('A 又说了一句') < newNext.indexOf('交接：换个话题'));
    assert.ok(newNext.indexOf('交接：换个话题') < newNext.indexOf('今天去哪里'));
    assert.equal(newNext.split('交接：换个话题').length, 2);
    assert.ok(prefix(newFirst, newNext) > prefix(oldFirst, oldNext));
    console.log('私聊动态输入共同前缀字符', prefix(oldFirst, oldNext), '→', prefix(newFirst, newNext));
  } finally { store.close(); }
});

test('私聊长窗口连续滚动时分块复用历史，保留最近至少四分之三', () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.store.contextLayering.maxHistoryMessages = 32;
  setRuntimeConfig(cfg);
  const store = new ChatStore(0);
  const chat = 'private:887';
  const last = [null, null], repeats = [0, 0];
  try {
    for (let i = 1; i <= 96; i++) {
      store.appendSelf(chat, { text: '历史' + i, ts: 1000 + i, mid: i });
      for (const mode of [0, 1]) {
        const window = buildPastState(store, chat, { limit: 32, blockWindow: Boolean(mode) });
        if (i >= 32) {
          assert.ok(window.count >= 24 && window.count <= 32);
          assert.equal(window.messages.at(-1).mid, String(i));
          if (i > 32 && window.messages[0].id === last[mode]) repeats[mode]++;
        }
        last[mode] = window.messages[0].id;
      }
    }
    assert.ok(repeats[1] > 40 && repeats[0] === 0);
    console.log('同一历史起点连续复用次数（普通 / 分块）', repeats);
  } finally { store.close(); }
});

test('共享上下文给每个来源独立的 24 小时窗口和面板条数', async () => {
  configWith(false, true);
  const store = new ChatStore(0, { filename: 'shared-window.sqlite' });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const append = (chatKey, ts, text) => store.appendIncoming(chatKey, { ts, senderId: '1', text });
  append('private:1', now - day - 1, '旧私聊');
  append('private:1', now - day, '窗口边界');
  append('private:1', now - 1, '最近私聊');
  append('group:8', now - day - 1, '不活跃群');
  for (let i = 0; i < 32; i++) append('group:9', now - 100 + i, '繁忙群消息 ' + i);
  for (const chatKey of store.listChats()) store.drainUnread(chatKey);

  const history = buildPastState(store, 'private:1', { now, limit: 8 });
  assert.equal(DEFAULT_CONFIG.store.contextLayering.maxHistoryMessages, 30);
  assert.equal(history.count, 32);
  assert.deepEqual(history.messages.slice(0, 2).map((m) => m.text), ['窗口边界', '最近私聊']);
  assert.deepEqual(history.messages.slice(2).map((m) => m.text),
    Array.from({ length: 30 }, (_, i) => '繁忙群消息 ' + (i + 2)));
  assert.match(history.text, /^当前会话\n[\s\S]*\n\n\[群 9\]\n/);
  assert.doesNotMatch(history.text, /不活跃群|旧私聊/);

  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.memory.crossScopeSharedContext = true;
  cfg.store.contextLayering.maxHistoryMessages = 20;
  cfg.store.contextLayering.enabled = false;
  setRuntimeConfig(cfg);
  const shorter = buildPastState(store, 'private:1', { now });
  assert.equal(shorter.count, 22);

  const tool = buildToolDefs().find((d) => d.name === 'get_recent_messages');
  const result = await executeTool([tool], {
    chatKey: 'private:1', store,
    session: { pastStateMessageKeys: history.messages.map((m) => m.chatKey + '/' + m.id) }
  }, 'get_recent_messages', JSON.stringify({ limit: 10 }));
  const remaining = JSON.parse(result.content).messages.map((m) => m.text);
  assert.equal(remaining.length, 4);
  assert.ok(remaining.includes('[群 9] 繁忙群消息 1'));
  assert.ok(remaining.includes('旧私聊'));
  store.close();
});
