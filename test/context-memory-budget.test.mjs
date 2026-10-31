import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-context-memory-'));
process.env.QQ_AGENT_DATA_DIR = dir;
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/core/config.js');
const { buildPastState } = await import('../src/llm/prompt.js');
const { MemoryStore } = await import('../src/memory/memory-global.js');
const { MemorySearchIndex } = await import('../src/memory/memory-search.js');

function configure() {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.store.pastStateMaxChars = 140;
  setRuntimeConfig(cfg);
  return cfg;
}

function message(id, text) {
  return { id, mid: String(id), chatKey: 'group:1', senderId: '12345', senderName: '甲', ts: Date.now(), text };
}

test('长消息不会清空最新历史；截断保留来源和消息 ID 且严格遵守预算', () => {
  configure();
  const latest = message(2, '这是最新内容' + '😀'.repeat(500));
  const past = buildPastState({ recent: () => [message(1, '旧消息'), latest] }, 'group:1');
  assert.equal(past.count, 1);
  assert.deepEqual(past.messages.map((m) => m.id), [2]);
  assert.ok(past.text.length <= 140);
  assert.match(past.text, /#2 .*甲：这是最新内容/);
  assert.match(past.text, /历史消息已截断/);
  assert.doesNotMatch(past.text, /旧消息/);
  assert.ok(!past.text.isWellFormed || past.text.isWellFormed());
});

test('普通历史保持时间顺序；零条档位和触发消息排除仍生效', () => {
  configure();
  const rows = [message(1, '第一条'), message(2, '第二条')];
  const store = { recent: () => rows };
  const past = buildPastState(store, 'group:1');
  assert.equal(past.count, 2);
  assert.ok(past.text.indexOf('第一条') < past.text.indexOf('第二条'));
  assert.ok(past.text.length <= 140);
  assert.equal(buildPastState(store, 'group:1', { limit: 0 }).text, '');
  assert.doesNotMatch(buildPastState(store, 'group:1', { excludeIds: [2] }).text, /第二条/);
});

test('记忆预算先覆盖每个人的最新印象，不被前面的人挤占', (t) => {
  configure();
  const store = new MemoryStore();
  t.after(() => store.close());
  const now = Date.now();
  const ids = Array.from({ length: 8 }, (_, i) => String(20000 + i));
  for (const id of ids) {
    for (let i = 0; i < 3; i++) {
      store.people.append('group:1', id, `群友${id}`, `${id}-${i} ${'内容'.repeat(210)}`, now + i, 'manual', now + i);
    }
  }
  const prompt = store.formatForPrompt('group:1', { userIds: ids });
  assert.ok(prompt.length <= 6000);
  for (const id of ids) assert.ok(prompt.includes(`${id}-2`), `${id} 的最新印象`);
  assert.ok(prompt.indexOf('20007-2') < prompt.indexOf('20000-1'));
});

test('超长印象跳过后仍能注入后续短印象，不返回空标题', (t) => {
  configure();
  const store = new MemoryStore();
  t.after(() => store.close());
  // 模拟遗留数据；读取端仍应保证整个块的预算，不截出半条事实。
  store.people.get = (id) => ({ userId: id, name: id, impressions: [{ content: id === '1' ? '长'.repeat(7000) : '喜欢散步', createdAt: Date.now() }] });
  assert.match(store.formatForPrompt('group:1', { userIds: ['1', '2'] }), /喜欢散步/);
  assert.equal(store.formatForPrompt('group:1', { userIds: ['1'] }), '');
});

test('检索先筛选用户和来源，再截候选；大量不可见结果不会挤掉可见记忆', (t) => {
  const index = new MemorySearchIndex({ dataDir: dir, filename: 'scope-test.sqlite' });
  t.after(() => index.close());
  const now = Date.now();
  const entry = (content, sourceChatKeys) => ({ content, sourceChatKeys, createdAt: now, lastObservedAt: now });
  const members = Array.from({ length: 300 }, (_, i) => ({
    userId: String(i), name: '干扰项', impressions: [entry('咖啡', ['private:9'])]
  }));
  members.push({ userId: 'target', name: '目标', impressions: [entry('周末喜欢喝咖啡和看书', ['group:1'])] });
  const byUser = index.search({ members, query: '咖啡', userId: 'target' });
  assert.equal(index.error, '');
  assert.equal(byUser.length, 1);
  assert.equal(byUser[0].userId, 'target');
  for (const visibility of [
    { mode: 'perChat', hidePrivateInGroup: false },
    { mode: 'global', hidePrivateInGroup: true }
  ]) {
    const results = index.search({ members, query: '咖啡', chatKey: 'group:1', visibility });
    assert.equal(index.error, '');
    assert.deepEqual(results.map((r) => r.userId), ['target']);
  }
  assert.equal(index.stats(members).docs, 301, '筛选只发生在读取时，不删除索引里的其它来源');
});
